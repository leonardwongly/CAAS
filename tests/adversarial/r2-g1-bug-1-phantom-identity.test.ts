import assert from "node:assert/strict";
import test from "node:test";
import type { Location } from "../../packages/contracts/src/index.ts";
import { createApiServer, type ApiServerOptions } from "../../apps/api/src/index.ts";
import { indexedReferenceResolution } from "../../apps/api/src/projection.ts";
import { locationTokens, token, UNAVAILABLE_AIRPORT_NAME } from "../../apps/api/src/snapshot.ts";
import { caasFixtureAdapter } from "../fixtures/caas-fixtures.ts";

// Domain tag: R2-G1 — snapshot location index (node lane), round-2 gap-fill
// 2026-08-23.
//
// Bug (R2-G1-BUG-1): every airport without a bundled ICAO name was assigned
// the display placeholder "Name unavailable" (snapshot.ts familyLocations),
// and that placeholder was then indexed as a location token verbatim. The
// token "NAME UNAVAILABLE" therefore mapped to EVERY unnamed airport, so a
// reference to any one unnamed airport by name resolved as ambiguous against
// every other unnamed airport (phantom ambiguity and phantom duplicate
// groups). The placeholder is a label, never an identity.
//
// This regression pins the fix (snapshot.ts locationTokens + projection.ts
// displayReference now share the exported UNAVAILABLE_AIRPORT_NAME constant):
//   - an unnamed airport contributes NO "Name unavailable" token,
//   - the snapshot index never contains "NAME UNAVAILABLE",
//   - resolving "Name unavailable" is a not-found gap, never ambiguous,
//   - an unnamed airport stays reachable through its id and ICAO code, and
//   - a genuinely named airport still contributes its name token (no
//     over-correction that would drop real names).
//
// Does not duplicate finding-1.test.ts / projection-regression.test.ts, which
// pin the DISPLAY label "Name unavailable (CODE)" (still emitted) — this file
// pins the SEARCH INDEX, the surface that was actually corrupt.

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;

function unnamedAirport(id: string, code: string): Location {
  return {
    id,
    name: UNAVAILABLE_AIRPORT_NAME,
    code,
    kind: "airport",
    coordinate: { lat: 1, lon: 1 },
    aliases: [],
  };
}

test("an unnamed airport contributes no 'Name unavailable' search token", () => {
  const tokens = locationTokens(unnamedAirport("AIR-0", "ZZZZ"));
  assert.ok(!tokens.includes(token(UNAVAILABLE_AIRPORT_NAME)), "the placeholder name must never be a searchable token");
  assert.ok(!tokens.includes("NAME UNAVAILABLE"), "the uppercase token must never appear");
  assert.ok(tokens.includes("AIR-0"), "the location id stays searchable");
  assert.ok(tokens.includes("ZZZZ"), "the ICAO code stays searchable");
});

test("a genuinely named airport still contributes its name token", () => {
  const named: Location = { ...unnamedAirport("AIR-1", "WSSS"), name: "Singapore Changi" };
  assert.ok(locationTokens(named).includes("SINGAPORE CHANGI"), "real names must remain indexed");
});

test("the snapshot index never contains the phantom placeholder token", async (t) => {
  const server = await createApiServer({ adapter: caasFixtureAdapter(), refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());
  const snapshot = server.store.requireSnapshot();

  assert.ok(!snapshot.locationTokens.has(token(UNAVAILABLE_AIRPORT_NAME)), "NAME UNAVAILABLE must be absent from the snapshot index");
  assert.ok(!snapshot.locationTokens.has("NAME UNAVAILABLE"), "the uppercase form must be absent too");
});

test("resolving 'Name unavailable' is a not-found gap, never phantom ambiguity", async (t) => {
  const server = await createApiServer({ adapter: caasFixtureAdapter(), refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());
  const snapshot = server.store.requireSnapshot();

  const result = indexedReferenceResolution(snapshot, UNAVAILABLE_AIRPORT_NAME, "airport");
  assert.equal(result.status, "gap", "the placeholder must resolve as a gap");
  assert.equal(result.reason, "not-found", "and specifically as not-found, not ambiguous");
});

test("unnamed airports remain individually reachable by code, without cross-resolving", async (t) => {
  const server = await createApiServer({ adapter: caasFixtureAdapter(), refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());
  const snapshot = server.store.requireSnapshot();

  // The CAAS fixture's airports use single-letter identifiers (A–E),
  // which are not valid ICAO codes and therefore have no bundled name. Each
  // must still resolve to exactly one location by its code, and two distinct
  // unnamed airports must never be joined through the phantom placeholder.
  const a = indexedReferenceResolution(snapshot, "A", "airport");
  const b = indexedReferenceResolution(snapshot, "B", "airport");
  assert.equal(a.status, "resolved", "airport A resolves by code");
  assert.equal(b.status, "resolved", "airport B resolves by code");
  if (a.status === "resolved" && b.status === "resolved") {
    assert.notEqual(a.match.id, b.match.id, "distinct unnamed airports must not collapse to one identity");
  }
});
