import assert from "node:assert/strict";
import test from "node:test";
import { GenerationStore, createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Consolidates three generation-concurrency regression pins (formerly
// sec-2.test.ts, sec-r2-4.test.ts, sec-r2-5.test.ts) that all exercised the
// same deferred()-armed adapter pattern against overlapping acquisitions:
//
// - sec-2: GenerationStore.refresh() must guard acquisition order. Among
//   overlapping refreshes the LATER-STARTED refresh's snapshot must remain
//   active; an earlier-started refresh (R1) settling after a later one (R2)
//   must not install its older data as active (stale data labeled fresher via
//   retrievedAtMs stamped at completion time), and drafts minted against the
//   intermediate active generation must stay valid. Binds the design Section
//   0.2 rule that a refresh "swaps atomically only after complete validation".
// - sec-r2-4: the same stale-overwrite class for GenerationStore.initialize()
//   (double initialize(), or initialize() racing refresh()): the LAST-STARTED
//   acquisition owns the active generation (plan §5.1).
// - sec-r2-5: HTTP-level reporting. A superseded (earlier-started) refresh
//   whose acquisition settles after a later attempt must report the store's
//   ACTIVE generation — never the snapshot it built but never installed —
//   including the variant where the later-started refresh FAILED and the store
//   keeps serving the pre-refresh generation (README binding: every endpoint's
//   generation field describes the snapshot the server actually serves).

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

interface GateOptions {
  /** The 1-based fixes() call that resolves `armed`, then parks on the gate. */
  parkFixesCall?: number;
  /** The 1-based fixes() call that throws (a failed acquisition). */
  failFixesCall?: number;
  /** Park a navaids() call while the fixes() counter equals this value. */
  parkNavaidsWhenFixesAt?: number;
}

// Shared gated harness: counts fixes() calls so a chosen acquisition parks at
// a deterministic point, letting a later-started acquisition settle first.
function gatedAdapter(base: CaasAdapter, options: GateOptions): { adapter: CaasAdapter; armed: Promise<void>; release: () => void } {
  const armed = deferred(); // resolves once the parked acquisition reaches the gate
  const gate = deferred(); // held until the parked acquisition should complete
  let fixesCalls = 0;
  const adapter: CaasAdapter = {
    ...base,
    fixes: async (signal) => {
      fixesCalls += 1;
      if (options.failFixesCall === fixesCalls) throw new Error("upstream unavailable");
      if (options.parkFixesCall === fixesCalls) {
        armed.resolve();
        await gate.promise;
      }
      return base.fixes(signal);
    },
    navaids: options.parkNavaidsWhenFixesAt === undefined
      ? base.navaids
      : async (signal) => {
          if (fixesCalls === options.parkNavaidsWhenFixesAt) {
            armed.resolve();
            await gate.promise;
          }
          return base.navaids(signal);
        },
  };
  return { adapter, armed: armed.promise, release: gate.resolve };
}

// --- sec-2 / sec-r2-4: store-level acquisition-order guard -----------------

test("overlapping refreshes: the later-started refresh stays active and its draft remains valid", async () => {
  let clock = 1_700_000_000_000;
  const { adapter, armed, release } = gatedAdapter(sanitizedAdapter(), { parkFixesCall: 1 });
  const store = new GenerationStore(adapter, () => clock);

  const r1 = store.refresh(); // earlier-started refresh: parks at the fixes gate
  await armed;
  const s2 = await store.refresh(); // later-started refresh completes fully -> active = S2
  const draftId = store.rememberDraft({ origin: "KOR1", via: ["MIDPT"], selections: [], destination: "KDS1" }, s2);
  clock += 60_000; // time passes while R1 is still in flight
  release();
  const s1 = await r1; // earlier-started refresh completes LAST

  assert.notEqual(s1.id, s2.id, "the two refreshes built distinct generations");
  assert.equal(store.active?.id, s2.id, "the later-started refresh must remain active; an older generation must not overwrite a newer one");
  assert.ok(store.active!.retrievedAtMs <= s2.retrievedAtMs, "the active generation must not be labeled fresher than the generation whose data is actually newer");
  const draft = store.getDraft(draftId, store.requireSnapshot());
  assert.equal(draft.origin, "KOR1", "a draft minted against the intermediate active generation must stay valid");
});

test("overlapping initialize(): the later-started acquisition stays active and its draft remains valid", async () => {
  let clock = 1_700_000_000_000;
  const { adapter, armed, release } = gatedAdapter(sanitizedAdapter(), { parkFixesCall: 1 });
  const store = new GenerationStore(adapter, () => clock);

  const i1 = store.initialize(); // earlier-started initialize: parks at the fixes gate
  await armed;
  const s2 = await store.initialize(); // later-started initialize completes fully -> active = S2
  const draftId = store.rememberDraft({ origin: "KOR1", via: ["MIDPT"], selections: [], destination: "KDS1" }, s2);
  clock += 60_000; // time passes while the earlier initialize is still in flight
  release();
  const s1 = await i1; // earlier-started initialize completes LAST

  assert.notEqual(s1.id, s2.id, "the two acquisitions built distinct generations");
  assert.equal(store.active?.id, s2.id, "the later-started acquisition must remain active; an earlier-started initialize must not overwrite a newer generation");
  assert.ok(store.active!.retrievedAtMs <= s2.retrievedAtMs, "the active generation must not be labeled fresher than the generation whose data is actually newer");
  const draft = store.getDraft(draftId, store.requireSnapshot());
  assert.equal(draft.origin, "KOR1", "a draft minted against the intermediate active generation must stay valid");
});

// --- sec-r2-5: HTTP-level superseded-refresh reporting ----------------------

const REFRESH_HEADERS = { "x-refresh-token": "test-refresh" };

test("superseded refresh must report the active generation, not its uninstalled snapshot (later-started refresh succeeds)", async (t) => {
  // initialize() consumes fixes call 1, so R1 parks at fixes call 2.
  const { adapter, armed, release } = gatedAdapter(sanitizedAdapter(), { parkFixesCall: 2 });
  const server = await createApiServer({ adapter, refreshSecret: "test-refresh", initialize: false, refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());

  await server.store.initialize(); // active = S0
  const initialActiveId = server.store.active!.id;

  // R1: earlier-started refresh, parks at the fixes gate.
  const r1 = server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: REFRESH_HEADERS });
  await armed;

  // R2: later-started refresh completes fully; the store now serves S2.
  const r2 = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: REFRESH_HEADERS });
  assert.equal(r2.statusCode, 200);
  const r2Body = r2.json() as { status: string; generation: { id: string } };
  assert.equal(r2Body.generation.id, server.store.active!.id);
  assert.notEqual(r2Body.generation.id, initialActiveId, "R2 must install a genuinely new generation");

  release();
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
  // Park R1 (earlier-started refresh) at the LAST family so its acquisition
  // genuinely completes after R2 has already failed; the shared fixes-call
  // counter must not re-throw into R1's continuation.
  const { adapter, armed, release } = gatedAdapter(sanitizedAdapter(), { failFixesCall: 3, parkNavaidsWhenFixesAt: 2 });
  const server = await createApiServer({ adapter, refreshSecret: "test-refresh", initialize: false, refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());

  await server.store.initialize(); // active = S0
  const initialActiveId = server.store.active!.id;

  const r1 = server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: REFRESH_HEADERS });
  await armed;

  // R2: later-started refresh fails; the store keeps serving S0 unchanged.
  const r2 = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: REFRESH_HEADERS });
  assert.equal(r2.statusCode, 503);
  assert.equal((r2.json() as { error: { code: string } }).error.code, "REFRESH_FAILED");
  assert.equal(server.store.active!.id, initialActiveId, "a failed refresh must keep the prior generation active");

  release();
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
