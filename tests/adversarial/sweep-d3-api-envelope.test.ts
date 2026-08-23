// Adversarial sweep owner/domain: D3 — API HTTP surface & envelope.
//
// Error-envelope consistency across the code table: every failure keeps the
// bounded { error: { code, message } } contract (JSON content type, stable
// code, message ≤ 160 chars, retryable only where documented), carries the
// security headers, and never leaks stack frames, file paths, or reflected
// attacker input.
//
// Complements (does not duplicate) adv-api-malformed (a few body shapes on
// two endpoints), adv-tokens-proofs (token forgery/TTL depth), and sec-4/5
// (unknown-path envelope shape).
import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer, type CaasAdapter } from "../../apps/api/src/index.ts";
import { scopedToken } from "../../apps/api/src/snapshot.ts";
import type { Snapshot } from "../../apps/api/src/snapshot.ts";
import { synthesisAdapter } from "../fixtures/synthesis-caas.ts";

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["app"]["inject"]>>;

async function newServer(t: test.TestContext, options: Parameters<typeof createApiServer>[0] = {}): Promise<ApiServer> {
  const server = await createApiServer({ adapter: synthesisAdapter(), ...options });
  t.after(() => server.app.close());
  return server;
}

interface Envelope { error: { code: string; message: string; retryable?: boolean } }

const LEAK_PATTERNS = [/\n\s+at /u, /apps\/api\/src/u, /node_modules/u, /tokenSecret/u, /at Object/u] as const;

function assertEnvelope(response: InjectResponse, status: number, code: string, context: string): Envelope {
  assert.equal(response.statusCode, status, `${context}: expected ${status}, body=${response.body.slice(0, 200)}`);
  assert.ok(String(response.headers["content-type"] ?? "").startsWith("application/json"), `${context}: envelope content-type must be JSON`);
  const parsed = response.json() as Envelope;
  assert.ok(parsed.error && typeof parsed.error === "object", `${context}: envelope must carry an error object`);
  assert.equal(parsed.error.code, code, `${context}: expected code ${code}, got ${parsed.error.code}`);
  assert.equal(typeof parsed.error.message, "string", `${context}: bounded message`);
  assert.ok(parsed.error.message.length > 0 && parsed.error.message.length <= 160, `${context}: message stays within 1..160 chars`);
  for (const pattern of LEAK_PATTERNS) {
    assert.ok(!pattern.test(response.body), `${context}: the envelope must not leak internals matching ${pattern}`);
  }
  // Security headers must survive the error path, not just the happy path.
  assert.equal(response.headers["x-content-type-options"], "nosniff", `${context}: nosniff on errors`);
  assert.ok(String(response.headers["content-security-policy"] ?? "").includes("frame-ancestors 'none'"), `${context}: CSP on errors`);
  return parsed;
}

test("D3 envelope: the common failure table keeps one bounded envelope shape", async (t) => {
  const server = await newServer(t);
  const cases: Array<{ label: string; request: Parameters<ApiServer["app"]["inject"]>[0]; status: number; code: string }> = [
    { label: "malformed JSON", request: { method: "POST", url: "/api/v1/search", payload: "{not-json", headers: { "content-type": "application/json" } }, status: 400, code: "INVALID_JSON" },
    { label: "array body", request: { method: "POST", url: "/api/v1/routes/overview", payload: [1, 2] }, status: 400, code: "INVALID_BODY" },
    { label: "non-object body", request: { method: "POST", url: "/api/v1/routes/overview", payload: "\"just a string\"", headers: { "content-type": "application/json" } }, status: 400, code: "INVALID_BODY" },
    { label: "unknown field", request: { method: "POST", url: "/api/v1/routes/overview", payload: { limit: 1, probe: true } }, status: 400, code: "INVALID_BODY" },
    { label: "non-numeric limit", request: { method: "POST", url: "/api/v1/routes/overview", payload: { limit: "abc" } }, status: 400, code: "INVALID_LIMIT" },
    { label: "query string on a body-only route", request: { method: "POST", url: "/api/v1/route-options?probe=1", payload: {} }, status: 400, code: "INVALID_QUERY" },
    { label: "empty draft", request: { method: "POST", url: "/api/v1/drafts", payload: {} }, status: 400, code: "INVALID_DRAFT" },
    { label: "unknown api path", request: { method: "POST", url: "/api/v1/never-registered", payload: {} }, status: 404, code: "NOT_FOUND" },
    { label: "wrong verb", request: { method: "GET", url: "/api/v1/routes/overview" }, status: 405, code: "METHOD_NOT_ALLOWED" },
    { label: "unknown point reference", request: { method: "GET", url: "/api/v1/points/ZZZZ99" }, status: 404, code: "POINT_NOT_FOUND" },
    { label: "invalid point kind", request: { method: "GET", url: "/api/v1/points/lookup?reference=A&kind=bogus" }, status: 400, code: "INVALID_KIND" },
    { label: "unknown airport draft endpoint", request: { method: "POST", url: "/api/v1/drafts", payload: { origin: "ZZZZ", destination: "A" } }, status: 404, code: "AIRPORT_NOT_FOUND" },
  ];
  for (const { label, request, status, code } of cases) {
    const response = await server.app.inject(request);
    assertEnvelope(response, status, code, label);
  }
});

