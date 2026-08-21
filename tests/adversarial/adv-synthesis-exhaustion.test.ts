// Adversarial sweep A2 — route-engine synthesis resource exhaustion & hostile topology.
//
// Scope: packages/route-engine/src/synthesis.ts (index build, donor slice lookup,
// candidate assembly) under scale, pathological topologies, duplicate floods, and
// self-donation. Complements (never duplicates) tests/synthesis/engine.test.ts
// (small-fixture semantics) and tests/adversarial/sec-r5-synthesis.test.ts (API/auth).

import assert from "node:assert/strict";
import test from "node:test";
import { MAX_DONOR_PROVENANCE, MAX_ROUTE_POINTS, MAX_SYNTHESIS_CANDIDATES } from "../../packages/contracts/src/index.ts";
import {
  assembleSynthesisCandidates,
  buildSynthesisIndex,
  findDonorSlices,
  type ObservedRoute,
} from "../../packages/route-engine/src/synthesis.ts";

const pt = (ordinal: number, referenceId: string, lat: number, lon: number) =>
  ({ ordinal, referenceId, coordinate: { lat, lon }, label: referenceId });
const coordPt = (ordinal: number, lat: number, lon: number, label: string) =>
  ({ ordinal, referenceId: undefined, coordinate: { lat, lon }, label });
const gap = (ordinal: number) => ({ ordinal, gapReason: "not-found" });
const route = (flightKey: string, occurrences: ObservedRoute["occurrences"]): ObservedRoute => ({ flightKey, occurrences });

const D = { lat: 10, lon: 20 };
const E = { lat: 10, lon: 40 };

// Generous ceilings: each phase is milliseconds in practice; the ceilings only
// catch combinatorial blow-ups while tolerating slow CI machines.
const BUILD_CEILING_MS = 3_000;
const ASSEMBLE_CEILING_MS = 2_000;

test("A2-scale: index over ~2000 donor routes sharing anchors stays bounded and fast", () => {
  // 2000 donors all routing through the shared D/E anchors, plus one
  // conflicted reference pair to prove conflict detection survives scale.
  const donors: ObservedRoute[] = Array.from({ length: 2000 }, (_, index) =>
    route(`bulk-${index}`, index < 2
      ? [pt(0, "SHARED", 10 + index, 5), pt(1, "D", D.lat, D.lon), pt(2, "E", E.lat, E.lon)]
      : [pt(0, "D", D.lat, D.lon), coordPt(1, 20 + index * 0.001, 30, `W${index}`), pt(2, "E", E.lat, E.lon)]));
  const target = route("bulk-target", [pt(0, "C", 10, 10), pt(1, "D", D.lat, D.lon), gap(2), pt(3, "E", E.lat, E.lon)]);

  const started = Date.now();
  const index = buildSynthesisIndex([...donors, target]);
  const buildMs = Date.now() - started;
  assert.ok(buildMs < BUILD_CEILING_MS, `index build over 2000 routes must stay linear-time, took ${buildMs}ms`);

  assert.equal(index.routes.length, 2001);
  assert.equal(index.components.length, 2001, "every donor chain is one component; nothing is merged across routes");
  assert.equal(index.pointsByKey.get("ref:D")?.length, 2001, "the shared anchor must index every occurrence, bounded to one entry per point");
  assert.ok(index.conflictedReferenceIds.has("SHARED"), "a reference seen at two coordinates is conflicted at scale");
  assert.equal(index.pointsByKey.has("ref:SHARED"), false, "conflicted references are never indexed for joining");

  // Assembly over the hostile index fails closed at the candidate cap quickly.
  const assembledAt = Date.now();
  const outcome = assembleSynthesisCandidates(index, target);
  const assembleMs = Date.now() - assembledAt;
  assert.ok(assembleMs < ASSEMBLE_CEILING_MS, `assembly over 2000-route index must stay bounded, took ${assembleMs}ms`);
  assert.equal(outcome.status, "candidate-limit-exceeded");
  assert.equal(outcome.candidates.length, 0, "an over-cap corridor fails closed with zero candidates");
});

