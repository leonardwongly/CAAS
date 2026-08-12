import assert from "node:assert/strict";
import test from "node:test";
import {
  API_KEY_HEADER,
  FAMILY_POLICIES,
  createCaasAdapter,
  type CaasTransport,
  type CaasTransportRequest,
  type CaasTransportResponse,
} from "../packages/upstream-caas/src/index.ts";

function response(body: string, family: CaasTransportRequest["family"], status = 200, contentType = family === "displayAll" ? "application/json" : "text/plain"): CaasTransportResponse {
  return { status, headers: { "content-type": contentType }, body };
}

function queued(...responses: CaasTransportResponse[]): { transport: CaasTransport; requests: CaasTransportRequest[] } {
  const requests: CaasTransportRequest[] = [];
  let index = 0;
  return { requests, transport: { async get(request) { requests.push(request); return responses[Math.min(index++, responses.length - 1)]!; } } };
}

const previousKey = process.env.apikey;
test.after(() => {
  if (previousKey === undefined) delete process.env.apikey;
  else process.env.apikey = previousKey;
});

test("uses only fixed allow-listed requests and redacts airway values from normalized data", async () => {
  process.env.apikey = "offline-fixture-key";
  const { transport, requests } = queued(
    response(JSON.stringify([{ id: "fixture-flight", callsign: " f1 ", departure: "KOR1", destination: "KDS1", route: [{ ident: "MIDPT", airway: "hidden-airway-value" }] }]), "displayAll"),
    response(JSON.stringify(["A1", "a1", "bad\u0000"]), "airways"),
    response(JSON.stringify(["MIDPT (35,-90)"]), "fixes"),
    response(JSON.stringify(["KOR1 (40,-73)", "KDS1 (33,-118)"]), "airports"),
    response(JSON.stringify(["DUPX (35,-90)", "DUPX (36,-91)"]), "navaids"),
  );
  const adapter = createCaasAdapter({ transport });
  const [flights, airways, fixes, airports, navaids] = await Promise.all([adapter.displayAll(), adapter.airways(), adapter.fixes(), adapter.airports(), adapter.navaids()] as const);
  assert.equal(flights.records[0]?.callsign, "F1");
  assert.equal("airway" in (flights.records[0]?.routeElements?.[0] ?? {}), false);
  assert.equal("A1" in airways, false);
  assert.equal(airways.uniqueRecords, 1);
  assert.equal(fixes.points.length, 1);
  assert.equal(airports.points.length, 2);
  assert.equal(navaids.index.get("DUPX")?.length, 2);
  assert.equal(requests.length, 5);
  for (const request of requests) {
    const policy = FAMILY_POLICIES[request.family];
    if (!policy) throw new Error(`Missing policy for ${request.family}`);
    const url = new URL(request.url);
    assert.equal(request.method, "GET");
    assert.equal(url.origin, "https://api.swimapisg.info");
    assert.equal(url.pathname, policy.path);
    assert.equal(url.search, "");
    assert.equal(request.headers[API_KEY_HEADER], "offline-fixture-key");
  }
});

test("retries exactly once for throttling and fails closed for non-retryable status", async () => {
  process.env.apikey = "offline-fixture-key";
  const retried = queued(response("", "airports", 429), response(JSON.stringify(["KOR1 (40,-73)"]), "airports"));
  const delays: number[] = [];
  const result = await createCaasAdapter({ transport: retried.transport, sleep: async (delay) => { delays.push(delay); } }).airports();
  assert.equal(result.evidence.retried, true);
  assert.equal(retried.requests.length, 2);
  assert.deepEqual(delays, [0]);

  const denied = queued(response("credential must not surface", "airports", 401), response(JSON.stringify([]), "airports"));
  await assert.rejects(() => createCaasAdapter({ transport: denied.transport }).airports(), { code: "UPSTREAM_STATUS" });
  assert.equal(denied.requests.length, 1);
});

test("rejects wrong media, malformed JSON, oversized content, and invalid coordinates without leaking body data", async () => {
  process.env.apikey = "offline-fixture-key";
  const wrongMedia = queued(response("[]", "airways", 200, "application/json"));
  await assert.rejects(() => createCaasAdapter({ transport: wrongMedia.transport }).airways(), { code: "MEDIA_TYPE" });
  const malformed = queued(response("not-json", "airways"));
  await assert.rejects(() => createCaasAdapter({ transport: malformed.transport }).airways(), { code: "INVALID_JSON" });
  const invalidCoordinate = queued(response(JSON.stringify(["BAD (91,0)"]), "navaids"));
  const normalized = await createCaasAdapter({ transport: invalidCoordinate.transport }).navaids();
  assert.equal(normalized.points.length, 0);
  const secretBody = "fixture-body-that-must-not-be-in-errors";
  const oversized = queued(response("x".repeat(5 * 1024 * 1024 + 1), "airways"));
  await assert.rejects(() => createCaasAdapter({ transport: oversized.transport }).airways(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "RESPONSE_TOO_LARGE");
    assert.equal(String(error).includes(secretBody), false);
    assert.equal(String(error).includes("offline-fixture-key"), false);
    return true;
  });
});
