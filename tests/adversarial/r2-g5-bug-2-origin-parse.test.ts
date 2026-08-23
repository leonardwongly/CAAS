// Adversarial sweep round 2, gap-fill agent G5 — domain: Fastify BFF HTTP surface DEPTH.
//
// R2-G5-BUG-2 (cross-origin defense failed open on unparseable Origin): the
// onRequest origin guard compared new URL(origin).host against the Host header
// only when the Origin parsed AND a Host was present. An Origin header that
// failed URL parsing (or an absent Host) skipped the comparison entirely, so
// "not-a-url" was treated as same-origin — inconsistent with the guard's own
// treatment of the opaque "null" origin, which it deliberately fails closed.
// A browser can never emit such an Origin, but the defense must not have a
// malformed-input bypass. The fix denies whenever the origin cannot be parsed
// to a host that equals the request Host.
//
// Does not duplicate:
// - tests/adversarial/sec-r2-7.test.ts — owns the cross-origin mismatch (403),
//   the same-origin allowance, and the literal Origin: "null" fail-closed pin.
//   This file owns ONLY the unparseable-Origin / missing-Host gap.
import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { synthesisAdapter } from "../fixtures/synthesis-caas.ts";

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;

async function newServer(t: test.TestContext): Promise<ApiServer> {
  const server = await createApiServer({ adapter: synthesisAdapter(), refreshSecret: "r2-g5-secret" });
  t.after(() => server.app.close());
  return server;
}

function assertCrossOriginDenied(response: { statusCode: number; body: string }, context: string): void {
  assert.equal(response.statusCode, 403, `${context}: expected 403`);
  const envelope = JSON.parse(response.body) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, "CROSS_ORIGIN_DENIED", `${context}: the envelope names CROSS_ORIGIN_DENIED`);
  assert.ok(envelope.error.message.length <= 160, `${context}: bounded message`);
}

test("R2-G5-BUG-2: an unparseable Origin header fails the cross-origin defense closed", async (t) => {
  const server = await newServer(t);
  // Before the fix each of these skipped the origin comparison and reached
  // the handler (here: refresh auth) instead of being denied.
  const malformedOrigins = [
    "not-a-url",
    "https://",
    "::::",
    "", // a present-but-empty Origin identifies no same-origin browser
    "http://[",
    "https://exa mple.com",
  ];
  for (const origin of malformedOrigins) {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v1/refresh",
      headers: { origin, host: "127.0.0.1:8080", "x-refresh-token": "r2-g5-secret" },
    });
    assertCrossOriginDenied(response, `Origin: ${JSON.stringify(origin)}`);
  }
});

test("R2-G5-BUG-2: an Origin header without a comparable Host fails closed", async (t) => {
  const server = await newServer(t);
  const response = await server.app.inject({
    method: "POST",
    url: "/api/v1/refresh",
    headers: { origin: "http://127.0.0.1:8080", host: "" },
  });
  assertCrossOriginDenied(response, "origin with empty host");
});

test("R2-G5-BUG-2 fix keeps well-formed same-origin state-changing requests allowed", async (t) => {
  const server = await newServer(t);
  // Denied requests never consume the refresh rate-limit window: after a run
  // of 403 denials (which carried a valid refresh token), the FIRST actual
  // refresh still succeeds. If a denial had started a refresh, this would 429.
  for (let index = 0; index < 3; index += 1) {
    const denied = await server.app.inject({
      method: "POST",
      url: "/api/v1/refresh",
      headers: { origin: "not-a-url", host: "127.0.0.1:8080", "x-refresh-token": "r2-g5-secret" },
    });
    assertCrossOriginDenied(denied, `denied probe ${index}`);
  }
  const firstRefresh = await server.app.inject({
    method: "POST",
    url: "/api/v1/refresh",
    headers: { origin: "http://127.0.0.1:8080", host: "127.0.0.1:8080", "x-refresh-token": "r2-g5-secret" },
  });
  assert.equal(firstRefresh.statusCode, 200, "a parseable matching origin must reach the handler");
  const secondRefresh = await server.app.inject({
    method: "POST",
    url: "/api/v1/refresh",
    headers: { origin: "http://127.0.0.1:8080", host: "127.0.0.1:8080", "x-refresh-token": "r2-g5-secret" },
  });
  assert.equal(secondRefresh.statusCode, 429, "the first real refresh consumed the rate-limit window");
  assert.equal((secondRefresh.json() as { error: { code: string } }).error.code, "REFRESH_RATE_LIMITED");
});

test("R2-G5-BUG-2 fix keeps decorated-but-parseable origins working on the admin alias", async (t) => {
  // Back-to-back refreshes allowed so the alias check is isolated from the
  // rate-limit window.
  const server = await createApiServer({ adapter: synthesisAdapter(), refreshSecret: "r2-g5-secret", refreshMinIntervalMs: 0 });
  t.after(() => server.app.close());
  const decorated = await server.app.inject({
    method: "POST",
    url: "/api/v1/admin/refresh",
    headers: { origin: "HTTP://127.0.0.1:8080", host: "127.0.0.1:8080", "x-refresh-token": "r2-g5-secret" },
  });
  assert.equal(decorated.statusCode, 200, "a scheme-decorated but matching origin still parses and compares");
});

test("R2-G5-BUG-2: the fail-closed denial applies to every state-changing method and both refresh aliases", async (t) => {
  const server = await newServer(t);
  const cases = [
    ["POST", "/api/v1/callsigns/search"],
    ["PUT", "/api/v1/callsigns/search"],
    ["PATCH", "/api/v1/routes/overview"],
    ["DELETE", "/api/v1/drafts"],
    ["POST", "/api/v1/admin/refresh"],
  ] as const;
  for (const [method, url] of cases) {
    const response = await server.app.inject({
      method,
      url,
      ...(method === "POST" ? { payload: { query: "SYNTH" } } : {}),
      headers: { origin: "definitely-not-a-url", host: "127.0.0.1:8080" },
    });
    assertCrossOriginDenied(response, `${method} ${url}`);
    // The denial happens in onRequest, before any method/URL routing logic,
    // so it must not surface a 404/405 instead of the 403.
    assert.equal((JSON.parse(response.body) as { error: { code: string } }).error.code, "CROSS_ORIGIN_DENIED");
  }
});
