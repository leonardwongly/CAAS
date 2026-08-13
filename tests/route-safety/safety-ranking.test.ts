import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import {
  compareDistanceOperands,
  competitionRank,
  displayDistanceNm,
  rankDistanceNm,
  rankRouteCandidates,
} from "../../packages/route-engine/src/index.ts";
import type { CaasAdapter, DatasetEvidence, FlightPlanRecord, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";
import { PERSISTENT_SAFETY_COPY, RANK_ONE_LABEL } from "../../packages/contracts/src/index.ts";
import { sanitizedAdapter, sanitizedFlights } from "../fixtures/sanitized-caas.ts";

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  return { family, bytes: 128, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 0 };
}

function references(dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult {
  const points = values.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: { lat, lon } }));
  const index = new Map<string, readonly typeof points[number][]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points, index, evidence: evidence(dataset, points.length) };
}

// Three complete same-endpoint flights whose great-circle splits sum to the same
// arc (3+7, 7+3, 5+5) so all three tie for rank 1, plus one incomplete flight.
const RANKING_RECORDS: readonly FlightPlanRecord[] = Object.freeze([
  Object.freeze({ id: "rank-a", callsign: "RANKTIE1", departure: "EK00", destination: "EW10", routeElements: Object.freeze([{ sequence: 0, coordinate: { lat: 0, lon: 3 } }]) }),
  Object.freeze({ id: "rank-b", callsign: "RANKTIE2", departure: "EK00", destination: "EW10", routeElements: Object.freeze([{ sequence: 0, coordinate: { lat: 0, lon: 7 } }]) }),
  Object.freeze({ id: "rank-c", callsign: "RANKTIE3", departure: "EK00", destination: "EW10", routeElements: Object.freeze([{ sequence: 0, coordinate: { lat: 0, lon: 5 } }]) }),
  Object.freeze({ id: "rank-gap", callsign: "RANKGAP", departure: "EK00", destination: "EW10", routeElements: Object.freeze([{ sequence: 0, identifier: "NOT-A-FIX" }]) }),
]);

const GAP_ONLY_RECORDS: readonly FlightPlanRecord[] = Object.freeze([RANKING_RECORDS[3]!]);

function equatorAdapter(records: readonly FlightPlanRecord[]): CaasAdapter {
  const base = sanitizedAdapter(records);
  return {
    ...base,
    airports: async () => references("airports", [["EK00", 0, 0], ["EW10", 0, 10]]),
    displayAll: async () => ({ records, evidence: evidence("displayAll", records.length) }),
  };
}

interface TestHarness {
  after: (fn: () => void) => void;
}

async function serverFor(t: TestHarness, adapter: CaasAdapter) {
  const server = await createApiServer({ adapter, refreshSecret: "offline-refresh-secret" });
  t.after(() => server.app.close());
  return server;
}

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;

async function flightId(server: ApiServer, callsign: string): Promise<string> {
  const search = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: callsign } });
  assert.equal(search.statusCode, 200);
  const id = (search.json() as { data: Array<{ id: string }> }).data[0]?.id;
  assert.ok(id);
  return id;
}

const FORBIDDEN_WORDS = /\b(valid|recommended|safe|cleared|best)\b/i;

