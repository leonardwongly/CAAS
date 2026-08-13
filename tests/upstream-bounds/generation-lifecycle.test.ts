import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer, GenerationAcquisitionError, GenerationStore } from "../../apps/api/src/index.ts";
import type { CaasAdapter, ReferenceDatasetResult } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter, sanitizedFlights } from "../fixtures/sanitized-caas.ts";

// Issue #30 evidence: the freshness/generation lifecycle — active generation,
// 30-minute expiry, atomic refresh, and the fail-closed invalidation of
// cursors, point references, and draft tokens.
//
// ACTUAL-behavior note (documented gap, not fixed here): plan §5.1 / design
// §0.2 require the active AND immediately previous generation to be retained
// for 30 minutes to complete in-flight interactions. The current
// GenerationStore retains only the active snapshot; on successful refresh the
// prior generation is dropped immediately and its cursors/draft tokens fail
// closed at once (409/410), not after a 30-minute window. Tests below capture
// that actual behavior. All fixtures are sanitized; no live data is used.

function referencePoints(dataset: "fixes" | "airports" | "navaids", count: number): ReferenceDatasetResult {
  const points = Array.from({ length: count }, (_unused, index) => ({ dataset, identifier: `X${index}`, coordinate: { lat: 1, lon: 1 } }));
  const index = new Map<string, readonly (typeof points)[number][]>();
  for (const point of points) index.set(point.identifier, [point]);
  return { dataset, points, index, evidence: { family: dataset, bytes: count * 4, records: count, acceptedRecords: count, rejectedRecords: 0, retried: false, durationMs: 0 } };
}

function failingAdapter(): CaasAdapter {
  return {
    displayAll: async () => { throw new Error("offline fixture unavailable"); },
    airways: async () => { throw new Error("offline fixture unavailable"); },
    fixes: async () => { throw new Error("offline fixture unavailable"); },
    airports: async () => { throw new Error("offline fixture unavailable"); },
    navaids: async () => { throw new Error("offline fixture unavailable"); },
  };
}

test("a fresh generation is ready and its expiry follows the 30-minute window", async () => {
  let clock = 1_700_000_000_000;
  const store = new GenerationStore(sanitizedAdapter(), () => clock, 30 * 60 * 1000);
  const snapshot = await store.initialize();
  assert.equal(store.status, "ready");
  assert.equal(store.readiness().ready, true);
  assert.equal(snapshot.summary.fresh, true);
  assert.equal(Date.parse(snapshot.summary.expiresAt) - Date.parse(snapshot.summary.createdAt), 30 * 60 * 1000);

  clock += 30 * 60 * 1000; // exactly at the expiry instant
  assert.equal(store.readiness().ready, false, "readiness fails once the generation is no longer fresh");
  assert.equal(store.readiness().code, "GENERATION_STALE");
  assert.throws(() => store.requireSnapshot(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "GENERATION_STALE");
    return true;
  });
});

test("a failed refresh retains the prior generation and its cursors while still fresh", async () => {
  const state = { failNext: false };
  const base = sanitizedAdapter();
  const adapter: CaasAdapter = {
    ...base,
    displayAll: async () => {
      if (state.failNext) throw new Error("offline fixture unavailable");
      return base.displayAll();
    },
  };
  let clock = 1_700_000_000_000;
  const store = new GenerationStore(adapter, () => clock, 30 * 60 * 1000);
  const first = await store.initialize();
  const firstId = first.summary.id;

  state.failNext = true;
  await assert.rejects(() => store.refresh(), (error: unknown) => {
    assert.ok(error instanceof GenerationAcquisitionError);
    assert.equal(error.causeCode, "UPSTREAM_UNAVAILABLE");
    return true;
  });
  assert.equal(store.status, "ready", "the store stays ready with the prior generation");
  assert.equal(store.failure, "UPSTREAM_UNAVAILABLE", "the failure code is recorded");
  assert.equal(store.readiness().ready, true);
  assert.equal(store.active?.summary.id, firstId, "the prior generation is still the active one");

  state.failNext = false;
  const second = await store.refresh();
  assert.notEqual(second.summary.id, firstId, "a later successful refresh replaces the generation");
});

