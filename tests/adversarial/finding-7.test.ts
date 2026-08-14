import assert from "node:assert/strict";
import test from "node:test";
import {
  CAAS_ORIGIN,
  FAMILY_POLICIES,
  createCaasAdapter,
  createLiveTransport,
  type CaasTransportRequest,
} from "../../packages/upstream-caas/src/index.ts";

// Finding 7: a retryable 429/5xx whose body stream is already errored skips
// the mandated retry. transport.ts line 97 awaits response.body.cancel() for
// every non-ok response; when the connection died after the status headers
// were received, that stream is errored and cancel() rejects, so the
// transport catch (lines 101-105) converts it to UPSTREAM_STATUS and the
// adapter (index.ts:79-82) rethrows CaasAdapterError before ever reaching the
// status-keyed retry branch (index.ts:91). Plan §6.1: "One retry for `429` or
// retryable `5xx`" — the 429 status WAS received, so the retry must happen
// even when body teardown fails. Correct behavior: 2 upstream calls, the
// second succeeds, and evidence.retried is true.

const previousKey = process.env.apikey;
test.after(() => {
  if (previousKey === undefined) delete process.env.apikey;
  else process.env.apikey = previousKey;
});

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
