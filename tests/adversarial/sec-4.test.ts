import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Finding sec-4: no app.setNotFoundHandler is registered (apps/api/src/server.ts
// registers only setErrorHandler at line 1135), so Fastify's default 404 body
// {"message":"Route <METHOD>:<path> not found","error":"Not Found","statusCode":404}
// is returned for unregistered routes and wrong-method requests. It reflects
// the attacker-controlled method and raw path into the JSON body, unbounded,
// and breaks the uniform bounded-error envelope that every other error path
// uses ({ error: { code, message } } with message.slice(0, MAX_ERROR_MESSAGE),
// MAX_ERROR_MESSAGE = 160; see server.ts lines 57, 1136, 1046-1048).
//
// Correct behavior per the uniform bounded-error envelope: every unknown-path
// and wrong-method request is a 4xx whose body is the bounded
// { error: { code, message } } shape, message <= 160 chars, with no method or
// path reflection.

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS";

const matrix: Array<[HttpMethod, string]> = [
  // Wrong method on existing routes
  ["POST", "/api/v1/routes/abc.def"], // GET-only route
  ["PUT", "/api/v1/routes/abc.def"],
  ["DELETE", "/api/v1/routes/abc.def"],
  ["GET", "/api/v1/refresh"], // POST-only route
  ["OPTIONS", "/api/v1/refresh"],
  ["PUT", "/api/v1/search"], // POST-only route
  // Unregistered routes
  ["GET", "/api/v1/definitely-unknown-path"],
  ["POST", "/api/v1/definitely-unknown-path"],
  ["OPTIONS", "/api/v1/definitely-unknown-path"],
  ["DELETE", "/api/v1/"],
  ["PUT", "/totally/unregistered"],
];

test("unknown-path and wrong-method requests return the bounded error envelope with no method/path reflection", async (t) => {
  const server = await createApiServer({ adapter: sanitizedAdapter() });
  t.after(() => server.app.close());

  for (const [method, url] of matrix) {
    const res = await server.app.inject({ method, url });
    const bodyText = res.payload;
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${method} ${url} -> ${res.statusCode} must be 4xx`);

    // Bounded envelope shape: { error: { code, message } } — not Fastify's
    // default { message, error: "Not Found", statusCode } shape.
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      assert.fail(`${method} ${url} body is not JSON: ${bodyText.slice(0, 120)}`);
    }
    assert.ok(typeof parsed === "object" && parsed !== null, `${method} ${url} body must be a JSON object`);
    const body = parsed as { error?: { code?: unknown; message?: unknown } };
    assert.ok(body.error && typeof body.error === "object", `${method} ${url} body must carry the error envelope, got: ${bodyText.slice(0, 120)}`);
    assert.equal(typeof body.error.code, "string", `${method} ${url} error.code must be a string`);
    assert.equal(typeof body.error.message, "string", `${method} ${url} error.message must be a string`);
    const envelopeMessage = body.error.message as string;
    assert.ok(envelopeMessage.length <= 160, `${method} ${url} error.message must be <= 160 chars, got ${envelopeMessage.length}: ${envelopeMessage}`);

    // No method or raw-path reflection in the body.
    assert.ok(!bodyText.includes(method), `${method} ${url} body reflects the method: ${bodyText.slice(0, 120)}`);
    assert.ok(!bodyText.includes(url), `${method} ${url} body reflects the raw path: ${bodyText.slice(0, 120)}`);
    // The Fastify default "Route METHOD:path not found" phrasing must not appear.
    assert.ok(!bodyText.includes(" not found"), `${method} ${url} body leaks the default Route ... not found phrasing: ${bodyText.slice(0, 120)}`);
  }
});
