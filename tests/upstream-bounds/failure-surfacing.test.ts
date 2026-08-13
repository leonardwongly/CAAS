import assert from "node:assert/strict";
import test from "node:test";
import {
  CAAS_ORIGIN,
  CONNECT_TIMEOUT_MS,
  FAMILY_POLICIES,
  MAX_TOTAL_REFERENCE_RECORDS,
  REQUEST_TIMEOUT_MS,
  createCaasAdapter,
  createLiveTransport,
  normalizeDisplayAll,
  normalizeReferenceList,
  type CaasTransportRequest,
} from "../../packages/upstream-caas/src/index.ts";

// Issue #30 evidence: failures surface as bounded, typed errors — never as
// silent truncation or leaked body content. Plan §6: "Crossing a hard limit
// fails closed with a bounded error and never silently truncates required
// results." All fixtures are sanitized; no live data is used.

const previousKey = process.env.apikey;
test.after(() => {
  if (previousKey === undefined) delete process.env.apikey;
  else process.env.apikey = previousKey;
});

test("policy wiring matches the documented per-family limits", () => {
  assert.equal(FAMILY_POLICIES.displayAll.maxRecords, 10_000);
  assert.equal(FAMILY_POLICIES.displayAll.maxBytes, 10 * 1024 * 1024);
  assert.equal(FAMILY_POLICIES.airways.maxRecords, 100_000);
  assert.equal(FAMILY_POLICIES.airways.maxBytes, 5 * 1024 * 1024);
  assert.equal(FAMILY_POLICIES.fixes.maxRecords, 500_000);
  assert.equal(FAMILY_POLICIES.fixes.maxBytes, 96 * 1024 * 1024);
  assert.equal(FAMILY_POLICIES.airports.maxRecords, 100_000);
  assert.equal(FAMILY_POLICIES.airports.maxBytes, 32 * 1024 * 1024);
  assert.equal(FAMILY_POLICIES.navaids.maxRecords, 100_000);
  assert.equal(FAMILY_POLICIES.navaids.maxBytes, 32 * 1024 * 1024);
  assert.equal(MAX_TOTAL_REFERENCE_RECORDS, 700_000);
});

