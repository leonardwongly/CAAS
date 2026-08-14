import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Finding: Fastify's onBadUrl path (fastify.js `onBadUrl`, exercised when a
// URL contains an invalid percent-escape such as `%zz`) writes the 400
// response directly to the socket when no `setFrameworkErrors` handler is
// registered. That bypasses setErrorHandler (apps/api/src/server.ts:1135) and
// both onSend hooks (server.ts:1113 size cap, server.ts:1124 security
// headers), so the raw path is reflected unbounded in the body, the internal
// code FST_ERR_BAD_URL is disclosed, and no security headers are emitted.
//
// North-star contract (README binding contract, design Section 0, plan §6):
// every browser response is a bounded JSON error envelope
// `{error: {code, message}}` with message capped at 160 chars, plus the
// standard security headers on every response. The fix is
// `app.setFrameworkErrors` routing framework errors through the same error
// envelope. This test asserts the contract, not the buggy behavior.

const SECURITY_HEADERS = [
  "content-security-policy",
  "referrer-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "permissions-policy",
] as const;

function envelope(body: string): { code: string; message: string } {
  const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
  assert.ok(parsed.error, `response body is an error envelope: ${body.slice(0, 200)}`);
  assert.equal(typeof parsed.error!.code, "string", "error envelope has a string code");
  assert.equal(typeof parsed.error!.message, "string", "error envelope has a string message");
  return { code: parsed.error!.code as string, message: parsed.error!.message as string };
}

test("malformed-URL framework error returns the bounded envelope, not a raw path reflection", async () => {
  const { app } = await createApiServer({ adapter: sanitizedAdapter() });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/points/%zz" });
    assert.equal(response.statusCode, 400);
    const { code, message } = envelope(response.body);
    assert.ok(code.length > 0, "error code is non-empty");
    assert.ok(
      !message.includes("FST_ERR_BAD_URL"),
      `internal Fastify error code is not disclosed: ${message}`,
    );
    assert.ok(
      !message.includes("%zz") && !message.includes("/api/v1/points/"),
      `raw request path is not reflected in the message: ${message}`,
    );
    assert.ok(
      message.length <= 160,
      `error message is capped at 160 chars, got ${message.length}: ${message}`,
    );
  } finally {
    await app.close();
  }
});

test("malformed-URL framework error on an unknown path behaves the same", async () => {
  const { app } = await createApiServer({ adapter: sanitizedAdapter() });
  try {
    const response = await app.inject({ method: "GET", url: "/foo%zz" });
    assert.equal(response.statusCode, 400);
    const { message } = envelope(response.body);
    assert.ok(!message.includes("FST_ERR_BAD_URL"), `no internal code disclosed: ${message}`);
    assert.ok(!message.includes("%zz"), `no raw path echo: ${message}`);
    assert.ok(message.length <= 160, `message capped at 160 chars: ${message}`);
  } finally {
    await app.close();
  }
});

test("malformed-URL framework error response stays bounded for a very long path", async () => {
  const { app } = await createApiServer({ adapter: sanitizedAdapter() });
  try {
    const longPath = "/" + "a".repeat(5000) + "%zz";
    const response = await app.inject({ method: "GET", url: longPath });
    assert.equal(response.statusCode, 400);
    assert.ok(
      response.body.length < 2048,
      `framework-error body is bounded (got ${response.body.length} bytes, no unbounded path reflection)`,
    );
    const { message } = envelope(response.body);
    assert.ok(message.length <= 160, `message capped at 160 chars, got ${message.length}`);
  } finally {
    await app.close();
  }
});

test("malformed-URL framework error response carries all security headers", async () => {
  const { app } = await createApiServer({ adapter: sanitizedAdapter() });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/points/%zz" });
    assert.equal(response.statusCode, 400);
    for (const header of SECURITY_HEADERS) {
      assert.ok(
        response.headers[header] !== undefined,
        `security header ${header} present on the framework-error response`,
      );
    }
  } finally {
    await app.close();
  }
});
