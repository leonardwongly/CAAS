// Adversarial sweep owner/domain: D3 — API HTTP surface & envelope.
//
// Numeric and capacity boundaries on the public surface:
// - limit parsing is enforced identically across every paging family
//   (including hostile string spellings that Number() would accept).
// - the 64-character search-query bound is exact at the boundary.
// - body-only routes reject every query-string shape before parsing.
//
// Draft capacity (512 live drafts, 429 on overflow, TTL reclamation) is
// owned by tests/adversarial/sec-r4-0.test.ts; the sweep's duplicate of that
// sequence was consolidated there, keeping only this file's unique delta
// assertions (unique burst ids, DRAFT_CAPACITY_REACHED, retryable: true).
//
// Complements adv-tokens-proofs (draft TTL token semantics) and
// adv-api-concurrency (capacity under concurrency).
import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { caasFixtureAdapter } from "../fixtures/caas-fixtures.ts";

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["app"]["inject"]>>;

async function newServer(t: test.TestContext, options: Parameters<typeof createApiServer>[0] = {}): Promise<ApiServer> {
  const server = await createApiServer({ adapter: caasFixtureAdapter(), ...options });
  t.after(() => server.app.close());
  return server;
}

function parseCode(response: InjectResponse): string {
  return String((response.json() as { error?: { code?: string } }).error?.code);
}

const LIMIT_ENDPOINTS = [
  "/api/v1/routes/overview",
  "/api/v1/callsigns/search",
  "/api/v1/data/flights",
] as const;

test("D3 boundaries: limit bounds are enforced identically across paging families", async (t) => {
  const server = await newServer(t);
  for (const url of LIMIT_ENDPOINTS) {
    // The endpoint families have different required fields; limit validation
    // must fire regardless, so pair each family with a minimally valid body.
    const base = url === "/api/v1/callsigns/search" ? { query: "SYNTH" } : {};
    for (const limit of [1, 100, "1", "100"] as const) {
      const response = await server.app.inject({ method: "POST", url, payload: { ...base, limit } });
      assert.equal(response.statusCode, 200, `${url} limit=${JSON.stringify(limit)} must be accepted, body=${response.body.slice(0, 160)}`);
    }
    // Hostile spellings: Number() accepts several of these (" 5", "1e2",
    // "0x10"), so the decimal-integer bound must reject them all.
    for (const limit of [0, 101, -1, 1.5, Infinity, null, [], {}, true, "abc", "0x10", "1e2", " 5", "5 ", "+5", "٥"] as const) {
      const response = await server.app.inject({ method: "POST", url, payload: { ...base, limit } });
      assert.equal(response.statusCode, 400, `${url} limit=${JSON.stringify(limit)} must fail closed`);
      assert.equal(parseCode(response), "INVALID_LIMIT", `${url} limit=${JSON.stringify(limit)} must name INVALID_LIMIT`);
    }
  }
});

test("D3 boundaries: the 64-character search-query bound is exact", async (t) => {
  const server = await newServer(t);
  const atBound = await server.app.inject({ method: "POST", url: "/api/v1/search", payload: { query: "S" .repeat(64) } });
  assert.equal(atBound.statusCode, 200, "a 64-character query is still admissible");

  for (const query of ["S".repeat(65), "", "   ", 42, null, ["SYNTH"]] as const) {
    const response = await server.app.inject({ method: "POST", url: "/api/v1/search", payload: { query } });
    assert.equal(response.statusCode, 400, `query=${JSON.stringify(query)} must fail closed`);
    assert.equal(parseCode(response), "INVALID_QUERY", `query=${JSON.stringify(query)} must name INVALID_QUERY`);
  }
});

test("D3 boundaries: body-only routes reject every query string before parsing", async (t) => {
  const server = await newServer(t);
  // Repo rule (plan §2.4): parameters travel in POST bodies only. The
  // assertion fires before body parsing, so even a hostile body + query pair
  // must answer INVALID_QUERY — never INVALID_BODY or a silent success.
  const urls = [
    "/api/v1/routes/options",
    "/api/v1/drafts",
    "/api/v1/drafts/compare",
    "/api/v1/routes/compare",
  ];
  for (const url of urls) {
    for (const suffix of ["?probe=1", "?limit=1", "?="] as const) {
      const response = await server.app.inject({ method: "POST", url: url + suffix, payload: {} });
      assert.equal(response.statusCode, 400, `POST ${url}${suffix} must fail closed`);
      assert.equal(parseCode(response), "INVALID_QUERY", `POST ${url}${suffix} must name INVALID_QUERY`);
    }
  }
});
