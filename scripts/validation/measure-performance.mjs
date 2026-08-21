// Measured performance evidence (design section 6 quantitative policy).
//
//   PERF-COLD-START  3 fresh-process boots to readiness; measured value is the
//                    worst of the 3 (cold start policy: 120s objective, 180s hard).
//   PERF-WARM-LIVE   warm p95 over 100 sampled GET /api/v1/health/live requests
//                    after 10 warmup requests (2s objective, 5s hard).
//   PERF-WARM-BROWSE warm p95 over 100 sampled GET /api/v1/routes?limit=20 pages.
//   PERF-SYNTHESIS-INDEX one synthesis index build over the fixture generation
//                    (duration only, no identifiers; 1s hard).
//   PERF-SYNTHESIS-WARM warm p95 over 50 sampled POST /api/v1/routes/synthesis
//                    requests after a warmup (inherits the 5s warm hard bound).
//   PERF-MEMORY-PEAK peak RSS sampled at 1 Hz during the warm window
//                    (1.5 GiB target, 2 GiB hard).
//
// Every measurement is real: the values below are what this machine actually
// observed on a fixture-backed loopback server (no live network latency). The
// live-data and CI measurements are recorded as pending with the exact
// procedure; nothing is invented.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CheckCollector, isoNow, reportAndExit, root, sha256Hex, shortSha, writeJsonRecord } from "./lib-evidence.mjs";

const short = shortSha();
const recordPath = `docs/evidence/performance-local-${short}.json`;
const collector = new CheckCollector();
const startedAt = isoNow();

const SELF_ARTIFACTS = [
  { path: "scripts/validation/measure-performance.mjs", sha256: sha256Hex(await readFile(resolve(root, "scripts/validation/measure-performance.mjs"), "utf8")) },
  { path: "scripts/validation/perf-child.mjs", sha256: sha256Hex(await readFile(resolve(root, "scripts/validation/perf-child.mjs"), "utf8")) },
];
const artifactsFor = (extra = []) => [...SELF_ARTIFACTS, ...extra];

function runChild(mode) {
  return new Promise((resolvePromise, reject) => {
    const spawnedAt = Date.now();
    const child = spawn("node", ["--experimental-strip-types", "scripts/validation/perf-child.mjs", mode], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      const line = stdout.trim().split("\n").filter((entry) => entry.startsWith("{")).at(-1);
      if (code !== 0 || !line) {
        reject(new Error(`perf-child ${mode} exited ${code}: ${stderr.trim().slice(-400) || stdout.trim().slice(-400)}`));
        return;
      }
      const result = JSON.parse(line);
      resolvePromise({ ...result, spawnToReadyMs: Date.now() - spawnedAt });
    });
  });
}

const coldResults = [];
for (let i = 0; i < 3; i += 1) {
  const result = await runChild("cold");
  coldResults.push(result);
  console.log(`cold start #${i + 1}: ${result.spawnToReadyMs} ms (spawn to readiness; in-process init ${result.readyMs} ms), ${result.rssMb} MiB peak RSS`);
}
// True cold start: worst of 3 fresh-process spawn-to-readiness measurements.
const coldStartMs = Math.max(...coldResults.map((result) => result.spawnToReadyMs));
collector.pass("PERF-COLD-START", "cold start to readiness (worst of 3)", "Fresh-process boot through five-family acquisition to health/ready; policy 120s objective, 180s hard.", startedAt, isoNow(),
  coldStartMs, "milliseconds", coldResults.length,
  artifactsFor([{ path: "raw", sha256: "none", metadata: { coldStartMs, samplesMs: coldResults.map((result) => result.spawnToReadyMs), initMs: coldResults.map((result) => result.readyMs) } }]));

const warm = await runChild("warm");
collector.pass("PERF-WARM-LIVE", "warm p95 health/live latency", "100 sampled requests after 10 warmup; policy 2000ms objective, 5000ms hard.", startedAt, isoNow(),
  warm.live.p95Ms, "milliseconds", warm.live.samples,
  artifactsFor([{ path: "raw", sha256: "none", metadata: { p95Ms: warm.live.p95Ms, maxMs: warm.live.maxMs, samples: warm.live.samples } }]));
collector.pass("PERF-WARM-BROWSE", "warm p95 browse page latency", "100 sampled GET /api/v1/routes?limit=20 pages after warmup.", startedAt, isoNow(),
  warm.browse.p95Ms, "milliseconds", warm.browse.samples,
  artifactsFor([{ path: "raw", sha256: "none", metadata: { p95Ms: warm.browse.p95Ms, maxMs: warm.browse.maxMs, samples: warm.browse.samples } }]));
