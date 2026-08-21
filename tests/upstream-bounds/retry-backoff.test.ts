import assert from "node:assert/strict";
import test from "node:test";
import {
  CaasAdapterError,
  MAX_RETRY_AFTER_MS,
  createCaasAdapter,
  createLiveTransport,
  type CaasTransport,
  type CaasTransportRequest,
  type CaasTransportResponse,
} from "../../packages/upstream-caas/src/index.ts";

// Issue #30 evidence: bounded retries with correct backoff.
// The policy under proof is plan §6.1: "One retry for 429 or retryable 5xx,
// honoring bounded Retry-After; no retry for other 4xx", with Retry-After
// capped at MAX_RETRY_AFTER_MS (5 seconds) and at most two total attempts.
// All fixtures are sanitized; no live data is used.

function response(body: string, family: CaasTransportRequest["family"], status = 200, headers: Record<string, string> = {}): CaasTransportResponse {
  return { status, headers: { "content-type": family === "displayAll" ? "application/json" : "text/plain", ...headers }, body };
}

function queued(...responses: CaasTransportResponse[]): { transport: CaasTransport; requests: CaasTransportRequest[] } {
  const requests: CaasTransportRequest[] = [];
  let index = 0;
  return { requests, transport: { async get(request) { requests.push(request); return responses[Math.min(index++, responses.length - 1)]!; } } };
}

function delays(): { recorded: number[]; sleep: (ms: number, signal?: AbortSignal) => Promise<void> } {
  const recorded: number[] = [];
  return { recorded, sleep: async (ms) => { recorded.push(ms); } };
}

const previousKey = process.env.apikey;
test.after(() => {
  if (previousKey === undefined) delete process.env.apikey;
  else process.env.apikey = previousKey;
});

test("honors Retry-After seconds exactly, capped at the 5-second bound", async () => {
  process.env.apikey = "offline-fixture-key";
  const throttled = queued(
    response("", "airports", 429, { "retry-after": "2" }),
    response(JSON.stringify(["KOR1 (40,-73)"]), "airports"),
  );
  const { recorded, sleep } = delays();
  const result = await createCaasAdapter({ transport: throttled.transport, sleep }).airports();
  assert.equal(result.evidence.retried, true);
  assert.equal(throttled.requests.length, 2);
  assert.deepEqual(recorded, [2_000]);

  const capped = queued(
    response("", "airports", 429, { "retry-after": "3600" }),
    response(JSON.stringify(["KOR1 (40,-73)"]), "airports"),
  );
  const cappedDelays: number[] = [];
  const result2 = await createCaasAdapter({ transport: capped.transport, sleep: async (ms) => { cappedDelays.push(ms); } }).airports();
  assert.equal(result2.evidence.retried, true);
  assert.deepEqual(cappedDelays, [MAX_RETRY_AFTER_MS]);
});

test("honors Retry-After as an HTTP-date against the adapter clock, still capped", async () => {
  process.env.apikey = "offline-fixture-key";
  const at = Date.parse("2026-08-13T00:00:00Z");
  const near = queued(
    response("", "fixes", 429, { "retry-after": "2026-08-13T00:00:02Z" }),
    response(JSON.stringify(["MIDPT (35,-90)"]), "fixes"),
  );
  const nearDelays: number[] = [];
  const result = await createCaasAdapter({ transport: near.transport, now: () => at, sleep: async (ms) => { nearDelays.push(ms); } }).fixes();
  assert.equal(result.evidence.retried, true);
  assert.deepEqual(nearDelays, [2_000]);

  const far = queued(
    response("", "fixes", 429, { "retry-after": "2030-01-01T00:00:00Z" }),
    response(JSON.stringify(["MIDPT (35,-90)"]), "fixes"),
  );
  const farDelays: number[] = [];
  await createCaasAdapter({ transport: far.transport, now: () => at, sleep: async (ms) => { farDelays.push(ms); } }).fixes();
  assert.deepEqual(farDelays, [MAX_RETRY_AFTER_MS]);

  const past = queued(
    response("", "fixes", 429, { "retry-after": "2020-01-01T00:00:00Z" }),
    response(JSON.stringify(["MIDPT (35,-90)"]), "fixes"),
  );
  const pastDelays: number[] = [];
  await createCaasAdapter({ transport: past.transport, now: () => at, sleep: async (ms) => { pastDelays.push(ms); } }).fixes();
  assert.deepEqual(pastDelays, [0]);
});

test("treats an invalid Retry-After as zero backoff", async () => {
  process.env.apikey = "offline-fixture-key";
  const invalid = queued(
    response("", "airways", 429, { "retry-after": "not-a-number" }),
    response(JSON.stringify(["A1"]), "airways"),
  );
  const invalidDelays: number[] = [];
  const result = await createCaasAdapter({ transport: invalid.transport, sleep: async (ms) => { invalidDelays.push(ms); } }).airways();
  assert.equal(result.retried, true); // AirwayEvidence carries retried at the top level
  assert.deepEqual(invalidDelays, [0]);
});

