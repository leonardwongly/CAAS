import assert from "node:assert/strict";
import test from "node:test";
import { GenerationStore } from "../../apps/api/src/index.ts";
import type { CaasAdapter } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Candidate finding (sec-r2-4): GenerationStore.initialize() (server.ts:466-480)
// has no acquisition-order guard. Its fast path (467) short-circuits only when
// a snapshot is already active AND state is "ready", so two overlapping
// acquisitions (a double initialize(), or initialize() racing refresh()) both
// pass through acquireSnapshot and the LAST to settle unconditionally overwrites
// activeSnapshot — even when it is the EARLIER-STARTED one. If the earlier
// acquisition settles last, its older data replaces the newer generation
// without rotating previousSnapshot (refresh() 505-506 does) and without
// invalidating the replaced generation's drafts. Because buildSnapshot stamps
// retrievedAtMs at completion time, the stale generation is labeled FRESHER
// than the one whose data is actually newer — the same stale-overwrite class
// that refreshSequence (495-509) fixed for refresh() and sec-2.test.ts pins for
// refresh() only.
//
// Correct behavior (plan §5.1, design Section 0.2 binding): a generation is
// swapped in only after complete validation, and among overlapping
// acquisitions the LAST-STARTED one owns the active generation. An
// earlier-started acquisition that settles late must never install its older
// snapshot over the newer one, and a draft minted against the intermediate
// active (later-started) generation must stay valid.

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("overlapping initialize(): the later-started acquisition stays active and its draft remains valid", async () => {
  let clock = 1_700_000_000_000;
  const base = sanitizedAdapter();
  const armed = deferred(); // resolves once the first initialize is parked inside the gate
  const gate = deferred(); // held until the second initialize has fully completed
  let gated = false;
  const adapter: CaasAdapter = {
    ...base,
    fixes: async (signal) => {
      if (!gated) {
        gated = true;
        armed.resolve();
        await gate.promise;
      }
      return base.fixes(signal);
    },
  };
  const store = new GenerationStore(adapter, () => clock);

  const i1 = store.initialize(); // earlier-started initialize: parks at the fixes gate
  await armed.promise;
  const s2 = await store.initialize(); // later-started initialize completes fully -> active = S2
  const draftId = store.rememberDraft({ origin: "KOR1", via: ["MIDPT"], selections: [], destination: "KDS1" }, s2);
  clock += 60_000; // time passes while the earlier initialize is still in flight
  gate.resolve();
  const s1 = await i1; // earlier-started initialize completes LAST

  assert.notEqual(s1.id, s2.id, "the two acquisitions built distinct generations");
  assert.equal(store.active?.id, s2.id, "the later-started acquisition must remain active; an earlier-started initialize must not overwrite a newer generation");
  assert.ok(store.active!.retrievedAtMs <= s2.retrievedAtMs, "the active generation must not be labeled fresher than the generation whose data is actually newer");
  const draft = store.getDraft(draftId, store.requireSnapshot());
  assert.equal(draft.origin, "KOR1", "a draft minted against the intermediate active generation must stay valid");
});
