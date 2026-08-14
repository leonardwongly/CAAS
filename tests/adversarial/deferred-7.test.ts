import assert from "node:assert/strict";
import test from "node:test";
import { LocationSchema } from "../../packages/contracts/src/index.ts";
import {
  createRouteCandidate,
  haversineDistanceNm,
  rankDistanceNm,
  sumDistanceNm,
} from "../../packages/route-engine/src/index.ts";

// Candidate finding: createRouteCandidate (packages/route-engine/src/index.ts:362-365) gates on
// legs.every((leg) => leg.distanceNm !== undefined); when ANY leg lacks a distance it substitutes
// the direct origin->destination great-circle as the candidate's total distanceNm and then parses
// the result through RouteCandidateSchema as a complete, rankable-looking candidate. For a
// multi-leg candidate with one missing leg distance this fabricates a total no recorded geometry
// supports (the direct great-circle ignores every waypoint and is materially shorter than the leg
// path), contradicting "never infer by proximity" (design 0.3) and the full-precision leg-sum
// total policy (design 0.4; README binding contract). The API server never calls this function —
// it builds its own projections and leaves distanceNm undefined for incomplete candidates
// (apps/api/src/server.ts:744) — so only unit tests can hit it.
//
// North-star contract: design 0.4 "Leg and total Haversine distance use full precision" and
// "Incomplete candidates remain available but unranked"; the server's own projection pattern
// (distanceNm undefined when incomplete) is the reference. Because RouteCandidateSchema requires a
// nonnegative finite distanceNm, the only honest outcomes for createRouteCandidate when a leg
// distance is missing are to fail closed (throw) or report incompleteness — never to emit the
// direct great-circle as the modeled total. Intended partial-leg behavior: reject the input;
// callers must supply a distance for every leg or handle the incompleteness themselves.

const ORIGIN = LocationSchema.parse({
  id: "KLAX",
  name: "Los Angeles Intl",
  kind: "airport",
  coordinate: { lat: 33.9425, lon: -118.4081 },
  aliases: [],
});
// A waypoint (Stockton Metro) deliberately off the LAX-JFK great circle so the direct
// origin->destination haversine differs materially from the leg-path total.
const WAYPOINT = LocationSchema.parse({
  id: "KSCK",
  name: "Stockton Metro",
  kind: "airport",
  coordinate: { lat: 37.8942, lon: -121.2384 },
  aliases: [],
});
const DESTINATION = LocationSchema.parse({
  id: "KJFK",
  name: "New York JFK",
  kind: "airport",
  coordinate: { lat: 40.6398, lon: -73.7789 },
  aliases: [],
});

function leg(from: string, to: string, distanceNm?: number) {
  return { from: { value: from, kind: "airport" as const }, to: { value: to, kind: "airport" as const }, ...(distanceNm === undefined ? {} : { distanceNm }) };
}

test("createRouteCandidate fails closed when any leg lacks distanceNm instead of emitting the direct great-circle total", () => {
  const firstLegDistance = haversineDistanceNm(ORIGIN.coordinate, WAYPOINT.coordinate);
  const secondLegDistance = haversineDistanceNm(WAYPOINT.coordinate, DESTINATION.coordinate);
  const legs = [leg("KLAX", "KSCK", firstLegDistance), leg("KSCK", "KJFK")];

  // Geometry guard: the direct great-circle (ignoring the waypoint) must be materially shorter
  // than the leg-path total, so substituting it would fabricate a total no recorded geometry
  // supports.
  const direct = haversineDistanceNm(ORIGIN.coordinate, DESTINATION.coordinate);
  const legTotal = firstLegDistance + secondLegDistance;
  assert.ok(legTotal - direct > 200, "test geometry must separate the direct great-circle from the leg-sum total");

  // An incomplete leg set must fail closed — never return a candidate whose modeled distanceNm is
  // the direct origin->destination great-circle. The candidate's distanceNm must also never equal
  // the leg-sum of the known legs, which would misrepresent a partial geometry as the total.
  assert.throws(
    () => createRouteCandidate("candidate-missing-leg", ORIGIN, DESTINATION, legs),
    "a leg without distanceNm must be rejected, not silently replaced by the direct great-circle",
  );
});

test("createRouteCandidate with every leg distance present returns the exact leg-sum total", () => {
  const legs = [
    leg("KLAX", "KSCK", haversineDistanceNm(ORIGIN.coordinate, WAYPOINT.coordinate)),
    leg("KSCK", "KJFK", haversineDistanceNm(WAYPOINT.coordinate, DESTINATION.coordinate)),
  ];
  const candidate = createRouteCandidate("candidate-complete", ORIGIN, DESTINATION, legs);
  const total = sumDistanceNm(legs.map((l) => l.distanceNm!));
  assert.equal(candidate.distanceNm, total, "a fully measured leg set must total the exact leg-sum");
  assert.equal(candidate.rankDistanceNm, rankDistanceNm(total), "rankDistanceNm must be the rounded leg-sum total");
});
