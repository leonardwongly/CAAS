import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { LIVE_UNUSABLE_MS } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Regression pin (post-fix): the draft-token expiry boundary once disagreed
// with every other scoped token. getDraft checked `decoded.e <= this.now()`
// while decodeScoped, cursorOffset, and selectedLocation all use `e < now()`,
// so at now === e (where e = snapshot.unusableAtMs) flight tokens and cursors
// stayed servable but a draft from the same snapshot returned 410
// DRAFT_EXPIRED — and a draft created at that instant got 201 yet immediately
// 410s on compare. The fix aligned getDraft with the inclusive boundary so all
// generation-bound tokens behave identically at the exact unusable instant.
// This test pins that FIXED behavior; the prior boundary tests only stepped
// the clock by LIVE_UNUSABLE_MS + 1 (apps/api/test/server.test.ts) or
// asserted store-level readiness (tests/upstream-bounds/
// generation-lifecycle.test.ts), leaving the exact-instant window covered
// solely here.
//
// North-star contract: design Section 0.2 binds every cursor, point reference,
// candidate ID, and draft token to the generation; docs/architecture/
// poc-interaction-exclusions.md: "A draft id expires with the generation that
// issued it." Plan §6.2 and freshness.ts define the unusable boundary as
// inclusive: the generation is "stale" (still servable) through elapsed ===
// LIVE_UNUSABLE_MS and unusable strictly after. Generation tokens (flights,
// cursors) remain servable at the exact unusable instant. Drafts additionally
// carry their own 15-minute TTL (sec-r4 draft-slot reclamation), so a draft
// minted early in the generation expires at its TTL boundary, strictly before
// the generation — draft expiry never outlives the generation that issued it.

test("draft tokens stay servable at the exact unusable instant, like every other generation-bound token", async (t) => {
  let clock = 1_700_000_000_000;
  const server = await createApiServer({ adapter: sanitizedAdapter(), now: () => clock, refreshSecret: "offline-refresh-secret" });
  t.after(() => server.app.close());

  // Mint a flight token, a cursor, and a draft while the generation is fresh.
  const browse = await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=1" });
  assert.equal(browse.statusCode, 200);
  const browseBody = browse.json() as { data: { id: string }[]; nextCursor?: string };
  const flightId = browseBody.data[0]!.id;
  assert.ok(browseBody.nextCursor, "browse response carries a nextCursor");
  const cursor = browseBody.nextCursor!;

  const draftCreated = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KOR1", destination: "KDS1", via: [] } });
  assert.equal(draftCreated.statusCode, 201);
  const draftId = (draftCreated.json() as { id: string }).id;

  // Jump exactly to the unusable instant: the generation is stale but servable.
  clock += LIVE_UNUSABLE_MS;

  const flightAtInstant = await server.app.inject({
    method: "POST",
    url: "/api/v1/routes/compare",
    payload: { baselineId: flightId, targetDraft: { origin: "KOR1", destination: "KDS1", via: [] } },
  });
  assert.equal(flightAtInstant.statusCode, 200, "flight token remains servable at the exact unusable instant");
  assert.equal((flightAtInstant.json() as { generation: { overall: string } }).generation.overall, "stale");

  const cursorAtInstant = await server.app.inject({ method: "GET", url: `/api/v1/routes?limit=1&cursor=${encodeURIComponent(cursor)}` });
  assert.equal(cursorAtInstant.statusCode, 200, "cursor remains servable at the exact unusable instant");
  assert.equal((cursorAtInstant.json() as { generation: { overall: string } }).generation.overall, "stale");

  // Drafts carry their own 15-minute TTL (sec-r4: bounded draft slots must be
  // reclaimable), shorter than the generation: the earlier-minted draft has
  // expired at the unusable instant, while the generation's own tokens
  // remain servable. The 410 names the draft's own expiry, not the
  // generation's.
  const draftAtInstant = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });
  assert.equal(draftAtInstant.statusCode, 410, "a draft minted 30 minutes earlier has exceeded its own TTL at the unusable instant");
  assert.equal((draftAtInstant.json() as { error: { code: string } }).error.code, "DRAFT_EXPIRED");

  // A draft minted at the exact instant must be immediately servable.
  const draftAtBoundary = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KOR1", destination: "KDS1", via: [] } });
  assert.equal(draftAtBoundary.statusCode, 201, "the generation is still servable at the exact unusable instant, so a draft can be created");
  const boundaryDraftId = (draftAtBoundary.json() as { id: string }).id;
  const boundaryDraftCompare = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId: boundaryDraftId } });
  assert.equal(boundaryDraftCompare.statusCode, 200, "a draft minted at the exact unusable instant is immediately servable");

  // Strictly past the boundary every token fails closed.
  clock += 1;
  const pastBoundary = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });
  assert.equal(pastBoundary.statusCode, 503);
  assert.equal((pastBoundary.json() as { error: { code: string } }).error.code, "GENERATION_STALE");
  assert.equal((await server.app.inject({ method: "GET", url: `/api/v1/routes?limit=1&cursor=${encodeURIComponent(cursor)}` })).statusCode, 503);
});