test("D3 envelope: an oversized body fails closed with REQUEST_TOO_LARGE", async (t) => {
  const server = await newServer(t);
  // 64 KiB bodyLimit + margin: the framework rejects the stream before the
  // handler runs, and the envelope must still be the bounded JSON contract.
  const response = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { junk: "x".repeat(96 * 1024) } });
  assertEnvelope(response, 413, "REQUEST_TOO_LARGE", "oversized body");
});

test("D3 envelope: an uninitialized store answers 503 NOT_INITIALIZED, retryable", async (t) => {
  const server = await newServer(t, { initialize: false });
  for (const request of [
    { method: "POST" as const, url: "/api/v1/routes/overview", payload: { limit: 1 } },
    { method: "GET" as const, url: "/api/v1/routes/browse" },
    { method: "GET" as const, url: "/api/v1/points/A" },
  ]) {
    const response = await server.app.inject(request);
    const envelope = assertEnvelope(response, 503, "NOT_INITIALIZED", `${request.method} ${request.url}`);
    assert.equal(envelope.error.retryable, true, `${request.method} ${request.url}: NOT_INITIALIZED is retryable`);
  }
});

test("D3 envelope: token-bound identifiers separate expired, forged, and out-of-range", async (t) => {
  const server = await newServer(t);
  const snapshot: Snapshot = server.store.requireSnapshot();

  // A genuine signature that expired: 410 GENERATION_EXPIRED, never a 5xx.
  const expired = scopedToken(snapshot, "flight", { i: 0 }, Date.now() - 1000);
  assertEnvelope(await server.app.inject({ method: "GET", url: `/api/v1/routes/${expired}` }), 410, "GENERATION_EXPIRED", "expired flight token");

  // A forged/garbage token fails signature verification and is indistinguishable
  // from an expired one — no oracle tells the attacker which part was wrong.
  assertEnvelope(await server.app.inject({ method: "GET", url: "/api/v1/routes/not-a-token" }), 410, "GENERATION_EXPIRED", "forged flight token");

  // A validly signed token naming an out-of-range index: bounded 404.
  const outOfRange = scopedToken(snapshot, "flight", { i: 99999 });
  const notFound = await server.app.inject({ method: "GET", url: `/api/v1/routes/${outOfRange}` });
  const envelope = assertEnvelope(notFound, 404, "ROUTE_NOT_FOUND", "out-of-range flight token");
  assert.ok(!envelope.error.message.includes("99999"), "the 404 must not echo the probed index");

  // The URL-private variant enforces the same identifier bounds in the body.
  assertEnvelope(await server.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: "" } }), 400, "INVALID_ROUTE_ID", "empty routeId body");
  assertEnvelope(await server.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: "x".repeat(2049) } }), 400, "INVALID_ROUTE_ID", "over-long routeId body");
});

