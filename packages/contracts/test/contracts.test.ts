import assert from "node:assert/strict";
import test from "node:test";
import { CoordinateSchema, DRAFT_SAFETY_COPY, LocationSchema, MAX_ROUTE_LEGS, MAX_ROUTE_POINTS, PERSISTENT_SAFETY_COPY, RANK_ONE_LABEL, RouteCandidateSchema, RouteDraftSchema, RouteDraftSelectionSchema, RoutePathSchema, RouteQuerySchema, parseCoordinate, parseReference, safeParseCoordinate } from "../src/index.ts";

test("coordinate parsing normalizes object and GeoJSON positions and rejects out-of-bounds values", () => {
  assert.deepEqual(parseCoordinate({ latitude: "51.4700", longitude: "-0.4543" }), { lat: 51.47, lon: -0.4543 });
  assert.deepEqual(parseCoordinate({ lat: 0, lng: "0" }), { lat: 0, lon: 0 });
  assert.deepEqual(parseCoordinate(["-0.4543", "51.4700"]), { lat: 51.47, lon: -0.4543 });
  assert.equal(safeParseCoordinate({ lat: 91, lon: 0 }).success, false);
  assert.equal(CoordinateSchema.safeParse({ lat: 0, lon: 181 }).success, false);
  assert.equal(safeParseCoordinate({ lat: "not-a-number", lon: 0 }).success, false);
});

test("route bounds are endpoint-inclusive and gaps remain separate from segments", () => {
  assert.equal(MAX_ROUTE_POINTS, 256);
  assert.equal(MAX_ROUTE_LEGS, 255);
  const point = { status: "point", sequence: 0, designatedIdentifier: null, coordinate: { lat: 0, lon: 0 } } as const;
  const gap = { status: "gap", sequence: 1, reference: null, reason: "not-found" } as const;
  assert.equal(RoutePathSchema.safeParse({
    occurrences: [point, gap],
    segments: [{ points: [point, { ...point, sequence: 2, coordinate: { lat: 1, lon: 1 } }] }],
    gaps: [gap],
  }).success, true);
  assert.equal(RoutePathSchema.safeParse({
    occurrences: Array.from({ length: 257 }, (_, sequence) => ({ ...point, sequence })),
    segments: [],
    gaps: [],
  }).success, false);
});

test("all route schemas share the 256-point endpoint-inclusive bound", () => {
  const reference = { value: "POINT" };
  const leg = { from: reference, to: reference };
  const candidate = {
    id: "CANDIDATE",
    origin: reference,
    destination: reference,
    legs: Array.from({ length: 255 }, () => leg),
    distanceNm: 1,
    rankDistanceNm: 1,
  };
  assert.equal(RouteCandidateSchema.safeParse(candidate).success, true);
  assert.equal(RouteCandidateSchema.safeParse({ ...candidate, legs: [...candidate.legs, leg] }).success, false);
  assert.equal(RouteQuerySchema.safeParse({ origin: reference, destination: reference, maxLegs: 255 }).success, true);
  assert.equal(RouteQuerySchema.safeParse({ origin: reference, destination: reference, maxLegs: 256 }).success, false);
  assert.equal(RouteDraftSchema.safeParse({ origin: "A", destination: "B", via: Array.from({ length: 254 }, () => "V") }).success, true);
  assert.equal(RouteDraftSchema.safeParse({ origin: "A", destination: "B", via: ["   "] }).success, false);
  assert.deepEqual(RouteDraftSchema.parse({ origin: "A", destination: "B", via: [" V "] }).via, ["V"]);
  assert.equal(RouteDraftSchema.safeParse({ origin: "A", destination: "B", via: Array.from({ length: 255 }, () => "V") }).success, false);
});

test("explicit draft selections are generation-bound tokens bounded to waypoint sequences", () => {
  const selection = { sequence: 0, locationId: "token.body.signature" };
  assert.deepEqual(RouteDraftSelectionSchema.parse({ sequence: 0, locationId: "  token  " }), { sequence: 0, locationId: "token" });
  assert.equal(RouteDraftSelectionSchema.safeParse(selection).success, true);
  assert.equal(RouteDraftSelectionSchema.safeParse({ ...selection, sequence: -1 }).success, false);
  assert.equal(RouteDraftSelectionSchema.safeParse({ ...selection, sequence: 0.5 }).success, false);
  assert.equal(RouteDraftSelectionSchema.safeParse({ ...selection, sequence: MAX_ROUTE_LEGS }).success, false);
  assert.equal(RouteDraftSelectionSchema.safeParse({ ...selection, locationId: "" }).success, false);
  assert.equal(RouteDraftSelectionSchema.safeParse({ ...selection, locationId: "x".repeat(513) }).success, false);
  assert.equal(RouteDraftSelectionSchema.safeParse({ sequence: 0, locationId: "t", extra: true }).success, false);
  // A draft may carry up to MAX_ROUTE_LEGS - 1 selections, one per waypoint position.
  const maxSelections = Array.from({ length: MAX_ROUTE_LEGS - 1 }, (_, sequence) => ({ sequence, locationId: "t" }));
  assert.equal(RouteDraftSchema.safeParse({ origin: "A", destination: "B", via: Array.from({ length: MAX_ROUTE_LEGS - 1 }, () => "V"), selections: maxSelections }).success, true);
  assert.equal(RouteDraftSchema.safeParse({ origin: "A", destination: "B", via: ["V"], selections: [...maxSelections, { sequence: MAX_ROUTE_LEGS - 1, locationId: "t" }] }).success, false);
});

test("safety and rank labels are exact and immutable contract constants", () => {
  assert.equal(PERSISTENT_SAFETY_COPY, "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.");
  assert.equal(RANK_ONE_LABEL, "Rank 1 by shortest modeled distance among complete candidates.");
  assert.equal(DRAFT_SAFETY_COPY, "Computationally complete; operational constraints not assessed.");
  assert.notEqual(PERSISTENT_SAFETY_COPY, DRAFT_SAFETY_COPY);
});
test("references and locations are normalized with bounded fields", () => {
  assert.deepEqual(parseReference(" kjfk "), { value: "KJFK", kind: "unknown" });
  const location = LocationSchema.parse({
    id: "kjfk",
    name: " John F. Kennedy ",
    kind: "airport",
    coordinate: { lat: 40.6413, lon: -73.7781 },
    aliases: ["jfk", "JFK"],
  });
  assert.deepEqual(location.aliases, ["JFK"]);
  assert.equal(location.id, "KJFK");
});