test("transport rejects every request outside the fixed origin/path/method/size policy before any network call", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls += 1; throw new Error("no network call may occur"); }) as typeof fetch;
  try {
    const transport = createLiveTransport();
    const valid = { method: "GET", headers: {}, maxBytes: FAMILY_POLICIES.fixes.maxBytes, url: `${CAAS_ORIGIN}${FAMILY_POLICIES.fixes.path}` };
    const invalid = [
      { ...valid, family: "fixes" as const, method: "POST" as const },
      { ...valid, family: "fixes" as const, url: "https://api.swimapisg.info.geocities.example/geopoints/list/fixes" },
      { ...valid, family: "fixes" as const, url: `${CAAS_ORIGIN}/not-a-family-path` },
      { ...valid, family: "fixes" as const, url: `${CAAS_ORIGIN}${FAMILY_POLICIES.fixes.path}?extra=1` },
      { ...valid, family: "fixes" as const, url: `${CAAS_ORIGIN}${FAMILY_POLICIES.fixes.path}#fragment` },
      { ...valid, family: "fixes" as const, maxBytes: FAMILY_POLICIES.fixes.maxBytes + 1 },
      { ...valid, family: "fixes" as const, method: "GET", url: "http://api.swimapisg.info/geopoints/list/fixes" },
      { ...valid, family: "unknown-family" as never },
    ];
    for (const request of invalid) {
      await assert.rejects(() => transport.get(request as CaasTransportRequest), { code: "POLICY_REJECTED" }, `should reject ${request.url ?? request.family}`);
    }
    assert.equal(networkCalls, 0, "policy rejection must happen before any network I/O");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live transport sends a fixed GET with the API key, redirects forbidden, and lowercased response headers", async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit & { url: string } | undefined;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    captured = { url: String(url), ...(init ?? {}) };
    return new Response(JSON.stringify(["MIDPT (35,-90)"]), { status: 200, headers: { "content-type": "text/plain", "X-Custom": "kept-lowercase" } });
  }) as typeof fetch;
  try {
    const transport = createLiveTransport();
    const result = await transport.get({
      family: "fixes",
      method: "GET",
      url: `${CAAS_ORIGIN}${FAMILY_POLICIES.fixes.path}`,
      headers: { accept: "text/plain", apikey: "offline-fixture-key" },
      maxBytes: FAMILY_POLICIES.fixes.maxBytes,
    });
    assert.equal(captured?.url, `${CAAS_ORIGIN}${FAMILY_POLICIES.fixes.path}`);
    assert.equal(captured?.method, "GET");
    assert.equal(captured?.redirect, "error", "redirects must be a hard error, never followed");
    assert.equal((captured?.headers as Record<string, string> | undefined)?.["apikey"], "offline-fixture-key");
    assert.ok(captured?.signal instanceof AbortSignal, "the request must carry an abort signal for the deadline timers");
    assert.equal(result.status, 200);
    assert.equal(result.headers["x-custom"], "kept-lowercase");
    assert.equal(JSON.parse(result.body)[0], "MIDPT (35,-90)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enforces the response size bound from the content-length header without reading the body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response("body-that-must-never-be-read", { status: 200, headers: { "content-type": "text/plain", "content-length": String(FAMILY_POLICIES.airways.maxBytes + 1) } });
  }) as typeof fetch;
  try {
    const transport = createLiveTransport();
    await assert.rejects(
      () => transport.get({ family: "airways", method: "GET", url: `${CAAS_ORIGIN}${FAMILY_POLICIES.airways.path}`, headers: {}, maxBytes: FAMILY_POLICIES.airways.maxBytes }),
      { code: "RESPONSE_TOO_LARGE" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enforces the response size bound while streaming when no content-length is present", async () => {
  const originalFetch = globalThis.fetch;
  const chunk = new Uint8Array(1024 * 1024); // 1 MiB
  globalThis.fetch = (async () => {
    let pushed = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pushed >= 11) { controller.close(); return; }
        controller.enqueue(chunk);
        pushed += 1;
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  try {
    const transport = createLiveTransport();
    await assert.rejects(
      () => transport.get({ family: "airways", method: "GET", url: `${CAAS_ORIGIN}${FAMILY_POLICIES.airways.path}`, headers: {}, maxBytes: FAMILY_POLICIES.airways.maxBytes }),
      { code: "RESPONSE_TOO_LARGE" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects invalid UTF-8 payloads as policy violations", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(new Uint8Array([0xff, 0xfe, 0x41, 0x42]), { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  try {
    const transport = createLiveTransport();
    await assert.rejects(
      () => transport.get({ family: "airports", method: "GET", url: `${CAAS_ORIGIN}${FAMILY_POLICIES.airports.path}`, headers: {}, maxBytes: FAMILY_POLICIES.airports.maxBytes }),
      { code: "POLICY_REJECTED" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aborts a stalled upstream at the connect and total deadlines, surfacing TIMEOUT", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  try {
    const transport = createLiveTransport();
    const connectDeadline = transport.get({ family: "fixes", method: "GET", url: `${CAAS_ORIGIN}${FAMILY_POLICIES.fixes.path}`, headers: {}, maxBytes: FAMILY_POLICIES.fixes.maxBytes });
    t.mock.timers.tick(CONNECT_TIMEOUT_MS);
    await assert.rejects(connectDeadline, { code: "TIMEOUT" });

    const totalDeadline = transport.get({ family: "fixes", method: "GET", url: `${CAAS_ORIGIN}${FAMILY_POLICIES.fixes.path}`, headers: {}, maxBytes: FAMILY_POLICIES.fixes.maxBytes });
    t.mock.timers.tick(REQUEST_TIMEOUT_MS);
    await assert.rejects(totalDeadline, { code: "TIMEOUT" });
  } finally {
    globalThis.fetch = originalFetch;
    t.mock.timers.reset();
  }
});

test("a response that completes quickly is not aborted by the deadline timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(["MIDPT (35,-90)"]), { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
  try {
    const transport = createLiveTransport();
    const result = await transport.get({ family: "fixes", method: "GET", url: `${CAAS_ORIGIN}${FAMILY_POLICIES.fixes.path}`, headers: {}, maxBytes: FAMILY_POLICIES.fixes.maxBytes });
    t.mock.timers.tick(REQUEST_TIMEOUT_MS + 1000);
    assert.equal(result.status, 200, "completed request must not be retroactively aborted");
  } finally {
    globalThis.fetch = originalFetch;
    t.mock.timers.reset();
  }
});

test("rejects the wrong media type in either direction", async () => {
  process.env.apikey = "offline-fixture-key";
  const calls: Array<{ body: string; family: CaasTransportRequest["family"]; contentType: string }> = [];
  const transport = {
    async get(request: CaasTransportRequest) {
      const call = calls.find((candidate) => candidate.family === request.family);
      if (!call) throw new Error("unexpected family");
      return { status: 200, headers: { "content-type": call.contentType }, body: call.body };
    },
  };
  calls.push({ body: "[]", family: "displayAll", contentType: "text/plain" });
  await assert.rejects(() => createCaasAdapter({ transport }).displayAll(), { code: "MEDIA_TYPE" });
  calls.length = 0;
  calls.push({ body: "[]", family: "airways", contentType: "application/json" });
  await assert.rejects(() => createCaasAdapter({ transport }).airways(), { code: "MEDIA_TYPE" });
});

test("fails with RECORD_LIMIT when a family exceeds its documented record bound", () => {
  const oversized = Array.from({ length: 4 }, (_unused, index) => ({ callsign: `C${index}`, departure: "KOR1", destination: "KDS1" }));
  assert.throws(() => normalizeDisplayAll(JSON.stringify(oversized), 3), { code: "RECORD_LIMIT" });
  assert.throws(() => normalizeReferenceList(JSON.stringify(["A (0,0)", "B (0,0)", "C (0,0)"]), "fixes", 2), { code: "RECORD_LIMIT" });
});

test("fails with RECORD_LIMIT through the adapter at the full displayAll bound", async () => {
  process.env.apikey = "offline-fixture-key";
  const records = Array.from({ length: 10_001 }, (_unused, index) => ({ callsign: `C${index}`, departure: "KOR1", destination: "KDS1" }));
  const transport = { async get() { return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(records) }; } };
  await assert.rejects(() => createCaasAdapter({ transport }).displayAll(), { code: "RECORD_LIMIT" });
});

test("fails with RECORD_LIMIT at the 700,000 aggregate reference bound", async () => {
  process.env.apikey = "offline-fixture-key";
  const points = Array.from({ length: MAX_TOTAL_REFERENCE_RECORDS + 1 }, (_unused, index) => `P${index} (0,0)`);
  const transport = { async get() { return { status: 200, headers: { "content-type": "text/plain" }, body: JSON.stringify(points) }; } };
  await assert.rejects(() => createCaasAdapter({ transport }).navaids(), { code: "RECORD_LIMIT" });
});

test("counts rejected records in evidence instead of silently truncating", async () => {
  process.env.apikey = "offline-fixture-key";
  const bodies: Array<{ family: CaasTransportRequest["family"]; body: string }> = [
    { family: "displayAll", body: JSON.stringify([
      { callsign: "OK1", departure: "KOR1", destination: "KDS1" },
      { departure: "KOR1", destination: "KDS1" }, // no callsign -> rejected
      { callsign: "OK2", departure: "KOR1", destination: "KDS1" },
    ]) },
  ];
  const transport = { async get(request: CaasTransportRequest) { const found = bodies.find((candidate) => candidate.family === request.family); return { status: 200, headers: { "content-type": request.family === "displayAll" ? "application/json" : "text/plain" }, body: found?.body ?? "[]" }; } };
  const adapter = createCaasAdapter({ transport });
  const display = await adapter.displayAll();
  assert.equal(display.records.length, 2, "two of three records normalize");
  assert.equal(display.evidence.records, 3, "evidence reports the raw upstream count");
  assert.equal(display.evidence.acceptedRecords, 2);
  assert.equal(display.evidence.rejectedRecords, 1, "the rejected record is counted, not silently dropped");

  const airwayBody = { family: "airways" as const, body: JSON.stringify(["A1", "A1", "bad\u0000control", 42, "A2"]) };
  bodies.length = 0;
  bodies.push(airwayBody);
  const airway = await adapter.airways();
  assert.equal(airway.acceptedRecords, 3, "the two A1s and A2 are accepted (duplicates count, only uniqueness dedupes)");
  assert.equal(airway.rejectedRecords, 2, "control characters and non-strings are counted as rejected");
  assert.equal(airway.uniqueRecords, 2);
});
