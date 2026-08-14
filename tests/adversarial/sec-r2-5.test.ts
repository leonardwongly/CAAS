import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Finding: GenerationStore.refresh() (server.ts:490-523) lets a superseded
// (earlier-started) refresh R1 settle after a later-started refresh R2 and
// return R1's own snapshot without installing it (server.ts:499-503). The
// /api/v1/refresh handler (server.ts:1434-1447) then answers HTTP 200
// {status:"refreshed", generation: summary(R1)} — a generation the store
// never serves. The store serves R2 (or, when R2 failed, the pre-refresh
// generation unchanged). The client (App.tsx:283-286) records that reported
// generation and announces "Live data refreshed. New generation retrieved at
// <R1's time>" while the served data is a different generation — in the
// R2-failed case the client is told the refresh succeeded although nothing
// changed.
//
// Correct behavior per the binding contract (README: "Refresh builds
// separately and swaps atomically only after complete validation"; design
// Section 0.2): every endpoint's generation field describes the snapshot the
// server actually serves. A superseded refresh must therefore report the
// store's ACTIVE generation (or a non-success status) — never a snapshot
// that was built but never installed.

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const REFRESH_HEADERS = { "x-refresh-token": "test-refresh" };

test("superseded refresh must report the active generation, not its uninstalled snapshot (later-started refresh succeeds)", async (t) => {
  const base = sanitizedAdapter();
  const armed = deferred(); // resolves once R1 is parked inside the fixes gate
  const gate = deferred(); // held until R2 has fully completed
  let fixesCalls = 0;
  const adapter: CaasAdapter = {
    ...base,
    fixes: async (signal) => {
      fixesCalls += 1;
      if (fixesCalls === 2) {
        // R1 (earlier-started refresh) parks here; R2 (later-started) passes.
        armed.resolve();
        await gate.promise;
      }
      return base.fixes(signal);
    },
  };
  const server = await createApiServer({ adapter, refreshSecret: "test-refresh", initialize: false, refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());

  await server.store.initialize(); // active = S0
  const initialActiveId = server.store.active!.id;

  // R1: earlier-started refresh, parks at the fixes gate.
  const r1 = server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: REFRESH_HEADERS });
  await armed.promise;

  // R2: later-started refresh completes fully; the store now serves S2.
  const r2 = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: REFRESH_HEADERS });
  assert.equal(r2.statusCode, 200);
  const r2Body = r2.json() as { status: string; generation: { id: string } };
  assert.equal(r2Body.generation.id, server.store.active!.id);
  assert.notEqual(r2Body.generation.id, initialActiveId, "R2 must install a genuinely new generation");

  gate.resolve();
  const r1Response = await r1;

  assert.equal(r1Response.statusCode, 200);
  const r1Body = r1Response.json() as { status: string; generation: { id: string } };
  assert.equal(r1Body.status, "refreshed");
  assert.equal(
    r1Body.generation.id,
    server.store.active!.id,
    "a superseded refresh must report the store's active generation, never its own snapshot that was never installed",
  );
  assert.equal(server.store.active!.id, r2Body.generation.id, "the active generation must stay R2's");
});

test("superseded refresh must report the active generation when the later-started refresh failed", async (t) => {
  const base = sanitizedAdapter();
  const armed = deferred();
  const gate = deferred();
  let fixesCalls = 0;
  const adapter: CaasAdapter = {
    ...base,
    fixes: async (signal) => {
      fixesCalls += 1;
      if (fixesCalls === 3) throw new Error("upstream unavailable"); // R2 fails
      return base.fixes(signal);
    },
    // Park R1 (earlier-started refresh) at the LAST family so its acquisition
    // genuinely completes after R2 has already failed; the shared fixes-call
    // counter must not re-throw into R1's continuation.
    navaids: async (signal) => {
      if (fixesCalls === 2) {
        armed.resolve();
        await gate.promise;
      }
      return base.navaids(signal);
    },
  };
  const server = await createApiServer({ adapter, refreshSecret: "test-refresh", initialize: false, refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());

  await server.store.initialize(); // active = S0
  const initialActiveId = server.store.active!.id;

  const r1 = server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: REFRESH_HEADERS });
  await armed.promise;

  // R2: later-started refresh fails; the store keeps serving S0 unchanged.
  const r2 = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: REFRESH_HEADERS });
  assert.equal(r2.statusCode, 503);
  assert.equal((r2.json() as { error: { code: string } }).error.code, "REFRESH_FAILED");
  assert.equal(server.store.active!.id, initialActiveId, "a failed refresh must keep the prior generation active");

  gate.resolve();
  const r1Response = await r1;

  assert.equal(r1Response.statusCode, 200);
  const r1Body = r1Response.json() as { status: string; generation: { id: string } };
  assert.equal(
    r1Body.generation.id,
    server.store.active!.id,
    "when the later-started refresh failed, the superseded request must report the retained active generation — it must not claim a new generation was installed",
  );
  assert.equal(r1Body.generation.id, initialActiveId, "the served generation is unchanged after the failed refresh");
});