test("engine rounding and comparison math follow the exact precision contract", () => {
  // Competition equality rounds at 0.000001 NM with EPSILON bias.
  assert.equal(rankDistanceNm(10.0000004), 10);
  assert.equal(rankDistanceNm(10.0000005), 10.000001);
  assert.equal(rankDistanceNm(9.9999994), 9.999999);
  assert.equal(rankDistanceNm(9.9999995), 10);
  // Display rounding is 0.1 NM and never feeds competition.
  assert.equal(displayDistanceNm(10.04), 10);
  assert.equal(displayDistanceNm(10.05), 10.1);
  assert.equal(displayDistanceNm(0.0499), 0);
  assert.equal(displayDistanceNm(0.05), 0.1);

  // Directed full-precision difference: delta = target - baseline exactly.
  const full = compareDistanceOperands(0.1, 0.3);
  assert.equal(full.status, "complete");
  assert.equal(full.distanceDeltaNm, 0.3 - 0.1);
  assert.equal(full.percentageDistanceDelta, (100 * (0.3 - 0.1)) / 0.1);
  assert.deepEqual(full.unavailable, []);

  const plain = compareDistanceOperands(10, 15);
  assert.equal(plain.status, "complete");
  assert.equal(plain.distanceDeltaNm, 5);
  assert.equal(plain.percentageDistanceDelta, 50);

  const missingBaseline = compareDistanceOperands(undefined, 5);
  assert.equal(missingBaseline.status, "incomplete");
  assert.deepEqual(missingBaseline.unavailable, ["INCOMPLETE_OPERAND"]);
  assert.equal(missingBaseline.distanceDeltaNm, undefined);
  assert.equal(missingBaseline.percentageDistanceDelta, undefined);

  const missingTarget = compareDistanceOperands(5, undefined);
  assert.equal(missingTarget.status, "incomplete");
  assert.deepEqual(missingTarget.unavailable, ["INCOMPLETE_OPERAND"]);

  // A zero-distance baseline keeps the delta but never fabricates a percentage.
  const zeroBaseline = compareDistanceOperands(0, 5);
  assert.equal(zeroBaseline.status, "complete");
  assert.equal(zeroBaseline.distanceDeltaNm, 5);
  assert.equal(zeroBaseline.percentageDistanceDelta, undefined);
  assert.deepEqual(zeroBaseline.unavailable, ["ZERO_BASELINE"]);
});

test("competition ranks share ties, skip gaps, and never round unequal distances into ties", () => {
  assert.deepEqual(competitionRank([10, 10, 12]), [1, 1, 3]);
  assert.deepEqual(competitionRank([12, 10, 10, 10, 11]), [5, 1, 1, 1, 4]);
  // Rounding at 1e-6 only merges distances that are equal at that precision:
  // 10.0000004 and 9.9999995 both round to 10 and tie; 10.0000005 rounds to 10.000001.
  assert.deepEqual(competitionRank([9.9999995, 10.0000004]), [1, 1]);
  assert.deepEqual(competitionRank([10.0000004, 10.0000005]), [1, 2]);
  assert.deepEqual(competitionRank([10.0000005, 10.0000025]), [1, 2]);

  const ranked = rankRouteCandidates([
    { id: "a", distanceNm: 10.0000004 },
    { id: "b", distanceNm: 10.0000005 },
    { id: "c", distanceNm: 12 },
  ]);
  assert.deepEqual(ranked.map((entry) => entry.rank), [1, 2, 3]);
  assert.deepEqual(ranked.map((entry) => entry.item.id), ["a", "b", "c"]);
  assert.ok(ranked[1]!.rankDistanceNm > ranked[0]!.rankDistanceNm);
});

test("every tied rank-1 candidate is presented together under the exact qualified label", async (t) => {
  const server = await serverFor(t, equatorAdapter(RANKING_RECORDS));
  const id = await flightId(server, "RANKTIE1");
  const response = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: id } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: Array<{ rank?: number; rankDistanceNm?: number; complete: boolean; distanceNm?: number; safety: string; operationalProxy?: { eligible: boolean; exclusion?: string } }>;
    rankLabel?: string;
  };
  assert.equal(body.rankLabel, RANK_ONE_LABEL, "rankLabel must be the exact qualified label");
  const complete = body.data.filter((candidate) => candidate.complete);
  const incomplete = body.data.filter((candidate) => !candidate.complete);
  assert.equal(complete.length, 3, "all three tied flights must be complete");
  assert.ok(complete.every((candidate) => candidate.rank === 1), "every complete candidate must be rank 1");
  assert.ok(complete.every((candidate) => candidate.rankDistanceNm === complete[0]!.rankDistanceNm), "tied candidates share rankDistanceNm");
  // Ties are contiguous at the front: no higher rank appears before them.
  assert.deepEqual(body.data.map((candidate) => candidate.rank).slice(0, 3), [1, 1, 1]);
  assert.ok(body.data.every((candidate) => candidate.safety === PERSISTENT_SAFETY_COPY));
  // Incomplete candidates stay unranked and carry no distance.
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0]!.rank, undefined);
  assert.equal(incomplete[0]!.rankDistanceNm, undefined);
  assert.equal(incomplete[0]!.distanceNm, undefined);
  assert.equal(incomplete[0]!.operationalProxy?.eligible, false);
  assert.ok(incomplete[0]!.operationalProxy?.exclusion);
  assert.equal(body.data[3]!.rank, undefined, "incomplete candidates appear after ranked ones");
});

