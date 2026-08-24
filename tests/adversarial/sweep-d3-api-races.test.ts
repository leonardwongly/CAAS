// Adversarial sweep owner/domain: D3 — API HTTP surface & envelope.
//
// Store/state races at the HTTP surface (capacity is owned by a dedicated lane; here we cover
// those): concurrent draft creation, reads racing an in-flight refresh,
// overlapping HTTP refreshes, and draft survival across a FAILED refresh.
//
// Complements the concurrency and cursor/2MiB race lanes,
// generation-concurrency (store state machine windows), and server.test
// (single-threaded draft invalidation after a successful refresh).
import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer, type CaasAdapter } from "../../apps/api/src/index.ts";
import { caasFixtureAdapter } from "../fixtures/caas-fixtures.ts";

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function generationId(response: { json(): unknown }): string {
  return String((response.json() as { generation: { id: string } }).generation.id);
}

async function createDraft(server: ApiServer): Promise<string> {
  const response = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "A", destination: "B" } });
  assert.equal(response.statusCode, 201, `draft creation must succeed, body=${response.body.slice(0, 160)}`);
  return String((response.json() as { id: string }).id);
}

test("D3 races: a concurrent draft-creation burst issues unique ids with zero 5xx", async (t) => {
  const server = await createApiServer({ adapter: caasFixtureAdapter() });
  t.after(() => server.app.close());

  const responses = await Promise.all(
    Array.from({ length: 64 }, () => server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "A", destination: "B" } })),
  );
  const ids = new Set<string>();
  for (const response of responses) {
    assert.equal(response.statusCode, 201, `every concurrent draft must be accepted, body=${response.body.slice(0, 160)}`);
    ids.add(String((response.json() as { id: string }).id));
  }
  assert.equal(ids.size, 64, "concurrent drafts must never collide on an id");
});

test("D3 races: reads racing an in-flight refresh observe one atomic generation swap", async (t) => {
  // The refresh acquisition is deliberately slowed so the read storm lands
  // squarely inside the swap window.
  const inner = caasFixtureAdapter();
  let displayCalls = 0;
  const adapter: CaasAdapter = {
    ...inner,
    displayAll: async () => {
      displayCalls += 1;
      if (displayCalls > 1) await delay(250);
      return inner.displayAll();
    },
  };
  const server = await createApiServer({ adapter, refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());

  const before = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 1 } });
  const oldId = generationId(before);

  const refreshPromise = server.app.inject({ method: "POST", url: "/api/v1/refresh" });
  await delay(50); // let the refresh start acquiring

  const observed = new Set<string>();
  const reads = await Promise.all(
    Array.from({ length: 30 }, (_, index) => server.app.inject(
      index % 2 === 0
        ? { method: "POST", url: "/api/v1/routes/overview", payload: { limit: 1 } }
        : { method: "GET", url: "/api/v1/points/lookup?reference=A" },
    )),
  );
  for (const response of reads) {
    assert.equal(response.statusCode, 200, `an in-flight refresh must never fail a read, body=${response.body.slice(0, 160)}`);
    observed.add(generationId(response));
  }

  const refresh = await refreshPromise;
  assert.equal(refresh.statusCode, 200, "the refresh completes");
  const newId = generationId(refresh);
  assert.notEqual(newId, oldId, "a successful refresh rotates the generation id");

  // Every read inside the window saw either the old or the new generation —
  // never a torn response, never a third half-installed snapshot.
  for (const id of observed) assert.ok(id === oldId || id === newId, `read observed an unknown generation ${id}`);

  const after = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 1 } });
  assert.equal(generationId(after), newId, "post-refresh reads serve the new generation");
});

test("D3 races: overlapping HTTP refreshes converge on the single served generation", async (t) => {
  const inner = caasFixtureAdapter();
  let displayCalls = 0;
  const adapter: CaasAdapter = {
    ...inner,
    displayAll: async () => {
      displayCalls += 1;
      if (displayCalls > 1) await delay(150);
      return inner.displayAll();
    },
  };
  const server = await createApiServer({ adapter, refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());

  const before = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 1 } });
  const originalId = generationId(before);

  const [first, second] = await Promise.all([
    server.app.inject({ method: "POST", url: "/api/v1/refresh" }),
    server.app.inject({ method: "POST", url: "/api/v1/refresh" }),
  ]);
  assert.equal(first.statusCode, 200, `first refresh succeeds, body=${first.body.slice(0, 160)}`);
  assert.equal(second.statusCode, 200, `second refresh succeeds, body=${second.body.slice(0, 160)}`);

  // The only generations a refresh may report are ones the store actually
  // serves: the pre-refresh generation (when the response lands before the
  // newer attempt installs) or the final installed one. A superseded refresh
  // must never claim its built-but-never-installed snapshot — that id is not
  // in { originalId, served }, so membership here proves the invariant.
  const served = server.store.requireSnapshot().id;
  assert.notEqual(served, originalId, "one of the overlapping refreshes installed a new generation");
  for (const [label, response] of [["first", first], ["second", second]] as const) {
    const reported = generationId(response);
    assert.ok(reported === originalId || reported === served, `${label} refresh reports a genuinely served generation`);
  }
  assert.ok(generationId(first) === served || generationId(second) === served, "the installing refresh reports the new generation");

  const after = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 1 } });
  assert.equal(generationId(after), served, "post-refresh reads serve the installed generation");
});

test("D3 races: drafts survive a failed refresh and die only with their generation", async (t) => {
  // Call 1 (initial acquisition) succeeds, call 2 (first refresh) fails,
  // call 3 (second refresh) succeeds again.
  const inner = caasFixtureAdapter();
  let displayCalls = 0;
  const adapter: CaasAdapter = {
    ...inner,
    displayAll: async () => {
      displayCalls += 1;
      if (displayCalls === 2) throw new Error("upstream flake");
      return inner.displayAll();
    },
  };
  const server = await createApiServer({ adapter, refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());

  const draftId = await createDraft(server);
  const consume = async (): Promise<number> =>
    (await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } })).statusCode;
  assert.equal(await consume(), 200, "the fresh draft is consumable");

  // A FAILED refresh must report the failure but never destroy in-flight
  // editing state: the generation is retained, so its drafts stay consumable.
  const failed = await server.app.inject({ method: "POST", url: "/api/v1/refresh" });
  assert.equal(failed.statusCode, 503, "the flaky refresh fails closed");
  assert.equal(String((failed.json() as { error: { code: string } }).error.code), "REFRESH_FAILED", "the failure names REFRESH_FAILED");
  assert.equal(await consume(), 200, "the draft survives the failed refresh");

  // A SUCCESSFUL refresh rotates the generation and invalidates the old
  // generation's drafts — the draft must fail closed, not resolve against
  // foreign generation data.
  const ok = await server.app.inject({ method: "POST", url: "/api/v1/refresh" });
  assert.equal(ok.statusCode, 200, "the recovered refresh succeeds");
  const expired = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });
  assert.equal(expired.statusCode, 410, "the pre-refresh draft is invalidated");
  assert.equal(String((expired.json() as { error: { code: string } }).error.code), "DRAFT_EXPIRED", "invalidation names DRAFT_EXPIRED");
});
