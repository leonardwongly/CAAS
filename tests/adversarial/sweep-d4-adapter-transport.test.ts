// Adversarial sweep — DOMAIN D4: upstream adapter & edge boundary.
// Owner: D4 — upstream adapter & edge boundary (parallel sweep).
// Scope: live-transport abort-signal semantics (abort DURING the request and
// DURING the body read, caller-cancel precedence over the internal deadline,
// abort-after-completion inertness) and the response size bound's exact
// off-by-one behavior.
//
// This file resolves the deferred-0 finding: the pre-abort gap it flagged is
// fixed in transport.ts (the `request.signal?.aborted` short-circuit before
// fetch) and pinned by deferred-0.test.ts itself, which passes. The remaining
// abort states — mid-flight, mid-body-read, post-completion, and precedence
// against the deadline timers — had NO coverage anywhere and are pinned here.
//
// De-duped against: deferred-0 (pre-abort), failure-surfacing (deadline
// TIMEOUT, oversize REJECTION paths, stream cancellation on content-length),
// retry-backoff (adapter-level cancellation during backoff / before attempt).
import assert from "node:assert/strict";
import test from "node:test";
import {
  CAAS_ORIGIN,
  FAMILY_POLICIES,
  REQUEST_TIMEOUT_MS,
  createLiveTransport,
  type CaasTransportRequest,
} from "../../packages/upstream-caas/src/index.ts";

const AIRWAYS_MAX = FAMILY_POLICIES.airways.maxBytes;

function airwaysRequest(signal?: AbortSignal): CaasTransportRequest {
  return {
    family: "airways",
    method: "GET",
    url: `${CAAS_ORIGIN}${FAMILY_POLICIES.airways.path}`,
    headers: {},
    maxBytes: AIRWAYS_MAX,
    ...(signal ? { signal } : {}),
  };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// 1. Abort semantics at the transport boundary.
// ---------------------------------------------------------------------------

test("an abort DURING the request surfaces CANCELLED — never TIMEOUT or UPSTREAM_STATUS", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = ((_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    fetchCalls += 1;
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  try {
    const controller = new AbortController();
    const pending = createLiveTransport().get(airwaysRequest(controller.signal));
    await settled();
    assert.equal(fetchCalls, 1, "the request must have reached the network before cancellation");
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CANCELLED", "a caller abort mid-flight must classify as CANCELLED");
      assert.equal((error as { family?: string }).family, "airways");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an abort DURING the body read surfaces CANCELLED and halts consumption", async () => {
  const originalFetch = globalThis.fetch;
  let chunksDelivered = 0;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      // Pace the stream like a real network: one chunk per macrotask, so
      // the abort lands while the body read is genuinely in flight (an
      // unpaced mock would exhaust the 5 MiB bound before any abort could fire).
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        chunksDelivered += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x41));
      },
    });
    // Real upstream behavior (undici): cancelling the request ERRORS the
    // response body stream even after headers arrived — simulate exactly that.
    init?.signal?.addEventListener("abort", () => {
      streamController?.error(new DOMException("aborted", "AbortError"));
    }, { once: true });
    return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const pending = createLiveTransport().get(airwaysRequest(controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 10)); // headers resolve, the body read begins
    controller.abort();
    await assert.rejects(pending, { code: "CANCELLED" });
    const deliveredAtAbort = chunksDelivered;
    await new Promise((resolve) => setTimeout(resolve, 10));
    // At most ONE in-flight pull may complete after the abort (it was already
    // executing); consumption must then be permanently halted — the stream
    // keeps pumping 1 chunk/ms, so any drift here proves a leaked reader.
    assert.ok(chunksDelivered <= deliveredAtAbort + 1, "no further chunks may be consumed after cancellation");
    const settledCount = chunksDelivered;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(chunksDelivered, settledCount, "consumption must stay halted");
    assert.ok(deliveredAtAbort > 0 && deliveredAtAbort < 100, "the read must have started, then stopped promptly");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a caller abort loses to nothing: even racing the internal deadline, CANCELLED is surfaced", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  try {
    const controller = new AbortController();
    const pending = createLiveTransport().get(airwaysRequest(controller.signal));
    // The total deadline fires first and aborts the internal controller…
    t.mock.timers.tick(REQUEST_TIMEOUT_MS);
    // …but the caller cancels before the rejection is classified. Cancellation
    // is the caller's truth and must win over the deadline classification.
    controller.abort();
    await assert.rejects(pending, { code: "CANCELLED" });
  } finally {
    globalThis.fetch = originalFetch;
    t.mock.timers.reset();
  }
});

