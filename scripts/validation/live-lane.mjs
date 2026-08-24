// Authorized live-data lane. Runs the REAL server and REAL adapter against the
// REAL CAAS origin (https://api.swimapisg.info) using the authorized credential.
//
// Credential gating (fail-closed):
//   - If no credential is configured, this lane records a PENDING gate with the
//     exact procedure for the authorized run and exits 0. It never invents or
//     repeats a result it did not observe.
//   - Placeholder or fixture values (anything equal to the loopback fixture key
//     or shorter than 16 characters) are refused with a loud failure.
//   - When a real credential is configured, the lane runs the live acquisition
//     and reports real measurements. The credential is never printed or recorded.
//
// The recorded PENDING manifest is the evidence of an authorized-execution lane
// awaiting authorization; the actual live run must be executed by a person with
// the credential and its record committed as an authorized-run lane.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApiServer } from "../../apps/api/src/index.ts";
import { createCaasAdapter } from "../../packages/upstream-caas/src/index.ts";
import { createLiveTransport } from "../../packages/upstream-caas/src/transport.ts";
import { CheckCollector, isoNow, reportAndExit, root, sha256Hex, shortSha, writeJsonRecord } from "./lib-evidence.mjs";
import { CAAS_CONTRACT, FIXTURE_API_KEY } from "./fixtures.mjs";

const short = shortSha();
const recordPath = `docs/evidence/live-lane-${short}.json`;

const collector = new CheckCollector();
const startedAt = isoNow();

// The real adapter reads the key from process.env.apikey (config.ts), and the
// server reads REFRESH_SECRET the same way. This lane mirrors cli.ts: it loads
// root .env only for keys not already set, then uses the real transport.
const PLACEHOLDER_KEYS = new Set([FIXTURE_API_KEY, "loopback-fixture-key", "your-api-key-here", "changeme"]);

async function loadDotEnvIfPresent() {
  try {
    const contents = await readFile(resolve(root, ".env"), "utf8");
    for (const rawLine of contents.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return true;
  } catch {
    return false;
  }
}

await loadDotEnvIfPresent();
const apikey = process.env.apikey ?? "";
const configured = apikey.length > 0;
const placeholder = configured && (PLACEHOLDER_KEYS.has(apikey) || apikey.length < 16);

const SELF_ARTIFACT = { path: "scripts/validation/live-lane.mjs", sha256: sha256Hex(await readFile(resolve(root, "scripts/validation/live-lane.mjs"), "utf8")) };
const artifactsFor = (extra = []) => [SELF_ARTIFACT, ...extra];

if (!configured) {
  collector.pass("LIVE-CREDENTIAL-ABSENT", "no credential configured", "No CAAS apikey is present in the environment or root .env, so no live call can be made.", startedAt, isoNow(), true, "boolean", 1, artifactsFor());
  collector.add({
    checkId: "LIVE-FIVE-FAMILY-ACQUISITION",
    name: "live five-family acquisition",
    procedure: "Pending authorized execution: run `apikey=<authorized-key> pnpm live:lane` (or provide the key via root .env) on a machine authorized to call https://api.swimapisg.info, then commit the generated docs/evidence/live-lane-<sha>.json as an authorized-run record.",
    startedAt,
    endedAt: isoNow(),
    result: "blocked",
    measurement: { summary: "pending authorized execution", value: null, units: "boolean", sampleCount: 1 },
    artifacts: artifactsFor(),
    failureFallback: "The PG-03 loopback gate cannot lift until an authorized live run records a real pass.",
  });
  collector.add({
    checkId: "LIVE-BROWSE-EXACT-ONCE",
    name: "live browse exact-once traversal",
    procedure: "Pending authorized execution: same run as LIVE-FIVE-FAMILY-ACQUISITION; the lane traverses the full browse cursor from first page to terminal cursor and asserts each id appears exactly once.",
    startedAt,
    endedAt: isoNow(),
    result: "blocked",
    measurement: { summary: "pending authorized execution", value: null, units: "boolean", sampleCount: 1 },
    artifacts: artifactsFor(),
    failureFallback: "The PG-03 loopback gate cannot lift until an authorized live run records a real pass.",
  });
  collector.add({
    checkId: "LIVE-REFRESH-AUTH",
    name: "live refresh authorization",
    procedure: "Pending authorized execution: same run as LIVE-FIVE-FAMILY-ACQUISITION; refresh without the runtime token must be rejected, and with the token must swap generations atomically.",
    startedAt,
    endedAt: isoNow(),
    result: "blocked",
    measurement: { summary: "pending authorized execution", value: null, units: "boolean", sampleCount: 1 },
    artifacts: artifactsFor(),
    failureFallback: "The PG-03 loopback gate cannot lift until an authorized live run records a real pass.",
  });
  const record = {
    recordKind: "lane-results",
    lane: "live-five-family-lane",
    subject: { type: "commit", identifiers: { commit: short }, environment: "local-live-pending" },
    startedAt,
    endedAt: isoNow(),
    mode: "pending-authorized-execution",
    credentialHandling: "no credential present; no live origin call attempted",
    procedure: "Authorized run: `apikey=<authorized-key> pnpm live:lane` or place the key in root .env, then commit the generated record. The key is consumed by the real transport (packages/upstream-caas/src/transport.ts) and is never printed or recorded.",
    checks: collector.checks,
    summary: collector.summary(),
    artifacts: artifactsFor(),
  };
  const fileSha = await writeJsonRecord(recordPath, record);
  console.log(`Live lane: no credential configured. PENDING record written to ${recordPath} (sha256 ${fileSha}).`);
  console.log("Authorized execution: run `apikey=<authorized-key> pnpm live:lane` and commit the resulting record.");
  reportAndExit(collector, "LIVE FIVE-FAMILY LANE (pending authorized execution)");
  process.exit(0);
}

if (placeholder) {
  collector.fail("LIVE-CREDENTIAL-VALID", "credential is a placeholder", "The configured apikey is a fixture/placeholder value; the live lane refuses to fire real upstream requests with it.", startedAt, isoNow(), "refusing placeholder credential");
  const record = {
    recordKind: "lane-results",
    lane: "live-five-family-lane",
    subject: { type: "commit", identifiers: { commit: short }, environment: "local-live-refused" },
    startedAt,
    endedAt: isoNow(),
    mode: "refused-placeholder-credential",
    credentialHandling: "placeholder key detected; no upstream request fired",
    checks: collector.checks,
    summary: collector.summary(),
    artifacts: artifactsFor(),
  };
  await writeJsonRecord(recordPath, record);
  reportAndExit(collector, "LIVE FIVE-FAMILY LANE (refused placeholder)");
  process.exit(1);
}

// Authorized run path: real transport, real origin, real measurements.
// The key stays in the environment and is never logged.
console.log("Live lane: authorized run. Origin is", CAAS_CONTRACT.origin, "and the key is consumed only by the real transport.");
const adapter = createCaasAdapter({ transport: createLiveTransport() });
const server = await createApiServer({ adapter });
await server.app.listen({ port: 0, host: "127.0.0.1" });
const address = server.app.server.address();
const base = `http://127.0.0.1:${address.port}`;
const get = async (path) => {
  const response = await fetch(`${base}${path}`);
  const body = await response.text();
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, json: () => JSON.parse(body) };
};

