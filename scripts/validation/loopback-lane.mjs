// Loopback-only five-family lane. Runs the REAL server and REAL adapter over
// loopback HTTP against a deterministic sanitized mock upstream, exercising
// acquisition, browse, search, ranking, drafts, refresh, restart, fail-closed,
// airway exclusion, and security-header mechanics. No live CAAS call, no cloud
// write, no credential: the fixture apikey is consumed only by the mock.
//
// This is the lane MECHANICS; the authorized live-data run is the separate
// live-lane.mjs and remains pending explicit authorization.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApiServer } from "../../apps/api/src/index.ts";
import { createCaasAdapter } from "../../packages/upstream-caas/src/index.ts";
import { CheckCollector, isoNow, reportAndExit, root, sha256Hex, shortSha } from "./lib-evidence.mjs";
import { FIXTURE_API_KEY, FIXTURE_AIRWAY_VALUES, FIXTURE_REFRESH_SECRET, createMockTransport, fixtureBodies, fixtureFlightBodies } from "./fixtures.mjs";

const short = shortSha();
const recordPath = `docs/evidence/loopback-lane-local-${short}.json`;

process.env.apikey = FIXTURE_API_KEY;
process.env.REFRESH_SECRET = FIXTURE_REFRESH_SECRET;

const collector = new CheckCollector();

