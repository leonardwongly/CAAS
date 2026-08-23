// Adversarial sweep D2 — geometry & resolution core (owner: D2 sub-agent).
// Scope: resolveExactReference / resolveRouteQuery in
// packages/route-engine/src/index.ts — dedupe-key semantics, kind filtering,
// token normalization, hostile location corpora, and query-status composition.
// Non-duplication: route-engine.test.ts pins resolved/missing/ambiguous for
// distinct ids sharing a name and single-endpoint gaps; A3 pins safe-parse
// issue shapes. The dedupe-key structure itself, kind filtering, whitespace
// references, polluted inputs, and the query-present-only-when-resolved
// contract are new coverage.
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveExactReference,
  resolveRouteQuery,
} from "../../packages/route-engine/src/index.ts";

function location(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "KAAA",
    name: "Alpha Field",
    kind: "airport",
    coordinate: { lat: 10, lon: 20 },
    aliases: [],
    ...overrides,
  };
}

test("whitespace-only and empty references are invalid-reference gaps, not not-found", () => {
  for (const value of ["", " ", "\t\n", "  x  ".slice(0, 0)]) {
    const result = resolveExactReference(value, [location({})]);
    assert.equal(result.status, "gap");
    if (result.status === "gap") {
      assert.equal(result.reason, "invalid-reference");
      assert.equal(result.reference, null);
    }
  }
  // Non-string, non-object references fail the same way.
  for (const value of [null, 5, true, [], { nope: 1 }]) {
    const result = resolveExactReference(value, [location({})]);
    assert.equal(result.status, "gap");
    if (result.status === "gap") assert.equal(result.reason, "invalid-reference");
  }
});

test("kind filtering: an explicit kind never matches a different location kind, unknown matches all", () => {
  const city = location({ id: "SPRINGFIELD", name: "Springfield", kind: "city" });
  const airport = location({ id: "SPRINGFIELD", name: "Springfield Municipal", kind: "airport", coordinate: { lat: 11, lon: 21 } });
  const corpus = [city, airport];
  const airportOnly = resolveExactReference({ value: "SPRINGFIELD", kind: "airport" }, corpus);
  assert.equal(airportOnly.status, "resolved");
  if (airportOnly.status === "resolved") assert.equal(airportOnly.match.kind, "airport");
  const station = resolveExactReference({ value: "SPRINGFIELD", kind: "station" }, corpus);
  assert.equal(station.status, "gap");
  if (station.status === "gap") assert.equal(station.reason, "not-found");
  // Unknown kind sees both kinds and must report the identifier collision.
  const unknownKind = resolveExactReference("SPRINGFIELD", corpus);
  assert.equal(unknownKind.status, "ambiguous");
  if (unknownKind.status === "ambiguous") assert.equal(unknownKind.matches.length, 2);
});

test("reference tokens are trimmed and case-folded before matching", () => {
  const corpus = [location({ id: "KJFK", code: "JFK", name: "John F Kennedy Intl" })];
  for (const value of [" kjfk ", "JfK", "jfk"]) {
    const result = resolveExactReference(value, corpus);
    assert.equal(result.status, "resolved", `expected "${value}" to resolve`);
  }
  // A match through code and alias resolves the same single location.
  assert.equal(resolveExactReference("jfk", corpus).status, "resolved");
  const aliased = [location({ id: "KXYZ", name: "Zulu", aliases: ["zeta gate", "ZULU"] })];
  const viaAlias = resolveExactReference(" Zeta Gate ", aliased);
  assert.equal(viaAlias.status, "resolved");
  if (viaAlias.status === "resolved") assert.equal(viaAlias.match.id, "KXYZ");
});

test("dedupe key is id|kind|coordinate: text differences dedupe, geometric or kind differences stay ambiguous", () => {
  // Same id, kind, coordinate but different name/aliases: one physical place
  // described twice — must resolve, never surface as ambiguity.
  const textTwins = [
    location({ id: "DUP", name: "First Rendering" }),
    location({ id: "DUP", name: "Second Rendering", aliases: ["Other"] }),
  ];
  assert.equal(resolveExactReference("DUP", textTwins).status, "resolved");
  // Same id and coordinate but different kind: different typed references —
  // the kind participates in the dedupe key, so this is ambiguity.
  const kindTwins = [
    location({ id: "DUP", kind: "airport" }),
    location({ id: "DUP", kind: "place" }),
  ];
  assert.equal(resolveExactReference("DUP", kindTwins).status, "ambiguous");
  // Same id and kind at different coordinates: a genuine identifier collision.
  const geometricTwins = [
    location({ id: "DUP", coordinate: { lat: 10, lon: 20 } }),
    location({ id: "DUP", coordinate: { lat: 10, lon: 20.0000001 } }),
  ];
  assert.equal(resolveExactReference("DUP", geometricTwins).status, "ambiguous");
  // -0 and +0 are the same point: coordinate twins with signed zeros dedupe.
  const signedZeroTwins = [
    location({ id: "DUP", coordinate: { lat: -0, lon: -0 } }),
    location({ id: "DUP", coordinate: { lat: 0, lon: 0 } }),
  ];
  assert.equal(resolveExactReference("DUP", signedZeroTwins).status, "resolved");
});