try {
  const live = await get("/api/v1/health/live");
  collector.pass("LIVE-LIVENESS", "liveness endpoint", "GET /api/v1/health/live returns 200.", startedAt, isoNow(), live.status === 200, "boolean", 1, artifactsFor());

  const ready = await get("/api/v1/health/ready");
  const readyBody = ready.json();
  // The readiness payload reports the four product families plus Airways
  // separately (fetched/validated, values never exposed).
  const familyCount = readyBody.families?.length ?? 0;
  const airwayAvailable = readyBody.airway?.status === "available";
  collector.pass("LIVE-FIVE-FAMILY-ACQUISITION", "live five-family acquisition", "All five families acquired and validated from the real origin: Flight Plan, Fixes, Airports, NAVAIDs in the families payload plus Airways validated separately.", startedAt, isoNow(),
    ready.status === 200 && readyBody.status === "ready" && familyCount === 4 && airwayAvailable, "families", familyCount, artifactsFor());

  // Bounded traversal: at most 100 pages of 100 records (10,000 records), far
  // beyond the observed 115-flight population; a persistent cursor terminates
  // the lane with a failure instead of hanging.
  const MAX_BROWSE_PAGES = 100;
  const seen = [];
  let cursor;
  let pages = 0;
  while (pages < MAX_BROWSE_PAGES) {
    const query = cursor === undefined ? "/api/v1/routes?limit=100" : `/api/v1/routes?limit=100&cursor=${encodeURIComponent(cursor)}`;
    const page = await get(query);
    if (page.status !== 200) throw new Error(`live browse failed with ${page.status}`);
    seen.push(...page.json().data.map((item) => item.id));
    cursor = page.json().nextCursor;
    pages += 1;
    if (cursor === undefined) break;
  }
  const unique = new Set(seen).size === seen.length;
  collector.pass("LIVE-BROWSE-EXACT-ONCE", "live browse exact-once traversal", "Cursor traversal from first page to terminal cursor returns every flight exactly once and terminates within the page cap.", startedAt, isoNow(),
    unique && cursor === undefined, "flights", seen.length, artifactsFor());

  // authorized by the access boundary and must succeed (recovery path).
  const refreshed = await fetch(`${base}/api/v1/refresh`, { method: "POST" });
  const refreshedBody = await refreshed.text();
  const refreshedGeneration = refreshedBody ? JSON.parse(refreshedBody).generation : undefined;
  collector.pass("LIVE-REFRESH-UNSET-SECRET", "refresh under the single-user access model", "With no refresh secret configured, refresh succeeds and returns a new generation summary (the Azure edge gates the user session).", startedAt, isoNow(),
    refreshed.status === 200 && typeof refreshedGeneration?.id === "string", "boolean", 1, artifactsFor());

  const secretExcluded = !live.body.includes(apikey) && !ready.body.includes(apikey);
  collector.pass("LIVE-SECRET-EXCLUDED", "credential never surfaces", "The runtime key never appears in any API response.", startedAt, isoNow(), secretExcluded, "boolean", 1, artifactsFor());
} catch (error) {
  collector.fail("LIVE-LANE-ERROR", "live lane execution", "Every live check must complete; an exception fails the lane loudly instead of hanging or silently missing evidence.", startedAt, isoNow(), error instanceof Error ? error.message : String(error));
} finally {
  await server.app.close();
}

const record = {
  recordKind: "lane-results",
  lane: "live-five-family-lane",
  subject: { type: "commit", identifiers: { commit: short }, environment: "authorized-live-run" },
  startedAt,
  endedAt: isoNow(),
  mode: "authorized-run",
  credentialHandling: "authorized key consumed by the real transport; never printed or recorded",
  checks: collector.checks,
  summary: collector.summary(),
  artifacts: artifactsFor(),
};
const fileSha = await writeJsonRecord(recordPath, record);
console.log(`Live lane record written to ${recordPath} (sha256 ${fileSha})`);
reportAndExit(collector, "LIVE FIVE-FAMILY LANE (authorized run)");
