import assert from "node:assert/strict";
import test from "node:test";
import { createCaasAdapter, type CaasTransport, type CaasTransportRequest, type CaasTransportResponse } from "../src/index.ts";

const previousKey = process.env.apikey;
process.env.apikey = "test-only-key";

test.after(() => {
  if (previousKey === undefined) delete process.env.apikey;
  else process.env.apikey = previousKey;
});

function response(body: string, family: CaasTransportRequest["family"], status = 200, contentType = family === "displayAll" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8"): CaasTransportResponse {
  return { status, headers: { "content-type": contentType }, body };
}

function queued(...responses: CaasTransportResponse[]): { transport: CaasTransport; requests: CaasTransportRequest[] } {
  const requests: CaasTransportRequest[] = [];
  let index = 0;
  return { requests, transport: { async get(request) { requests.push(request); return responses[Math.min(index++, responses.length - 1)]!; } } };
}

test("uses only the fixed HTTPS GET family requests and retains recorded route-element airway labels", async () => {
  const { transport, requests } = queued(
    response(JSON.stringify([{
      id: "f-1", callsign: " ab123 ", departureAirport: { icao: "kjfk" }, destination: "KLAX",
      route: [{ seq: 0, ident: "DCT", airway: "SECRET-AIRWAY" }, { sequence: 1, coordinate: { latitude: "40", longitude: "-73" }, unknown: "discard" }],
      unknown: "discard",
    }]), "displayAll"),
    response(JSON.stringify(["A1", "a1", "bad\u0000"]), "airways"),
  );
  const adapter = createCaasAdapter({ transport, sleep: async () => undefined });
  const flight = await adapter.displayAll();
  const airway = await adapter.airways();
  assert.equal(flight.records[0]!.callsign, "AB123");
  assert.deepEqual(flight.records[0]!.routeElements![1]!.coordinate, { lat: 40, lon: -73 });
  assert.equal(flight.records[0]!.routeElements![0]!.airway, "SECRET-AIRWAY");
  assert.equal("A1" in airway, false);
  assert.equal(airway.acceptedRecords, 2);
  assert.equal(airway.uniqueRecords, 1);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.equal(new URL(request.url).origin, "https://api.swimapisg.info");
    assert.equal(request.headers["apikey"], "test-only-key");
    assert.equal(new URL(request.url).search, "");
  }
});

test("maps the live nested Flight Plan shape with an explicit safe allow-list", async () => {
  const { transport } = queued(response(JSON.stringify([
    {
      aircraftIdentification: " live123 ",
      departure: { departureAerodrome: { locationId: "kdep" } },
      arrival: { destinationAerodrome: { locationId: "karr" } },
      filedRoute: {
        routeElement: [
          {
            seqNum: 4,
            position: { designatedPoint: { designator: "fixalpha" } },
            airway: "PLACEHOLDER-AIRWAY",
            airwayType: "PLACEHOLDER-AIRWAY-TYPE",
            sensitiveField: "discard",
          },
          {
            seqNum: 5,
            position: { designatedPoint: { latitude: "12.5", longitude: "-45.25" } },
            airway: "ANOTHER-PLACEHOLDER-AIRWAY",
            airwayType: "ANOTHER-PLACEHOLDER-AIRWAY-TYPE",
          },
        ],
      },
      sensitiveField: "discard",
    },
    { aircraftIdentification: "NO-ROUTE" },
    { aircraftIdentification: "EMPTY-ROUTE", filedRoute: { routeElement: [] } },
  ]), "displayAll"));
  const result = await createCaasAdapter({ transport }).displayAll();
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.records[0], {
    id: "flight-1",
    callsign: "LIVE123",
    departure: "KDEP",
    destination: "KARR",
    routeElements: [
      { sequence: 4, identifier: "FIXALPHA", airway: "PLACEHOLDER-AIRWAY", airwayType: "PLACEHOLDER-AIRWAY-TYPE" },
      { sequence: 5, coordinate: { lat: 12.5, lon: -45.25 }, airway: "ANOTHER-PLACEHOLDER-AIRWAY", airwayType: "ANOTHER-PLACEHOLDER-AIRWAY-TYPE" },
    ],
  });
  assert.equal("sensitiveField" in result.records[0]!, false);
  assert.equal("routeElements" in result.records[1]!, false);
  assert.deepEqual(result.records[2]!.routeElements, []);
});