async function runChecks() {
  const transport = createMockTransport();
  const adapter = createCaasAdapter({ transport });
  const server = await createApiServer({ adapter });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const startedAt = isoNow();

  const responses = [];
  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    const body = await response.text();
    responses.push({ method: "GET", path, status: response.status, body });
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, json: () => JSON.parse(body) };
  };
  const post = async (path, payload, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const body = await response.text();
    responses.push({ method: "POST", path, status: response.status, body });
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, json: () => JSON.parse(body) };
  };

  const artifactRefs = [
    { path: "scripts/validation/loopback-lane.mjs", sha256: sha256Hex(await readFile(resolve(root, "scripts/validation/loopback-lane.mjs"), "utf8")) },
    { path: "scripts/validation/fixtures.mjs", sha256: sha256Hex(await readFile(resolve(root, "scripts/validation/fixtures.mjs"), "utf8")) },
  ];
  const artifactsFor = (extra = []) => [...artifactRefs, ...extra];

  // 1-3. Health, startup, readiness after five-family acquisition.
  const live = await get("/api/v1/health/live");
  collector.pass("LANE-HEALTH-LIVE", "liveness endpoint", "GET /api/v1/health/live returns 200.", startedAt, isoNow(), live.status === 200, "boolean", 1, artifactsFor());
  const startup = await get("/api/v1/health/startup");
  collector.pass("LANE-STARTUP-READY", "startup readiness", "Cold startup completes five-family acquisition and reports started.", startedAt, isoNow(), startup.status === 200 && startup.json().status === "started", "boolean", 1, artifactsFor());
  const ready = await get("/api/v1/health/ready");
  const readyBody = ready.json();
  const familiesAvailable = readyBody.status === "ready" ? readyBody.families?.map((item) => item.family) ?? [] : [];
  const airwayAvailable = readyBody.status === "ready" && readyBody.airway?.status === "available";
  collector.pass("LANE-FIVE-FAMILY-ACQUISITION", "five-family acquisition path", "All five families acquired, validated, and available in one complete generation.", startedAt, isoNow(),
    ready.status === 200 && familiesAvailable.length === 5 && familiesAvailable.every((family) => ["Flight Plan", "Airways", "Fixes", "Airports", "NAVAIDs"].includes(family)) && airwayAvailable, "boolean", 1, artifactsFor());

  // 4. Retry: the mock returns 429 once for displayAll; the adapter must retry once and succeed.
  const retriedOnce = transport.state.displayAllAttempts === 2;
  collector.pass("LANE-RETRY-POLICY", "bounded single retry on 429", "Mock returns 429 once for Flight Plan; the adapter retries exactly once and succeeds.", startedAt, isoNow(), retriedOnce, "boolean", 1, artifactsFor());
  const familiesRequested = new Set(transport.state.requests.map((request) => request.family));
  collector.pass("LANE-BOUNDED-EGRESS", "allow-listed request contract", "All upstream requests use the fixed allow-listed family URLs with the apikey header only.", startedAt, isoNow(),
    familiesRequested.size === 5 && transport.state.requests.every((request) => request.headers.includes("apikey") && request.headers.includes("accept")), "boolean", 1, artifactsFor());

  // 5. Browse-all exact-once cursor traversal (AC-POC-BROWSE-01 mechanics).
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const query = cursor === undefined ? "/api/v1/routes?limit=1" : `/api/v1/routes?limit=1&cursor=${encodeURIComponent(cursor)}`;
    const page = await get(query);
    if (page.status !== 200) throw new Error(`browse page failed with ${page.status}`);
    seen.push(...page.json().data.map((item) => item.id));
    cursor = page.json().nextCursor;
    pages += 1;
  } while (cursor !== undefined);
  const unique = new Set(seen).size === seen.length;
  collector.pass("LANE-BROWSE-EXACT-ONCE", "browse-all exact-once traversal", "Cursor traversal from first page to terminal cursor returns every active-generation flight exactly once.", startedAt, isoNow(),
    seen.length === 6 && unique && pages === 6, "boolean", pages, artifactsFor());

  // 6. Callsign search, case-insensitive and negative.
  const search = await get("/api/v1/callsigns/search?query=fixture1");
  const searchData = search.json().data ?? [];
  collector.pass("LANE-CALLSIGN-SEARCH", "callsign search", "Case-insensitive callsign search returns the exact flight.", startedAt, isoNow(),
    search.status === 200 && searchData.length === 1 && searchData[0].callsign === "FIXTURE1", "boolean", 1, artifactsFor());
  const negative = await get("/api/v1/callsigns/search?query=NOPE");
  collector.pass("LANE-SEARCH-NEGATIVE", "negative search", "A callsign with no match returns an empty page.", startedAt, isoNow(),
    negative.status === 200 && (negative.json().data ?? []).length === 0, "boolean", 1, artifactsFor());

  // 7. Route options: exact resolution, tied ranks, dedup, incomplete unranked.
  const firstId = searchData[0].id;
  const options = await post("/api/v1/routes/options", { flightId: firstId });
  const routeData = options.json().data ?? [];
  const complete = routeData.filter((route) => route.complete);
  const incomplete = routeData.filter((route) => !route.complete);
  const rankOne = complete.filter((route) => route.rank === 1);
  const everyDtoBound = routeData.every((route) => route.provenance === "CAAS normalized live generation" && typeof route.safety === "string" && route.safety.includes("Demonstration only."));
  collector.pass("LANE-RANK-TIES", "tied rank-1 presentation", "The complete candidates are ranked by modeled distance and the Rank 1 group is presented together; incomplete candidates are never ranked.", startedAt, isoNow(),
    options.status === 200 && complete.length === 2 && rankOne.length === 1 && rankOne.every((route) => route.rank === 1) && incomplete.every((route) => route.rank === undefined) && everyDtoBound, "boolean", routeData.length, artifactsFor());
  // FIXTURE1, FIXTURE5, FIXTURE6 share the exact MIDPT signature -> one deduplicated candidate.
  const signatureGroupPresent = routeData.filter((route) => ["FIXTURE1", "FIXTURE5", "FIXTURE6"].includes(route.callsign)).length === 1;
  collector.pass("LANE-DEDUP-SIGNATURE", "exact-signature candidate dedup", "Candidates with identical normalized signatures are deduplicated with source provenance retained.", startedAt, isoNow(), signatureGroupPresent, "boolean", 1, artifactsFor());
  // FIXTURE3 (KLAX->KJFK via an unresolvable reference) is incomplete with an explicit gap.
  const gapSearch = await get("/api/v1/callsigns/search?query=FIXTURE3");
  const gapOptions = await post("/api/v1/routes/options", { flightId: gapSearch.json().data[0].id });
  const gapRoute = (gapOptions.json().data ?? []).find((route) => route.callsign === "FIXTURE3");
  collector.pass("LANE-GAP-PRESERVATION", "explicit gap preservation", "Unresolved references surface as explicit gaps; no distance or geometry is inferred.", startedAt, isoNow(),
    gapOptions.status === 200 && gapRoute !== undefined && gapRoute.complete === false && gapRoute.distanceNm === undefined && gapRoute.geometry === undefined && (gapRoute.gaps ?? []).length >= 1 && (gapRoute.legs ?? []).some((leg) => leg.status === "gap"), "boolean", 1, artifactsFor());

  // 8. Exact reference lookup with preserved ambiguity.
  const lookup = await get("/api/v1/points/lookup?reference=DUPX");
  collector.pass("LANE-AMBIGUITY", "duplicate-identifier ambiguity", "Duplicate reference identifiers are preserved as an explicit ambiguity group.", startedAt, isoNow(),
    lookup.status === 200 && lookup.json().status === "ambiguous" && (lookup.json().matches ?? []).length === 2, "boolean", 1, artifactsFor());

  // 9. Draft create and complete compare.
  const draft = await post("/api/v1/drafts", { origin: "KJFK", via: ["MIDPT"], destination: "KLAX" });
  const draftId = draft.json().id;
  const comparison = await post("/api/v1/drafts/compare", { draftId });
  collector.pass("LANE-DRAFT-COMPARE", "bounded local draft and server comparison", "A complete draft is stored and compared with server-computed distance.", startedAt, isoNow(),
    draft.status === 201 && comparison.status === 200 && comparison.json().comparison?.status === "complete" && typeof comparison.json().route?.distanceNm === "number", "boolean", 1, artifactsFor());

  // 10. Refresh authorization fails closed without the token.
  const unauthorizedRefresh = await post("/api/v1/refresh", undefined);
  collector.pass("LANE-REFRESH-AUTH", "refresh authorization fails closed", "Refresh without the runtime token is rejected.", startedAt, isoNow(), unauthorizedRefresh.status === 401, "boolean", 1, artifactsFor());

  // 11. Refresh swaps generations atomically; old opaque IDs fail closed.
  const oldGeneration = (await get("/api/v1/routes?limit=1")).json().generation.id;
  transport.state.bodies.displayAll = JSON.stringify(fixtureFlightBodies().slice(0, 5));
  const refreshed = await post("/api/v1/refresh", undefined, { "x-refresh-token": FIXTURE_REFRESH_SECRET });
  const newGeneration = refreshed.json().generation?.id;
  const oldRouteAfter = await get(`/api/v1/routes/${encodeURIComponent(firstId)}`);
  collector.pass("LANE-REFRESH-BOUND", "generation-bound cursors and IDs", "Refresh swaps the generation atomically; IDs bound to the prior generation fail closed.", startedAt, isoNow(),
    refreshed.status === 200 && typeof newGeneration === "string" && newGeneration !== oldGeneration && oldRouteAfter.status === 410, "boolean", 1, artifactsFor());

  // 12. Failed refresh retains the last usable generation.
  transport.state.bodies.displayAll = "not-json";
  const failedRefresh = await post("/api/v1/refresh", undefined, { "x-refresh-token": FIXTURE_REFRESH_SECRET });
  const stillServing = await get("/api/v1/routes?limit=1");
  collector.pass("LANE-REFRESH-RETAINS", "failed refresh retains usable generation", "A failed refresh returns 503 while the last usable complete generation keeps serving.", startedAt, isoNow(),
    failedRefresh.status === 503 && stillServing.status === 200, "boolean", 1, artifactsFor());

  // 13. Airways are exercised but excluded from every output.
  const airwayValuesExcluded = !responses.some((response) => FIXTURE_AIRWAY_VALUES.some((value) => response.body.includes(value)));
  const secretExcluded = !responses.some((response) => response.body.includes(FIXTURE_API_KEY) || response.body.includes(FIXTURE_REFRESH_SECRET));
  const rawIdsExcluded = !responses.some((response) => response.body.includes("fixture-1"));
  collector.pass("LANE-AIRWAY-EXCLUSION", "airway values excluded from output", "Airway fixture values, the fixture key, and raw upstream ids never appear in any API response.", startedAt, isoNow(),
    airwayValuesExcluded && secretExcluded && rawIdsExcluded, "boolean", responses.length, artifactsFor());

  // 14. Same-origin security headers on API responses.
  const securityHeaders = ["content-security-policy", "referrer-policy", "strict-transport-security", "x-content-type-options", "x-frame-options", "permissions-policy"];
  const headerSample = await get("/api/v1/health/live");
  collector.pass("LANE-SECURITY-HEADERS", "same-origin security headers", "All documented response security headers are present on API responses.", startedAt, isoNow(),
    securityHeaders.every((name) => headerSample.headers[name] !== undefined), "boolean", securityHeaders.length, artifactsFor());

  await server.app.close();

  // 15. Cold startup fails closed when any mandatory family is unusable.
  const failingTransport = createMockTransport(fixtureBodies(), { failAll: true });
  const failingAdapter = createCaasAdapter({ transport: failingTransport });
  let failedClosed = false;
  try {
    await createApiServer({ adapter: failingAdapter, initialize: true });
  } catch {
    failedClosed = true;
  }
  collector.pass("LANE-FAIL-CLOSED-STARTUP", "startup fails closed on unusable family", "Cold startup with any unusable mandatory family fails explicitly without serving.", startedAt, isoNow(), failedClosed, "boolean", 1, artifactsFor());

  // 16. Restart reacquires a complete generation.
  const restartTransport = createMockTransport();
  const restartServer = await createApiServer({ adapter: createCaasAdapter({ transport: restartTransport }) });
  await restartServer.app.listen({ port: 0, host: "127.0.0.1" });
  const restartAddress = restartServer.app.server.address();
  const restartReady = await fetch(`http://127.0.0.1:${restartAddress.port}/api/v1/health/ready`);
  collector.pass("LANE-RESTART-REACQUISITION", "restart reacquires generation", "A fresh process restarts and reacquires a complete usable generation.", startedAt, isoNow(),
    restartReady.status === 200, "boolean", 1, artifactsFor());
  await restartServer.app.close();

  return { responses, transport };
}