test("resolution is order-independent across ambiguous and resolved corpora", () => {
  const a = location({ id: "TWIN", coordinate: { lat: 1, lon: 1 } });
  const b = location({ id: "TWIN", coordinate: { lat: 2, lon: 2 } });
  const forward = resolveExactReference("TWIN", [a, b]);
  const backward = resolveExactReference("TWIN", [b, a]);
  assert.equal(forward.status, "ambiguous");
  assert.equal(backward.status, "ambiguous");
  if (forward.status === "ambiguous" && backward.status === "ambiguous") {
    const key = (match: { id: string; kind: string; coordinate: { lat: number; lon: number } }) =>
      `${match.id}|${match.kind}|${match.coordinate.lat}|${match.coordinate.lon}`;
    assert.deepEqual(forward.matches.map(key).sort(), backward.matches.map(key).sort());
  }
  // A resolved corpus resolves identically under permutation.
  const unique = location({ id: "SOLE" });
  assert.deepEqual(
    resolveExactReference("SOLE", [unique, location({ id: "OTHER", name: "Beta" })]),
    resolveExactReference("SOLE", [location({ id: "OTHER", name: "Beta" }), unique]),
  );
});

test("hostile corpora: junk entries are filtered silently, pollution attempts never propagate", () => {
  const real = location({ id: "KEEP" });
  const junk: unknown[] = [null, undefined, 5, "KEEP", [], { id: "KEEP" }, { __proto__: null }];
  const result = resolveExactReference("KEEP", [...junk, real, ...junk]);
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.equal(result.match.id, "KEEP");
  // A prototype-pollution payload riding the reference object must never
  // reach Object.prototype, and resolution still succeeds on the clean keys.
  const polluted = JSON.parse('{"value":"KEEP","__proto__":{"polluted":true}}');
  const attempt = resolveExactReference(polluted, [real]);
  assert.equal(attempt.status, "resolved");
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  assert.equal((polluted as { polluted?: unknown }).polluted, undefined, "the payload must not re-home onto the input either");
  // A location entry smuggling a __proto__ payload matches on its clean keys
  // without leaking the payload onto the parsed output or any fresh object.
  const sneaky = JSON.parse('{"id":"KEEP","name":"Alpha Field","kind":"airport","coordinate":{"lat":10,"lon":20},"aliases":[],"__proto__":{"admin":true}}');
  const withSneaky = resolveExactReference("KEEP", [sneaky]);
  assert.equal(withSneaky.status, "resolved");
  assert.equal(({} as { admin?: unknown }).admin, undefined);
  if (withSneaky.status === "resolved") {
    assert.equal((withSneaky.match as unknown as { admin?: unknown }).admin, undefined);
  }
});

test("resolveRouteQuery attaches the query only when fully resolved and composes ambiguity above gaps", () => {
  const corpus = [
    location({ id: "AAA" }),
    location({ id: "BBB" }),
    location({ id: "BBB", coordinate: { lat: 1, lon: 2 } }),
  ];
  const resolved = resolveRouteQuery({ origin: { value: "AAA" }, destination: { value: "AAA" } }, corpus);
  assert.equal(resolved.status, "resolved");
  assert.ok(resolved.query, "a fully resolved query must carry the parsed query");
  assert.equal(resolved.query?.maxLegs, 255, "maxLegs defaults to the maximum leg count");
  // Ambiguous destination outranks a plain gap on the origin.
  const ambiguous = resolveRouteQuery({ origin: { value: "MISSING" }, destination: { value: "BBB" } }, corpus);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.query, undefined, "non-resolved outcomes must never carry a query");
  // Two gaps compose to a gap with both endpoints explicit.
  const gapped = resolveRouteQuery({ origin: { value: "NOPE" }, destination: { value: "NADA" } }, corpus);
  assert.equal(gapped.status, "gap");
  assert.equal(gapped.origin.status, "gap");
  assert.equal(gapped.destination.status, "gap");
  // A malformed query shape fails closed on both endpoints at once.
  const malformed = resolveRouteQuery({ origin: "" }, corpus);
  assert.equal(malformed.status, "gap");
  if (malformed.origin.status === "gap") assert.equal(malformed.origin.reason, "invalid-reference");
  if (malformed.destination.status === "gap") assert.equal(malformed.destination.reason, "invalid-reference");
});