collector.pass("PERF-SYNTHESIS-INDEX", "synthesis index build over the generation", "One buildSynthesisIndex pass over the fixture generation's observed routes; measured once per generation, duration only (no identifiers).", startedAt, isoNow(),
  warm.synthesisIndex.buildMs, "milliseconds", 1,
  artifactsFor([{ path: "raw", sha256: "none", metadata: { buildMs: warm.synthesisIndex.buildMs, flightCount: warm.synthesisIndex.flightCount } }]));
collector.pass("PERF-SYNTHESIS-WARM", "warm p95 synthesis latency", "50 sampled POST /api/v1/routes/synthesis requests against the first incomplete target in generation order, after 1 warmup; aggregates are request count, latency, and response bytes only (never request bodies).", startedAt, isoNow(),
  warm.synthesis.p95Ms, "milliseconds", warm.synthesis.samples,
  artifactsFor([{ path: "raw", sha256: "none", metadata: { p95Ms: warm.synthesis.p95Ms, maxMs: warm.synthesis.maxMs, samples: warm.synthesis.samples, responseBytes: warm.synthesis.responseBytes } }]));
collector.pass("PERF-MEMORY-PEAK", "peak RSS during warm window", "Peak resident set sampled at 1 Hz during the warm measurement; policy 1536 MiB target, 2048 MiB hard.", startedAt, isoNow(),
  warm.rssPeakMb, "MiB", 1,
  artifactsFor([{ path: "raw", sha256: "none", metadata: { rssPeakMb: warm.rssPeakMb } }]));

// Policy evaluation: fail loudly if a hard bound is exceeded (recorded pass
// above already carries the measured value; here we assert the policy).
const policy = [
  { checkId: "PERF-COLD-START-HARD", limit: 180000, measured: coldStartMs },
  { checkId: "PERF-WARM-LIVE-HARD", limit: 5000, measured: warm.live.p95Ms },
  { checkId: "PERF-WARM-BROWSE-HARD", limit: 5000, measured: warm.browse.p95Ms },
  { checkId: "PERF-SYNTHESIS-INDEX-HARD", limit: 1000, measured: warm.synthesisIndex.buildMs },
  { checkId: "PERF-SYNTHESIS-WARM-HARD", limit: 5000, measured: warm.synthesis.p95Ms },
  { checkId: "PERF-MEMORY-HARD", limit: 2048, measured: warm.rssPeakMb },
];
for (const entry of policy) {
  const within = entry.measured <= entry.limit;
  collector.add({
    checkId: entry.checkId, name: `${entry.checkId.replace(/^PERF-|(?:-HARD)$/g, " ").trim()} within hard bound`,
    procedure: "Design section 6 hard bound; failing this keeps the gate red.",
    startedAt, endedAt: isoNow(), result: within ? "pass" : "fail",
    measurement: { summary: `${entry.measured} <= ${entry.limit}`, value: entry.measured, units: entry.limit >= 1000 ? "milliseconds" : "MiB", sampleCount: 1 },
    artifacts: artifactsFor(), failureFallback: "Keep the performance gate blocked until the hard bound is met.",
  });
}

const record = {
  recordKind: "measurement-results",
  lane: "performance",
  subject: { type: "commit", identifiers: { commit: short }, environment: "local-fixture-backed-loopback" },
  startedAt,
  endedAt: isoNow(),
  scope: "fixture-backed loopback server on this machine; no live network latency included",
  policy: { coldStartObjectiveMs: 120000, coldStartHardMs: 180000, warmP95ObjectiveMs: 2000, warmP95HardMs: 5000, memoryTargetMiB: 1536, memoryHardMiB: 2048 },
  pendingLive: "Live-data cold start and latency (with real acquisition over the network) are pending an authorized run: execute the measurement with the live transport (replace the mock in perf-child.mjs with createLiveTransport and the authorized apikey) and commit the resulting record.",
  pendingCi: "CI-measured values are pending the authoritative CI workflow run (oci-subject-build.yml / ci-secretless-validation.yml), which must be triggered by an authorized push.",
  checks: collector.checks,
  summary: collector.summary(),
  artifacts: artifactsFor(),
};
const fileSha = await writeJsonRecord(recordPath, record);
console.log(`Performance record written to ${recordPath} (sha256 ${fileSha})`);
console.log(`Cold start (worst of 3): ${coldStartMs} ms | warm p95 live: ${warm.live.p95Ms} ms | warm p95 browse: ${warm.browse.p95Ms} ms | synthesis index build: ${warm.synthesisIndex.buildMs} ms | warm p95 synthesis: ${warm.synthesis.p95Ms} ms | peak RSS: ${warm.rssPeakMb} MiB`);
reportAndExit(collector, "PERFORMANCE MEASUREMENT (fixture-backed loopback)");
