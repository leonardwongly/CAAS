import assert from "node:assert/strict";
import test from "node:test";
import {
  CAAS_ORIGIN,
  FAMILY_POLICIES,
  createLiveTransport,
  type CaasTransportRequest,
} from "../../packages/upstream-caas/src/index.ts";

// Finding: transport.ts lines 83-84 observe request.signal only through an
// "abort" event listener, and fetch (line 87) receives only the internal
// controller.signal, which is never pre-aborted. Nothing checks
// request.signal.aborted before fetch, so a pre-aborted signal performs the
// full network call and body read and resolves 200 instead of rejecting
// CANCELLED. The adapter's requestCancelled() guard (index.ts:53-54,68,83)
// hides this for createCaasAdapter callers, but createLiveTransport is an
// exported public CaasTransport and must uphold the same cancellation
// contract: a pre-cancelled request never reaches the network (same rule the
// adapter contract encodes: "a pre-cancelled signal never reaches the
// transport").
//
// Correct behavior: reject with code CANCELLED and zero fetch calls.

test("a pre-aborted signal rejects CANCELLED with zero fetch calls at the transport level", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(["KOR1 (40,-73)"]), { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  try {
    const transport = createLiveTransport();
    const controller = new AbortController();
    controller.abort();
    const request: CaasTransportRequest = {
      family: "airports",
      method: "GET",
      url: `${CAAS_ORIGIN}${FAMILY_POLICIES.airports.path}`,
      headers: {},
      maxBytes: FAMILY_POLICIES.airports.maxBytes,
      signal: controller.signal,
    };
    await assert.rejects(() => transport.get(request), { code: "CANCELLED" });
    assert.equal(calls, 0, "a pre-cancelled signal must never reach fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
