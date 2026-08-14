import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Finding sec-r2-6: the warm-request deadline aborts the refresh handler via an
// AbortSignal (apps/api/src/server.ts withWarmDeadline), but the deadline and
// the store's refresh state machine are not coordinated. server.test.ts:387
// pins only the 503 REQUEST_DEADLINE_EXCEEDED response and its promptness —
// nothing pins the store's state after the abort.
//
// Two failure modes with the current code:
//
// 1. Signal-ignoring upstream: withWarmDeadline's deadline rejects the race and
//    the client gets 503 REQUEST_DEADLINE_EXCEEDED, but the ignored acquisition
//    later completes and refresh()'s success path installs the new snapshot —
//    rotating previousSnapshot, clearing every draft bound to the old
//    generation, and flipping the store to "ready". The client was told the
//    refresh failed (retryable: true), yet the generation advanced and the
//    user's drafts were silently invalidated. Plan §6.2's refresh contract is
//    "a failed refresh keeps the prior generation only within freshness
//    limits" — the deadline-aborted refresh IS a failed refresh from the
//    client's perspective, so the prior generation (and its drafts) must stay
//    servable.
//
// 2. Cold store: with an upstream that honors the abort, the store's catch
//    (server.ts:511-522) records state="failed" and failureCode=
//    "UPSTREAM_UNAVAILABLE" for what was actually a server-policy deadline
//    abort, not an upstream failure. /startup and readiness then report
//    "upstream unavailable", misattributing a local deadline policy to the
//    upstream.
//
// Correct behavior per the contract: after a REQUEST_DEADLINE_EXCEEDED 503 the
// store must not advance a generation (active id unchanged, drafts minted
// before the deadline still servable), and a deadline abort on a cold store
// must not be recorded as UPSTREAM_UNAVAILABLE.

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Drains the microtask chain so any post-503 store mutation would have run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a deadline-aborted refresh with a signal-ignoring upstream leaves the store unchanged after the 503", async (t) => {
  const base = sanitizedAdapter();
  const gate = deferred();     // holds the refresh's acquisition mid-flight
  const completed = deferred(); // resolves when the ignored acquisition returns
  let slow = false;
  const adapter: CaasAdapter = {
    ...base,
    displayAll: async (signal) => {
      if (!slow) return base.displayAll(signal);
      await gate.promise;
      completed.resolve();
      return base.displayAll(signal); // upstream ignores the abort signal entirely
    },
  };
  const server = await createApiServer({ adapter, refreshSecret: "test-refresh", warmRequestDeadlineMs: 25 });
  t.after(() => server.app.close());

  const created = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"] } });
  assert.equal(created.statusCode, 201);
  const draftId = (created.json() as { id: string }).id;
  const initialGenerationId = (created.json() as { generation: { id: string } }).generation.id;
  assert.equal(server.store.active?.id, initialGenerationId);

  slow = true;
  const refresh = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "test-refresh" } });
  assert.equal(refresh.statusCode, 503);
  assert.equal((refresh.json() as { error: { code: string } }).error.code, "REQUEST_DEADLINE_EXCEEDED");

  // The client was told the refresh failed. A late completion of the ignored
  // acquisition must not install a new generation or clear user drafts.
  gate.resolve();
  await completed.promise;
  await tick();

  assert.equal(server.store.active?.id, initialGenerationId, "the store must not advance a generation the client was told failed to refresh");
  const draft = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });
  assert.equal(draft.statusCode, 200, "drafts minted before the deadline must remain servable; the store is unchanged");
});

test("a deadline-aborted refresh on a cold store is not recorded as UPSTREAM_UNAVAILABLE", async (t) => {
  const base = sanitizedAdapter();
  const gate = deferred(); // held until the 503 is in hand, then the upstream observes the abort
  const adapter: CaasAdapter = {
    ...base,
    displayAll: async (signal) => {
      await gate.promise;
      if (signal?.aborted) throw new Error("cancelled by the request deadline");
      return base.displayAll(signal);
    },
  };
  const server = await createApiServer({ adapter, initialize: false, refreshSecret: "test-refresh", warmRequestDeadlineMs: 25 });
  t.after(() => server.app.close());
  assert.equal(server.store.status, "cold");

  const refresh = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "test-refresh" } });
  assert.equal(refresh.statusCode, 503);
  assert.equal((refresh.json() as { error: { code: string } }).error.code, "REQUEST_DEADLINE_EXCEEDED");

  gate.resolve(); // the upstream now rejects because the deadline aborted it
  await tick();

  assert.notEqual(server.store.failure, "UPSTREAM_UNAVAILABLE", "a server-deadline abort is not upstream unavailability and must not be reported as such");
});
