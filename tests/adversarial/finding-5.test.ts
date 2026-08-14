import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { AirwayEvidence, CaasAdapter, DatasetEvidence, FlightPlanRecord, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedFlights } from "../fixtures/sanitized-caas.ts";

// Plan §6.1 (binding quantitative POC policy) sets "Ambiguity page | 50 results"
// and "Ambiguity hard total | 500; above this require a narrower term", and the
// §6 preamble requires that "Crossing a hard limit fails closed with a bounded
// error and never silently truncates required results."
//
// The reference dataset is a real five-family acquisition in which duplicate
// identifiers are preserved as explicit ambiguity (design Section 0: "Ambiguity
// is preserved... no proximity inference is permitted"). The largest family is
// 247,419 fixes, so an identifier shared by more than 50 (or more than 500)
// records is reachable with real data.
//
// Correct behavior asserted here:
//   - >50 matches  -> a 50-result page with a cursor for the rest (page bound),
//     never one 200 dumping every match and never silent truncation.
//   - >500 matches -> a bounded fail-closed error requiring a narrower term,
//     never a 200 dumping every match.

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  return { family, bytes: 128, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 0 };
}

function references(dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult {
  const points = values.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: { lat, lon } }));
  const index = new Map<string, readonly typeof points[number][]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points, index, evidence: evidence(dataset, points.length) };
}

function adapterWithManyDuplicates(records: readonly FlightPlanRecord[] = sanitizedFlights): CaasAdapter {
  // 60 navaid points sharing one identifier: exceeds the 50-result page bound.
  const manyNavaids = Array.from({ length: 60 }, (_unused, index) => ["HUBB", -60 + (index % 120), -150 + (index % 300)] as const);
  // 550 fix points sharing one identifier: exceeds the 500 ambiguity hard total.
  const manyFixes = Array.from({ length: 550 }, (_unused, index) => ["MEGA", -60 + (index % 120), -150 + (index % 300)] as const);
  const airway: AirwayEvidence = { family: "airways", bytes: 64, records: 2, acceptedRecords: 2, rejectedRecords: 0, uniqueRecords: 1, retried: false, durationMs: 0 };
  return {
    displayAll: async () => ({ records, evidence: evidence("displayAll", records.length) }),
    airways: async () => airway,
    fixes: async () => references("fixes", manyFixes),
    airports: async () => references("airports", [["KOR1", 40, -73], ["KDS1", 33, -118]] as const),
    navaids: async () => references("navaids", manyNavaids),
  };
}

interface AmbiguousBody {
  status: string;
  matches: unknown[];
  nextCursor?: string;
}

test("an ambiguity with 60 matches pages at the plan §6.1 50-result bound instead of returning all matches", async () => {
  const server = await createApiServer({ adapter: adapterWithManyDuplicates() });
  try {
    const response = await server.app.inject({ method: "GET", url: "/api/v1/points/lookup?reference=HUBB" });
    assert.equal(response.statusCode, 200, "a pageable ambiguity is still a successful lookup");
    const body = response.json() as AmbiguousBody;
    assert.equal(body.status, "ambiguous", "duplicate identifiers must surface as explicit ambiguity");
    assert.ok(body.matches.length <= 50, `page must not exceed the 50-result page bound, got ${body.matches.length} matches`);
    assert.equal(typeof body.nextCursor, "string", "a page at the bound must carry a cursor rather than silently truncate");
    assert.ok(body.nextCursor!.length > 0, "the cursor must be non-empty");
  } finally {
    await server.app.close();
  }
});

test("an ambiguity above the 500 hard total fails closed with a bounded error instead of returning all matches", async () => {
  const server = await createApiServer({ adapter: adapterWithManyDuplicates() });
  try {
    const response = await server.app.inject({ method: "GET", url: "/api/v1/points/lookup?reference=MEGA" });
    assert.ok(response.statusCode >= 400 && response.statusCode < 600, `crossing the 500 hard total must fail closed with a bounded error, got status ${response.statusCode}`);
    const body = response.json() as { error?: { code?: unknown } };
    assert.equal(typeof body.error?.code, "string", "the bounded error must name its code");
  } finally {
    await server.app.close();
  }
});