test("retries every retryable 5xx exactly once and exhausts on a second failure", async () => {
  process.env.apikey = "offline-fixture-key";
  for (const status of [500, 502, 503, 504]) {
    const pair = queued(response("", "airports", status), response(JSON.stringify(["KOR1 (40,-73)"]), "airports"));
    const result = await createCaasAdapter({ transport: pair.transport, sleep: async () => {} }).airports();
    assert.equal(result.evidence.retried, true, `status ${status} should retry`);
    assert.equal(pair.requests.length, 2, `status ${status} should be attempted exactly twice`);
  }

  const exhausted = queued(response("", "airports", 503), response("", "airports", 503));
  const attempts: number[] = [];
  await assert.rejects(
    () => createCaasAdapter({ transport: exhausted.transport, sleep: async () => { attempts.push(1); } }).airports(),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "RETRY_EXHAUSTED");
      return true;
    },
  );
  assert.equal(exhausted.requests.length, 2, "retry budget is exactly one retry; no third attempt");
  assert.equal(attempts.length, 1, "backoff applied once between the two attempts");
});

test("does not retry any other 4xx status", async () => {
  process.env.apikey = "offline-fixture-key";
  for (const status of [400, 401, 403, 404]) {
    const single = queued(response("", "airports", status));
    await assert.rejects(
      () => createCaasAdapter({ transport: single.transport, sleep: async () => { throw new Error("no backoff expected"); } }).airports(),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "UPSTREAM_STATUS");
        assert.equal((error as { status?: number }).status, status);
        return true;
      },
    );
    assert.equal(single.requests.length, 1, `status ${status} must not retry`);
  }
});

test("surfaces a CaasAdapterError raised by the transport without reclassification", async () => {
  process.env.apikey = "offline-fixture-key";
  const transport: CaasTransport = { async get() { throw new CaasAdapterError("POLICY_REJECTED", "The upstream request is outside the fixed CAAS policy.", { family: "fixes" }); } };
  await assert.rejects(() => createCaasAdapter({ transport }).fixes(), { code: "POLICY_REJECTED" });
});

test("cancels the retry during backoff and before any attempt", async () => {
  process.env.apikey = "offline-fixture-key";
  const throttled = queued(response("", "airports", 429, { "retry-after": "1" }), response(JSON.stringify(["KOR1 (40,-73)"]), "airports"));
  const controller = new AbortController();
  const sleep = (ms: number, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) { reject(new CaasAdapterError("CANCELLED", "The upstream request was cancelled.")); return; }
    signal?.addEventListener("abort", () => reject(new CaasAdapterError("CANCELLED", "The upstream request was cancelled.")), { once: true });
    void ms;
  });
  const pending = createCaasAdapter({ transport: throttled.transport, sleep }).airports(controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(throttled.requests.length, 1, "cancellation during backoff prevents the second attempt");

  const never = queued(response(JSON.stringify(["KOR1 (40,-73)"]), "airports"));
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(() => createCaasAdapter({ transport: never.transport }).airports(preAborted.signal), { code: "CANCELLED" });
  assert.equal(never.requests.length, 0, "a pre-cancelled signal never reaches the transport");
});

test("succeeds on the retry attempt with the retried flag surfaced in evidence", async () => {
  process.env.apikey = "offline-fixture-key";
  const pair = queued(
    response("", "displayAll", 429, { "retry-after": "1" }),
    response(JSON.stringify([{ callsign: "f1", departure: "KOR1", destination: "KDS1" }]), "displayAll"),
  );
  const result = await createCaasAdapter({ transport: pair.transport, sleep: async () => {} }).displayAll();
  assert.equal(result.evidence.retried, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.callsign, "F1");
});

// Merged from tests/adversarial/finding-7.test.ts: a retryable 429 whose
// body stream is already errored must not skip the mandated retry. The live
// transport awaits response.body.cancel() for every non-ok response; when the
// connection died after the status headers arrived, that stream is errored
// and cancel() rejects — the retry decision is keyed on the 429 status and
// must still fire (plan §6.1: "One retry for 429 or retryable 5xx").
test("a 429 whose body teardown fails still gets the mandated retry (2 calls, retried=true)", async () => {
  process.env.apikey = "offline-fixture-key";
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      // Status headers arrive, then the connection dies: the body stream is
      // already errored, so cancel() rejects with the connection error.
      const dead = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("connection died after 429 headers"));
        },
      });
      return new Response(dead, { status: 429, headers: { "content-type": "text/plain" } });
    }
    return new Response(JSON.stringify(["KOR1 (40,-73)"]), { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  try {
    const adapter = createCaasAdapter({ transport: createLiveTransport(), sleep: async () => {} });
    const result = await adapter.airports();
    assert.equal(calls, 2, "a received 429 must be retried exactly once even when body teardown fails");
    assert.equal(result.evidence.retried, true, "the retry flag must be surfaced in evidence");
    assert.equal(result.points.length, 1);
    assert.equal(result.points[0]?.identifier, "KOR1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
