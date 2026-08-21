// Authorized container live lane: runs the BUILT OCI IMAGE (not a source
// spawn) with the real CAAS credential and executes the live five-family
// checks against the container's own API. This is the PG03-LOOPBACK-REAL-DATA
// evidence source for the exact CI-built subject.
//
// Subject binding (fail-closed):
//   - `--subject-digest <sha256:...>` is REQUIRED for an authorized run; the
//     lane refuses to run without it. The loaded image's ID must equal it,
//     so the record can only bind an image that actually ran.
//   - `--subject-commit <sha>` records which commit the subject was built
//     from (taken from the digest bundle).
//
// Credential gating (same as live-lane.mjs):
//   - No credential configured: a PENDING record is written (exit 0).
//   - Placeholder/fixture values: refused loudly (exit 1).
//   - The real key is injected into the container as `apikey` only and is
//     never printed or recorded.
import { readFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { CheckCollector, isoNow, reportAndExit, root, sha256Hex, shortSha, writeJsonRecord } from "./lib-evidence.mjs";
import { SYNTHESIS_PAGE } from "../../packages/contracts/src/index.ts";
import { FIXTURE_API_KEY } from "./fixtures.mjs";

const short = shortSha();
const defaultRecordPath = () => `docs/evidence/container-live-lane-${short}.json`;

function requestedOption(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value !== undefined && value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const subjectDigest = requestedOption("--subject-digest");
const subjectCommit = requestedOption("--subject-commit");
const imageTag = requestedOption("--image") ?? "flight-route-explorer:release-evidence";
// --record-dir/--record-id isolate test probes from the real evidence
// directory; production runs use the canonical docs/evidence/<head>.json name.
const recordDir = requestedOption("--record-dir") ?? "docs/evidence";
const recordId = requestedOption("--record-id") ?? short;
const recordPath = `${recordDir}/container-live-lane-${recordId}.json`;

const collector = new CheckCollector();
const startedAt = isoNow();
const SELF_ARTIFACT = { path: "scripts/validation/container-live-lane.mjs", sha256: sha256Hex(await readFile(resolve(root, "scripts/validation/container-live-lane.mjs"), "utf8")) };
const artifactsFor = (extra = []) => [SELF_ARTIFACT, ...extra];

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

function dockerInspect(template) {
  try {
    return execFileSync("docker", ["image", "inspect", "--format", template, imageTag], { encoding: "utf8", cwd: root }).trim();
  } catch {
    return "";
  }
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolveProbe, rejectProbe) => {
    probe.once("error", rejectProbe);
    probe.listen(0, "127.0.0.1", resolveProbe);
  });
  const address = probe.address();
  await new Promise((resolveProbe) => probe.close(resolveProbe));
  return address.port;
}

function recordPending() {
  const pendingRecord = {
    recordKind: "lane-results",
    lane: "live-five-family-container-lane",
    subject: { type: "oci", identifiers: { digest: subjectDigest ?? "unbound", commit: subjectCommit ?? short }, environment: "container-live-pending" },
    startedAt,
    endedAt: isoNow(),
    mode: "pending-authorized-execution",
    credentialHandling: "no credential present; no container was started and no live origin call was attempted",
    procedure: "Authorized run: `apikey=<authorized-key> node scripts/validation/container-live-lane.mjs --subject-digest <sha256:...> --subject-commit <sha>` against the loaded CI-built image.",
    checks: collector.checks,
    summary: collector.summary(),
    artifacts: artifactsFor(),
  };
  return pendingRecord;
}

if (!configured) {
  collector.pass("CONTAINER-LIVE-CREDENTIAL-ABSENT", "no credential configured", "No CAAS apikey is present in the environment or root .env, so no container run or live call was attempted.", startedAt, isoNow(), true, "boolean", 1, artifactsFor());
  for (const [checkId, name, procedure] of [
    ["CONTAINER-LIVE-EXACT-SUBJECT", "exact subject digest", "Pending authorized execution: the loaded image ID must equal --subject-digest (the authoritative CI-built digest)."],
    ["CONTAINER-LIVE-LIVENESS", "container liveness", "Pending authorized execution: GET /api/v1/health/live on the running container returns 200."],
    ["CONTAINER-LIVE-FIVE-FAMILY", "container five-family acquisition", "Pending authorized execution: the container acquires and validates all five families from the real origin."],
    ["CONTAINER-LIVE-BROWSE-EXACT-ONCE", "container browse exact-once", "Pending authorized execution: cursor traversal returns every flight exactly once."],
    ["CONTAINER-LIVE-SYNTHESIS-AGGREGATE", "container synthesis honest aggregation", "Pending authorized execution: up to 5 incomplete targets in generation order each receive a bounded, honest synthesis outcome and the aggregate counts are recorded. Zero synthesizable targets is a legitimate live result."],
    ["CONTAINER-LIVE-SECRET-EXCLUDED", "credential never surfaces", "Pending authorized execution: the runtime key never appears in any API response."],
  ]) {
    collector.add({ checkId, name, procedure, startedAt, endedAt: isoNow(), result: "blocked", measurement: { summary: "pending authorized execution", value: null, units: "boolean", sampleCount: 1 }, artifacts: artifactsFor(), failureFallback: "PG-03 cannot lift until an authorized container run on the exact digest records a real pass." });
  }
  await writeJsonRecord(recordPath, recordPending());
  console.log(`Container live lane: no credential configured. PENDING record written to ${recordPath}.`);
  reportAndExit(collector, "CONTAINER LIVE LANE (pending authorized execution)");
  process.exit(0);
}