test("a successful refresh drops the previous generation immediately (actual behavior; gap vs plan §5.1)", async () => {
  const state = { records: sanitizedFlights };
  const base = sanitizedAdapter(state.records);
  const adapter: CaasAdapter = { ...base, displayAll: async () => ({ records: state.records, evidence: { family: "displayAll", bytes: 128, records: state.records.length, acceptedRecords: state.records.length, rejectedRecords: 0, retried: false, durationMs: 0 } }) };
  const server = await createApiServer({ adapter, refreshSecret: "offline-refresh-secret" });
  try {
    const first = await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=1" });
    const firstBody = first.json() as { nextCursor?: string; generation: { id: string } };
    assert.ok(firstBody.nextCursor);
    const firstGeneration = firstBody.generation.id;

    state.records = [sanitizedFlights[1]!];
    const refreshed = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "offline-refresh-secret" } });
    assert.equal(refreshed.statusCode, 200);
    const refreshedGeneration = (refreshed.json() as { generation: { id: string } }).generation.id;
    assert.notEqual(refreshedGeneration, firstGeneration);

    // The prior generation is NOT retained for a 30-minute in-flight window:
    // its cursor fails closed immediately. This is the actual behavior and the
    // documented divergence from plan §5.1 ("active and immediately previous
    // generation retained for 30 minutes to complete in-flight interactions").
    const staleCursor = await server.app.inject({ method: "GET", url: `/api/v1/routes?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}` });
    assert.equal(staleCursor.statusCode, 409);
    assert.equal((staleCursor.json() as { error: { code: string } }).error.code, "CURSOR_EXPIRED");
  } finally {
    await server.app.close();
  }
});

test("generations never persist across a store instance (no cross-restart reuse)", async () => {
  const firstStore = new GenerationStore(sanitizedAdapter(), () => 1_700_000_000_000, 30 * 60 * 1000);
  const secondStore = new GenerationStore(sanitizedAdapter(), () => 1_700_000_000_000, 30 * 60 * 1000);
  const [first, second] = await Promise.all([firstStore.initialize(), secondStore.initialize()]);
  assert.notEqual(first.summary.id, second.summary.id, "every process/instance acquires a fresh generation UUID");

  const draftId = firstStore.rememberDraft({ origin: "KOR1", via: ["MIDPT"], destination: "KDS1" }, first);
  assert.throws(() => secondStore.getDraft(draftId, second), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "DRAFT_EXPIRED", "tokens minted by another instance fail closed");
    return true;
  });
});

test("draft tokens bind to their generation and are invalidated by refresh", async () => {
  const state = { records: sanitizedFlights };
  const base = sanitizedAdapter(state.records);
  const adapter: CaasAdapter = { ...base, displayAll: async () => ({ records: state.records, evidence: { family: "displayAll", bytes: 128, records: state.records.length, acceptedRecords: state.records.length, rejectedRecords: 0, retried: false, durationMs: 0 } }) };
  const store = new GenerationStore(adapter, () => 1_700_000_000_000, 30 * 60 * 1000);
  const first = await store.initialize();
  const draftId = store.rememberDraft({ origin: "KOR1", via: ["MIDPT"], destination: "KDS1" }, first);
  const draft = store.getDraft(draftId, first);
  assert.equal(draft.origin, "KOR1");

  const second = await store.refresh();
  assert.throws(() => store.getDraft(draftId, second), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "DRAFT_EXPIRED", "the draft belongs to the dropped generation");
    return true;
  });
});

test("draft capacity is bounded and fails closed with 429", async () => {
  const store = new GenerationStore(sanitizedAdapter(), () => 1_700_000_000_000, 30 * 60 * 1000);
  const snapshot = await store.initialize();
  for (let index = 0; index < 512; index += 1) store.rememberDraft({ origin: "KOR1", via: [], destination: "KDS1" }, snapshot);
  assert.throws(() => store.rememberDraft({ origin: "KOR1", via: [], destination: "KDS1" }, snapshot), (error: unknown) => {
    assert.equal((error as { statusCode?: number }).statusCode, 429);
    assert.equal((error as { code?: string }).code, "DRAFT_CAPACITY_REACHED");
    return true;
  });
});

