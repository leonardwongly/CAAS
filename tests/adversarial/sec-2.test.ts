import assert from "node:assert/strict";
import test from "node:test";
import { GenerationStore } from "../../apps/api/src/index.ts";
import type { CaasAdapter } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Finding: GenerationStore.refresh() (server.ts:479-496) has no mutex or
// acquisition-order guard, so two overlapping refreshes interleave at the
// single await inside acquireSnapshot. When the earlier-started refresh (R1)
// completes last, its swap runs after the later-started refresh (R2) already
// installed a newer snapshot: R1 reads `current = this.activeSnapshot` (now
// S2), demotes S2 to previous, installs S1 (data read from upstream at an
// earlier point) as active, and its draft cleanup deletes every draft not
// bound to S1 — a draft minted against the genuinely-newest generation S2
// spuriously fails 410. Because buildSnapshot stamps retrievedAtMs at
// completion time, S1 is labeled retrieved LATER than S2 even though its data
// is older: stale data shown as fresher, inverting the design Section 0.2
// binding that a refresh "swaps atomically only after complete validation".
//
// Correct behavior: among overlapping refreshes the later-started refresh's
// snapshot must remain active (serialization or an acquisition-order guard at
// the swap), and tokens/drafts minted against the intermediate active
// generation must stay valid.

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("overlapping refreshes: the later-started refresh stays active and its draft remains valid", async () => {
  let clock = 1_700_000_000_000;
  const base = sanitizedAdapter();
  const armed = deferred(); // resolves once the first refresh is parked inside the gate
  const gate = deferred(); // held until the second refresh has fully completed
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

  const r1 = store.refresh(); // earlier-started refresh: parks at the fixes gate
  await armed.promise;
  const s2 = await store.refresh(); // later-started refresh completes fully -> active = S2
  const draftId = store.rememberDraft({ origin: "KOR1", via: ["MIDPT"], selections: [], destination: "KDS1" }, s2);
  clock += 60_000; // time passes while R1 is still in flight
  gate.resolve();
  const s1 = await r1; // earlier-started refresh completes LAST

  assert.notEqual(s1.id, s2.id, "the two refreshes built distinct generations");
  assert.equal(store.active?.id, s2.id, "the later-started refresh must remain active; an older generation must not overwrite a newer one");
  assert.ok(store.active!.retrievedAtMs <= s2.retrievedAtMs, "the active generation must not be labeled fresher than the generation whose data is actually newer");
  const draft = store.getDraft(draftId, store.requireSnapshot());
  assert.equal(draft.origin, "KOR1", "a draft minted against the intermediate active generation must stay valid");
});
