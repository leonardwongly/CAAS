import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { LIVE_UNUSABLE_MS } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Candidate finding: apps/api/src/server.ts getDraft (line 538) checks the token
// expiry with `decoded.e <= this.now()` while decodeScoped (line 563),
// cursorOffset (line 1001), and selectedLocation (line 619) all use `e < now()`.
// Every scoped token carries e = snapshot.unusableAtMs (scopedToken, line 241),
// so at now === e the generation is still servable ("stale", inclusive boundary
// per packages/upstream-caas/src/freshness.ts: "unusable strictly after it") and
// flight tokens and cursors return 200 — but a draft from the same snapshot
// returns 410 DRAFT_EXPIRED at that exact instant. A draft CREATED at that
// instant gets 201 yet immediately 410s on compare. All existing boundary tests
// step the clock by LIVE_UNUSABLE_MS + 1 (apps/api/test/server.test.ts:346,380)
// or assert store-level readiness only (tests/upstream-bounds/
// generation-lifecycle.test.ts:44-45), so the 1 ms window is untested.
//
// North-star contract: design Section 0.2 binds every cursor, point reference,
// candidate ID, and draft token to the generation; docs/architecture/
// poc-interaction-exclusions.md: "A draft id expires with the generation that
// issued it." Plan §6.2 and freshness.ts define the unusable boundary as
// inclusive: the generation is "stale" (still servable) through elapsed ===
// LIVE_UNUSABLE_MS and unusable strictly after. Draft tokens must therefore
// remain servable at the exact unusable instant, exactly like every other
// generation-bound token.

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

  const draftAtInstant = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });
  assert.equal(draftAtInstant.statusCode, 200, "a draft minted earlier remains servable at the exact unusable instant");
  assert.equal((draftAtInstant.json() as { generation: { overall: string } }).generation.overall, "stale");

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
