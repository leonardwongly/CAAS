// Adversarial sweep owner/domain: D3 — API HTTP surface & envelope.
//
// Method and URL hygiene across the whole registered surface:
// - Every wrong verb on every STATIC route answers the bounded 405 envelope
//   with a correct Allow header (regression: most families previously fell
//   through to unstructured 404s for PUT/DELETE/OPTIONS/PATCH).
// - Parametric resources (:routeId, :reference) keep the bounded 404
//   unknown-route envelope for wrong verbs — pinned by the reference suite.
// - Trailing-slash, case, percent-encoding, and over-long-param variants are
//   bounded envelopes with no path/method reflection.
// - The static-asset fallback (assetDirectory) serves the SPA safely and
//   rejects traversal.
//
// Complements (does not duplicate) sec-4 (unknown-path/wrong-method envelope
// on a few paths), sec-5 (routes/options + routes/compare GET 405), and
// adv-api-malformed (synthesis/source-occurrences 405s).
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { synthesisAdapter } from "../fixtures/synthesis-caas.ts";

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["app"]["inject"]>>;

async function newServer(t: test.TestContext): Promise<ApiServer> {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  return server;
}

interface Envelope { error: { code: string; message: string } }

function assertEnvelope(response: InjectResponse, status: number, code: string, context: string): Envelope {
  assert.equal(response.statusCode, status, `${context}: expected ${status}, body=${response.body.slice(0, 200)}`);
  assert.ok(String(response.headers["content-type"] ?? "").startsWith("application/json"), `${context}: envelope content-type must be JSON`);
  const parsed = response.json() as Envelope;
  assert.ok(parsed.error && typeof parsed.error === "object", `${context}: envelope must carry an error object`);
  assert.equal(parsed.error.code, code, `${context}: expected code ${code}`);
  assert.equal(typeof parsed.error.message, "string", `${context}: bounded message`);
  assert.ok(parsed.error.message.length <= 160, `${context}: message stays bounded`);
  return parsed;
}

const POST_ONLY_ALLOW_POST = [
  "/api/v1/callsigns/search",
  "/api/v1/search",
  "/api/v1/flights/search",
  "/api/v1/routes/overview",
  "/api/v1/routes/synthesis",
  "/api/v1/routes/source-occurrences",
  "/api/v1/routes/options",
  "/api/v1/route-options",
  "/api/v1/data/flights",
  "/api/v1/data/fixes",
  "/api/v1/data/airports",
  "/api/v1/data/navaids",
  "/api/v1/drafts",
  "/api/v1/drafts/compare",
  "/api/v1/compare",
  "/api/v1/routes/compare",
  "/api/v1/refresh",
  "/api/v1/admin/refresh",
  "/api/v1/points",
] as const;

const GET_ONLY_ALLOW_GET = [
  "/api/v1/routes/browse",
  "/api/v1/browse",
  "/api/v1/flights",
  "/api/v1/data/summary",
] as const;

test("D3 methods: every wrong verb on POST-only static routes answers 405 + Allow: POST", async (t) => {
  const server = await newServer(t);
  for (const url of POST_ONLY_ALLOW_POST) {
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS", "PATCH"] as const) {
      const response = await server.app.inject({ method, url });
      assertEnvelope(response, 405, "METHOD_NOT_ALLOWED", `${method} ${url}`);
      assert.equal(response.headers.allow, "POST", `${method} ${url} must advertise Allow: POST`);
      assert.ok(!response.body.includes(url), `${method} ${url}: the envelope must not reflect the path`);
    }
    // HEAD follows the registered GET 405 handler: same status + Allow header,
    // and (by HTTP semantics) no body.
    const head = await server.app.inject({ method: "HEAD", url });
    assert.equal(head.statusCode, 405, `HEAD ${url} must answer 405`);
    assert.equal(head.headers.allow, "POST", `HEAD ${url} must advertise Allow: POST`);
    assert.equal(head.body, "", `HEAD ${url} must carry no body`);
  }
});