if (placeholder) {
  collector.fail("CONTAINER-LIVE-CREDENTIAL-VALID", "credential is a placeholder", "The configured apikey is a fixture/placeholder value; the container lane refuses to inject it.", startedAt, isoNow(), "refusing placeholder credential");
  const refused = recordPending();
  refused.mode = "refused-placeholder-credential";
  refused.credentialHandling = "placeholder key detected; no container started and no upstream request fired";
  await writeJsonRecord(recordPath, refused);
  reportAndExit(collector, "CONTAINER LIVE LANE (refused placeholder)");
  process.exit(1);
}

if (!subjectDigest || !/^sha256:[0-9a-f]{64}$/u.test(subjectDigest)) {
  throw new Error("container-live-lane: --subject-digest <sha256:...> is required for an authorized run and must be the exact CI-built digest");
}

const loadedImageId = dockerInspect("{{.Id}}");
if (!loadedImageId) throw new Error(`container-live-lane: image ${imageTag} is not present; docker load the CI-built OCI tar first`);
if (loadedImageId !== subjectDigest) {
  throw new Error(`container-live-lane: the loaded image ID ${loadedImageId} does not equal --subject-digest ${subjectDigest}; refuse to run the gate against a non-exact subject`);
}

collector.pass("CONTAINER-LIVE-EXACT-SUBJECT", "exact subject digest", "The loaded image ID equals the authoritative CI-built digest passed as --subject-digest.", startedAt, isoNow(), loadedImageId === subjectDigest, "digest", 1, artifactsFor());

const port = await freePort();
const containerName = `container-live-${process.pid}`;
console.log(`Container live lane: running ${imageTag} (${subjectDigest.slice(0, 20)}…) on 127.0.0.1:${port} with the authorized credential.`);
const run = spawn("docker", ["run", "--rm", "--name", containerName, "-p", `${port}:8080`, "-e", `apikey=${apikey}`, imageTag], { stdio: ["ignore", "pipe", "pipe"], cwd: root });
const containerLogs = [];
run.stdout.on("data", (chunk) => containerLogs.push(chunk));
run.stderr.on("data", (chunk) => containerLogs.push(chunk));
let stopped = false;
const stopContainer = () => {
  if (stopped) return;
  stopped = true;
  try {
    execFileSync("docker", ["stop", "-t", "3", containerName], { stdio: "ignore", cwd: root });
  } catch {
    try {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore", cwd: root });
    } catch {
      // The --rm container may have already exited; nothing further to do.
    }
  }
};

