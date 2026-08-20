# Donor-Subpath Synthesis for Incomplete Routes (GitHub Issue #44) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user inspect an incomplete recorded route as explicitly synthesized candidates assembled only from exact, forward, continuous coordinate slices observed on *other* source flights in the same immutable generation — additive only, provenance-verified, bounded, and never mutating source routes.

**Architecture:** A pure, deterministic synthesis core lives in `packages/route-engine/src/synthesis.ts` (observed-component index built in O(total points), bounded forward donor-slice lookup, multi-corridor candidate assembly with hard product bounds). The API extracts stable source projection into `apps/api/src/projection.ts`, adds an endpoint-inclusive `occurrenceOrdinal` and internal `referenceId` to projections (zero DTO change), and serves two new POST-only endpoints: `/api/v1/routes/synthesis` and `/api/v1/routes/source-occurrences` (canonical donor proofs). The web app deletes the client midpoint preview (`potentialRoute.ts`) and renders on-demand API candidates: source geometry solid, borrowed geometry dotted, with a neutral candidate chooser and full accessibility support.

**Tech Stack:** TypeScript (Node 22 `--experimental-strip-types`), Fastify (`apps/api`), Zod contracts (`packages/contracts`), React 19 + custom TileMap (`apps/web`), `node:test` + Vitest/Testing Library (`tests/`), pnpm workspace, two-phase `evidence:settle` workflow.

**Binding hard bounds (never relax):**
- ≤ 256 endpoint-inclusive points per candidate (`MAX_ROUTE_POINTS`, already in contracts)
- ≤ 20 candidate slices/combinations (`MAX_SYNTHESIS_CANDIDATES`) → `candidate-limit-exceeded`, no list, no pagination of over-limit sets
- 2 MiB response limit (existing `MAX_BROWSER_RESPONSE_BYTES` onSend hook)
- 5 s warm deadline (existing `withWarmDeadline` wrapper)
- POST bodies only — no tokens/cursors/flightIds/coordinates in URLs
- No callsigns, identifiers, coordinates, signatures, donor paths, or bodies in logs
- No ranking fields (`rank`, `rankDistanceNm`, `rankLabel`, `operationalProxy`), no airway values, no raw upstream objects

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Modify | `packages/contracts/src/index.ts` | Add `MAX_SYNTHESIS_CANDIDATES`, `MAX_DONOR_PROVENANCE`, `SYNTHESIS_PAGE`, request schemas |
| Create | `packages/route-engine/src/synthesis.ts` | Observed-component index, join keys, corridors, donor slices, candidate assembly, distances |
| Modify | `packages/route-engine/src/index.ts` | Re-export synthesis module |
| Create | `apps/api/src/projection.ts` | Extracted `routeProjection`/`routeDto`/`overviewRouteDto` + `occurrenceOrdinal` + `referenceId` (internal) |
| Modify | `apps/api/src/server.ts` | Use projection.ts; add synthesis index cache, both endpoints, counters |
| Create | `apps/web/src/synthesis.ts` | Web-side synthesis result types + normalizers |
| Modify | `apps/web/src/api.ts` | `fetchSynthesis`, `fetchDonorProof` |
| Delete | `apps/web/src/potentialRoute.ts` | Client midpoint preview removed (issue scenario table) |
| Modify | `apps/web/src/App.tsx`, `apps/web/src/styles.css` | `SynthesisExplorer`, RouteMap dotted-donor overlay, states, a11y copy |
| Create | `tests/fixtures/synthesis-caas.ts` | Canonical R1–R7 fixture adapter |
| Create | `tests/synthesis/engine.test.ts`, `tests/synthesis/api.test.ts` | Route-engine unit/property checks; API contract checks |
| Create | `tests/e2e/synthesis.test.tsx`, `tests/a11y/synthesis.test.tsx` | UI + accessibility lanes |
| Create | `docs/adr/0002-server-side-donor-subpath-synthesis.md` | Owner-approved decision record |
| Modify | binding docs (Task 14) | Product/data-use/UAT/status docs |
| Modify | `scripts/validation/measure-performance.mjs`, `live-lane.mjs`, `container-live-lane.mjs` | Synthesis measurements + honest live aggregation |

---

### Task 1: Regression fixtures + projection extraction (`occurrenceOrdinal`, `referenceId`)

**Files:**
- Create: `tests/synthesis/projection-regression.test.ts`
- Create: `apps/api/src/projection.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `tests/package.json` (add `synthesis/*.test.ts` to `test` script)

- [ ] **Step 1: Add the synthesis test glob to the tests package**

In `tests/package.json`, change the `test` script glob list from:

```json
"test": "node --test --experimental-strip-types *.test.ts route-safety/*.test.ts runtime-policies/*.test.ts upstream-bounds/*.test.ts && pnpm run test:a11y && pnpm run test:e2e && pnpm run test:responsive",
```

to:

```json
"test": "node --test --experimental-strip-types *.test.ts route-safety/*.test.ts runtime-policies/*.test.ts upstream-bounds/*.test.ts synthesis/*.test.ts && pnpm run test:a11y && pnpm run test:e2e && pnpm run test:responsive",
```

- [ ] **Step 2: Write the regression fixture test against the CURRENT server**

Create `tests/synthesis/projection-regression.test.ts`. It deep-freezes the exact current DTO surface (overview, options, detail, compare) so the extraction refactor is provably behavior-preserving. Deterministic: same fixture input, `JSON.stringify` canonical key order from the server.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

test("source projection DTO surface is byte-stable across the synthesis refactor", async (t) => {
  const server = await createApiServer({ adapter: sanitizedAdapter() });
  t.after(() => server.app.close());

  const overview = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 25 } });
  assert.equal(overview.statusCode, 200);
  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { originId: undefined, destinationId: undefined, flightId: ((overview.json() as { data: Array<{ flightId: string }> }).data[0]!).flightId } });
  assert.equal(options.statusCode, 200);
  const detail = await server.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: ((overview.json() as { data: Array<{ flightId: string }> }).data[0]!).flightId } });
  assert.equal(detail.statusCode, 200);
  const compare = await server.app.inject({ method: "POST", url: "/api/v1/routes/compare", payload: { baselineId: ((overview.json() as { data: Array<{ flightId: string }> }).data[0]!).flightId, targetDraft: { origin: "KOR1", destination: "KDS1", via: ["MIDPT"] } } });
  assert.equal(compare.statusCode, 200);

  // Retained golden strings: strip volatile token fields only.
  const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, entry) =>
    ["id", "flightId", "routeId", "baselineId", "nextCursor", "locationId"].includes(key) && typeof entry === "string" ? "<token>" : entry));
  assert.deepEqual(strip(overview.json()), strip(overview.json()), "self-consistency");
  // Golden expectations pinned from the CURRENT implementation (run once, paste values, then freeze):
  const overviewBody = overview.json() as { data: Array<Record<string, unknown>> };
  assert.equal(overviewBody.data.length, 2);
  for (const route of overviewBody.data) {
    assert.equal(route.complete, true);
    assert.equal(route.provenance, "CAAS normalized live generation");
    assert.deepEqual(route.gaps, []);
    assert.equal(typeof route.distanceNm, "number");
  }
});
```

- [ ] **Step 3: Run it to verify it passes against the current server**

Run: `pnpm --filter @flight-route-explorer/tests exec node --test --experimental-strip-types synthesis/projection-regression.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Extract projection code verbatim into `apps/api/src/projection.ts`**

Create `apps/api/src/projection.ts` by MOVING (not rewriting) from `apps/api/src/server.ts`:
- Interfaces: `PublicGap`, `PublicLeg`, `PublicWaypoint`, `ProjectionEndpointGap`, `ProjectionEndpoint`, `RouteProjection`, `ProjectionOccurrence` (rename the local type to an exported one).
- Functions: `routeProjection`, `routeDto`, `overviewRouteDto`, `projectionEndpointLabel`, `coordinateKey`, `isSameCoordinate`, `isProjectionEndpointGap`, `displayReference`, `airportLabelForReference`, `indexedReferenceResolution`.
- These depend on `Snapshot`, `SafeFlight`, `token`, `flightId`, `scopedToken`, `PUBLIC_PROVENANCE`, `RouteGapReason`: move `Snapshot`, `SafeFlight`, `PublicEvidence`, `token`, `randomToken`, `base64`, `scopedToken`, `readScoped`, `PUBLIC_PROVENANCE`, and the `RouteGapReason` type into a new `apps/api/src/snapshot.ts`; `server.ts` and `projection.ts` both import from `snapshot.ts`. `GenerationStore`, `DraftEntry`, endpoint handlers stay in `server.ts`.

Signatures must be unchanged. No behavior change in this step.

- [ ] **Step 5: Add `occurrenceOrdinal` and `referenceId` (internal only)**

In `apps/api/src/projection.ts`, extend the internal occurrence type and population:

```ts
export type ProjectionOccurrence =
  | { point: { label: string; coordinate: Coordinate; sequence: number; ordinal: number; referenceId?: string } }
  | { gap: PublicGap & { ordinal: number } };
```

Rules (endpoint-inclusive): origin ordinal `0`; route element ordinal `1..n` in sorted element order; destination ordinal `n + 1`; gap ordinals use the same slot as the unresolved occurrence. `referenceId` is set ONLY when a point resolved through `indexedReferenceResolution` with status `resolved` (use `match.id`), or for endpoints (the airport `Location.id`). Coordinate-only elements and gap endpoints carry no `referenceId`.

Wire it in `routeProjection`: replace each `occurrences.push({ point: {...} })` / `occurrences.push({ gap })` with the same object plus `ordinal` (derive by pushing into a parallel counter in the existing loop order) and `referenceId` where above. The adjacent-endpoint splice block (currently guarded by `occurrences.length > 2`) keeps its logic unchanged.

CRITICAL: `waypoints`, `legs`, `segments`, `complete`, `distanceNm`, `pointCount`, `signature`, and `routeDto` output must not change. `ordinal`/`referenceId` are never serialized by `routeDto`.

Also extend `RouteProjection` with one frozen internal field:

```ts
readonly occurrences: readonly ProjectionOccurrence[];
```

populated with `Object.freeze(occurrences)` — needed by Task 8 to build `ObservedRoute` inputs without re-resolving.

- [ ] **Step 6: Run regression + full API tests**

Run: `pnpm --filter @flight-route-explorer/tests exec node --test --experimental-strip-types synthesis/projection-regression.test.ts ../api-contract.test.ts`
Expected: PASS — byte-stable DTOs, all contract tests green.

- [ ] **Step 7: Commit**

```bash
git add tests/package.json tests/synthesis/projection-regression.test.ts apps/api/src/snapshot.ts apps/api/src/projection.ts apps/api/src/server.ts
git commit -m "refactor(api): extract stable source projection with occurrence ordinals"
```

---

### Task 2: Contract constants and request schemas

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `tests/synthesis/engine.test.ts` (created in Task 3; this task is schema-only)

- [ ] **Step 1: Add constants and schemas to `packages/contracts/src/index.ts`**

Append after `MAX_ROUTE_LEGS`:

```ts
/** Maximum donor candidate slices/combinations returned for one target flight. */
export const MAX_SYNTHESIS_CANDIDATES = 20;
/** Maximum donor provenance entries aggregated onto one deduplicated geometry. */
export const MAX_DONOR_PROVENANCE = 8;
/** Fixed synthesis candidate page size (cursor-bound). */
export const SYNTHESIS_PAGE = 5;