test("D3 methods: every wrong verb on GET-only static routes answers 405 + Allow: GET", async (t) => {
  const server = await newServer(t);
  for (const url of GET_ONLY_ALLOW_GET) {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"] as const) {
      const response = await server.app.inject({ method, url, ...(method === "POST" ? { payload: { limit: 1 } } : {}) });
      assertEnvelope(response, 405, "METHOD_NOT_ALLOWED", `${method} ${url}`);
      assert.equal(response.headers.allow, "GET", `${method} ${url} must advertise Allow: GET`);
    }
  }
  // The dual-verb point lookup advertises both verbs on its wrong-verb paths.
  for (const method of ["PUT", "DELETE", "OPTIONS", "PATCH"] as const) {
    const response = await server.app.inject({ method, url: "/api/v1/points/lookup" });
    assertEnvelope(response, 405, "METHOD_NOT_ALLOWED", `${method} /api/v1/points/lookup`);
    assert.equal(response.headers.allow, "GET, POST", `${method} /api/v1/points/lookup must advertise both verbs`);
  }
});

test("D3 methods: wrong verbs on parametric resources keep the bounded 404 unknown-route envelope", async (t) => {
  const server = await newServer(t);
  // Reference pin (adv-api-malformed): POST /api/v1/routes/<unknown> is an
  // unknown route, never a 405; the same holds for the other parametric
  // resources and never reflects the path or the oversized identifier.
  const marker = "does-not-exist-marker-0123456789";
  const cases = [
    ["POST", `/api/v1/routes/${marker}`],
    ["PUT", `/api/v1/routes/${marker}`],
    ["DELETE", `/api/v1/detail/${marker}`],
    ["PUT", `/api/v1/flights/${marker}`],
    ["DELETE", `/api/v1/points/${marker}`],
  ] as const;
  for (const [method, url] of cases) {
    const response = await server.app.inject({ method, url });
    const envelope = assertEnvelope(response, 404, "NOT_FOUND", `${method} ${url}`);
    assert.ok(!envelope.error.message.includes(marker), `${method} ${url}: the 404 message must not echo the identifier`);
  }
});

test("D3 methods: trailing-slash, case, and version variants are bounded 404s without reflection", async (t) => {
  const server = await newServer(t);
  const urls = [
    "/api/v1/routes/overview/",
    "/api/v1/Routes/Overview",
    "/API/V1/ROUTES/OVERVIEW",
    "/api/v1/routes/synthesis/extra",
    "/api/v2/routes/overview",
    "/api/v1//routes/overview",
  ];
  for (const url of urls) {
    const response = await server.app.inject({ method: "POST", url, payload: { limit: 1 } });
    const envelope = assertEnvelope(response, 404, "NOT_FOUND", `POST ${url}`);
    assert.ok(!envelope.error.message.includes(url), `POST ${url}: the 404 must not echo the path`);
  }
});

test("D3 methods: percent-encoded segments resolve like their decoded routes and never leak", async (t) => {
  const server = await newServer(t);
  // %6F == "o": find-my-way decodes percent-escapes before matching, so the
  // encoded path lands on the genuine static route — a 200 overview page.
  const encoded = await server.app.inject({ method: "POST", url: "/api/v1/routes/%6Fverview", payload: { limit: 1 } });
  assert.equal(encoded.statusCode, 200, "a percent-encoded static route must match its decoded twin");
  assert.ok(Array.isArray((encoded.json() as { data: unknown[] }).data), "the encoded route serves a genuine overview page");

  // An encoded slash inside a parametric reference stays one segment and
  // resolves to the bounded gap envelope — never a traversal or a leak.
  const slashed = await server.app.inject({ method: "GET", url: "/api/v1/points/A%2FB" });
  assert.equal(slashed.statusCode, 404, "an encoded slash reference is an unknown point");
  const body = slashed.json() as { status: string; error: { code: string; message: string } };
  assert.equal(body.error.code, "POINT_NOT_FOUND", "the gap envelope names POINT_NOT_FOUND");
  assert.ok(!slashed.body.includes("A%2FB") && !body.error.message.includes("A/B"), "the response must not echo the raw reference");

  // An over-long parametric identifier (past maxParamLength) is rejected by
  // the router before dispatch: the bounded framework envelope, never a 5xx
  // and never a reflection of the 3000-character parameter.
  const overLong = await server.app.inject({ method: "GET", url: `/api/v1/routes/${"x".repeat(3000)}` });
  const envelope = assertEnvelope(overLong, 400, "INVALID_REQUEST", "over-long routeId param");
  assert.ok(!envelope.error.message.includes("x".repeat(16)), "the envelope must not echo the over-long identifier");
});