test("an abort AFTER the response completed is inert — no retroactive cancellation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(["A1"]), { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
  try {
    const controller = new AbortController();
    const result = await createLiveTransport().get(airwaysRequest(controller.signal));
    assert.equal(result.status, 200);
    controller.abort(); // late abort: the request already settled
    await settled();
    await settled();
    assert.equal(result.status, 200, "the settled result must not be invalidated by a late abort");
    assert.equal(result.body, JSON.stringify(["A1"]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 2. Size bound: exact off-by-one behavior, inclusive at the limit.
// ---------------------------------------------------------------------------

function streamedResponse(chunks: Uint8Array[], contentLength?: number): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  });
  const headers: Record<string, string> = { "content-type": "text/plain" };
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  return new Response(stream, { status: 200, headers });
}

test("a streamed body at EXACTLY maxBytes is accepted — the bound is inclusive", async () => {
  const originalFetch = globalThis.fetch;
  const mib = new Uint8Array(1024 * 1024).fill(0x41);
  globalThis.fetch = (async () => streamedResponse([mib, mib, mib, mib, mib])) as typeof fetch; // 5 MiB == airways maxBytes
  try {
    const result = await createLiveTransport().get(airwaysRequest());
    assert.equal(result.status, 200);
    assert.equal(result.body.length, AIRWAYS_MAX, "every byte exactly at the bound must be served");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a content-length of EXACTLY maxBytes passes the header gate and streams to completion", async () => {
  const originalFetch = globalThis.fetch;
  const mib = new Uint8Array(1024 * 1024).fill(0x41);
  globalThis.fetch = (async () => streamedResponse([mib, mib, mib, mib, mib], AIRWAYS_MAX)) as typeof fetch;
  try {
    const result = await createLiveTransport().get(airwaysRequest());
    assert.equal(result.status, 200);
    assert.equal(result.body.length, AIRWAYS_MAX);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a single chunk one byte over the bound rejects immediately and cancels the stream", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  const oversize = new Uint8Array(AIRWAYS_MAX + 1).fill(0x41);
  globalThis.fetch = (async () => {
    // The stream stays OPEN after the oversize chunk: this is the case where
    // cancellation actually matters (upstream still has bytes to pump). A
    // stream closed after the chunk would make cancel() a no-op by spec.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversize);
      },
      cancel() {
        cancelled += 1;
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  try {
    await assert.rejects(() => createLiveTransport().get(airwaysRequest()), { code: "RESPONSE_TOO_LARGE" });
    assert.equal(cancelled, 1, "the partially-read stream must be cancelled, not abandoned");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a non-ok response is classified by STATUS, never by the size bound", async () => {
  // The size bound guards bodies we are about to READ. A 429 advertising an
  // oversized content-length must still reach the retry layer with its status.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 429,
    ok: false,
    headers: new Headers({ "content-length": String(AIRWAYS_MAX + 1), "retry-after": "1" }),
    body: { cancel: async () => {} },
  }) as unknown as Response) as typeof fetch;
  try {
    const result = await createLiveTransport().get(airwaysRequest());
    assert.equal(result.status, 429, "the 429 status must be surfaced for the adapter's retry decision");
    assert.equal(result.body, "", "a non-ok body must never be read");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hostile content-length headers cannot false-trigger or crash the size gate", async () => {
  const originalFetch = globalThis.fetch;
  const tiny = new TextEncoder().encode(JSON.stringify(["A1"]));
  try {
    for (const hostile of ["-5", "not-a-number", "1, 5", "+Infinity", "1e999"]) {
      globalThis.fetch = (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(tiny);
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/plain", "content-length": hostile } });
      }) as typeof fetch;
      const result = await createLiveTransport().get(airwaysRequest());
      assert.equal(result.status, 200, `content-length ${JSON.stringify(hostile)} must fall through to bounded streaming`);
      assert.equal(result.body, JSON.stringify(["A1"]));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