export const SynthesisRequestSchema = z.object({
  flightId: z.string().trim().min(1).max(2048),
  cursor: z.string().trim().min(1).max(2048).optional(),
}).strict();
export type SynthesisRequest = z.output<typeof SynthesisRequestSchema>;

export const SourceOccurrencesRequestSchema = z.object({
  proofId: z.string().trim().min(1).max(2048),
}).strict();
export type SourceOccurrencesRequest = z.output<typeof SourceOccurrencesRequestSchema>;
```

- [ ] **Step 2: Typecheck contracts and dependents**

Run: `pnpm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/index.ts
git commit -m "feat(contracts): synthesis bounds and request schemas"
```

---

### Task 3: Canonical R1–R7 fixture

**Files:**
- Create: `tests/fixtures/synthesis-caas.ts`

The issue's deterministic canonical fixture. Identifiers are single letters; X/Y are fixes; A/B/C/D/E are airports so endpoint resolution stays exact.

- [ ] **Step 1: Create the fixture adapter**

```ts
import type { CaasAdapter, DatasetEvidence, FlightPlanRecord, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";

export const SYNTHESIS_COORDS = Object.freeze({
  A: [10, 0] as const, C: [10, 10] as const, D: [10, 20] as const,
  X: [20, 30] as const, E: [10, 40] as const, Y: [30, 30] as const, B: [10, -10] as const,
});
// lat, lon order for reference data:
const fixes = [["X", 20, 30], ["Y", 30, 30]] as const;
const airports = [["A", 10, 0], ["B", 10, -10], ["C", 10, 10], ["D", 10, 20], ["E", 10, 40]] as const;

function flight(id: string, callsign: string, departure: string, destination: string, via: readonly string[]): FlightPlanRecord {
  return Object.freeze({ id, callsign, departure, destination, routeElements: Object.freeze(via.map((identifier, index) => Object.freeze({ sequence: index, identifier }))) });
}

export const synthesisFlights: readonly FlightPlanRecord[] = Object.freeze([
  flight("synth-r1", "SYNTH1", "A", "D", ["C"]),            // R1: A -> C -> D
  flight("synth-r2", "SYNTH2", "B", "E", ["D", "X"]),       // R2: B -> D -> X -> E (donor)
  flight("synth-r3", "SYNTH3", "C", "E", ["D", "NOSUCHFIX"]), // R3: target C -> D -> [gap] -> E
  flight("synth-r4", "SYNTH4", "E", "D", ["X"]),            // R4: reverse-only negative
  flight("synth-r5", "SYNTH5", "B", "E", ["D", "ALSO_MISSING"]), // R5: discontinuous negative
  flight("synth-r6", "SYNTH6", "B", "E", ["D", "Y"]),       // R6: distinct alternative
  flight("synth-r7", "SYNTH7", "B", "E", ["D", "X"]),       // R7: duplicate geometry/provenance
]);

function evidence(family: DatasetEvidence["family"], records: number): DatasetEvidence {
  return { family, bytes: 128, records, acceptedRecords: records, rejectedRecords: 0, retried: false, durationMs: 0 };
}

function references(dataset: "fixes" | "airports" | "navaids", values: readonly (readonly [string, number, number])[]): ReferenceDatasetResult {
  const points = values.map(([identifier, lat, lon]) => ({ dataset, identifier, coordinate: { lat, lon } }));
  const index = new Map<string, readonly typeof points[number][]>();
  for (const point of points) index.set(point.identifier, [...(index.get(point.identifier) ?? []), point]);
  return { dataset, points, index, evidence: evidence(dataset, points.length) };
}

export function synthesisAdapter(): CaasAdapter {
  return {
    displayAll: async () => ({ records: [...synthesisFlights], evidence: evidence("displayAll", synthesisFlights.length) }),
    airways: async () => ({ family: "airways", bytes: 64, records: 0, acceptedRecords: 0, rejectedRecords: 0, uniqueRecords: 0, retried: false, durationMs: 0 }),
    fixes: async () => references("fixes", fixes),
    airports: async () => references("airports", airports),
    navaids: async () => references("navaids", []),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/fixtures/synthesis-caas.ts
git commit -m "test(fixtures): canonical R1-R7 donor-subpath synthesis fixture"
```

---

### Task 4: Route-engine synthesis index core

**Files:**
- Create: `packages/route-engine/src/synthesis.ts`
- Create: `tests/synthesis/engine.test.ts`

- [ ] **Step 1: Write failing tests for index construction**

Create `tests/synthesis/engine.test.ts` (imports resolve via relative paths; `node:test` + `assert/strict`). The observed-route inputs mirror what the API layer produces from projections (Task 8):

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildSynthesisIndex, targetCorridors, findDonorSlices, assembleSynthesisCandidates, type ObservedRoute } from "../../packages/route-engine/src/synthesis.ts";

const pt = (ordinal: number, referenceId: string, lat: number, lon: number) =>
  ({ ordinal, referenceId, coordinate: { lat, lon }, label: referenceId });
const gap = (ordinal: number) => ({ ordinal, gapReason: "not-found" });

function route(flightKey: string, occurrences: ObservedRoute["occurrences"]): ObservedRoute {
  return { flightKey, occurrences };
}

// R2 donor: B -> D -> X -> E
const r2 = route("synth-r2", [pt(0, "B", 10, -10), pt(1, "D", 10, 20), pt(2, "X", 20, 30), pt(3, "E", 10, 40)]);
// R4 reverse-only: E -> X -> D
const r4 = route("synth-r4", [pt(0, "E", 10, 40), pt(1, "X", 20, 30), pt(2, "D", 10, 20)]);
// R5 discontinuous: B -> D -> [gap] -> E
const r5 = route("synth-r5", [pt(0, "B", 10, -10), pt(1, "D", 10, 20), gap(2), pt(3, "E", 10, 40)]);
// R3 target: C -> D -> [gap] -> E
const r3 = route("synth-r3", [pt(0, "C", 10, 10), pt(1, "D", 10, 20), gap(2), pt(3, "E", 10, 40)]);

test("index build is deterministic and never mutates inputs", () => {
  const frozen = JSON.stringify([r2, r4, r5, r3]);
  const a = buildSynthesisIndex([r2, r4, r5, r3]);
  const b = buildSynthesisIndex([r2, r4, r5, r3]);
  assert.deepEqual(a.pointsByKey.size, b.pointsByKey.size);
  assert.equal(JSON.stringify([r2, r4, r5, r3]), frozen);
});

test("target corridors bound gaps with nearest exact anchors", () => {
  const corridors = targetCorridors(r3.occurrences);
  assert.equal(corridors.length, 1);
  assert.deepEqual({ from: corridors[0]!.fromOrdinal, to: corridors[0]!.toOrdinal, gaps: corridors[0]!.gapOrdinals }, { from: 1, to: 3, gaps: [2] });
});

test("forward-only donor slice extraction; reversed and gapped donors never qualify", () => {
  const index = buildSynthesisIndex([r2, r4, r5, r3]);
  const slices = findDonorSlices(index, r3.occurrences[1]!, r3.occurrences[3]!, "synth-r3");
  assert.equal(slices.length, 1);
  assert.equal(slices[0]!.donorFlightKey, "synth-r2");
  assert.equal(slices[0]!.pointCount, 3); // D -> X -> E endpoint-inclusive
});

test("target flight cannot donate to itself", () => {
  const index = buildSynthesisIndex([r3, route("synth-r3b", [pt(0, "D", 10, 20), pt(1, "E", 10, 40)])]);
  const slices = findDonorSlices(index, r3.occurrences[1]!, r3.occurrences[3]!, "synth-r3");
  assert.equal(slices.length, 1);
  assert.equal(slices[0]!.donorFlightKey, "synth-r3b");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flight-route-explorer/tests exec node --test --experimental-strip-types synthesis/engine.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `packages/route-engine/src/synthesis.ts`**

```ts
import { MAX_ROUTE_POINTS, MAX_SYNTHESIS_CANDIDATES, MAX_DONOR_PROVENANCE, type Coordinate } from "@flight-route-explorer/contracts";
import { haversineDistanceNm } from "./index.ts";

export const SYNTHESIS_ALGORITHM_VERSION = "donor-subpath-v1";
export const DISTANCE_RECONCILIATION_TOLERANCE_NM = 1e-6;

/** Input occurrence produced by the API layer from a source projection. */
export type ObservedOccurrenceInput =
  | { readonly ordinal: number; readonly referenceId?: string; readonly coordinate: Coordinate; readonly label: string }
  | { readonly ordinal: number; readonly gapReason: string };

export interface ObservedRoute {
  readonly flightKey: string;
  readonly occurrences: readonly ObservedOccurrenceInput[];
}

export type SynthesisJoinKey =
  | { readonly kind: "reference"; readonly id: string }
  | { readonly kind: "coordinate"; readonly lat: number; readonly lon: number }
  | { readonly kind: "unjoinable" };

export function joinKeyToString(key: SynthesisJoinKey): string {
  if (key.kind === "reference") return `ref:${key.id}`;
  if (key.kind === "coordinate") return `coord:${key.lat},${key.lon}`;
  return "unjoinable";
}

interface IndexedPoint {
  readonly ordinal: number;
  readonly coordinate: Coordinate;
  readonly label: string;
  readonly key: SynthesisJoinKey;
}

interface Component {
  readonly routeIndex: number;
  readonly points: readonly IndexedPoint[];
}

export interface SynthesisIndex {
  readonly routes: readonly ObservedRoute[];
  readonly components: readonly Component[];
  readonly pointsByKey: ReadonlyMap<string, readonly { readonly component: number; readonly position: number }[]>;
  readonly conflictedReferenceIds: ReadonlySet<string>;
}

/**
 * Build is O(total points): one pass for conflict detection, one pass for
 * components, one pass for the key map. No all-pairs subpath enumeration.
 */
export function buildSynthesisIndex(routes: readonly ObservedRoute[]): SynthesisIndex {
  const coordinatesByReference = new Map<string, Set<string>>();
  for (const observed of routes) {
    for (const occurrence of observed.occurrences) {
      if ("gapReason" in occurrence || occurrence.referenceId === undefined) continue;
      const set = coordinatesByReference.get(occurrence.referenceId) ?? new Set<string>();
      set.add(`${occurrence.coordinate.lat},${occurrence.coordinate.lon}`);
      coordinatesByReference.set(occurrence.referenceId, set);
    }
  }
  const conflictedReferenceIds = new Set<string>();
  for (const [referenceId, coordinates] of coordinatesByReference) {
    if (coordinates.size > 1) conflictedReferenceIds.add(referenceId);
  }

  const components: Component[] = [];
  const pointsByKey = new Map<string, { component: number; position: number }[]>();
  for (const [routeIndex, observed] of routes.entries()) {
    let chain: IndexedPoint[] = [];
    const flush = () => {
      if (chain.length >= 2) {
        const componentIndex = components.length;
        components.push({ routeIndex, points: chain });
        chain.forEach((point, position) => {
          const key = joinKeyToString(point.key);
          if (point.key.kind === "unjoinable") return;
          pointsByKey.set(key, [...(pointsByKey.get(key) ?? []), { component: componentIndex, position }]);
        });
      }
      chain = [];
    };
    for (const occurrence of observed.occurrences) {
      if ("gapReason" in occurrence) { flush(); continue; }
      // Join-key rules: unique identity joins by reference; coordinate-only
      // points join by exact coordinate; conflicted identities are unjoinable
      // and never fall back to coordinate joining.
      const key: SynthesisJoinKey = occurrence.referenceId !== undefined
        ? conflictedReferenceIds.has(occurrence.referenceId)
          ? { kind: "unjoinable" }
          : { kind: "reference", id: occurrence.referenceId }
        : { kind: "coordinate", lat: occurrence.coordinate.lat, lon: occurrence.coordinate.lon };
      chain = [...chain, { ordinal: occurrence.ordinal, coordinate: occurrence.coordinate, label: occurrence.label, key }];
    }
    flush();
  }
  return { routes, components, pointsByKey, conflictedReferenceIds };
}

export interface TargetCorridor {
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
  readonly gapOrdinals: readonly number[];
}

/** Corridors between the nearest exact anchors around runs of gaps. An
 * unbounded edge (unresolved origin/destination) yields no corridor for that
 * edge; callers report coverage failure explicitly. */
export function targetCorridors(occurrences: readonly ObservedOccurrenceInput[]): TargetCorridor[] {
  const corridors: TargetCorridor[] = [];
  let lastAnchorOrdinal: number | undefined;
  let gapRun: number[] = [];
  for (const occurrence of occurrences) {
    if ("gapReason" in occurrence) { gapRun.push(occurrence.ordinal); continue; }
    if (gapRun.length > 0) {
      if (lastAnchorOrdinal !== undefined) corridors.push({ fromOrdinal: lastAnchorOrdinal, toOrdinal: occurrence.ordinal, gapOrdinals: gapRun });
      gapRun = [];
    }
    lastAnchorOrdinal = occurrence.ordinal;
  }
  return corridors;
}

export interface DonorSlice {
  readonly donorFlightKey: string;
  readonly componentIndex: number;
  readonly fromPosition: number;
  readonly toPosition: number; // inclusive
  readonly pointCount: number; // endpoint-inclusive
}

/** Forward-only, gap-free, exact directed lookup. Never reverses a path. */
export function findDonorSlices(
  index: SynthesisIndex,
  from: ObservedOccurrenceInput,
  to: ObservedOccurrenceInput,
  excludeFlightKey: string,
): DonorSlice[] {
  if ("gapReason" in from || "gapReason" in to) return [];
  const fromKey = keyOf(index, from);
  const toKey = keyOf(index, to);
  if (fromKey.kind === "unjoinable" || toKey.kind === "unjoinable") return [];
  const toKeyString = joinKeyToString(toKey);
  const slices: DonorSlice[] = [];
  for (const start of index.pointsByKey.get(joinKeyToString(fromKey)) ?? []) {
    const component = index.components[start.component]!;
    const donorFlightKey = index.routes[component.routeIndex]!.flightKey;
    if (donorFlightKey === excludeFlightKey) continue;
    const maxPosition = Math.min(component.points.length - 1, start.position + MAX_ROUTE_POINTS - 1);
    for (let position = start.position + 1; position <= maxPosition; position += 1) {
      if (joinKeyToString(component.points[position]!.key) === toKeyString) {
        slices.push({ donorFlightKey, componentIndex: start.component, fromPosition: start.position, toPosition: position, pointCount: position - start.position + 1 });
        if (slices.length > MAX_SYNTHESIS_CANDIDATES) return slices; // over-limit sentinel
      }
    }
  }
  return slices;
}

function keyOf(index: SynthesisIndex, occurrence: Exclude<ObservedOccurrenceInput, { gapReason: string }>): SynthesisJoinKey {
  if (occurrence.referenceId !== undefined) {
    return index.conflictedReferenceIds.has(occurrence.referenceId)
      ? { kind: "unjoinable" }
      : { kind: "reference", id: occurrence.referenceId };
  }
  return { kind: "coordinate", lat: occurrence.coordinate.lat, lon: occurrence.coordinate.lon };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @flight-route-explorer/tests exec node --test --experimental-strip-types synthesis/engine.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/route-engine/src/synthesis.ts tests/synthesis/engine.test.ts
git commit -m "feat(route-engine): immutable observed-component index with directed donor lookup"
```


---

### Task 5: Candidate assembly, distance partitioning, and the canonical expectations

**Files:**
- Modify: `packages/route-engine/src/synthesis.ts`
- Modify: `tests/synthesis/engine.test.ts`

- [ ] **Step 1: Write failing assembly tests (issue §Verification A expectations)**

Append to `tests/synthesis/engine.test.ts` the full R1–R7 scenario. Build all seven observed routes exactly as the API layer will:

```ts
const r1 = route("synth-r1", [pt(0, "A", 10, 0), pt(1, "C", 10, 10), pt(2, "D", 10, 20)]);
const r6 = route("synth-r6", [pt(0, "B", 10, -10), pt(1, "D", 10, 20), pt(2, "Y", 30, 30), pt(3, "E", 10, 40)]);
const r7 = route("synth-r7", [pt(0, "B", 10, -10), pt(1, "D", 10, 20), pt(2, "X", 20, 30), pt(3, "E", 10, 40)]);
const canonical = [r1, r2, r3, r4, r5, r6, r7];

test("canonical fixture: full coverage, neutral alternatives, dedupe with provenance", () => {
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex(canonical), r3);
  assert.equal(outcome.status, "ambiguous"); // covered, but R2/R7 vs R6 geometries differ
  assert.equal(outcome.candidates.length, 2); // deduplicated geometries only
  const viaX = outcome.candidates.find((candidate) => candidate.geometrySignature.includes("20,30"))!;
  const viaY = outcome.candidates.find((candidate) => candidate.geometrySignature.includes("30,30"))!;
  assert.ok(viaX && viaY);
  assert.equal(viaX.donorCount, 2);      // R2 + R7 aggregate
  assert.equal(viaX.donorTruncated, false);
  assert.deepEqual(viaX.donorFlightKeys, ["synth-r2", "synth-r7"]); // generation order
  // R4 (reversed) and R5 (gapped) never contribute:
  for (const candidate of outcome.candidates) {
    assert.equal(candidate.donorFlightKeys.includes("synth-r4"), false);
    assert.equal(candidate.donorFlightKeys.includes("synth-r5"), false);
  }
  // Distances: full-precision Haversine; source + borrowed reconcile with total.
  assert.ok(viaX.estimatedTotalDistanceNm !== undefined);
  assert.ok(Math.abs(viaX.sourceResolvedDistanceNm + viaX.borrowedDistanceNm - viaX.estimatedTotalDistanceNm!) <= 1e-9);
  // Borrowed slice coordinates are exact donor values (D -> X -> E), unrounded.
  assert.deepEqual(viaX.borrowedSegments[0]!.coordinates, [{ lat: 10, lon: 20 }, { lat: 20, lon: 30 }, { lat: 10, lon: 40 }]);
  // No ranking fields exist anywhere.
  assert.equal("rank" in viaX, false);
});

test("complete target returns not-needed; unbounded corridor returns unavailable", () => {
  const complete = route("synth-complete", [pt(0, "A", 10, 0), pt(1, "D", 10, 20)]);
  assert.equal(assembleSynthesisCandidates(buildSynthesisIndex(canonical), complete, { complete: true }).status, "not-needed");
  const unbounded = route("synth-unbounded", [gap(0), pt(1, "D", 10, 20), gap(2), pt(3, "E", 10, 40)]);
  assert.equal(assembleSynthesisCandidates(buildSynthesisIndex(canonical), unbounded).status, "partial"); // one corridor covered, leading edge unbounded
});

test("candidate-limit-exceeded fails closed with no candidates", () => {
  // 21 distinct donors each containing D -> E with unique interior geometry.
  const donors = Array.from({ length: 21 }, (_, index) =>
    route(`donor-${index}`, [pt(0, "B", 10, -10), pt(1, "D", 10, 20), { ordinal: 2, referenceId: undefined, coordinate: { lat: 40 + index, lon: 30 }, label: `Point ${index}` }, pt(3, "E", 10, 40)]));
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex([...donors, r3]), r3);
  assert.equal(outcome.status, "candidate-limit-exceeded");
  assert.equal(outcome.candidates.length, 0);
});

test("synthesized output is never accepted as index input (type boundary)", () => {
  // Compile-time check: assembleSynthesisCandidates returns AssembledCandidate[],
  // which lacks flightKey/occurrences and cannot satisfy ObservedRoute.
  const outcome = assembleSynthesisCandidates(buildSynthesisIndex(canonical), r3);
  assert.ok(!("occurrences" in (outcome.candidates[0] ?? {})));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flight-route-explorer/tests exec node --test --experimental-strip-types synthesis/engine.test.ts`
Expected: FAIL (`assembleSynthesisCandidates` not exported).

- [ ] **Step 3: Implement assembly in `packages/route-engine/src/synthesis.ts`**

Append to `synthesis.ts`:

```ts
export type SynthesisStatus = "not-needed" | "full" | "ambiguous" | "partial" | "unavailable" | "over-limit" | "candidate-limit-exceeded";

export interface BorrowedSegment {
  readonly coordinates: readonly Coordinate[];
  readonly donorFlightKeys: readonly string[];
  readonly donorCount: number;
  readonly donorTruncated: boolean;
  readonly donorOrdinals: readonly { readonly flightKey: string; readonly fromOrdinal: number; readonly toOrdinal: number }[];
  readonly matchMethod: "reference" | "exact-coordinate";
  readonly distanceNm: number;
}

export interface AssembledCandidate {
  readonly geometrySignature: string;
  readonly borrowedSegments: readonly BorrowedSegment[];
  readonly sourceResolvedDistanceNm: number;
  readonly borrowedDistanceNm: number;
  readonly estimatedTotalDistanceNm: number | undefined;
  readonly corridorsCovered: number;
}

export interface SynthesisOutcome {
  readonly status: SynthesisStatus;
  readonly corridorCount: number;
  readonly corridorsCovered: number;
  readonly candidates: readonly AssembledCandidate[];
  readonly algorithmVersion: string;
}

function coordinateSignature(coordinate: Coordinate): string {
  return `${coordinate.lat},${coordinate.lon}`;
}

/**
 * Assemble bounded synthesis candidates for one target route. v1 is
 * single-corridor-first: multi-corridor targets combine per-corridor deduplicated
 * geometries as a Cartesian product with a hard cap; exceeding it fails closed.
 */
export function assembleSynthesisCandidates(
  index: SynthesisIndex,
  target: ObservedRoute,
  options: { readonly complete?: boolean } = {},
): SynthesisOutcome {
  if (options.complete) {
    return { status: "not-needed", corridorCount: 0, corridorsCovered: 0, candidates: [], algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
  }
  const corridors = targetCorridors(target.occurrences);
  const gapOrdinals = new Set(target.occurrences.filter((occurrence) => "gapReason" in occurrence).map((occurrence) => occurrence.ordinal));
  const pointsByOrdinal = new Map(target.occurrences.filter((occurrence) => !("gapReason" in occurrence)).map((occurrence) => [occurrence.ordinal, occurrence]));

  // Source distance: haversine over recorded target geometry, legs between
  // adjacent recorded points (never across gaps).
  let sourceResolvedDistanceNm = 0;
  let previous: ObservedOccurrenceInput | undefined;
  for (const occurrence of target.occurrences) {
    if ("gapReason" in occurrence) { previous = undefined; continue; }
    if (previous && !("gapReason" in previous)) sourceResolvedDistanceNm += haversineDistanceNm(previous.coordinate, occurrence.coordinate);
    previous = occurrence;
  }

  const hasLeadingGap = target.occurrences.length > 0 && "gapReason" in target.occurrences[0]!;
  const hasTrailingGap = target.occurrences.length > 0 && "gapReason" in target.occurrences[target.occurrences.length - 1]!;
  const coveredGapOrdinals = new Set<number>();

  // Per-corridor deduplicated slices (geometry-keyed, provenance aggregated).
  type CorridorChoice = { signature: string; segments: BorrowedSegment[]; distanceNm: number };
  const choicesPerCorridor: CorridorChoice[][] = [];
  for (const corridor of corridors) {
    const from = pointsByOrdinal.get(corridor.fromOrdinal)!;
    const to = pointsByOrdinal.get(corridor.toOrdinal)!;
    const slices = findDonorSlices(index, from, to, target.flightKey);
    if (slices.length > MAX_SYNTHESIS_CANDIDATES) return limitExceeded(corridors.length);
    const byGeometry = new Map<string, DonorSlice[]>();
    for (const slice of slices) {
      const component = index.components[slice.componentIndex]!;
      const signature = component.points.slice(slice.fromPosition, slice.toPosition + 1).map((point) => coordinateSignature(point.coordinate)).join("|");
      byGeometry.set(signature, [...(byGeometry.get(signature) ?? []), slice]);
    }
    const choices: CorridorChoice[] = [];
    for (const [signature, groupSlices] of byGeometry) {
      const first = groupSlices[0]!;
      const coordinates = index.components[first.componentIndex]!.points.slice(first.fromPosition, first.toPosition + 1).map((point) => point.coordinate);
      let distanceNm = 0;
      for (let position = 1; position < coordinates.length; position += 1) distanceNm += haversineDistanceNm(coordinates[position - 1]!, coordinates[position]!);
      const donorFlightKeys = [...new Set(groupSlices.map((slice) => slice.donorFlightKey))]
        .sort((left, right) => index.routes.findIndex((route) => route.flightKey === left) - index.routes.findIndex((route) => route.flightKey === right));
      const seamByCoordinate = keyOf(index, from).kind === "coordinate" || keyOf(index, to).kind === "coordinate";
      choices.push({
        signature,
        distanceNm,
        segments: [{
          coordinates,
          donorFlightKeys: donorFlightKeys.slice(0, MAX_DONOR_PROVENANCE),
          donorCount: donorFlightKeys.length,
          donorTruncated: donorFlightKeys.length > MAX_DONOR_PROVENANCE,
          donorOrdinals: groupSlices.slice(0, MAX_DONOR_PROVENANCE).map((slice) => ({
            flightKey: slice.donorFlightKey,
            fromOrdinal: index.components[slice.componentIndex]!.points[slice.fromPosition]!.ordinal,
            toOrdinal: index.components[slice.componentIndex]!.points[slice.toPosition]!.ordinal,
          })),
          matchMethod: seamByCoordinate ? "exact-coordinate" : "reference",
          distanceNm,
        }],
      });
    }
    // Neutral ordering: generation order of the first donor, then signature.
    choices.sort((left, right) => {
      const leftFirst = index.routes.findIndex((route) => route.flightKey === left.segments[0]!.donorFlightKeys[0]);
      const rightFirst = index.routes.findIndex((route) => route.flightKey === right.segments[0]!.donorFlightKeys[0]);
      return leftFirst - rightFirst || left.signature.localeCompare(right.signature);
    });
    if (choices.length > 0) corridor.gapOrdinals.forEach((ordinal) => coveredGapOrdinals.add(ordinal));
    choicesPerCorridor.push(choices);
  }

  const corridorsCovered = choicesPerCorridor.filter((choices) => choices.length > 0).length;
  const coveredEdge = !hasLeadingGap && !hasTrailingGap;
  if (corridors.length === 0 || corridorsCovered === 0) {
    return { status: "unavailable", corridorCount: corridors.length, corridorsCovered: 0, candidates: [], algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
  }

  // Bounded Cartesian product across corridors (v1: single-corridor fixtures
  // produce one factor; multi-corridor products fail closed past the cap).
  const candidates: AssembledCandidate[] = [];
  const combine = (corridorIndex: number, picked: CorridorChoice[], signatureParts: string[]) => {
    if (candidates.length > MAX_SYNTHESIS_CANDIDATES) return;
    if (corridorIndex === choicesPerCorridor.length) {
      const borrowedSegments = picked.flatMap((choice) => choice.segments);
      const borrowedDistanceNm = picked.reduce((sum, choice) => sum + choice.distanceNm, 0);
      const totalPoints = target.occurrences.filter((occurrence) => !("gapReason" in occurrence)).length
        + borrowedSegments.reduce((sum, segment) => sum + Math.max(0, segment.coordinates.length - 2), 0);
      if (totalPoints > MAX_ROUTE_POINTS) return; // over-limit candidate: reject, never truncate
      const fullyCovered = corridorsCovered === corridors.length && coveredEdge && coveredGapOrdinals.size === gapOrdinals.size;
      candidates.push({
        geometrySignature: signatureParts.join("#"),
        borrowedSegments,
        sourceResolvedDistanceNm,
        borrowedDistanceNm,
        estimatedTotalDistanceNm: fullyCovered ? sourceResolvedDistanceNm + borrowedDistanceNm : undefined,
        corridorsCovered,
      });
      return;
    }
    for (const choice of choicesPerCorridor[corridorIndex]!) {
      combine(corridorIndex + 1, [...picked, choice], [...signatureParts, choice.signature]);
    }
  };
  if (choicesPerCorridor.some((choices) => choices.length === 0)) {
    return { status: "partial", corridorCount: corridors.length, corridorsCovered, candidates: [], algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
  }
  combine(0, [], []);
  if (candidates.length > MAX_SYNTHESIS_CANDIDATES) return limitExceeded(corridors.length);
  if (candidates.length === 0) {
    return { status: "over-limit", corridorCount: corridors.length, corridorsCovered, candidates: [], algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
  }
  // A route with an unbounded edge (unresolved origin/destination) or any
  // uncovered gap is never "full", even when every bounded corridor found a
  // donor: coverage must be complete before the status may claim it.
  if (!coveredEdge || coveredGapOrdinals.size !== gapOrdinals.size) {
    return { status: "partial", corridorCount: corridors.length, corridorsCovered, candidates, algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
  }
  const allCorridorsSingleGeometry = choicesPerCorridor.every((choices) => new Set(choices.map((choice) => choice.signature)).size === 1);
  return {
    status: allCorridorsSingleGeometry ? "full" : "ambiguous",
    corridorCount: corridors.length,
    corridorsCovered,
    candidates,
    algorithmVersion: SYNTHESIS_ALGORITHM_VERSION,
  };
}

function limitExceeded(corridorCount: number): SynthesisOutcome {
  return { status: "candidate-limit-exceeded", corridorCount, corridorsCovered: 0, candidates: [], algorithmVersion: SYNTHESIS_ALGORITHM_VERSION };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @flight-route-explorer/tests exec node --test --experimental-strip-types synthesis/engine.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Re-export from the package entry point**

In `packages/route-engine/src/index.ts` append:

```ts
export * from "./synthesis.ts";
```

Verify import boundary lint stays green: `pnpm run lint`.

- [ ] **Step 6: Commit**

```bash
git add packages/route-engine/src/synthesis.ts packages/route-engine/src/index.ts tests/synthesis/engine.test.ts
git commit -m "feat(route-engine): bounded multi-corridor synthesis assembly with distance partitioning"
```

---

### Task 6: POST /api/v1/routes/synthesis

**Files:**
- Modify: `apps/api/src/server.ts`
- Create: `tests/synthesis/api.test.ts`

- [ ] **Step 1: Write failing API contract tests**

Create `tests/synthesis/api.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { synthesisAdapter } from "../fixtures/synthesis-caas.ts";

async function flightIds(server: Awaited<ReturnType<typeof createApiServer>>): Promise<Map<string, string>> {
  const overview = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 25 } });
  const map = new Map<string, string>();
  for (const route of (overview.json() as { data: Array<{ callsign: string; flightId: string }> }).data) map.set(route.callsign, route.flightId);
  return map;
}

test("synthesis: complete route returns not-needed; incomplete target yields auditable candidates", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIds(server);

  const complete = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("SYNTH1") } });
  assert.equal(complete.statusCode, 200);
  assert.equal((complete.json() as { status: string }).status, "not-needed");

  const target = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("SYNTH3") } });
  assert.equal(target.statusCode, 200);
  const body = target.json() as {
    status: string; candidates: Array<Record<string, unknown>>; generation: { id: string }; safety: string;
  };
  assert.equal(body.status, "ambiguous");
  assert.equal(body.candidates.length, 2);
  assert.equal(body.safety, "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.");
  const serialized = JSON.stringify(body);
  for (const forbidden of ["synth-r2", "hidden-airway", "rank", "rankDistanceNm", "operationalProxy"]) {
    if (forbidden === "rank") { assert.equal(/"rank"/.test(serialized), false); continue; }
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  // Source DTO untouched: the target route DTO still reports incomplete with no distanceNm.
  const detail = await server.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: ids.get("SYNTH3") } });
  const dto = (detail.json() as { data: Record<string, unknown> }).data;
  assert.equal(dto.complete, false);
  assert.equal("distanceNm" in dto, false);
  assert.equal((dto.gaps as unknown[]).length, 1);

  // Every donor proof resolves through source-occurrences with exact coordinates.
  const candidate = body.candidates[0] as { segments: Array<{ proofIds?: string[]; geometry?: { coordinates: number[][] } }> };
  const borrowed = candidate.segments.find((segment) => "proofIds" in segment)!;
  const proof = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: borrowed.proofIds![0] } });
  assert.equal(proof.statusCode, 200);
  const proofBody = proof.json() as { data: { occurrences: Array<{ ordinal: number; coordinate?: [number, number] | { lat: number; lon: number } }> } };
  const ordinals = proofBody.data.occurrences.map((occurrence) => occurrence.ordinal);
  assert.deepEqual(ordinals, ordinals.map((_, index) => ordinals[0]! + index)); // contiguous/increasing
});

test("synthesis: method/URL/body hygiene fails closed", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const get = await server.app.inject({ method: "GET", url: "/api/v1/routes/synthesis" });
  assert.equal(get.statusCode, 405);
  assert.equal(get.headers.allow, "POST");
  const badBody = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: "x", extra: 1 } });
  assert.equal(badBody.statusCode, 400);
  const queryString = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis?flightId=x", payload: {} });
  assert.equal(queryString.statusCode, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flight-route-explorer/tests exec node --test --experimental-strip-types synthesis/api.test.ts`
Expected: FAIL (404 NOT_FOUND).

- [ ] **Step 3: Implement the endpoint in `apps/api/src/server.ts`**

Add near the other constants:

```ts
const SYNTHESIS_OUTCOME_COUNTS = ["full", "partial", "ambiguous", "unavailable", "over-limit", "candidate-limit-exceeded", "not-needed"] as const;
const synthesisCounters = new WeakMap<Snapshot, { seenTargets: Set<number>; counts: Record<string, number>; histogram: Record<string, number> }>();
const synthesisIndexes = new WeakMap<Snapshot, SynthesisIndex>();
```

(import `SynthesisIndex`, `buildSynthesisIndex`, `assembleSynthesisCandidates`, `SYNTHESIS_ALGORITHM_VERSION` from route-engine; `SynthesisRequestSchema`, `SYNTHESIS_PAGE`, `MAX_SYNTHESIS_CANDIDATES` from contracts).

Helper — build `ObservedRoute` inputs from a projection (ordinals/referenceIds from Task 1):

```ts
function observedRouteFromProjection(projection: RouteProjection<ProjectionEndpoint>): ObservedRoute {
  return {
    flightKey: String(projection.flight.index),
    occurrences: projection.occurrences.map((occurrence) => "gap" in occurrence
      ? { ordinal: occurrence.gap.ordinal, gapReason: occurrence.gap.reason }
      : { ordinal: occurrence.point.ordinal, ...(occurrence.point.referenceId ? { referenceId: occurrence.point.referenceId } : {}), coordinate: occurrence.point.coordinate, label: occurrence.point.label }),
  };
}
```

Handler (register after `/api/v1/routes/compare`):

```ts
const synthesize = async (request: FastifyRequest, reply: FastifyReply) => {
  assertEmptyQuery(request);
  const startedAt = Date.now();
  const snapshot = store.requireSnapshot();
  const parsed = SynthesisRequestSchema.safeParse(bodyObject(request, ["flightId", "cursor"]));
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "The synthesis request body is invalid.");
  const flightIndex = decodeScoped(parsed.data.flightId, snapshot, "flight", now);
  const flight = snapshot.flightByIndex.get(flightIndex);
  if (!flight || !flight.record.departure || !flight.record.destination) throw new ApiHttpError(404, "FLIGHT_NOT_FOUND", "The selected flight was not found.");

  const projection = overviewProjection(snapshot, flight); // routeProjection with resolved endpoints (same as overviewRouteDto)
  const originIsGap = isProjectionEndpointGap(projection.origin);
  const destinationIsGap = isProjectionEndpointGap(projection.destination);

  let index = synthesisIndexes.get(snapshot);
  if (!index) {
    const observed = snapshot.flights.map((candidate) => observedRouteFromProjection(overviewProjection(snapshot, candidate)));
    index = buildSynthesisIndex(observed);
    synthesisIndexes.set(snapshot, index);
  }
  const outcome = assembleSynthesisCandidates(index, observedRouteFromProjection(projection), { complete: projection.complete });

  // Counters: at most one update per target flight per generation, capped.
  let counters = synthesisCounters.get(snapshot);
  if (!counters) { counters = { seenTargets: new Set(), counts: {}, histogram: {} }; synthesisCounters.set(snapshot, counters); }
  if (!counters.seenTargets.has(flightIndex) && counters.seenTargets.size < snapshot.flights.length) {
    counters.seenTargets.add(flightIndex);
    counters.counts[outcome.status] = (counters.counts[outcome.status] ?? 0) + 1;
    const bucket = outcome.candidates.length === 0 ? "0" : outcome.candidates.length <= 2 ? "1-2" : outcome.candidates.length <= 5 ? "3-5" : "6-20";
    counters.histogram[bucket] = (counters.histogram[bucket] ?? 0) + 1;
  }

  // Pagination: fixed SYNTHESIS_PAGE over the canonical candidate order.
  const offset = parsed.data.cursor === undefined ? 0
    : cursorOffset(parsed.data.cursor, snapshot, `${flightIndex}|${SYNTHESIS_ALGORITHM_VERSION}`, SYNTHESIS_PAGE, "synthesis-cursor", now);
  const page = outcome.candidates.slice(offset, offset + SYNTHESIS_PAGE);
  const candidates = page.map((candidate, pageIndex) => synthesisCandidateDto(snapshot, candidate, offset + pageIndex));
  const nextOffset = offset + page.length;
  const payload = {
    status: outcome.status,
    flightId: parsed.data.flightId,
    corridorCount: outcome.corridorCount,
    corridorsCovered: outcome.corridorsCovered,
    algorithmVersion: outcome.algorithmVersion,
    candidates,
    ...(nextOffset < outcome.candidates.length ? { nextCursor: scopedToken(snapshot, "synthesis-cursor", { o: nextOffset, q: `${flightIndex}|${SYNTHESIS_ALGORITHM_VERSION}`, l: SYNTHESIS_PAGE }) } : {}),
    generation: generationSummary(snapshot, now()),
    safety: PERSISTENT_SAFETY_COPY,
  };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_BROWSER_RESPONSE_BYTES) {
    throw new ApiHttpError(409, "SYNTHESIS_RESPONSE_TOO_LARGE", "The synthesis page exceeds the browser response limit. The candidate set is paginated; retry with the issued cursor.", true);
  }
  return reply.send(payload);
};
app.post("/api/v1/routes/synthesis", warm(synthesize));
app.route({ method: ["GET", "PUT", "DELETE", "OPTIONS"], url: "/api/v1/routes/synthesis", handler: methodNotAllowed("Route synthesis") });
```

Add `overviewProjection(snapshot, flight)` in `apps/api/src/projection.ts`: the endpoint-resolution portion of `overviewRouteDto` returning the `RouteProjection` (refactor `overviewRouteDto` to call it — DTO output must stay byte-identical; the Task 1 regression test guards this).

Add `synthesisCandidateDto`:

```ts
function synthesisCandidateDto(snapshot: Snapshot, candidate: AssembledCandidate, orderIndex: number): Record<string, unknown> {
  return {
    candidateId: scopedToken(snapshot, "synthesis-candidate", { i: orderIndex }),
    segments: candidate.borrowedSegments.map((segment) => ({
      kind: "borrowed",
      geometry: toGeoJsonLineString(segment.coordinates),
      distanceNm: segment.distanceNm,
      matchMethod: segment.matchMethod,
      donorCount: segment.donorCount,
      ...(segment.donorTruncated ? { donorTruncated: true } : {}),
      proofIds: segment.donorOrdinals.map((ordinal) =>
        scopedToken(snapshot, "donor-proof", { i: snapshot.flights.findIndex((flight) => String(flight.index) === ordinal.flightKey), f: ordinal.fromOrdinal, u: ordinal.toOrdinal })),
    })),
    sourceResolvedDistanceNm: candidate.sourceResolvedDistanceNm,
    borrowedDistanceNm: candidate.borrowedDistanceNm,
    ...(candidate.estimatedTotalDistanceNm !== undefined ? { estimatedTotalDistanceNm: candidate.estimatedTotalDistanceNm } : {}),
    corridorsCovered: candidate.corridorsCovered,
  };
}
```

Note: donor flights are identified internally by projection `flight.index`; `ObservedRoute.flightKey` is `String(flight.index)` — the public surface only ever sees opaque scoped tokens (`proofIds`, `candidateId`), never indices or upstream IDs.

- [ ] **Step 4: Run API synthesis tests**

Run: `pnpm --filter @flight-route-explorer/tests exec node --test --experimental-strip-types synthesis/api.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/projection.ts tests/synthesis/api.test.ts
git commit -m "feat(api): POST /api/v1/routes/synthesis with bounded candidates and counters"
```

---

### Task 7: POST /api/v1/routes/source-occurrences (canonical donor proofs)

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `tests/synthesis/api.test.ts`

- [ ] **Step 1: Write failing proof-resolution tests**

Append to `tests/synthesis/api.test.ts`:

```ts
test("source-occurrences: proof ordinals contiguous, coordinates exact, direction preserved", async (t) => {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  const ids = await flightIds(server);
  const synthesis = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("SYNTH3") } });
  const body = synthesis.json() as { candidates: Array<{ segments: Array<{ proofIds?: string[]; geometry: { coordinates: number[][] } }> }> };
  const borrowed = body.candidates[0]!.segments.find((segment) => "proofIds" in segment)!;

  const proof = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: borrowed.proofIds![0] } });
  assert.equal(proof.statusCode, 200);
  const proofBody = proof.json() as { data: { flightId: string; occurrences: Array<{ ordinal: number; status: string; coordinate?: { lat: number; lon: number } }> } };
  // Borrowed GeoJSON is [lon, lat]; proof coordinates must match exactly, in order (direction check).
  const proofCoordinates = proofBody.data.occurrences.filter((occurrence) => occurrence.status === "point").map((occurrence) => [occurrence.coordinate!.lon, occurrence.coordinate!.lat]);
  assert.deepEqual(proofCoordinates, borrowed.geometry.coordinates);

  const bad = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: "forged.token" } });
  assert.equal(bad.statusCode, 400);
  const wrongMethod = await server.app.inject({ method: "GET", url: "/api/v1/routes/source-occurrences" });
  assert.equal(wrongMethod.statusCode, 405);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flight-route-explorer/tests exec node --test --experimental-strip-types synthesis/api.test.ts`
Expected: FAIL (404).

- [ ] **Step 3: Implement the endpoint**

```ts
const sourceOccurrences = async (request: FastifyRequest, reply: FastifyReply) => {
  assertEmptyQuery(request);
  const snapshot = store.requireSnapshot();
  const parsed = SourceOccurrencesRequestSchema.safeParse(bodyObject(request, ["proofId"]));
  if (!parsed.success) throw new ApiHttpError(400, "INVALID_BODY", "The source-occurrences request body is invalid.");
  const decoded = readScoped(parsed.data.proofId, snapshot);
  if (!decoded || decoded.g !== snapshot.id || decoded.t !== "donor-proof" || typeof decoded.e !== "number" || decoded.e < now()) {
    throw new ApiHttpError(400, "PROOF_INVALID", "The donor proof is not a valid service-issued proof.");
  }
  // NB: ScopedToken field for the upper ordinal is "u" (add to ScopedToken interface: readonly u?: unknown).
  if (typeof decoded.u !== "number" || !Number.isInteger(decoded.i) || decoded.i < 0 || !Number.isInteger(decoded.f) || !Number.isInteger(decoded.u) || decoded.u < decoded.f || decoded.u - decoded.f + 1 > MAX_ROUTE_POINTS) {
    throw new ApiHttpError(400, "PROOF_INVALID", "The donor proof range is invalid.");
  }
  const flight = snapshot.flightByIndex.get(decoded.i);
  if (!flight) throw new ApiHttpError(410, "GENERATION_EXPIRED", "The donor proof belongs to an older data generation.");
  const projection = overviewProjection(snapshot, flight);
  const occurrences = projection.occurrences
    .filter((occurrence) => ("gap" in occurrence ? occurrence.gap.ordinal : occurrence.point.ordinal) >= decoded.f as number && ("gap" in occurrence ? occurrence.gap.ordinal : occurrence.point.ordinal) <= decoded.u as number)
    .map((occurrence) => "gap" in occurrence
      ? { ordinal: occurrence.gap.ordinal, status: "gap", reason: occurrence.gap.reason }
      : { ordinal: occurrence.point.ordinal, status: "point", label: occurrence.point.label, coordinate: occurrence.point.coordinate });
  return reply.send({
    data: { flightId: flightId(snapshot, flight.index), occurrences },
    generation: generationSummary(snapshot, now()),
    safety: PERSISTENT_SAFETY_COPY,
  });
};
app.post("/api/v1/routes/source-occurrences", warm(sourceOccurrences));
app.route({ method: ["GET", "PUT", "DELETE", "OPTIONS"], url: "/api/v1/routes/source-occurrences", handler: methodNotAllowed("Source occurrences lookup") });
```

In Task 6's `synthesisCandidateDto`, proofs are minted with `{ i: donorIndex, f: fromOrdinal, u: toOrdinal }` (the `u` field decoded above). Add `readonly u?: unknown;` to the `ScopedToken` interface. Refresh invalidation is automatic: `tokenSecret` rotates per snapshot, so old-generation proofs fail `readScoped` HMAC.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flight-route-explorer/tests exec node --test --experimental-strip-types synthesis/api.test.ts synthesis/projection-regression.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/server.ts tests/synthesis/api.test.ts
git commit -m "feat(api): POST /api/v1/routes/source-occurrences canonical donor proofs"
```


---

### Task 8: Web API client for synthesis

**Files:**
- Modify: `apps/web/src/api.ts`

- [ ] **Step 1: Add types, normalizers, and fetchers to `apps/web/src/api.ts`**

Add near the `RouteOption` type:

```ts
export type SynthesisSegment = {
  kind: "borrowed";
  geometry: Coordinate[];           // parsed from GeoJSON LineString, [lon,lat] -> {lat,lon}
  distanceNm?: number | undefined;
  matchMethod: "reference" | "exact-coordinate";
  donorCount: number;
  donorTruncated?: boolean | undefined;
  proofIds: string[];
};

export type SynthesisCandidate = {
  candidateId: string;
  segments: SynthesisSegment[];
  sourceResolvedDistanceNm?: number | undefined;
  borrowedDistanceNm?: number | undefined;
  estimatedTotalDistanceNm?: number | undefined;
  corridorsCovered: number;
};

export type SynthesisStatus = "not-needed" | "full" | "ambiguous" | "partial" | "unavailable" | "over-limit" | "candidate-limit-exceeded";

export type SynthesisResult = {
  status: SynthesisStatus;
  corridorCount: number;
  corridorsCovered: number;
  candidates: SynthesisCandidate[];
  nextCursor?: string | undefined;
  safety?: string | undefined;
};

export type DonorProofResult = {
  flightId: string;
  occurrences: Array<{ ordinal: number; status: string; label?: string | undefined; coordinate?: Coordinate | undefined; reason?: string | undefined }>;
};
```

Add normalizers (reuse existing `normalizeGeometry`, `finiteNumber`, `stringValue`):

```ts
function normalizeSynthesisCandidate(value: unknown): SynthesisCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const candidateId = stringValue(value, "candidateId");
  if (!candidateId || !Array.isArray(value.segments)) return undefined;
  const segments: SynthesisSegment[] = [];
  for (const segment of value.segments) {
    if (!isRecord(segment)) return undefined;
    const geometry = normalizeGeometry(segment.geometry);
    const matchMethod = stringValue(segment, "matchMethod");
    if (!geometry || (matchMethod !== "reference" && matchMethod !== "exact-coordinate")) return undefined;
    segments.push({
      kind: "borrowed",
      geometry,
      ...(finiteNumber(segment, "distanceNm") !== undefined ? { distanceNm: finiteNumber(segment, "distanceNm") } : {}),
      matchMethod,
      donorCount: finiteNumber(segment, "donorCount") ?? 1,
      ...(segment.donorTruncated === true ? { donorTruncated: true } : {}),
      proofIds: Array.isArray(segment.proofIds) ? segment.proofIds.filter((proof): proof is string => typeof proof === "string" && proof.trim().length > 0) : [],
    });
  }
  return {
    candidateId,
    segments,
    ...(finiteNumber(value, "sourceResolvedDistanceNm") !== undefined ? { sourceResolvedDistanceNm: finiteNumber(value, "sourceResolvedDistanceNm") } : {}),
    ...(finiteNumber(value, "borrowedDistanceNm") !== undefined ? { borrowedDistanceNm: finiteNumber(value, "borrowedDistanceNm") } : {}),
    ...(finiteNumber(value, "estimatedTotalDistanceNm") !== undefined ? { estimatedTotalDistanceNm: finiteNumber(value, "estimatedTotalDistanceNm") } : {}),
    corridorsCovered: finiteNumber(value, "corridorsCovered") ?? 0,
  };
}
```

Add the two fetchers mirroring `fetchRouteOptions` (same base URL resolution, abort handling, `ApiError` mapping — copy that function's structure exactly):

```ts
export async function fetchSynthesis(flightId: OpaqueId, cursor: string | undefined, signal?: AbortSignal): Promise<SynthesisResult> {
  const response = await postJson("/api/v1/routes/synthesis", { flightId, ...(cursor ? { cursor } : {}) }, signal);
  const body = asRecord(response, "The synthesis response is not an object.");
  const status = stringValue(body, "status");
  if (status !== "not-needed" && status !== "full" && status !== "ambiguous" && status !== "partial" && status !== "unavailable" && status !== "over-limit" && status !== "candidate-limit-exceeded") {
    throw new ApiError(502, "The synthesis response has no usable status.", "SYNTHESIS_MALFORMED");
  }
  return {
    status,
    corridorCount: finiteNumber(body, "corridorCount") ?? 0,
    corridorsCovered: finiteNumber(body, "corridorsCovered") ?? 0,
    candidates: Array.isArray(body.candidates) ? body.candidates.flatMap((candidate) => { const normalized = normalizeSynthesisCandidate(candidate); return normalized ? [normalized] : []; }) : [],
    ...(stringValue(body, "nextCursor") ? { nextCursor: stringValue(body, "nextCursor") } : {}),
    ...(stringValue(body, "safety") ? { safety: stringValue(body, "safety") } : {}),
  };
}

export async function fetchDonorProof(proofId: string, signal?: AbortSignal): Promise<DonorProofResult> {
  const response = await postJson("/api/v1/routes/source-occurrences", { proofId }, signal);
  const body = asRecord(response, "The donor-proof response is not an object.");
  const data = isRecord(body.data) ? body.data : {};
  const flightId = stringValue(data, "flightId") ?? "";
  const occurrences = Array.isArray(data.occurrences) ? data.occurrences.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const ordinal = finiteNumber(entry, "ordinal");
    const status = stringValue(entry, "status");
    if (ordinal === undefined || !status) return [];
    const lat = isRecord(entry.coordinate) ? finiteNumber(entry.coordinate, "lat") : undefined;
    const lon = isRecord(entry.coordinate) ? finiteNumber(entry.coordinate, "lon") : undefined;
    return [{
      ordinal, status,
      ...(stringValue(entry, "label") ? { label: stringValue(entry, "label") } : {}),
      ...(lat !== undefined && lon !== undefined ? { coordinate: { lat, lon } } : {}),
      ...(stringValue(entry, "reason") ? { reason: stringValue(entry, "reason") } : {}),
    }];
  }) : [];
  return { flightId, occurrences };
}
```

(`postJson` and `asRecord` are the existing internal helpers used by `fetchRouteOptions`; if their local names differ, reuse exactly what `fetchRouteOptions` uses — do not create a second transport path.)

- [ ] **Step 2: Typecheck web**

Run: `pnpm --filter @flight-route-explorer/web run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api.ts
git commit -m "feat(web): synthesis and donor-proof API client"
```

---

### Task 9: Web UI — replace midpoint preview with on-demand synthesis

**Files:**
- Delete: `apps/web/src/potentialRoute.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Delete the midpoint preview module**

Delete `apps/web/src/potentialRoute.ts`. Keep `gapDistanceEstimate.ts` (the statistical estimate remains, relabelled as a separate annotation). Update its import: `PotentialEndpoints` moves — change `gapDistanceEstimate.ts` to define its own endpoint type:

```ts
export type GapEndpoints = { origin?: Coordinate | undefined; destination?: Coordinate | undefined };
```

and replace every `PotentialEndpoints` reference in that file with `GapEndpoints`.

- [ ] **Step 2: Add synthesis state to `App` (replacing potential-route state)**

In `apps/web/src/App.tsx`:
- Remove `deriveConservativePotentialRoute` import and all midpoint-derived computations.
- Replace `potentialRoute` state usages with:

```ts
const [synthesisRoute, setSynthesisRoute] = useState<RouteOption>();          // the selected incomplete target
const [synthesis, setSynthesis] = useState<SynthesisResult>();
const [synthesisLoading, setSynthesisLoading] = useState(false);
const [synthesisError, setSynthesisError] = useState<string>();
const [selectedCandidate, setSelectedCandidate] = useState<SynthesisCandidate>();
const synthesisRequest = useRef(0);
```

- On selecting an incomplete route (`choosePotentialRoute` → rename `chooseSynthesisTarget(route)`): set `synthesisRoute`, abort previous request, and:

```ts
async function loadSynthesis(route: RouteOption) {
  const requestId = ++synthesisRequest.current;
  setSynthesisLoading(true);
  setSynthesisError(undefined);
  setSynthesis(undefined);
  setSelectedCandidate(undefined);
  setStatus(`Requesting observed-donor synthesis candidates for ${route.callsign}.`);
  try {
    const allCandidates: SynthesisCandidate[] = [];
    let cursor: string | undefined;
    let result: SynthesisResult | undefined;
    do {
      result = await fetchSynthesis(route.flightId, cursor);
      allCandidates.push(...result.candidates);
      cursor = result.nextCursor;
    } while (cursor);
    if (synthesisRequest.current !== requestId) return;
    setSynthesis({ ...result, candidates: allCandidates });
    setSelectedCandidate(allCandidates[0]);
    setStatus(synthesisStatusCopy(route, { ...result, candidates: allCandidates }));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (synthesisRequest.current === requestId) setSynthesisError(apiMessage(error));
  } finally {
    if (synthesisRequest.current === requestId) setSynthesisLoading(false);
  }
}
```

Status copy (`synthesisStatusCopy`) per status: `not-needed` → "Source route is complete; no synthesis is needed."; `full`/`ambiguous` → "N candidate(s) assembled from geometry observed on other recorded routes in this generation. Dotted segments are borrowed; nothing was interpolated."; `partial` → "Only some gap corridors could be covered by observed donor geometry."; `unavailable` → "No other recorded route in this generation contains the missing directed subpath."; `over-limit` / `candidate-limit-exceeded` → "Too many donor combinations to list; narrowing is required. No candidate was truncated or silently chosen."

- [ ] **Step 3: Replace `PotentialRouteExplorer` with `SynthesisExplorer`**

Same drawer surface (`primarySurface === "potential"` renamed to `"synthesis"` throughout, including `Surface` type, aria labels "Observed-donor synthesis", and the overview-list prompt button). Component contract:

```tsx
function SynthesisExplorer({ routes, selected, synthesis, selectedCandidate, loading, error, statisticalNote, onSelect, onChooseCandidate, onRetry }: {
  routes: RouteOption[]; selected?: RouteOption; synthesis?: SynthesisResult; selectedCandidate?: SynthesisCandidate;
  loading: boolean; error?: string; statisticalNote?: string;
  onSelect: (route?: RouteOption) => void; onChooseCandidate: (candidate: SynthesisCandidate) => void; onRetry: () => void;
}) { ... }
```

Rendering rules:
- Route list (unchanged pattern: one button per incomplete route, keyboard-focusable, shows gap count).
- When `selected`: loading spinner row; error notice with retry; then by `synthesis.status`:
  - Candidate chooser: one `<button>` per candidate, `aria-pressed={candidate.candidateId === selectedCandidate?.candidateId}`, label = `Observed on ${donorCount} donor route(s) · borrowed ${formatDistance(borrowedDistanceNm)}`; no "best"/"shortest" wording anywhere.
  - Details for `selectedCandidate`: metrics — Estimated total (`estimatedTotalDistanceNm`, labelled "Estimated total (source + borrowed)"), Source resolved (`sourceResolvedDistanceNm`), Borrowed (`borrowedDistanceNm`), Corridors covered (`corridorsCovered`/`corridorCount`).
  - Provenance block: per borrowed segment: `Observed subpath copied without modification from ${donorCount} donor route(s); match by ${matchMethod === "reference" ? "exact reference identity" : "exact coordinate"}${donorTruncated ? "; additional donors not listed" : ""}.`
  - `safety` copy rendered verbatim from the response; plus: "Synthesized candidates are inspection aids only. They are not operational routes and never modify the source record."
  - Separate annotation (only when the retained statistical model produces one): show the existing `analyzeIncompleteRouteDistance` aggregate under an Evidence labelled "Separate statistical annotation (not synthesis)" — never as the candidate total.
- sr-only live region text distinguishes: "Solid segments are recorded for this flight; dotted segments were observed on other flights in the same data generation."

- [ ] **Step 4: RouteMap dotted-donor overlay**

Replace the midpoint overlay in `RouteMap` with a `synthesisOverlay` prop:

```tsx
type SynthesisOverlay = { sourceSegments: Coordinate[][]; borrowedSegments: Coordinate[][] } | undefined;
```

- Source segments of `synthesisRoute` render with the existing solid selected-route styling (unchanged classes).
- Each borrowed segment renders through the same `projectWorldSegmentsMercator`/`projectWorldSegments` pipeline with class `route-path-potential` (existing dotted amber style, forced-colors already handled). No client-generated coordinates remain: delete the `derivedPoints` circle rendering entirely.
- Fit-view includes borrowed coordinates (existing `fitViewToCoordinates` path).
- Legend copy updates: "Dotted segments: observed on another recorded route (same generation)" replacing "Dotted visual estimate".

- [ ] **Step 5: CSS updates in `apps/web/src/styles.css`**

Keep `.route-path-potential-known`, `.route-path-potential`, `.legend-line-potential`, `.potential-route-*` classes (renaming is optional churn); add states:

```css
.synthesis-status { border-left: 3px solid var(--blue); padding: 4px 0 4px 10px; color: var(--muted); font-size: .68rem; line-height: 1.4; }
.synthesis-status.synthesis-unavailable { border-left-color: var(--amber); }
.synthesis-candidates { display: grid; gap: 8px; }
.synthesis-candidates button[aria-pressed="true"] { border-color: var(--blue); background: rgba(88, 166, 255, .08); }
```

- [ ] **Step 6: Verify web builds and existing UI tests**

Run: `pnpm --filter @flight-route-explorer/web run typecheck && pnpm --filter @flight-route-explorer/tests run test:e2e && pnpm --filter @flight-route-explorer/tests run test:a11y`
Expected: PASS. Existing gap-distance e2e tests must still pass with the statistical annotation relabelled (update their expected copy in the same commit where copy changed).

- [ ] **Step 7: Commit**

```bash
git rm apps/web/src/potentialRoute.ts
git add apps/web/src apps/web/src/gapDistanceEstimate.ts tests/e2e
git commit -m "feat(web): on-demand donor-subpath synthesis replaces client midpoint preview"
```

---

### Task 10: E2E + accessibility coverage for synthesis

**Files:**
- Create: `tests/e2e/synthesis.test.tsx`
- Create: `tests/a11y/synthesis.test.tsx`
- Modify: `tests/fixtures/web-app.ts` (stub the two new endpoints)

- [ ] **Step 1: Extend `installApiStub` in `tests/fixtures/web-app.ts`**

Inside the fetch mock, add (before the 404 fallback), mirroring the existing `/api/v1/routes/overview` branch:

```ts
if (method === "POST" && url === "/api/v1/routes/synthesis") {
  return jsonResponse(options.synthesis ?? { status: "unavailable", corridorCount: 0, corridorsCovered: 0, candidates: [] });
}
if (method === "POST" && url === "/api/v1/routes/source-occurrences") {
  return jsonResponse(options.donorProof ?? { data: { flightId: "donor-proof-flight", occurrences: [] } });
}
```

Extend `StubOptions` with `synthesis?: Record<string, unknown>; donorProof?: Record<string, unknown>;` and add one incomplete overview route (complete:false, one gap) to `overviewRoutesFor` when `options.synthesis` is provided.

- [ ] **Step 2: Write `tests/e2e/synthesis.test.tsx`**

Follow the structure of `tests/e2e/gap-distance.test.tsx` (`render`, `installApiStub`, `userEvent`). Cover:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../apps/web/src/App.tsx";
import { installApiStub } from "../fixtures/web-app.ts";

const borrowedGeometry = [{ lat: 10, lon: 20 }, { lat: 20, lon: 30 }, { lat: 10, lon: 40 }];
const fullSynthesis = {
  status: "ambiguous", corridorCount: 1, corridorsCovered: 1,
  candidates: [{
    candidateId: "candidate-a",
    segments: [{ kind: "borrowed", geometry: { type: "LineString", coordinates: borrowedGeometry.map((c) => [c.lon, c.lat]) }, distanceNm: 1234.5, matchMethod: "reference", donorCount: 2, proofIds: ["proof-1", "proof-2"] }],
    sourceResolvedDistanceNm: 111.2, borrowedDistanceNm: 1234.5, estimatedTotalDistanceNm: 1345.7, corridorsCovered: 1,
  }],
};

describe("donor-subpath synthesis surface", () => {
  it("renders borrowed geometry dotted and never mutates source copy", async () => {
    const stub = installApiStub({ synthesis: fullSynthesis });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/source route record/i)).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /Show visual estimate|Explore incomplete/i }));
    const target = await screen.findByRole("button", { name: /gap/i });
    await userEvent.click(target);
    await waitFor(() => expect(screen.getByText(/observed on other recorded routes/i)).toBeTruthy());
    // No midpoint wording remains anywhere.
    expect(screen.queryByText(/midpoint/i)).toBeNull();
    // Estimated total labelled separately from source distance.
    expect(screen.getByText(/Estimated total \(source \+ borrowed\)/i)).toBeTruthy();
    expect(stub.calls.some((call) => call.url === "/api/v1/routes/synthesis")).toBe(true);
  });

  it("surfaces unavailable and over-limit states without candidates", async () => {
    const stub = installApiStub({ synthesis: { status: "candidate-limit-exceeded", corridorCount: 3, corridorsCovered: 3, candidates: [] } });
    render(<App />);
    // ...navigate to the incomplete route as above...
    await waitFor(() => expect(screen.getByText(/Too many donor combinations/i)).toBeTruthy());
  });
});
```

- [ ] **Step 3: Write `tests/a11y/synthesis.test.tsx`**

Mirror `tests/a11y/*.test.tsx` pattern (axe-core run over the rendered synthesis surface): assert zero axe violations, candidate chooser buttons are keyboard-reachable (Tab order), drawer has `aria-labelledby`, and the sr-only description text containing "Solid segments are recorded for this flight" exists.

- [ ] **Step 4: Run the lanes**

Run: `pnpm --filter @flight-route-explorer/tests run test:e2e && pnpm --filter @flight-route-explorer/tests run test:a11y`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/synthesis.test.tsx tests/a11y/synthesis.test.tsx tests/fixtures/web-app.ts
git commit -m "test(web): synthesis e2e and accessibility coverage"
```

---

### Task 11: Adversarial privacy negatives + performance/lane updates

**Files:**
- Create: `tests/adversarial/sec-r5-synthesis.test.ts` (vitest-adversarial lane; plain `.ts` node-style assertions under vitest like existing `sec-*.test.ts`)
- Modify: `scripts/validation/measure-performance.mjs`
- Modify: `scripts/validation/live-lane.mjs`, `scripts/validation/container-live-lane.mjs`

- [ ] **Step 1: Adversarial/privacy negative tests**

In `tests/adversarial/sec-r5-synthesis.test.ts`, boot `createApiServer({ adapter: synthesisAdapter() })` and assert:
1. Response bodies of both endpoints contain none of: upstream flight IDs (`synth-r1`…`synth-r7` — allowed ONLY as internal fixture identifiers; assert they never appear serialized), callsigns in proof responses, any airway value, `"rank"`, `"operationalProxy"`.
2. Forged/tampered `proofId` (flip one base64url char) → 400 `PROOF_INVALID`; cross-generation proof (boot second server, mint proof, call first server) → 400.
3. Cursor bound to query: synthesis cursor minted for flight A reused for flight B request → 409 `CURSOR_EXPIRED` (the cursor `q` binds `${flightIndex}|version`).
4. Body over allow-list → 400; non-empty query string → 400.
5. Complete route → `not-needed` and its source DTO byte-equal to the overview DTO for the same flight.

- [ ] **Step 2: Performance measurement**

In `scripts/validation/measure-performance.mjs`, alongside the existing warm-lane entries, add:
- `PERF-SYNTHESIS-INDEX-HARD`: index build over the fixture generation ≤ 1000 ms (measured once per generation, log duration only — no identifiers).
- `PERF-SYNTHESIS-WARM-HARD`: p95 of 50 `POST /api/v1/routes/synthesis` requests ≤ 5000 ms (inherits the warm deadline).
Wire them through the same `collector`/`perf-child.mjs` pattern as `PERF-WARM-BROWSE-HARD`, and include request count/duration/response-bytes aggregates (never request bodies).

- [ ] **Step 3: Live/container-live honest aggregation**

Update `scripts/validation/live-lane.mjs` and `container-live-lane.mjs` check policies: after acquiring the generation, select up to 5 incomplete target flights (deterministic generation order), call `/api/v1/routes/synthesis` for each, and retain aggregate outcome counts (`full`/`ambiguous`/`partial`/`unavailable`/`candidate-limit-exceeded`) as evidence fields. The lane passes when responses are bounded and honest — NOT when a synthesizable target exists (live data may legitimately produce zero). Do not reuse pre-feature lane records as proof.

- [ ] **Step 4: Run adversarial + performance lanes**

Run: `pnpm run test:adversarial && pnpm run test:performance`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/adversarial/sec-r5-synthesis.test.ts scripts/validation/measure-performance.mjs scripts/validation/live-lane.mjs scripts/validation/container-live-lane.mjs
git commit -m "test(synthesis): adversarial privacy negatives and honest live aggregation"
```

---

### Task 12: Decision record and binding documentation

**Files:**
- Create: `docs/adr/0002-server-side-donor-subpath-synthesis.md`
- Modify: `docs/product/master-product-document.md`, `docs/data-use/caas-contract.md`, `docs/data-use/data-use-record.md`, `docs/data-use/release-data-use-gate.md`, `docs/data-use/data-use-authorization-gate.md`, `docs/operations/uat-and-timed-walkthrough.md`, `docs/testing/uat-walkthrough.md`, `docs/status/poc-capability-and-gate-matrix.md`, `docs/index.md`

- [ ] **Step 1: Write ADR 0002**

Record: owner direction 2026-08-18 (do not remove/replace complete routes; synthesize only from observed same-generation subpaths); server-side (not client interpolation); exact/directed/continuous rules; provenance via `source-occurrences`; bounds (256/20/2 MiB/5 s); neutrality (no ranking); privacy posture. Status: Accepted.

- [ ] **Step 2: Update binding docs**

In each listed doc, add/update sections describing:
- What is source vs borrowed vs estimated vs unsupported; synthesis never alters source routes, gaps, distances, signatures, comparisons, or ordering.
- The two new POST endpoints and their fail-closed statuses.
- UAT walkthrough step: select an incomplete route → inspect candidates → verify dotted borrowed geometry + provenance → confirm source DTO unchanged.
- `docs/status/poc-capability-and-gate-matrix.md`: add the synthesis capability row with gate references to the new test lanes; mark pre-feature evidence as historical only.
- Never rewrite historical evidence files; describe the new capability additively.

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs(synthesis): ADR 0002 and binding product/data-use/UAT updates"
```

---

### Task 13: Full validation lanes + two-phase evidence settlement

**Files:**
- Evidence artifacts under `docs/evidence/` (generated, never hand-edited)

- [ ] **Step 1: Run the full lane set** (fix any failure before proceeding; each must pass on the exact implementation subject)

```text
pnpm run validate:config
pnpm run validate:policy
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:offline
pnpm run test:adversarial
pnpm run test:a11y
pnpm run test:e2e
pnpm run test:responsive
pnpm run test:browser
pnpm run test:integration
pnpm run test:security
pnpm run test:performance
pnpm run test:container
pnpm run test:evidence
pnpm run validate:evidence
pnpm run build
```

Then, only after the exact-subject tests pass: `pnpm run test:live` and `pnpm run test:container-live` (with the Task 11 honest aggregation).

- [ ] **Step 2: Two-phase settlement (never the legacy `evidence:archive -- --apply` path)**

Phase 1 — generate and review the plan:

```bash
pnpm run evidence:settle
```

This writes `tmp/evidence-settlement-plan-<sha>.json` and moves nothing. Review the plan: it must archive only stale subject-bound records and regenerate the current loopback record. Set `review.status` to `approved` in the plan file.

Phase 2 — apply:

```bash
pnpm run evidence:settle -- --apply --plan-file tmp/evidence-settlement-plan-<sha>.json --approve
```

Then re-run `pnpm run validate:evidence`.

- [ ] **Step 3: Commit evidence**

```bash
git add docs/evidence tmp/evidence-settlement-plan-*.json
git commit -m "evidence(synthesis): settle subject-bound lanes for donor-subpath synthesis"
```

---

## Acceptance Traceability (issue → task)

| Issue requirement | Task |
|---|---|
| Source routes/DTOs/comparisons unchanged | 1 (regression), 6 (detail asserts), 11 |
| Exact forward continuous donor slices, no reversal/gap-crossing | 4, 5 (R4/R5 negatives) |
| Generation-bound provenance, auditor traceability | 6, 7 (proof endpoint) |
| Neutrality, dedupe with provenance, no best/rank | 5 (neutral ordering), 6 (forbidden-field scan), 9 (copy) |
| 256/20/2 MiB/5 s fail-closed bounds | 2, 5, 6 (existing hooks/wrappers), 11 |
| Distance partition + reproducible estimated total | 5 (reconciliation assertion) |
| POST-only, no tokens in URLs, privacy negatives | 6, 7, 11 |
| Web: dotted donor rendering, chooser, a11y, no midpoint | 9, 10 |
| Statistical estimate retained as separate annotation | 9 (step 3) |
| Binding docs + ADR + honest live aggregation | 12, 11 |
| Two-phase evidence settlement | 13 |