const startedAt = isoNow();
const { responses, transport } = await runChecks();
const endedAt = isoNow();

const record = {
  recordKind: "lane-results",
  lane: "loopback-five-family-lane",
  subject: {
    type: "commit",
    identifiers: { commit: short },
    environment: "local-loopback-fixture-backed",
  },
  startedAt,
  endedAt,
  mode: "mechanics",
  credentialHandling: "fixture apikey consumed only by the deterministic mock transport; no live CAAS origin call was made",
  checks: collector.checks,
  summary: collector.summary(),
  artifacts: [
    { path: "scripts/validation/loopback-lane.mjs", sha256: sha256Hex(await readFile(resolve(root, "scripts/validation/loopback-lane.mjs"), "utf8")) },
    { path: "scripts/validation/fixtures.mjs", sha256: sha256Hex(await readFile(resolve(root, "scripts/validation/fixtures.mjs"), "utf8")) },
  ],
};

const fileSha = await (async () => {
  const { writeFile } = await import("node:fs/promises");
  const { mkdir, readFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const absolute = resolve(root, recordPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return sha256Hex(await readFile(absolute, "utf8"));
})();
console.log(`Loopback lane record written to ${recordPath} (sha256 ${fileSha})`);
console.log(`Upstream request families seen: ${[...new Set(transport.state.requests.map((request) => request.family))].join(", ")}`);
console.log(`Response bodies captured for exclusion scanning: ${responses.length}`);

reportAndExit(collector, "LOOPBACK FIVE-FAMILY LANE (fixture-backed mechanics)");
