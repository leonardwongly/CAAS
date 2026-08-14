import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Finding: POST-only /api/v1/routes/options and /api/v1/routes/compare lack
// GET 405 handlers (unlike the search family, apps/api/src/server.ts:1210-1217
// which returns 405 with Allow: POST). The generic GET /api/v1/routes/:routeId
// route (server.ts:1335) matches "options" and "compare" as routeIds, so a GET
// on those POST-only paths is absorbed into the route-detail handler and fails
// token decode with 410 GENERATION_EXPIRED ("The requested item belongs to an
// older data generation.") instead of a method rejection.
//
// North-star contract (docs/security/safety-and-secrets.md "Plan §2.4
// conformance"): POST-only endpoints reject GET with 405 and an Allow: POST
// header so no live flight identifier, coordinate, token, or query state can
// appear in a URL or browser history; the search family is the implemented
// template for that envelope. A wrong method on a POST-only path must never be
// absorbed by another route into a misleading 410 (or a bare 404) — it must
// fail 405 METHOD_NOT_ALLOWED with Allow: POST and the bounded error envelope.

const POST_ONLY_COLLISION_PATHS = ["/api/v1/routes/options", "/api/v1/routes/compare"] as const;

interface ErrorEnvelope {
  code: string;
  message: string;
}

function envelope(body: string): ErrorEnvelope {
  const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
  assert.ok(parsed.error, `response body is an error envelope: ${body.slice(0, 200)}`);
  assert.equal(typeof parsed.error!.code, "string", "error envelope has a string code");
  assert.equal(typeof parsed.error!.message, "string", "error envelope has a string message");
  return { code: parsed.error!.code as string, message: parsed.error!.message as string };
}

async function withServer(run: (baseUrl: (method: string, url: string) => Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}>) => Promise<void>) {
  const { app } = await createApiServer({ adapter: sanitizedAdapter() });
  try {
    const inject = (method: string, url: string) =>
      app.inject({ method: method as "GET", url }).then((response) => ({
        statusCode: response.statusCode,
        headers: response.headers as Record<string, string | string[] | undefined>,
        body: response.body,
      }));
    await run(inject);
  } finally {
    await app.close();
  }
}

function assertMethodNotAllowed(response: {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}, method: string, url: string) {
  assert.equal(
    response.statusCode,
    405,
    `${method} ${url} is 405 METHOD_NOT_ALLOWED, not ${response.statusCode} (a wrong method on a POST-only path must not be absorbed into another route's 410 or a bare 404): ${response.body.slice(0, 200)}`,
  );
  assert.equal(
    response.headers.allow,
    "POST",
    `${method} ${url} carries Allow: POST: ${JSON.stringify(response.headers.allow)}`,
  );
  const { code, message } = envelope(response.body);
  assert.equal(code, "METHOD_NOT_ALLOWED", `${method} ${url} reports METHOD_NOT_ALLOWED, not ${code}`);
  assert.ok(
    message.length <= 160,
    `${method} ${url} message is bounded at 160 chars, got ${message.length}: ${message}`,
  );
  assert.ok(
    !message.includes("generation") && !message.includes("expired"),
    `${method} ${url} does not misattribute the rejection to token/generation state: ${message}`,
  );
  const parsed = JSON.parse(response.body) as { data?: unknown; generation?: unknown };
  assert.equal(parsed.data, undefined, `${method} ${url} serves no data payload`);
  assert.equal(parsed.generation, undefined, `${method} ${url} serves no generation payload`);
}

test("GET on POST-only routes/options and routes/compare is 405 + Allow: POST, never absorbed into GET :routeId (410) or 404", async () => {
  await withServer(async (inject) => {
    for (const url of POST_ONLY_COLLISION_PATHS) {
      const response = await inject("GET", url);
      assertMethodNotAllowed(response, "GET", url);
    }
  });
});

test("PUT and OPTIONS on POST-only collision paths also reject with 405 + Allow: POST", async () => {
  await withServer(async (inject) => {
    for (const url of POST_ONLY_COLLISION_PATHS) {
      for (const method of ["PUT", "OPTIONS"] as const) {
        const response = await inject(method, url);
        assertMethodNotAllowed(response, method, url);
      }
    }
  });
});

test("control: the search family's own GET 405 handler pins the required envelope shape", async () => {
  await withServer(async (inject) => {
    const response = await inject("GET", "/api/v1/search");
    assertMethodNotAllowed(response, "GET", "/api/v1/search");
  });
});