test("D3 envelope: route-options identifier errors stay bounded and unreflected", async (t) => {
  const server = await newServer(t);
  const snapshot: Snapshot = server.store.requireSnapshot();

  const missing = await server.app.inject({ method: "POST", url: "/api/v1/route-options", payload: { flightId: scopedToken(snapshot, "flight", { i: 99999 }) } });
  assertEnvelope(missing, 404, "FLIGHT_NOT_FOUND", "out-of-range flightId");

  const wrongType = await server.app.inject({ method: "POST", url: "/api/v1/route-options", payload: { originId: 1, destinationId: {} } });
  assertEnvelope(wrongType, 400, "INVALID_FLIGHT_ID", "non-string endpoint ids");

  // Signed location tokens naming non-airports (or nothing at all) fail closed
  // before any candidate enumeration starts.
  const notAirports = await server.app.inject({ method: "POST", url: "/api/v1/route-options", payload: { originId: scopedToken(snapshot, "location", { i: 99999 }), destinationId: scopedToken(snapshot, "location", { i: 99998 }) } });
  assertEnvelope(notAirports, 400, "INVALID_ENDPOINTS", "non-airport endpoint tokens");
});

test("D3 envelope: donor-proof validation rejects garbage and negative ordinal ranges", async (t) => {
  const server = await newServer(t);
  const snapshot: Snapshot = server.store.requireSnapshot();

  assertEnvelope(await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: "garbage-proof" } }), 400, "PROOF_INVALID", "garbage proofId");
  assertEnvelope(await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: {} }), 400, "INVALID_BODY", "missing proofId");

  // Regression (D3 fix): a validly signed donor proof with a negative ordinal
  // range previously answered 200 with occurrence data. The range bounds must
  // be validated alongside the donor index.
  const negativeRange = scopedToken(snapshot, "donor-proof", { i: 0, f: -5, u: -1 });
  assertEnvelope(await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: negativeRange } }), 400, "PROOF_INVALID", "negative ordinal range");
  const negativeFrom = scopedToken(snapshot, "donor-proof", { i: 0, f: -1, u: 3 });
  assertEnvelope(await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: negativeFrom } }), 400, "PROOF_INVALID", "negative lower bound only");
});

test("D3 envelope: forged cursors and draft ids fail closed", async (t) => {
  const server = await newServer(t);
  assertEnvelope(await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { cursor: "forged-cursor" } }), 409, "CURSOR_EXPIRED", "forged overview cursor");
  assertEnvelope(await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId: "forged-draft" } }), 410, "DRAFT_EXPIRED", "forged draft id");
});

test("D3 envelope: refresh authorization and rate limiting keep the bounded envelope", async (t) => {
  const server = await newServer(t, { refreshSecret: "d3-secret" });

  assertEnvelope(await server.app.inject({ method: "POST", url: "/api/v1/refresh" }), 401, "UNAUTHORIZED", "missing refresh secret");
  assertEnvelope(await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "wrong-secret" } }), 401, "UNAUTHORIZED", "wrong refresh secret");

  const ok = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "d3-secret" } });
  assert.equal(ok.statusCode, 200, `an authorized refresh succeeds, body=${ok.body.slice(0, 200)}`);

  // The default 30s minimum interval bounds upstream acquisition cost: the
  // immediate second refresh must fail closed with the rate-limit envelope.
  const limited = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { "x-refresh-token": "d3-secret" } });
  const envelope = assertEnvelope(limited, 429, "REFRESH_RATE_LIMITED", "second immediate refresh");
  assert.equal(envelope.error.retryable, true, "the rate limit is retryable");
});

test("D3 envelope: a failed refresh answers 503 REFRESH_FAILED without leaking the cause", async (t) => {
  const failingAdapter: CaasAdapter = {
    displayAll: async () => { throw new Error("upstream unavailable — secret=leak-probe"); },
    airways: async () => { throw new Error("upstream unavailable"); },
    fixes: async () => { throw new Error("upstream unavailable"); },
    airports: async () => { throw new Error("upstream unavailable"); },
    navaids: async () => { throw new Error("upstream unavailable"); },
  };
  const server = await createApiServer({ adapter: failingAdapter, initialize: false });
  t.after(() => server.app.close());

  const response = await server.app.inject({ method: "POST", url: "/api/v1/refresh" });
  const envelope = assertEnvelope(response, 503, "REFRESH_FAILED", "failing adapter refresh");
  assert.equal(envelope.error.retryable, true, "a failed refresh is retryable");
  assert.ok(!response.body.includes("leak-probe"), "the upstream failure reason must never reach the client");
});
