import assert from "node:assert/strict";
import test from "node:test";
import { parseCoordinate, parseLocation, safeParseRouteDraft } from "../packages/contracts/src/index.ts";
import {
  competitionRank,
  fromGeoJsonPosition,
  fromLeafletCoordinate,
  haversineDistanceNm,
  rankRouteCandidates,
  resolveExactReference,
  resolveRouteQuery,
  toGeoJsonPosition,
  toLeafletCoordinate,
} from "../packages/route-engine/src/index.ts";

const locations = [
  parseLocation({ id: "origin", name: "Origin", code: "KOR1", kind: "airport", coordinate: { lat: 40, lon: -73 } }),
  parseLocation({ id: "destination", name: "Destination", code: "KDS1", kind: "airport", coordinate: { lat: 33, lon: -118 } }),
  parseLocation({ id: "duplicate-a", name: "Duplicate A", code: "DUPX", kind: "station", coordinate: { lat: 35, lon: -90 } }),
  parseLocation({ id: "duplicate-b", name: "Duplicate B", code: "DUPX", kind: "station", coordinate: { lat: 36, lon: -91 } }),
];

test("normalizes bounded contract inputs and rejects unsafe shape drift", () => {
  assert.deepEqual(parseCoordinate({ latitude: "40", longitude: "-73" }), { lat: 40, lon: -73 });
  assert.deepEqual(parseLocation({ id: " origin ", name: "Origin", code: " kor1 ", coordinate: { lat: 40, lon: -73 }, aliases: ["alias", "ALIAS"] }), {
    id: "ORIGIN", name: "Origin", code: "KOR1", kind: "place", coordinate: { lat: 40, lon: -73 }, aliases: ["ALIAS"],
  });
  assert.equal(safeParseRouteDraft({ origin: "A", destination: "B", extra: "must reject" }).success, false);
  assert.throws(() => parseCoordinate({ lat: 91, lon: 0 }));
  assert.throws(() => parseCoordinate({ lat: 0, lon: 181 }));
});

test("preserves exact resolution, duplicate ambiguity, and explicit gaps", () => {
  const resolved = resolveExactReference({ value: "kor1", kind: "airport" }, locations);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.status === "resolved" ? resolved.match.id : "", "ORIGIN");

  const ambiguous = resolveExactReference({ value: "DUPX" }, locations);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.status === "ambiguous" ? ambiguous.matches.length : 0, 2);

  const gap = resolveRouteQuery({ origin: { value: "KOR1" }, destination: { value: "MISSING" } }, locations);
  assert.equal(gap.status, "gap");
  assert.equal(gap.destination.status, "gap");
  assert.equal(gap.destination.status === "gap" ? gap.destination.reason : "", "not-found");
});

test("uses full precision for distance and only rounded values for competition", () => {
  const distance = haversineDistanceNm({ lat: 40, lon: -73 }, { lat: 33, lon: -118 });
  assert.ok(distance > 0);
  assert.notEqual(distance, Math.round(distance * 1_000_000) / 1_000_000);
  const ranked = rankRouteCandidates([
    { id: "a", distanceNm: 10.0000001 },
    { id: "b", distanceNm: 10.0000002 },
    { id: "c", distanceNm: 12 },
  ]);
  assert.deepEqual(ranked.map((item) => [item.item.id, item.rankDistanceNm, item.rank]), [["a", 10, 1], ["b", 10, 1], ["c", 12, 3]]);
  assert.deepEqual(competitionRank([5.1, 5.1, 8]), [1, 1, 3]);
});

test("keeps coordinate adapter ordering lossless", () => {
  const coordinate = { lat: 40.5, lon: -73.25 };
  assert.deepEqual(toGeoJsonPosition(coordinate), [-73.25, 40.5]);
  assert.deepEqual(fromGeoJsonPosition([-73.25, 40.5]), coordinate);
  assert.deepEqual(toLeafletCoordinate(coordinate), { lat: 40.5, lng: -73.25 });
  assert.deepEqual(fromLeafletCoordinate({ lat: 40.5, lng: -73.25 }), coordinate);
});
