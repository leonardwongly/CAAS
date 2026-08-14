import assert from "node:assert/strict";
import test from "node:test";
import { createLiveTransport, FAMILY_POLICIES } from "../../packages/upstream-caas/src/index.ts";

// Security sweep (deferred candidate, fixed by triage): rejecting an
// oversize response by content-length must CANCEL the unread body stream —
// an abandoned stream ties up the connection for the full response length.

test("an oversize response rejected by content-length cancels the body stream", async () => {
  const cancelled: boolean[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, _init?: RequestInit) => {
    return {
      status: 200,
      ok: true,
      headers: new Headers({ "content-length": String(FAMILY_POLICIES.airways.maxBytes + 1), "content-type": "text/plain; charset=utf-8" }),
      body: { cancel: async () => { cancelled.push(true); } },
      json: async () => ({}),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const transport = createLiveTransport();
    await assert.rejects(
      () => transport.get({ family: "airways", method: "GET", url: "https://api.swimapisg.info/geopoints/list/airways", headers: { accept: FAMILY_POLICIES.airways.expectedMediaType, apikey: "fixture-key" }, maxBytes: FAMILY_POLICIES.airways.maxBytes }),
      (error: unknown) => (error as { code?: string }).code === "RESPONSE_TOO_LARGE",
    );
    assert.deepEqual(cancelled, [true], "the unread body stream must be cancelled on the content-length rejection");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
