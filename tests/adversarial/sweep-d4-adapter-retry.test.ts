// Adversarial sweep — DOMAIN D4: upstream adapter & edge boundary.
// Owner: D4 — upstream adapter & edge boundary (parallel sweep).
// Scope: the adapter's retry/backoff decision boundaries that
// tests/upstream-bounds/retry-backoff.test.ts does NOT pin — the exact
// retryable-status edges (429/500..599 vs 600+, 3xx, and the commonly
// misassumed-retryable 408/425), error classification across a MIXED retry
// sequence, Retry-After arithmetic exactly at the 5-second cap, and
// cancellation winning over a completed 200. Backoff here is deterministic
// (Retry-After driven, capped at MAX_RETRY_AFTER_MS) — there is no jitter by
// design, so there is no jitter edge to sweep.
//
// De-duped against: retry-backoff (500/502/503/504 single-retry, 400/401/
// 403/404 no-retry, "2"/"3600" Retry-After, invalid→0, backoff cancellation,
// pre-attempt cancellation, success-on-retry), adapter.test.ts retry smoke.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CaasAdapterError,
  MAX_RETRY_AFTER_MS,
  createCaasAdapter,
  type CaasTransport,
  type CaasTransportRequest,
  type CaasTransportResponse,
} from "../../packages/upstream-caas/src/index.ts";

function response(body: string, family: CaasTransportRequest["family"], status = 200, headers: Record<string, string> = {}): CaasTransportResponse {
  return { status, headers: { "content-type": family === "displayAll" ? "application/json" : "text/plain", ...headers }, body };
}

function queued(...responses: CaasTransportResponse[]): { transport: CaasTransport; requests: CaasTransportRequest[] } {
  const requests: CaasTransportRequest[] = [];
  let index = 0;
  return { requests, transport: { async get(request) { requests.push(request); return responses[Math.min(index++, responses.length - 1)]!; } } };
}

const OK_AIRPORTS = response(JSON.stringify(["KOR1 (40,-73)"]), "airports");

const previousKey = process.env.apikey;
test.after(() => {
  if (previousKey === undefined) delete process.env.apikey;
  else process.env.apikey = previousKey;
});

// ---------------------------------------------------------------------------
// 1. Retryable-status classification at its exact edges.
// ---------------------------------------------------------------------------

test("429/500/599 are retryable; 600+ is not — 599 is the inclusive upper edge", async () => {
  process.env.apikey = "offline-fixture-key";
  for (const status of [429, 500, 599]) {
    const pair = queued(response("", "airports", status), OK_AIRPORTS);
    const result = await createCaasAdapter({ transport: pair.transport, sleep: async () => {} }).airports();
    assert.equal(pair.requests.length, 2, `status ${status} must be retried exactly once`);
    assert.equal(result.evidence.retried, true);
  }
  const sixHundred = queued(response("", "airports", 600), OK_AIRPORTS);
  await assert.rejects(() => createCaasAdapter({ transport: sixHundred.transport, sleep: async () => { throw new Error("no backoff expected"); } }).airports(), { code: "UPSTREAM_STATUS", status: 600 });
  assert.equal(sixHundred.requests.length, 1, "600 is outside the 429/500-599 retryable set");
});

test("3xx, 204, and the misassumed-retryable 408/425 fail fast with their status preserved", async () => {
  process.env.apikey = "offline-fixture-key";
  for (const status of [204, 301, 302, 408, 425]) {
    const single = queued(response("", "airports", status), OK_AIRPORTS);
    await assert.rejects(
      () => createCaasAdapter({ transport: single.transport, sleep: async () => { throw new Error("no backoff expected"); } }).airports(),
      (error: unknown) => {
        assert.ok(error instanceof CaasAdapterError);
        assert.equal(error.code, "UPSTREAM_STATUS");
        assert.equal(error.status, status, `the surfaced status must be ${status}`);
        return true;
      },
    );
    assert.equal(single.requests.length, 1, `status ${status} must never be retried`);
  }
});

// ---------------------------------------------------------------------------
// 2. Mixed retry sequences: the FINAL status decides the surfaced code.
// ---------------------------------------------------------------------------