test("preserves missing versus explicit-empty routes and coordinate-only occurrences", async () => {
  const { transport } = queued(response(JSON.stringify([
    { callsign: "MISSING" },
    { callsign: "EMPTY", route: [] },
    { callsign: "COORD", route: [{ airway: "DO-NOT-EXPOSE", coordinates: [12, 34] }] },
    { callsign: "x".repeat(40), callSign: "OK", route: [{ ident: "x".repeat(40), coordinate: { lat: 1, lon: 2 } }] },
  ]), "displayAll"));
  const result = await createCaasAdapter({ transport }).displayAll();
  assert.equal(result.records.length, 4);
  assert.equal("routeElements" in result.records[0]!, false);
  assert.deepEqual(result.records[1]!.routeElements, []);
  assert.deepEqual(result.records[2]!.routeElements, [{ sequence: 0, coordinate: { lat: 34, lon: 12 }, airway: "DO-NOT-EXPOSE" }]);
  assert.equal(result.records[3]!.callsign, "OK");
  assert.deepEqual(result.records[3]!.routeElements, [{ sequence: 0, coordinate: { lat: 1, lon: 2 } }]);
});

test("accepts 254 endpoint-interior elements but rejects the next bounded record", async () => {
  const validRoute = Array.from({ length: 254 }, (_, sequence) => ({ sequence, coordinate: { lat: 0, lon: sequence / 2 } }));
  const tooLongRoute = [...validRoute, { sequence: 254, coordinate: { lat: 0, lon: 127 } }];
  const { transport } = queued(response(JSON.stringify([
    { callsign: "VALID", route: validRoute },
    { callsign: "TOO-LONG", route: tooLongRoute },
  ]), "displayAll"));
  const result = await createCaasAdapter({ transport }).displayAll();
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]!.routeElements!.length, 254);
  assert.equal(result.evidence.rejectedRecords, 1);
});
test("preserves duplicate reference identifiers in the index", async () => {
  const { transport } = queued(response(JSON.stringify(["ABC (1,2)", "abc (3,4)", "BAD (91,2)"]), "fixes"));
  const result = await createCaasAdapter({ transport }).fixes();
  assert.equal(result.points.length, 2);
  assert.equal(result.index.get("ABC")?.length, 2);
  assert.equal(result.evidence.rejectedRecords, 1);
});

test("retries one 429 or 5xx and never retries other 4xx", async () => {
  const first = queued(response("", "airports", 429, "text/plain"), response(JSON.stringify(["KJFK (1,2)"]), "airports"));
  let delays: number[] = [];
  const adapter = createCaasAdapter({ transport: first.transport, sleep: async (delay) => { delays.push(delay); } });
  const result = await adapter.airports();
  assert.equal(result.points.length, 1);
  assert.equal(first.requests.length, 2);
  assert.equal(result.evidence.retried, true);
  assert.deepEqual(delays, [0]);

  const denied = queued(response("", "airports", 401, "text/plain"), response(JSON.stringify(["BAD (1,2)"]), "airports"));
  await assert.rejects(() => createCaasAdapter({ transport: denied.transport }).airports(), { code: "UPSTREAM_STATUS" });
  assert.equal(denied.requests.length, 1);
});

test("rejects wrong media, malformed JSON, and bounded-size violations without body leakage", async () => {
  const media = queued(response("[]", "airways", 200, "application/json"));
  await assert.rejects(() => createCaasAdapter({ transport: media.transport }).airways(), { code: "MEDIA_TYPE" });
  const malformed = queued(response("not-json", "airways"));
  await assert.rejects(() => createCaasAdapter({ transport: malformed.transport }).airways(), { code: "INVALID_JSON" });
  const oversized = queued(response("x".repeat(5 * 1024 * 1024 + 1), "airways"));
  await assert.rejects(() => createCaasAdapter({ transport: oversized.transport }).airways(), { code: "RESPONSE_TOO_LARGE" });
  try { await createCaasAdapter({ transport: oversized.transport }).airways(); } catch (error) {
    assert.equal(String(error), "CaasAdapterError: The upstream response exceeded its bounded size.");
    assert.equal(String(error).includes("test-only-key"), false);
    assert.equal(String(error).includes("x".repeat(20)), false);
  }
});

test("requires the runtime process credential and rejects malformed coordinates", async () => {
  delete process.env.apikey;
  assert.throws(() => createCaasAdapter({ transport: queued(response("[]", "airways")).transport }), { code: "CONFIGURATION" });
  process.env.apikey = "test-only-key";
  const { transport } = queued(response(JSON.stringify(["A (1e2,2)", "B (90,180)", "C (90.000001,0)"]), "navaids"));
  const result = await createCaasAdapter({ transport }).navaids();
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0]!.identifier, "B");
});
