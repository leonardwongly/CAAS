// Child process for performance measurement. Spawned by measure-performance.mjs
// so every "cold" run is a genuinely fresh process (module load, adapter
// construction, five-family acquisition) rather than an in-process warm call.
//
// Modes (first argv):
//   cold  - one fresh boot to readiness; prints {phase:"cold", readyMs, readyStatus, rssMb}
//   warm  - one fresh boot, then 10 warmup + 100 sampled requests per endpoint
//           with 1 Hz RSS sampling; prints {phase:"warm", ...}
//
// The fixture apikey is consumed only by the deterministic mock transport; no
// live CAAS origin call is made by this measurement.
import { createApiServer } from "../../apps/api/src/index.ts";
import { createCaasAdapter } from "../../packages/upstream-caas/src/index.ts";
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
clearInterval(rssTimer);
console.log(JSON.stringify({
  phase: "warm",
  readyMs,
  live: { p95Ms: live.p95Ms, maxMs: live.maxMs, samples: live.samples },
  browse: { p95Ms: browse.p95Ms, maxMs: browse.maxMs, samples: browse.samples },
  rssPeakMb: Math.round(rssPeak.value / 1048576),
}));
await server.app.close();
process.exit(0);