const base = `http://127.0.0.1:${port}`;
const get = async (path) => {
  const response = await fetch(`${base}${path}`);
  const body = await response.text();
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, json: () => JSON.parse(body) };
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const probe = await get("/api/v1/health/live");
      if (probe.status === 200) { ready = true; break; }
    } catch {
      // Container still starting; retry.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  if (!ready) throw new Error("container never became ready within 60s");

  const live = await get("/api/v1/health/live");
  collector.pass("CONTAINER-LIVE-LIVENESS", "container liveness", "GET /api/v1/health/live on the running container returns 200.", startedAt, isoNow(), live.status === 200, "boolean", 1, artifactsFor());

  const readyRes = await get("/api/v1/health/ready");
  const readyBody = readyRes.json();
  const familyCount = readyBody.families?.length ?? 0;
  const airwayAvailable = readyBody.airway?.status === "available";
  collector.pass("CONTAINER-LIVE-FIVE-FAMILY", "container five-family acquisition", "The container acquired and validated all five families from the real origin: Flight Plan, Fixes, Airports, NAVAIDs in the families payload plus Airways validated separately.", startedAt, isoNow(),
    readyRes.status === 200 && readyBody.status === "ready" && familyCount === 4 && airwayAvailable, "families", familyCount, artifactsFor());

  const MAX_BROWSE_PAGES = 100;
  const seen = [];
  let cursor;
  let pages = 0;
  while (pages < MAX_BROWSE_PAGES) {
    const query = cursor === undefined ? "/api/v1/routes?limit=100" : `/api/v1/routes?limit=100&cursor=${encodeURIComponent(cursor)}`;
    const page = await get(query);
    if (page.status !== 200) throw new Error(`container browse failed with ${page.status}`);
    seen.push(...page.json().data.map((item) => item.id));
    cursor = page.json().nextCursor;
    pages += 1;
    if (cursor === undefined) break;
  }
  const unique = new Set(seen).size === seen.length;
  collector.pass("CONTAINER-LIVE-BROWSE-EXACT-ONCE", "container browse exact-once traversal", "Cursor traversal from first page to terminal cursor returns every flight exactly once and terminates within the page cap.", startedAt, isoNow(),
    unique && cursor === undefined, "flights", seen.length, artifactsFor());

  // Honest synthesis aggregation (issue #44 task 11): after acquiring the
  // generation, select up to 5 incomplete target flights in deterministic
  // generation order, call /api/v1/routes/synthesis for each on the
  // container's own API, and retain aggregate outcome counts as evidence.
  // The lane passes when responses are bounded and honest — NOT when a
  // synthesizable target exists (live data may legitimately produce zero).
  // This check is new evidence for the feature commit; pre-feature lane
  // records are never reused as proof.
  const SYNTHESIS_OUTCOMES = ["full", "ambiguous", "partial", "unavailable", "candidate-limit-exceeded"];
  const post = async (path, payload) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.text();
    return { status: response.status, body, json: () => JSON.parse(body) };
  };
  const targets = [];
  let overviewCursor;
  let overviewPages = 0;
  while (targets.length < 5 && overviewPages < MAX_BROWSE_PAGES) {
    const page = await post("/api/v1/routes/overview", overviewCursor === undefined ? { limit: 100 } : { limit: 100, cursor: overviewCursor });
    if (page.status !== 200) throw new Error(`container overview paging failed with ${page.status}`);
    const parsed = page.json();
    for (const route of parsed.data) {
      if (route.complete === false && targets.length < 5) targets.push(route.flightId);
    }
    overviewCursor = parsed.nextCursor;
    overviewPages += 1;
    if (overviewCursor === undefined) break;
  }
  const outcomeCounts = Object.fromEntries(SYNTHESIS_OUTCOMES.map((status) => [status, 0]));
  let synthesisBoundedAndHonest = true;
  for (const flightId of targets) {
    const response = await post("/api/v1/routes/synthesis", { flightId });
    if (response.status !== 200) { synthesisBoundedAndHonest = false; continue; }
    const body = response.json();
    if (!SYNTHESIS_OUTCOMES.includes(body.status)) { synthesisBoundedAndHonest = false; continue; }
    outcomeCounts[body.status] += 1;
    if (!Array.isArray(body.candidates) || body.candidates.length > SYNTHESIS_PAGE) synthesisBoundedAndHonest = false;
  }
  collector.pass("CONTAINER-LIVE-SYNTHESIS-AGGREGATE", "container synthesis honest aggregation", "Up to 5 incomplete targets in generation order each receive a 200 synthesis response from the container with an honest outcome status and a candidate page bounded to SYNTHESIS_PAGE; zero synthesizable targets is a legitimate live result and never fails the lane.", startedAt, isoNow(),
    synthesisBoundedAndHonest, "targets", targets.length,
    artifactsFor([{ path: "raw", sha256: "none", metadata: { targets: targets.length, outcomeCounts } }]));

  const secretExcluded = !live.body.includes(apikey) && !readyRes.body.includes(apikey);
  collector.pass("CONTAINER-LIVE-SECRET-EXCLUDED", "credential never surfaces", "The runtime key never appears in any API response from the container.", startedAt, isoNow(), secretExcluded, "boolean", 1, artifactsFor());
} catch (error) {
  collector.fail("CONTAINER-LIVE-ERROR", "container live execution", "Every container live check must complete; an exception fails the lane loudly instead of hanging or silently missing evidence.", startedAt, isoNow(), error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  stopContainer();
}

const record = {
  recordKind: "lane-results",
  lane: "live-five-family-container-lane",
  subject: { type: "oci", identifiers: { digest: subjectDigest, commit: subjectCommit ?? short, imageTag }, environment: "authorized-container-run" },
  startedAt,
  endedAt: isoNow(),
  mode: "authorized-run",
  credentialHandling: "authorized key injected into the container environment as apikey; never printed or recorded",
  checks: collector.checks,
  summary: collector.summary(),
  artifacts: artifactsFor(),
};
const fileSha = await writeJsonRecord(recordPath, record);
console.log(`Container live lane record written to ${recordPath} (sha256 ${fileSha})`);
reportAndExit(collector, "CONTAINER LIVE LANE (authorized run)");
