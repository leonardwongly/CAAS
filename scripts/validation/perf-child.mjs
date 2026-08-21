// Child process for performance measurement. Spawned by measure-performance.mjs
// so every "cold" run is a genuinely fresh process (module load, adapter
// construction, five-family acquisition) rather than an in-process warm call.
//
// Modes (first argv):
//   cold  - one fresh boot to readiness; prints {phase:"cold", readyMs, readyStatus, rssMb}
//   warm  - one fresh boot, then 10 warmup + 100 sampled requests per endpoint
//           with 1 Hz RSS sampling; additionally one synthesis index build
//           over the generation plus 1 warmup + 50 sampled
//           POST /api/v1/routes/synthesis requests; prints {phase:"warm", ...}
//
// The fixture apikey is consumed only by the deterministic mock transport; no
// live CAAS origin call is made by this measurement.
import { createApiServer } from "../../apps/api/src/index.ts";
import { observedRouteFromProjection } from "../../apps/api/src/server.ts";
import { overviewProjection } from "../../apps/api/src/projection.ts";
import { createCaasAdapter } from "../../packages/upstream-caas/src/index.ts";
import { buildSynthesisIndex } from "../../packages/route-engine/src/index.ts";
import { FIXTURE_API_KEY, createMockTransport, fixtureBodies } from "./fixtures.mjs";

const mode = process.argv[2] ?? "cold";
process.env.apikey = FIXTURE_API_KEY;

const startedAt = Date.now();
const server = await createApiServer({ adapter: createCaasAdapter({ transport: createMockTransport() }) });
await server.app.listen({ port: 0, host: "127.0.0.1" });
const address = server.app.server.address();
const base = `http://127.0.0.1:${address.port}`;

async function waitUntilReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/v1/health/ready`);
    if (response.status === 200) {
      const body = await response.json();
      if (body.status === "ready") return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return false;
}

const readyMs = Date.now() - startedAt;
const ready = await waitUntilReady();
if (!ready) {
  console.log(JSON.stringify({ phase: mode, error: "server never reached readiness" }));
  process.exit(2);
}

if (mode === "cold") {
  console.log(JSON.stringify({ phase: "cold", readyMs, readyStatus: 200, rssMb: Math.round(process.memoryUsage().rss / 1048576) }));
  await server.app.close();
  process.exit(0);
}

// Synthesis index build over the active generation, measured once. This
// reuses the server's exact reduction (observedRouteFromProjection) so the
// measured build is the build the server performs — duration only, no flight
// identifiers are ever printed or recorded.
const snapshot = server.store.readiness().snapshot;
const indexStartedAt = Date.now();
buildSynthesisIndex(snapshot.flights.map((flight) => observedRouteFromProjection(overviewProjection(snapshot, flight))));
const synthesisIndexBuildMs = Date.now() - indexStartedAt;

// Warm mode: 10 warmup requests, then 100 samples per endpoint with 1 Hz RSS
// sampling over the same window.
const rssPeak = { value: process.memoryUsage().rss };
const rssTimer = setInterval(() => {
  const current = process.memoryUsage().rss;
  if (current > rssPeak.value) rssPeak.value = current;
}, 1000);

const endpoint = async (path) => {
  const response = await fetch(`${base}${path}`);
  await response.text();
};

for (let i = 0; i < 10; i += 1) await endpoint("/api/v1/health/live");

const sample = async (path, count) => {
  const latencies = [];
  for (let i = 0; i < count; i += 1) {
    const sampleStarted = Date.now();
    await endpoint(path);
    latencies.push(Date.now() - sampleStarted);
  }
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.ceil(0.95 * latencies.length) - 1];
  return { p95Ms: p95, samples: latencies.length, maxMs: latencies[latencies.length - 1] };
};

const live = await sample("/api/v1/health/live", 100);
const browse = await sample("/api/v1/routes?limit=20", 100);

// Synthesis warm window: select the first incomplete target in deterministic
// generation order (fall back to the first flight), then 1 warmup request
// (which also triggers the server's own lazy index build) and 50 sampled
// POST /api/v1/routes/synthesis requests. Aggregates are request count,
// latency, and response bytes only — never request bodies.
const postJson = async (path, payload) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) };
};
let firstFlightId;
let firstIncompleteId;
let overviewCursor;
let overviewPages = 0;
const MAX_BROWSE_PAGES = 100;
while (overviewPages < MAX_BROWSE_PAGES && firstIncompleteId === undefined) {
  const page = await postJson("/api/v1/routes/overview", overviewCursor === undefined ? { limit: 100 } : { limit: 100, cursor: overviewCursor });
  if (page.status !== 200) throw new Error(`overview paging failed with ${page.status}`);
  const parsed = page.json();
  firstFlightId ??= parsed.data[0]?.flightId;
  firstIncompleteId ??= parsed.data.find((route) => route.complete === false)?.flightId;
  overviewCursor = parsed.nextCursor;
  overviewPages += 1;
  if (overviewCursor === undefined) break;
}
const synthesisTarget = firstIncompleteId ?? firstFlightId;
if (!synthesisTarget) throw new Error("the fixture generation has no flights to synthesize");
// Warmup also triggers the server's lazy index build; a non-200 here means
// the measured window would sample error paths, so fail loudly instead.
const synthesisWarmup = await postJson("/api/v1/routes/synthesis", { flightId: synthesisTarget });
if (synthesisWarmup.status !== 200) throw new Error(`synthesis warmup failed with ${synthesisWarmup.status}`);
const synthesisLatencies = [];
let synthesisResponseBytes = 0;
for (let i = 0; i < 50; i += 1) {
  const sampleStarted = Date.now();
  const response = await postJson("/api/v1/routes/synthesis", { flightId: synthesisTarget });
  if (response.status !== 200) throw new Error(`sampled synthesis request failed with ${response.status}`);
  synthesisLatencies.push(Date.now() - sampleStarted);
  synthesisResponseBytes += Buffer.byteLength(response.text, "utf8");
}
synthesisLatencies.sort((a, b) => a - b);
const synthesis = {
  p95Ms: synthesisLatencies[Math.ceil(0.95 * synthesisLatencies.length) - 1],
  maxMs: synthesisLatencies[synthesisLatencies.length - 1],
  samples: synthesisLatencies.length,
  responseBytes: synthesisResponseBytes,
};
clearInterval(rssTimer);
console.log(JSON.stringify({
  phase: "warm",
  readyMs,
  live: { p95Ms: live.p95Ms, maxMs: live.maxMs, samples: live.samples },
  browse: { p95Ms: browse.p95Ms, maxMs: browse.maxMs, samples: browse.samples },
  synthesisIndex: { buildMs: synthesisIndexBuildMs, flightCount: snapshot.flights.length },
  synthesis,
  rssPeakMb: Math.round(rssPeak.value / 1048576),
}));
await server.app.close();
process.exit(0);