test("a retryable failure followed by a non-retryable one surfaces RETRY_EXHAUSTED carrying the final status", async () => {
  process.env.apikey = "offline-fixture-key";
  for (const [first, second] of [[500, 404], [429, 599], [599, 600]] as const) {
    const pair = queued(response("", "airports", first), response("", "airports", second));
    await assert.rejects(
      () => createCaasAdapter({ transport: pair.transport, sleep: async () => {} }).airports(),
      (error: unknown) => {
        assert.ok(error instanceof CaasAdapterError);
        assert.equal(error.code, "RETRY_EXHAUSTED", `after a retry, ${first}->${second} must surface as exhausted`);
        assert.equal(error.status, second, "the final attempt's status must be preserved");
        return true;
      },
    );
    assert.equal(pair.requests.length, 2);
  }
});

// ---------------------------------------------------------------------------
// 3. Retry-After arithmetic exactly at the cap and its rounding edges.
// ---------------------------------------------------------------------------

test("Retry-After seconds are rounded, bounded inclusively at the 5-second cap, and negatives degrade to zero", async () => {
  process.env.apikey = "offline-fixture-key";
  for (const [header, expectedDelay] of [
    ["5", MAX_RETRY_AFTER_MS], // exactly the cap
    ["4.999", 4_999], // rounding just under the cap
    ["5.001", MAX_RETRY_AFTER_MS], // rounding just over the cap clamps
    ["-3", 0], // negative seconds are invalid -> zero backoff
    ["  2  ", 2_000], // whitespace-padded numerics still parse
    ["+1", 1_000], // explicit positive sign
    ["0", 0], // explicit zero
  ] as const) {
    const pair = queued(response("", "airports", 429, { "retry-after": header }), OK_AIRPORTS);
    const recorded: number[] = [];
    const result = await createCaasAdapter({ transport: pair.transport, sleep: async (ms) => { recorded.push(ms); } }).airports();
    assert.equal(result.evidence.retried, true);
    assert.deepEqual(recorded, [expectedDelay], `retry-after ${JSON.stringify(header)} must back off ${expectedDelay}ms`);
  }
});

test("Retry-After HTTP-dates are bounded inclusively at the cap against the adapter clock", async () => {
  process.env.apikey = "offline-fixture-key";
  const now = Date.parse("2026-08-23T00:00:00Z");
  for (const [offsetMs, expectedDelay] of [
    [MAX_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS], // exactly the cap is honored
    [MAX_RETRY_AFTER_MS + 1, MAX_RETRY_AFTER_MS], // one millisecond over clamps
    [0, 0], // a date equal to now means no backoff
  ] as const) {
    const pair = queued(response("", "airports", 429, { "retry-after": new Date(now + offsetMs).toUTCString() }), OK_AIRPORTS);
    const recorded: number[] = [];
    await createCaasAdapter({ transport: pair.transport, now: () => now, sleep: async (ms) => { recorded.push(ms); } }).airports();
    assert.deepEqual(recorded, [expectedDelay], `a Retry-After date ${offsetMs}ms ahead must back off ${expectedDelay}ms`);
  }
});

test("a case-variant Retry-After header is honored for transports that do not lowercase headers", async () => {
  // The live transport lowercases response headers, but the adapter contract
  // must not depend on that: custom CaasTransport implementations may hand
  // over canonical-case headers.
  process.env.apikey = "offline-fixture-key";
  const pair = queued(response("", "airports", 429, { "Retry-After": "2" }), OK_AIRPORTS);
  const recorded: number[] = [];
  const result = await createCaasAdapter({ transport: pair.transport, sleep: async (ms) => { recorded.push(ms); } }).airports();
  assert.equal(result.evidence.retried, true);
  assert.deepEqual(recorded, [2_000], "canonical-case Retry-After must still be honored");
});

// ---------------------------------------------------------------------------
// 4. Cancellation wins over a completed success.
// ---------------------------------------------------------------------------

test("a cancellation that lands after the transport returns still surfaces CANCELLED, never the 200", async () => {
  process.env.apikey = "offline-fixture-key";
  const controller = new AbortController();
  // The transport completes a perfect 200, but the caller cancelled during
  // the call: the adapter's post-transport cancellation check must win.
  const transport: CaasTransport = {
    async get() {
      controller.abort();
      return OK_AIRPORTS;
    },
  };
  await assert.rejects(() => createCaasAdapter({ transport }).airports(controller.signal), { code: "CANCELLED" });
});