test("D3 methods: the static-asset fallback serves the SPA and rejects traversal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "d3-assets-"));
  await mkdir(join(directory, "assets"), { recursive: true });
  await writeFile(join(directory, "index.html"), "<!doctype html><title>probe</title>", "utf8");
  await writeFile(join(directory, "assets", "app.js"), "export const probe = 1;", "utf8");
  const server = await createApiServer({ adapter: synthesisAdapter(), assetDirectory: directory });
  t.after(async () => { await server.app.close(); await rm(directory, { recursive: true, force: true }); });

  const root = await server.app.inject({ method: "GET", url: "/" });
  assert.equal(root.statusCode, 200, "the asset root serves the SPA");
  assert.ok(String(root.headers["content-type"]).startsWith("text/html"), "the SPA is served as HTML");
  assert.ok(root.body.includes("probe"), "the SPA content is the index document");

  const asset = await server.app.inject({ method: "GET", url: "/assets/app.js" });
  assert.equal(asset.statusCode, 200, "a real asset is served");
  assert.ok(String(asset.headers["content-type"]).startsWith("text/javascript"), "the asset content type comes from the extension map");

  const fallback = await server.app.inject({ method: "GET", url: "/some/client/route" });
  assert.equal(fallback.statusCode, 200, "an extension-less unknown path falls back to the SPA");
  assert.ok(fallback.body.includes("probe"), "the SPA fallback serves the index document");

  const missingTyped = await server.app.inject({ method: "GET", url: "/assets/missing.css" });
  assertEnvelope(missingTyped, 404, "NOT_FOUND", "a missing typed asset");

  // Traversal attempts stay contained: bounded 404s, never file contents.
  for (const url of ["/../package.json", "/%2e%2e/package.json", "/assets/../../package.json"]) {
    const response = await server.app.inject({ method: "GET", url });
    assert.ok(response.statusCode === 404 || response.statusCode === 200, `${url}: traversal never 5xx`);
    assert.ok(!response.body.includes("\"name\":"), `${url}: traversal must never leak a foreign file`);
    if (response.statusCode === 404) assertEnvelope(response, 404, "NOT_FOUND", `traversal ${url}`);
  }

  // The /api prefix stays reserved even under the asset wildcard.
  const apiReserved = await server.app.inject({ method: "GET", url: "/api/v1/never-registered" });
  assertEnvelope(apiReserved, 404, "NOT_FOUND", "unknown /api path under the asset wildcard");
});

test("D3 methods: every liveness alias serves the identical health payload", async (t) => {
  const server = await newServer(t);
  const aliases = ["/health", "/healthz", "/live", "/livez", "/health/live", "/api/v1/health", "/api/v1/healthz", "/api/v1/live", "/api/v1/livez", "/api/v1/liveness", "/api/v1/health/live"];
  const bodies = new Set<string>();
  for (const url of aliases) {
    const response = await server.app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, `GET ${url} must be healthy`);
    assert.equal(String(response.headers["content-type"]).startsWith("application/json"), true, `GET ${url} serves JSON`);
    bodies.add(response.body);
  }
  assert.equal(bodies.size, 1, "all liveness aliases must serve a byte-identical payload");
});
