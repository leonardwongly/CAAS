import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { LIVE_UNUSABLE_MS } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Candidate finding (deferred-5): every expiry decision in apps/api/src/server.ts
// reads the live clock with no monotonicity guard:
//   - isServable (server.ts:503) and generationSummary (server.ts:409) clamp
//     elapsed time with Math.max(0, now - retrievedAtMs), so a clock regression
//     resets a generation's measured age to zero;
//   - decodeScoped (server.ts:559), cursorOffset (server.ts:992), and getDraft
//     (server.ts:534) compare token expiry e (= snapshot.unusableAtMs) against
//     live now(), so a token whose expiry has passed re-validates once the clock
//     steps back below e.
// A wall-clock regression (NTP step-back) therefore re-validates tokens the
// server had already rejected and revives a generation it had declared unusable:
// the fail-closed state silently reopens.
//
// North-star contract:
//   - Plan §6.2: "Live flight generation freshness: fresh <= 5 minutes; stale
//     warning after 5 minutes; unusable after 30 minutes" — data age does not
//     decrease when the wall clock steps back; a generation declared unusable
//     stays unusable until a fresh refresh swaps in a new one.
//   - README binding contract: "Generation-bound cursors, point references,
//     candidate IDs, and draft tokens fail closed after invalidation." A token
//     already rejected as expired must stay rejected.
//
// Correct behavior: monotonic failure. Once the server has failed closed on a
// generation (503 GENERATION_STALE) and its tokens, a clock regression must not
// make the same cursor or flight token valid again.

test("a clock regression must not revive an unusable generation or its expired tokens", async () => {
  let clock = 1_700_000_000_000;
  const server = await createApiServer({ adapter: sanitizedAdapter(), now: () => clock, refreshSecret: "offline-refresh-secret" });
  try {
    // Mint a browse cursor and a flight token at the initial instant.
    const mintedAt = clock;
    const page = await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=1" });
    assert.equal(page.statusCode, 200);
    const body = page.json() as { data: Array<{ flightId: string }>; nextCursor: string };
    assert.ok(body.nextCursor, "the browse walk must produce a cursor");
    const cursor = body.nextCursor;
    const flightId = body.data[0]!.flightId;

    // Advance past the live unusable boundary: the generation fails closed
    // (503 GENERATION_STALE) and the minted tokens are rejected.
    clock = mintedAt + LIVE_UNUSABLE_MS + 1;
    const staleReady = await server.app.inject({ method: "GET", url: "/readyz" });
    assert.equal(staleReady.statusCode, 503);
    assert.equal((staleReady.json() as { code: string }).code, "GENERATION_STALE");
    const staleCursor = await server.app.inject({ method: "GET", url: `/api/v1/routes?limit=1&cursor=${encodeURIComponent(cursor)}` });
    assert.equal(staleCursor.statusCode, 503, "the unusable generation must fail closed on every data route");
    assert.equal((staleCursor.json() as { error: { code: string } }).error.code, "GENERATION_STALE");
    const staleFlight = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId } });
    assert.equal(staleFlight.statusCode, 503, "the unusable generation must fail closed on every data route");
    assert.equal((staleFlight.json() as { error: { code: string } }).error.code, "GENERATION_STALE");

    // Regress the clock to the mint instant (NTP step-back). The generation was
    // already declared unusable and these tokens already rejected; the
    // fail-closed state must persist across the regression.
    clock = mintedAt;
    const revivedReady = await server.app.inject({ method: "GET", url: "/readyz" });
    assert.equal(revivedReady.statusCode, 503, "a clock regression must not revive an unusable generation");
    assert.equal((revivedReady.json() as { code: string }).code, "GENERATION_STALE");
    const revivedCursor = await server.app.inject({ method: "GET", url: `/api/v1/routes?limit=1&cursor=${encodeURIComponent(cursor)}` });
    assert.equal(revivedCursor.statusCode, 503, "a rejected cursor must stay rejected after a clock regression");
    assert.equal((revivedCursor.json() as { error: { code: string } }).error.code, "GENERATION_STALE");
    const revivedFlight = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId } });
    assert.equal(revivedFlight.statusCode, 503, "a rejected flight token must stay rejected after a clock regression");
    assert.equal((revivedFlight.json() as { error: { code: string } }).error.code, "GENERATION_STALE");
  } finally {
    await server.app.close();
  }
});