test("no rankLabel is emitted when no complete candidates exist", async (t) => {
  const server = await serverFor(t, equatorAdapter(GAP_ONLY_RECORDS));
  const id = await flightId(server, "RANKGAP");
  const response = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: id } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: Array<{ rank?: number; complete: boolean }>; rankLabel?: string };
  assert.equal(body.rankLabel, undefined, "the qualified first-place label must not be emitted without complete candidates");
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]!.rank, undefined);
  assert.equal(body.data[0]!.complete, false);
});

test("the persistent safety copy appears exactly on options, detail, drafts, and comparison operands", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const id = await flightId(server, "FIXTURE1");

  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: id } });
  assert.equal(options.statusCode, 200);
  const option = (options.json() as { data: Array<{ safety: string }> }).data[0]!;
  assert.equal(option.safety, PERSISTENT_SAFETY_COPY);

  const detail = await server.app.inject({ method: "GET", url: `/api/v1/routes/${encodeURIComponent(id)}` });
  assert.equal(detail.statusCode, 200);
  assert.equal((detail.json() as { data: { safety: string } }).data.safety, PERSISTENT_SAFETY_COPY);

  const legacy = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draft: { origin: "KOR1", destination: "KDS1", via: [], selections: [] } } });
  assert.equal(legacy.statusCode, 200);
  assert.equal((legacy.json() as { route: { safety: string } }).route.safety, PERSISTENT_SAFETY_COPY);

  const comparison = await server.app.inject({ method: "POST", url: "/api/v1/routes/compare", payload: { baselineId: id, targetDraft: { origin: "KOR1", destination: "KDS1", via: [], selections: [] } } });
  assert.equal(comparison.statusCode, 200);
  const body = comparison.json() as { baseline: { safety: string }; target: { safety: string } };
  assert.equal(body.baseline.safety, PERSISTENT_SAFETY_COPY);
  assert.equal(body.target.safety, PERSISTENT_SAFETY_COPY);
});

test("no API payload qualifies a candidate as valid, recommended, safe, cleared, or best", async (t) => {
  const server = await serverFor(t, equatorAdapter(RANKING_RECORDS));
  const id = await flightId(server, "RANKTIE1");

  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId: id } });
  const detail = await server.app.inject({ method: "GET", url: `/api/v1/routes/${encodeURIComponent(id)}` });
  const legacy = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draft: { origin: "EK00", destination: "EW10", via: [], selections: [] } } });
  const comparison = await server.app.inject({ method: "POST", url: "/api/v1/routes/compare", payload: { baselineId: id, targetDraft: { origin: "EK00", destination: "EW10", via: [], selections: [] } } });
  const payloads = [options, detail, legacy, comparison] as const;
  for (const response of payloads) {
    assert.equal(response.statusCode, 200);
    const serialized = JSON.stringify(response.json());
    assert.equal(FORBIDDEN_WORDS.test(serialized), false, `forbidden qualifier found: ${serialized.match(FORBIDDEN_WORDS)?.[0]}`);
  }
});

test("draft route payloads never carry rank or complete fields", async (t) => {
  const server = await serverFor(t, sanitizedAdapter());
  const response = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"], selections: [] } } });
  assert.equal(response.statusCode, 200);
  const route = (response.json() as { route: Record<string, unknown> }).route;
  assert.equal("rank" in route, false, "drafts are never ranked into the recorded-candidate population");
  assert.equal("complete" in route, false, "the draft DTO keeps the legacy shape without a complete field");
  assert.equal("status" in route, false);
  // A complete draft still reports its modeled distance rounded at 0.000001 NM.
  assert.equal(typeof route.rankDistanceNm, "number");

  const baselineId = await flightId(server, "FIXTURE1");
  const comparison = await server.app.inject({ method: "POST", url: "/api/v1/routes/compare", payload: { baselineId, targetDraft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"], selections: [] } } });
  assert.equal(comparison.statusCode, 200);
  const target = (comparison.json() as { target: Record<string, unknown> }).target;
  assert.equal("rank" in target, false);
  assert.equal("complete" in target, false);
});
