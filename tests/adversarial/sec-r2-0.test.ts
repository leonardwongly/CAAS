import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";

// Finding sec-r2-0: exact-reference resolution rescans all locations per route
// element and evades the plan §6.2 warm-request deadline.
//
// resolveExactReference (packages/route-engine/src/index.ts:93-129) re-validates
// EVERY location with LocationSchema.safeParse on every call — there is no index.
// POST /api/v1/drafts/compare calls it once per via entry
// (apps/api/src/server.ts:909) against snapshot.locations (acquireSnapshot caps
// the reference tier at 700_000 records, server.ts:416-421); via is capped at
// MAX_ROUTE_LEGS - 1 = 254 entries (packages/contracts/src/index.ts:141).
// Measured on this machine: ~49ms per resolution over 20k locations, so 254 via
// entries ≈ 12.5s of synchronous CPU per request. withWarmDeadline
// (apps/api/src/server.ts:1105-1125) is setTimeout + Promise.race: a timer
// cannot fire while the event loop is blocked by the synchronous scan, so the
// deadline is evaded and the request answers 200 many seconds later instead of
// failing closed with 503 REQUEST_DEADLINE_EXCEEDED. The prebuilt
// snapshot.locationTokens index (server.ts:382-385) is unused for resolution.
//
// Correct behavior per plan §6.2 (server.ts:1097-1104): a warm request whose
// work exceeds the deadline must fail closed with 503 REQUEST_DEADLINE_EXCEEDED
// promptly, and must never hold the event loop for seconds — the response must
// arrive within the deadline plus a small margin, either as a fast success or
// as the bounded 503.

const LOCATION_COUNT = 20_000;
const VIA_COUNT = 254; // MAX_ROUTE_LEGS - 1 (contracts:141)
const DEADLINE_MS = 1_000;
const ALLOWED_MS = DEADLINE_MS + 3_000;

function referenceResult(dataset: "fixes" | "airports" | "navaids", count: number): ReferenceDatasetResult {
  const points = Array.from({ length: count }, (_unused, index) => ({
    dataset,
    identifier: `REFX${index}`,
    coordinate: { lat: (index % 90) - 45, lon: (index % 180) - 90 },
  }));
  const index = new Map<string, typeof points[number][]>();
  for (const point of points) index.set(point.identifier, [point]);
  return {
    dataset,
    points,
    index,
    evidence: { family: dataset, bytes: 128, records: points.length, acceptedRecords: points.length, rejectedRecords: 0, retried: false, durationMs: 0 },
  };
}

// The two airports the draft endpoints must resolve against.
function airportResult(): ReferenceDatasetResult {
  const points = [
    { dataset: "airports" as const, identifier: "KOR1", coordinate: { lat: 40.0, lon: -73.0 } },
    { dataset: "airports" as const, identifier: "KDS1", coordinate: { lat: 33.0, lon: -118.0 } },
  ];
  const index = new Map<string, typeof points[number][]>();
  for (const point of points) index.set(point.identifier, [point]);
  return { dataset: "airports", points, index, evidence: { family: "airports", bytes: 128, records: 2, acceptedRecords: 2, rejectedRecords: 0, retried: false, durationMs: 0 } };
}

const adapter: CaasAdapter = {
  displayAll: async () => ({ records: [], evidence: { family: "displayAll", bytes: 64, records: 0, acceptedRecords: 0, rejectedRecords: 0, retried: false, durationMs: 0 } }),
  airways: async () => ({ family: "airways", bytes: 64, records: 0, acceptedRecords: 0, rejectedRecords: 0, uniqueRecords: 0, retried: false, durationMs: 0 }),
  fixes: async () => referenceResult("fixes", LOCATION_COUNT),
  airports: async () => airportResult(),
  navaids: async () => referenceResult("navaids", 0),
};

test("draft compare over 254 via entries must not hold the event loop past the warm deadline", async (t) => {
  const server = await createApiServer({ adapter, warmRequestDeadlineMs: DEADLINE_MS, refreshSecret: "test-refresh" });
  t.after(() => server.app.close());

  const via = Array.from({ length: VIA_COUNT }, (_unused, index) => `NOPE${index}`);
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/drafts",
    payload: { origin: "KOR1", destination: "KDS1", via },
  });
  assert.equal(created.statusCode, 201, `draft creation must succeed with ${VIA_COUNT} via entries`);
  const draftId = (created.json() as { id: string }).id;
  assert.equal((created.json() as { draft: { via: string[] } }).draft.via.length, VIA_COUNT, "all via entries must be accepted");

  const startedAt = Date.now();
  const response = await server.app.inject({
    method: "POST",
    url: "/api/v1/drafts/compare",
    payload: { draftId },
  });
  const elapsedMs = Date.now() - startedAt;

  assert.ok(
    elapsedMs < ALLOWED_MS,
    `compare request took ${elapsedMs}ms — the ${DEADLINE_MS}ms warm deadline was evaded by synchronous resolution work ` +
      `(resolveExactReference rescans all ${LOCATION_COUNT} locations per via entry; ${VIA_COUNT} entries)`,
  );
  if (response.statusCode === 503) {
    const body = response.json() as { error: { code: string; retryable: boolean } };
    assert.equal(body.error.code, "REQUEST_DEADLINE_EXCEEDED", "a deadline failure must fail closed with the documented code");
    assert.equal(body.error.retryable, true);
  } else {
    assert.equal(response.statusCode, 200, "a request inside the deadline succeeds; a request past it fails closed with 503");
  }
});