test("A2-cap: one gap with 100+ donor slices hits the sentinel cap without blow-up", () => {
  const donors = Array.from({ length: 150 }, (_, index) =>
    route(`cap-${index}`, [pt(0, "D", D.lat, D.lon), coordPt(1, 20 + index * 0.001, 30, `Z${index}`), pt(2, "E", E.lat, E.lon)]));
  const target = route("cap-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon)]);
  const index = buildSynthesisIndex([...donors, target]);

  const started = Date.now();
  const slices = findDonorSlices(index, target.occurrences[0]!, target.occurrences[2]!, target.flightKey);
  const lookupMs = Date.now() - started;
  assert.ok(lookupMs < ASSEMBLE_CEILING_MS, `slice lookup across 150 donors must terminate fast, took ${lookupMs}ms`);
  assert.equal(slices.length, MAX_SYNTHESIS_CANDIDATES + 1, "lookup returns the over-limit sentinel and stops scanning — never the full 150");
  assert.ok(slices.every((slice) => slice.pointCount >= 2 && slice.pointCount <= MAX_ROUTE_POINTS));

  const assembledAt = Date.now();
  const outcome = assembleSynthesisCandidates(index, target);
  assert.ok(Date.now() - assembledAt < ASSEMBLE_CEILING_MS, "assembly must fail closed without deduplicating an over-cap slice set");
  assert.equal(outcome.status, "candidate-limit-exceeded");
  assert.equal(outcome.candidates.length, 0);
});

test("A2-corridors: 10-corridor Cartesian products terminate via candidate cap and visit budget", () => {
  // 11 shared anchors => 10 bounded corridors on the target.
  const anchor = (index: number) => ({ lat: 0, lon: index });
  const targetOccurrences: Array<ObservedRoute["occurrences"][number]> = [];
  for (let corridor = 0; corridor <= 10; corridor += 1) {
    if (corridor > 0) targetOccurrences.push(gap(2 * corridor - 1));
    targetOccurrences.push(pt(2 * corridor, `A${corridor}`, anchor(corridor).lat, anchor(corridor).lon));
  }
  const target = route("corridor-target", targetOccurrences);

  // Phase 1 — 3 small distinct geometries per corridor (3^10 ≈ 59k potential
  // combinations): assembly must stop as soon as candidates exceed the cap.
  const smallDonors: ObservedRoute[] = [];
  for (let corridor = 0; corridor < 10; corridor += 1) {
    for (let variant = 0; variant < 3; variant += 1) {
      smallDonors.push(route(`small-${corridor}-${variant}`, [
        pt(0, `A${corridor}`, anchor(corridor).lat, anchor(corridor).lon),
        coordPt(1, 10 + variant, corridor, `S${corridor}-${variant}`),
        pt(2, `A${corridor + 1}`, anchor(corridor + 1).lat, anchor(corridor + 1).lon),
      ]));
    }
  }
  const started = Date.now();
  const productOutcome = assembleSynthesisCandidates(buildSynthesisIndex([...smallDonors, target]), target);
  const productMs = Date.now() - started;
  assert.ok(productMs < ASSEMBLE_CEILING_MS, `a 3^10 product must terminate early, took ${productMs}ms`);
  assert.equal(productOutcome.status, "candidate-limit-exceeded");
  assert.equal(productOutcome.candidates.length, 0);
  assert.equal(productOutcome.corridorCount, 10);

  // Phase 2 — every combination over the point cap: rejected leaves still
  // consume the visit budget, so traversal terminates at the budget, not at
  // exponential completion (2^10 leaves > 20*20 budget).
  const hugeDonors: ObservedRoute[] = [];
  for (let corridor = 0; corridor < 10; corridor += 1) {
    for (let variant = 0; variant < 2; variant += 1) {
      const interior = Array.from({ length: MAX_ROUTE_POINTS - 2 }, (_, index) =>
        coordPt(index + 1, 30 + variant + index * 0.0001, corridor, `H${corridor}-${variant}-${index}`));
      hugeDonors.push(route(`huge-${corridor}-${variant}`, [
        pt(0, `A${corridor}`, anchor(corridor).lat, anchor(corridor).lon),
        ...interior,
        pt(MAX_ROUTE_POINTS - 1, `A${corridor + 1}`, anchor(corridor + 1).lat, anchor(corridor + 1).lon),
      ]));
    }
  }
  const budgetStarted = Date.now();
  const budgetOutcome = assembleSynthesisCandidates(buildSynthesisIndex([...hugeDonors, target]), target);
  const budgetMs = Date.now() - budgetStarted;
  assert.ok(budgetMs < ASSEMBLE_CEILING_MS, `the visit budget must bound rejected-leaf traversal, took ${budgetMs}ms`);
  assert.equal(budgetOutcome.status, "candidate-limit-exceeded");
  assert.equal(budgetOutcome.candidates.length, 0, "over-limit combinations are rejected, never truncated into candidates");
});

test("A2-duplicates: identical donor floods dedup stably with bounded provenance", () => {
  const target = route("dup-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon)]);
  const identical = (count: number) => Array.from({ length: count }, (_, index) =>
    route(`dup-${index}`, [pt(0, "D", D.lat, D.lon), coordPt(1, 20, 30, "X"), pt(2, "E", E.lat, E.lon)]));

  // Exactly the cap of identical slices: one deduplicated geometry, full
  // segment donor count, provenance arrays truncated to MAX_DONOR_PROVENANCE.
  const atCap = assembleSynthesisCandidates(buildSynthesisIndex([...identical(MAX_SYNTHESIS_CANDIDATES), target]), target);
  assert.equal(atCap.status, "full", "one shared geometry across cap-many donors is unambiguous");
  assert.equal(atCap.candidates.length, 1, "identical geometries must dedup to exactly one candidate");
  const candidate = atCap.candidates[0]!;
  assert.equal(candidate.donorTruncated, true);
  const segment = candidate.borrowedSegments[0]!;
  assert.equal(segment.donorCount, MAX_SYNTHESIS_CANDIDATES, "segment donorCount reports the true aggregate, not the truncated list");
  assert.equal(segment.donorFlightKeys.length, MAX_DONOR_PROVENANCE, "provenance keys are capped");
  assert.equal(segment.donorOrdinals.length, MAX_DONOR_PROVENANCE, "provenance ordinals are capped");
  assert.deepEqual(segment.donorFlightKeys, Array.from({ length: MAX_DONOR_PROVENANCE }, (_, index) => `dup-${index}`), "generation order is preserved");

  // Re-running on a rebuilt index is byte-identical: dedup is stable.
  const rebuilt = assembleSynthesisCandidates(buildSynthesisIndex([...identical(MAX_SYNTHESIS_CANDIDATES), target]), target);
  assert.deepEqual(JSON.stringify(rebuilt.candidates), JSON.stringify(atCap.candidates));

  // One donor beyond the cap: dedup must not rescue an over-limit slice set.
  const overCap = assembleSynthesisCandidates(buildSynthesisIndex([...identical(MAX_SYNTHESIS_CANDIDATES + 1), target]), target);
  assert.equal(overCap.status, "candidate-limit-exceeded");
  assert.equal(overCap.candidates.length, 0);
});

// Regression: candidate-level donor aggregates must come from the UNCAPPED
// per-corridor donor unions. Previously combine() flatMapped the already-capped
// segment.donorFlightKeys (MAX_DONOR_PROVENANCE), so with 20 identical donors
// the candidate reported donorCount 8 while the segment honestly reported 20.
// (Found by adversarial sweep A2.)
test("A2-duplicates: candidate-level donorCount must carry the true aggregate", () => {
  const target = route("dup-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon)]);
  const identical = Array.from({ length: MAX_SYNTHESIS_CANDIDATES }, (_, index) =>
    route(`dup-${index}`, [pt(0, "D", D.lat, D.lon), coordPt(1, 20, 30, "X"), pt(2, "E", E.lat, E.lon)]));
  const candidate = assembleSynthesisCandidates(buildSynthesisIndex([...identical, target]), target).candidates[0]!;
  assert.equal(candidate.donorCount, MAX_SYNTHESIS_CANDIDATES, "candidate-level donorCount must report the true aggregate, not the capped provenance size");
  assert.equal(candidate.donorFlightKeys.length, candidate.donorCount, "the candidate key list must be consistent with its own donorCount");
});

test("A2-self-donor: the target never donates to itself, even when its own chain covers its gap", () => {
  // target = D [gap] E D E: its trailing E->D->E component contains a forward
  // D->E chain, so the target WOULD donate to its own corridor without exclusion.
  const target = route("self-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon), pt(3, "D", D.lat, D.lon), pt(4, "E", E.lat, E.lon)]);
  const donors = Array.from({ length: 3 }, (_, index) =>
    route(`self-donor-${index}`, [pt(0, "D", D.lat, D.lon), coordPt(1, 20 + index, 30, `V${index}`), pt(2, "E", E.lat, E.lon)]));
  const filler = Array.from({ length: 500 }, (_, index) =>
    route(`filler-${index}`, [pt(0, `F${index}`, index * 0.01, index * 0.01), pt(1, `G${index}`, index * 0.01 + 0.005, index * 0.01)]));
  const index = buildSynthesisIndex([...filler, ...donors, target]);

  // Capability proof: without exclusion the target's own chain is joinable.
  const unexcluded = findDonorSlices(index, target.occurrences[0]!, target.occurrences[2]!, "nobody");
  assert.ok(unexcluded.some((slice) => slice.donorFlightKey === "self-target"), "the fixture must prove the target could otherwise self-donate");

  // With exclusion at scale: the target's key never surfaces.
  const excluded = findDonorSlices(index, target.occurrences[0]!, target.occurrences[2]!, "self-target");
  assert.ok(excluded.every((slice) => slice.donorFlightKey !== "self-target"), "self-donation must be excluded across a 500-route index");
  assert.equal(excluded.length, 3);

  const outcome = assembleSynthesisCandidates(index, target);
  assert.equal(outcome.candidates.length, 3);
  for (const candidate of outcome.candidates) {
    assert.equal(candidate.donorFlightKeys.includes("self-target"), false, "no candidate may list the target as a donor");
    for (const segment of candidate.borrowedSegments) {
      assert.equal(segment.donorFlightKeys.includes("self-target"), false, "no segment provenance may list the target as a donor");
      assert.ok(segment.donorOrdinals.every((entry) => entry.flightKey !== "self-target"));
    }
  }
});

test("A2-anchors: slices end exactly at matched anchors, touch component edges, and are clamped by the point window", () => {
  // Donor continues past E: the slice must stop at E, never extend beyond.
  const extended = route("ext", [pt(0, "D", D.lat, D.lon), coordPt(1, 20, 30, "X"), pt(2, "E", E.lat, E.lon), coordPt(3, 15, 50, "Z"), coordPt(4, 12, 60, "W")]);
  // Donor whose E is the final point of the component: boundary touch works.
  const edgeTouching = route("edge", [pt(0, "D", D.lat, D.lon), coordPt(1, 25, 30, "Y"), pt(2, "E", E.lat, E.lon)]);
  // Donor with E only beyond the MAX_ROUTE_POINTS scan window: no slice.
  const tooFarInterior = Array.from({ length: MAX_ROUTE_POINTS }, (_, index) => coordPt(index + 1, 20 + index * 0.0001, 30, `T${index}`));
  const tooFar = route("too-far", [pt(0, "D", D.lat, D.lon), ...tooFarInterior, pt(MAX_ROUTE_POINTS + 1, "E", E.lat, E.lon)]);
  // Donor with E twice: every slice still terminates exactly on an E anchor.
  const doubleE = route("double-e", [pt(0, "D", D.lat, D.lon), coordPt(1, 21, 30, "P"), pt(2, "E", E.lat, E.lon), coordPt(3, 22, 35, "Q"), pt(4, "E", E.lat, E.lon)]);
  const target = route("anchor-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon)]);
  const index = buildSynthesisIndex([extended, edgeTouching, tooFar, doubleE, target]);

  const slices = findDonorSlices(index, target.occurrences[0]!, target.occurrences[2]!, target.flightKey);
  const byDonor = new Map(slices.map((slice) => [`${slice.donorFlightKey}:${slice.toPosition}`, slice]));
  assert.equal(slices.length, 4, "extended(1) + edge(1) + double-e(2); too-far yields none");

  const extSlice = byDonor.get("ext:2")!;
  assert.ok(extSlice, "the extended donor yields exactly the D->X->E slice");
  assert.equal(extSlice.pointCount, 3, "the slice is clamped at the matched anchor, never extended to Z/W");

  const edgeSlice = byDonor.get("edge:2")!;
  assert.ok(edgeSlice, "a slice ending at the component's last point is valid");
  assert.equal(edgeSlice.toPosition, 2);

  assert.equal(byDonor.get("too-far:256"), undefined, "a match beyond start+MAX_ROUTE_POINTS-1 is never returned");
  assert.ok(slices.every((slice) => slice.donorFlightKey !== "too-far"));

  const secondE = byDonor.get("double-e:4")!;
  assert.ok(secondE, "a repeated anchor yields a second slice ending at the later anchor");
  assert.equal(secondE.pointCount, 5, "the longer slice spans D..E2 inclusive, still anchor-bounded");

  const outcome = assembleSynthesisCandidates(index, target);
  for (const candidate of outcome.candidates) {
    for (const segment of candidate.borrowedSegments) {
      assert.deepEqual(segment.coordinates[0], D, "borrowed geometry starts exactly at the from anchor");
      assert.deepEqual(segment.coordinates[segment.coordinates.length - 1], E, "borrowed geometry ends exactly at the to anchor");
    }
  }
});

test("A2-memory: candidate payloads never retain full donor geometry and stay bounded", () => {
  // Donors carry long tails outside the matched slice; none of it may leak
  // into candidates or provenance.
  const donors = Array.from({ length: MAX_SYNTHESIS_CANDIDATES }, (_, index) =>
    route(`mem-${index}`, [
      coordPt(0, 5, 10, `A${index}`),
      pt(1, "D", D.lat, D.lon),
      coordPt(2, 20, 30, "X"),
      pt(3, "E", E.lat, E.lon),
      ...Array.from({ length: 40 }, (_, tail) => coordPt(4 + tail, 15 + tail * 0.1, 45 + tail * 0.1, `TAIL${index}-${tail}`)),
    ]));
  const target = route("mem-target", [pt(0, "D", D.lat, D.lon), gap(1), pt(2, "E", E.lat, E.lon)]);
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([...donors, target]), target);

  assert.equal(outcome.candidates.length, 1, "20 identical geometries dedup to one candidate");
  const candidate = outcome.candidates[0]!;
  const segment = candidate.borrowedSegments[0]!;
  assert.equal(segment.coordinates.length, 3, "only the anchor-bounded slice is retained, never the donor tails");
  assert.equal(segment.coordinates.some((coordinate) => coordinate.lon > E.lon), false, "no geometry beyond the to anchor");
  assert.ok(segment.donorFlightKeys.length <= MAX_DONOR_PROVENANCE);
  assert.ok(segment.donorOrdinals.length <= MAX_DONOR_PROVENANCE);
  assert.equal(segment.donorCount, MAX_SYNTHESIS_CANDIDATES, "segment-level aggregate survives the provenance cap");
  // Payload shape stays small regardless of aggregate donor size (~1KB vs the
  // ~35KB of donor geometry in the index).
  const serialized = JSON.stringify(candidate);
  assert.ok(serialized.length < 4_096, `candidate payload must stay bounded, was ${serialized.length} bytes`);
  assert.equal(serialized.includes("TAIL"), false, "donor tail labels must never reach the candidate payload");
});

test("A2-independence: repeated buildSynthesisIndex calls share no module-level state", () => {
  // Build 1 marks WIDGET as conflicted (two coordinates).
  const conflicted = buildSynthesisIndex([
    route("c1", [pt(0, "WIDGET", 1, 1), pt(1, "K1", 2, 2)]),
    route("c2", [pt(0, "WIDGET", 9, 9), pt(1, "K2", 3, 3)]),
  ]);
  assert.ok(conflicted.conflictedReferenceIds.has("WIDGET"));
  assert.equal(conflicted.pointsByKey.has("ref:WIDGET"), false);
  const conflictedSnapshot = JSON.stringify({ routes: conflicted.routes.length, keys: [...conflicted.pointsByKey.keys()].sort() });

  // Build 2 reuses the same reference id at ONE coordinate: it must be fully
  // joinable again — a leaked conflicted set would corrupt this build.
  const clean = buildSynthesisIndex([
    route("n1", [pt(0, "WIDGET", 1, 1), pt(1, "K1", 2, 2)]),
    route("n2", [pt(0, "WIDGET", 1, 1), pt(1, "K2", 3, 3)]),
  ]);
  assert.equal(clean.conflictedReferenceIds.size, 0, "conflict state must not leak between builds");
  assert.equal(clean.pointsByKey.get("ref:WIDGET")?.length, 2, "the reused reference is joinable in the fresh build");
  const cleanTarget = route("n-target", [pt(0, "WIDGET", 1, 1), gap(1), pt(2, "K2", 3, 3)]);
  assert.equal(assembleSynthesisCandidates(clean, cleanTarget).status, "full", "the fresh index resolves what a leaked conflict set would poison");

  // Build 3 (with conflicts again) must not retroactively mutate build 1.
  buildSynthesisIndex([route("c3", [pt(0, "WIDGET", 7, 7), pt(1, "K3", 4, 4)]), route("c4", [pt(0, "WIDGET", 8, 8), pt(1, "K4", 5, 5)])]);
  assert.equal(JSON.stringify({ routes: conflicted.routes.length, keys: [...conflicted.pointsByKey.keys()].sort() }), conflictedSnapshot, "earlier indexes are immutable across later builds");
});