test("acquisition fails closed beyond 700,000 aggregate records; the store collapses the cause", async () => {
  const adapter: CaasAdapter = {
    ...sanitizedAdapter(),
    fixes: async () => referencePoints("fixes", 300_000),
    airports: async () => referencePoints("airports", 300_000),
    navaids: async () => referencePoints("navaids", 100_001),
  };
  const store = new GenerationStore(adapter, () => 1_700_000_000_000, 30 * 60 * 1000);
  await assert.rejects(() => store.initialize(), (error: unknown) => {
    assert.ok(error instanceof GenerationAcquisitionError);
    // ACTUAL-behavior note (documented gap): acquireSnapshot computes and
    // throws GenerationAcquisitionError("REFERENCE_RECORD_LIMIT"), but the
    // store's catch re-throws a default GenerationAcquisitionError whose
    // causeCode is "UPSTREAM_UNAVAILABLE". The precise acquisition cause
    // never reaches the public surface today.
    assert.equal(error.causeCode, "UPSTREAM_UNAVAILABLE");
    return true;
  });
  assert.equal(store.status, "failed");
  assert.equal(store.readiness().code, "UPSTREAM_UNAVAILABLE");
});

test("cold startup failure surfaces as 503 and never serves partial data", async () => {
  const server = await createApiServer({ adapter: failingAdapter(), initialize: false });
  try {
    assert.equal((await server.app.inject({ method: "GET", url: "/readyz" })).statusCode, 503);
    assert.equal((await server.app.inject({ method: "GET", url: "/startupz" })).statusCode, 503);
    await assert.rejects(() => server.store.initialize(), GenerationAcquisitionError);
    const readiness = await server.app.inject({ method: "GET", url: "/readyz" });
    assert.equal(readiness.statusCode, 503);
    assert.equal((readiness.json() as { code: string }).code, "UPSTREAM_UNAVAILABLE");
  } finally {
    await server.app.close();
  }
});

test("a failed refresh surfaces as 503 REFRESH_FAILED while the prior generation keeps serving", async () => {
  const state = { failNext: false };
  const base = sanitizedAdapter();
  const adapter: CaasAdapter = {
    ...base,
    displayAll: async () => {
      if (state.failNext) throw new Error("offline fixture unavailable");
      return base.displayAll();
    },
  };
  let clock = 1_700_000_000_000;
  const server = await createApiServer({ adapter, now: () => clock, refreshSecret: "offline-refresh-secret" });
  try {
    assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=1" })).statusCode, 200);

    state.failNext = true;
    const failed = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "offline-refresh-secret" } });
    assert.equal(failed.statusCode, 503);
    assert.equal((failed.json() as { error: { code: string; retryable: boolean } }).error.code, "REFRESH_FAILED");
    assert.equal((failed.json() as { error: { retryable: boolean } }).error.retryable, true);

    assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=1" })).statusCode, 200, "the prior generation keeps serving");
  } finally {
    await server.app.close();
  }
});

test("cursors bind the generation id and carry no separate application-revision field", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter(), refreshSecret: "offline-refresh-secret" });
  try {
    const page = await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=1" });
    const body = page.json() as { nextCursor?: string; generation: { id: string } };
    assert.ok(body.nextCursor);
    const [encoded, signature] = body.nextCursor.split(".");
    assert.ok(encoded && signature);
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    assert.equal(decoded.g, body.generation.id, "the cursor binds the generation UUID");
    assert.equal(decoded.t, "browse-cursor");
    assert.equal(typeof decoded.e, "number");
    assert.equal(typeof decoded.n, "string");
    assert.equal(decoded.o, 1);
    assert.equal(decoded.q, "");
    assert.equal(decoded.l, 1);
    // ACTUAL-behavior note (documented gap): design §0.2 says tokens bind to
    // "application revision and generation", but no revision identifier is
    // present in the token; binding to a fresh per-process generation UUID is
    // the only mechanism, so a restart or redeploy invalidates tokens de facto.
    for (const key of ["r", "rev", "revision", "appRevision"]) assert.equal(decoded[key], undefined, `unexpected revision field ${key}`);
  } finally {
    await server.app.close();
  }
});
