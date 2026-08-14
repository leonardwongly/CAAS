import assert from "node:assert/strict";
import test from "node:test";
import { resolveExactReference } from "../../packages/route-engine/src/index.ts";

// README binding contract: "Use exact reference resolution. Preserve duplicate
// matches and unresolved positions as explicit ambiguity/gaps; never infer by
// proximity." Design Section 0.3: "Ambiguity is preserved and unresolved
// positions remain explicit gaps; no proximity inference is permitted."
// Plan §6 confirms the upstream data genuinely contains duplicate-identifier
// groups (Fixes: 12,230 groups, max multiplicity 160; NAVAIDs: 1,791 groups,
// max multiplicity 32) — distinct records can share an identifier at different
// coordinates. When two distinct locations (differing coordinates and/or kind)
// share the same id and both match the reference token, the engine must
// preserve both matches as an explicit `ambiguous` result. It must never
// silently collapse them to a single `resolved` match whose identity depends on
// input order.

const alpha = { id: "JFKX", code: "JFKX", name: "Alpha Point", kind: "airport", coordinate: { lat: 10, lon: -70 }, aliases: [] } as const;
const beta = { id: "JFKX", code: "JFKX", name: "Beta Point", kind: "airport", coordinate: { lat: 40.64, lon: -73.78 }, aliases: [] } as const;

test("same-id locations with differing coordinates stay ambiguous, never resolved-last-wins", () => {
  const forward = resolveExactReference("JFKX", [alpha, beta]);
  assert.equal(forward.status, "ambiguous");
  if (forward.status === "ambiguous") {
    assert.equal(forward.matches.length, 2);
    assert.deepEqual(forward.matches.map((match) => match.coordinate), [alpha.coordinate, beta.coordinate]);
  }
  // Input order must not change the outcome.
  const reversed = resolveExactReference("JFKX", [beta, alpha]);
  assert.equal(reversed.status, "ambiguous");
  if (reversed.status === "ambiguous") {
    assert.equal(reversed.matches.length, 2);
  }
});

test("same-id locations with differing kind stay ambiguous for unknown-kind references", () => {
  const airportDup = { id: "DUP", code: "DUP", name: "Airport Dup", kind: "airport", coordinate: { lat: 1, lon: 2 }, aliases: [] } as const;
  const placeDup = { id: "DUP", code: "DUP", name: "Place Dup", kind: "place", coordinate: { lat: 3, lon: 4 }, aliases: [] } as const;
  const forward = resolveExactReference({ value: "DUP" }, [airportDup, placeDup]);
  assert.equal(forward.status, "ambiguous");
  if (forward.status === "ambiguous") {
    assert.equal(forward.matches.length, 2);
  }
  const reversed = resolveExactReference({ value: "DUP" }, [placeDup, airportDup]);
  assert.equal(reversed.status, "ambiguous");
  if (reversed.status === "ambiguous") {
    assert.equal(reversed.matches.length, 2);
  }
});
