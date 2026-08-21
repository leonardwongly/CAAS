// Adversarial sweep owner/domain: A4 — API synthesis & source-occurrences
// endpoints (POST /api/v1/routes/synthesis, POST /api/v1/routes/source-occurrences):
// malformed/edge inputs must fail closed with structured 4xx envelopes.
//
// Complements (does not duplicate) tests/synthesis/api.test.ts and
// tests/adversarial/sec-r5-synthesis.test.ts, which already cover: GET->405,
// extra-field bodies, non-empty query strings, forged/tampered/expired/
// cross-generation proofs, and cursor flight-binding.
import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { synthesisAdapter } from "../fixtures/synthesis-caas.ts";

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;
interface ErrorEnvelope { error: { code: string; message: string } }

// Every failure on these endpoints must be a bounded client-error envelope:
// 4xx only (never 500), structured {error:{code,message}}, and free of stack
// frames, file paths, internal snapshot ids, or echoed raw request inputs.
function assertClientErrorEnvelope(response: { statusCode: number; body: string }, context: string, expectedCode?: string): ErrorEnvelope {
  assert.ok(response.statusCode >= 400 && response.statusCode < 500, `${context}: expected 4xx, got ${response.statusCode} body=${response.body}`);
  const parsed = JSON.parse(response.body) as ErrorEnvelope;
  assert.ok(parsed.error && typeof parsed.error === "object", `${context}: response must carry an error object`);
  assert.equal(typeof parsed.error.code, "string", `${context}: error.code must be a stable string`);
  assert.ok(parsed.error.code.length > 0, `${context}: error.code must be non-empty`);
  assert.equal(typeof parsed.error.message, "string", `${context}: error.message must be a string`);
  if (expectedCode !== undefined) assert.equal(parsed.error.code, expectedCode, `${context}: expected code ${expectedCode}`);
  assert.equal(response.body.includes("    at "), false, `${context}: body must never carry stack frames`);
  assert.equal(/\/Users\/|file:\/\/|\.(ts|js):\d+/.test(response.body), false, `${context}: body must never carry file paths`);
  assert.equal(response.body.includes("stackTrace"), false, `${context}: body must never carry stack trace fields`);
  return parsed;
}

async function postExpectEnvelope(server: ApiServer, url: string, options: { payload: unknown; headers?: Record<string, string> | undefined }, context: string, expectedCode?: string): Promise<{ statusCode: number; envelope: ErrorEnvelope }> {
  // The adversarial payloads are deliberately outside InjectPayload's type
  // surface; inject serializes them faithfully at runtime regardless.
  const response = await server.app.inject({ method: "POST", url, payload: options.payload as never, ...(options.headers ? { headers: options.headers } : {}) });
  const envelope = assertClientErrorEnvelope(response, context, expectedCode);
  return { statusCode: response.statusCode, envelope };
}

async function newServer(t: test.TestContext): Promise<ApiServer> {
  const server = await createApiServer({ adapter: synthesisAdapter() });
  t.after(() => server.app.close());
  return server;
}

const SYNTHESIS = "/api/v1/routes/synthesis";
const OCCURRENCES = "/api/v1/routes/source-occurrences";

test("non-object bodies fail closed with INVALID_BODY on both endpoints", async (t) => {
  const server = await newServer(t);
  const nonObjects: Array<readonly [string, unknown, Record<string, string>?]> = [
    ["missing body", undefined],
    ["null", null],
    ["array", [{ flightId: "x" }]],
    // A JSON scalar string body: parses fine, so bodyObject (not the parser)
    // must reject it. Sent as a raw Buffer with an explicit JSON content type
    // so inject does not re-serialize or drop the content-type header.
    ["string", Buffer.from("\"flightId=x\""), { "content-type": "application/json" }],
    ["number", 42],
    ["boolean", true],
  ];
  for (const url of [SYNTHESIS, OCCURRENCES]) {
    for (const [label, payload, headers] of nonObjects) {
      await postExpectEnvelope(server, url, { payload, headers }, `${url} ${label} body`, "INVALID_BODY");
    }
  }
});

test("wrong field types fail closed with INVALID_BODY on both endpoints", async (t) => {
  const server = await newServer(t);
  const synthesisBodies: Array<readonly [string, unknown]> = [
    ["empty object", {}],
    ["number flightId", { flightId: 123 }],
    ["boolean flightId", { flightId: true }],
    ["null flightId", { flightId: null }],
    ["array flightId", { flightId: ["a"] }],
    ["nested object flightId", { flightId: { id: "x" } }],
    ["number cursor", { flightId: "x", cursor: 5 }],
    ["null cursor", { flightId: "x", cursor: null }],
    ["array cursor", { flightId: "x", cursor: ["a"] }],
    ["object cursor", { flightId: "x", cursor: { o: 1 } }],
  ];
  for (const [label, payload] of synthesisBodies) {
    await postExpectEnvelope(server, SYNTHESIS, { payload }, `synthesis ${label}`, "INVALID_BODY");
  }
  const occurrencesBodies: Array<readonly [string, unknown]> = [
    ["empty object", {}],
    ["number proofId", { proofId: 1 }],
    ["boolean proofId", { proofId: false }],
    ["null proofId", { proofId: null }],
    ["array proofId", { proofId: ["p"] }],
    ["object proofId", { proofId: { token: "x" } }],
  ];
  for (const [label, payload] of occurrencesBodies) {
    await postExpectEnvelope(server, OCCURRENCES, { payload }, `source-occurrences ${label}`, "INVALID_BODY");
  }
});

test("boundary string values fail closed with INVALID_BODY (empty/whitespace/oversize)", async (t) => {
  const server = await newServer(t);
  const synthesisStrings: Array<readonly [string, unknown]> = [
    ["empty flightId", { flightId: "" }],
    ["whitespace-only flightId", { flightId: "   \t" }],
    // 4096 chars: over the 2048-char schema max yet under the 64 KiB body
    // limit, so the schema (not the parser) must reject it with INVALID_BODY.
    ["oversize flightId", { flightId: "a".repeat(4096) }],
    ["empty cursor", { flightId: "x", cursor: "" }],
    ["whitespace cursor", { flightId: "x", cursor: "   " }],
    ["oversize cursor", { flightId: "x", cursor: "c".repeat(4096) }],
  ];
  for (const [label, payload] of synthesisStrings) {
    await postExpectEnvelope(server, SYNTHESIS, { payload }, `synthesis ${label}`, "INVALID_BODY");
  }
  const occurrencesStrings: Array<readonly [string, unknown]> = [
    ["empty proofId", { proofId: "" }],
    ["whitespace proofId", { proofId: " \t " }],
    ["oversize proofId", { proofId: "p".repeat(4096) }],
  ];
  for (const [label, payload] of occurrencesStrings) {
    await postExpectEnvelope(server, OCCURRENCES, { payload }, `source-occurrences ${label}`, "INVALID_BODY");
  }
});

test("schema-valid but bogus tokens fail closed without echoing the raw identifier", async (t) => {
  const server = await newServer(t);
  const garbageTokens = [
    "not-a-token",
    "aaa.bbb", // two segments, wrong alphabet handling/signature
    "a.b.c", // extra segment
    "abc.", // empty signature segment
    ".abc", // empty body segment
    "!!not-base64!!.sig",
    "abc\u0000def", // null byte inside a schema-valid string
    "\u0001\u0007.sig", // control bytes only
    "✈️→🛫", // unicode-only identifier
    "x".repeat(2048), // max schema length of pure garbage
  ];

  // Unknown flight ids fail closed as GENERATION_EXPIRED (410): an opaque
  // rejection that never distinguishes "never existed" from "old generation".
  for (const flightId of garbageTokens) {
    const { envelope } = await postExpectEnvelope(server, SYNTHESIS, { payload: { flightId } }, `synthesis garbage flightId ${flightId.slice(0, 12)}`, "GENERATION_EXPIRED");
    assert.equal(envelope.error.message.includes(flightId), false, "error must never echo the raw flightId");
  }

  // Garbage proofs fail closed as PROOF_INVALID (400), echoing nothing.
  for (const proofId of garbageTokens) {
    const { envelope } = await postExpectEnvelope(server, OCCURRENCES, { payload: { proofId } }, `source-occurrences garbage proofId ${proofId.slice(0, 12)}`, "PROOF_INVALID");
    assert.equal(envelope.error.message.includes(proofId), false, "error must never echo the raw proofId");
  }

  // A truncated genuine-looking token and a well-formed base64url body with a
  // fabricated signature must both fail closed (HMAC verification).
  const plausibleBody = Buffer.from(JSON.stringify({ g: "00000000-0000-0000-0000-000000000000", t: "donor-proof", e: Date.now() + 60_000, i: 0, f: 0, u: 1 }), "utf8").toString("base64url");
  const fabricated = await postExpectEnvelope(server, OCCURRENCES, { payload: { proofId: `${plausibleBody}.${"A".repeat(43)}` } }, "fabricated-signature proof", "PROOF_INVALID");
  assert.equal(fabricated.envelope.error.message.includes(plausibleBody), false, "error must never echo the proof body");
  const truncated = await postExpectEnvelope(server, OCCURRENCES, { payload: { proofId: plausibleBody.slice(0, 10) } }, "truncated proof", "PROOF_INVALID");
  assert.ok(truncated.envelope.error.code === "PROOF_INVALID");
});

test("non-POST methods answer 405 with allow: POST and the METHOD_NOT_ALLOWED envelope", async (t) => {
  const server = await newServer(t);
  for (const url of [SYNTHESIS, OCCURRENCES]) {
    for (const method of ["PUT", "DELETE", "OPTIONS"] as const) {
      const response = await server.app.inject({ method, url, ...(method === "OPTIONS" ? {} : { payload: { probe: 1 } }) });
      assert.equal(response.statusCode, 405, `${method} ${url} must answer 405`);
      assert.equal(response.headers.allow, "POST", `${method} ${url} must advertise allow: POST`);
      assertClientErrorEnvelope(response, `${method} ${url}`, "METHOD_NOT_ALLOWED");
    }
  }
});

test("malformed JSON, foreign content-types, and empty json bodies are structured 4xx (never 500)", async (t) => {
  const server = await newServer(t);
  for (const url of [SYNTHESIS, OCCURRENCES]) {
    // Raw invalid JSON with the JSON content type: the dedicated stable
    // INVALID_JSON code (the error handler unwraps Fastify's parser-wrapped
    // SyntaxError), never a 500 or stack leak.
    const badJson = await server.app.inject({ method: "POST", url, payload: "{not json", headers: { "content-type": "application/json" } });
    assertClientErrorEnvelope(badJson, `${url} malformed JSON`, "INVALID_JSON");
    assert.equal(badJson.statusCode, 400, `${url} malformed JSON must be 400`);

    // Unsupported content types fail closed with a 4xx envelope.
    const textPlain = await server.app.inject({ method: "POST", url, payload: "flightId=x", headers: { "content-type": "text/plain" } });
    assertClientErrorEnvelope(textPlain, `${url} text/plain content-type`);

    // Empty body under a JSON content type is a client error, never a 500.
    const emptyJson = await server.app.inject({ method: "POST", url, payload: "", headers: { "content-type": "application/json" } });
    assertClientErrorEnvelope(emptyJson, `${url} empty JSON body`);

    // JSON content type with an invalid charset parameter fails closed.
    const badCharset = await server.app.inject({ method: "POST", url, payload: "{}", headers: { "content-type": "application/json; charset=bogus-charset" } });
    assertClientErrorEnvelope(badCharset, `${url} invalid charset`);
  }
});

// Regression: Fastify's content-type parser wraps JSON parse failures in a
// FastifyError (code FST_ERR_CTP_INVALID_JSON_BODY) before the error handler
// runs, so the handler must match that shape to emit the stable INVALID_JSON
// code instead of the generic INVALID_REQUEST. (Found by adversarial sweep A4.)
test("malformed JSON answers the dedicated stable INVALID_JSON code", async (t) => {
  const server = await newServer(t);
  for (const url of [SYNTHESIS, OCCURRENCES]) {
    const badJson = await server.app.inject({ method: "POST", url, payload: "{not json", headers: { "content-type": "application/json" } });
    assertClientErrorEnvelope(badJson, `${url} malformed JSON`, "INVALID_JSON");
  }
});

test("bodies over the 64 KiB parser limit fail closed as REQUEST_TOO_LARGE (413)", async (t) => {
  const server = await newServer(t);
  const oversized = { flightId: "x", padding: "a".repeat(128 * 1024) };
  const response = await server.app.inject({ method: "POST", url: SYNTHESIS, payload: oversized });
  assert.equal(response.statusCode, 413, "an oversized body must answer 413");
  assertClientErrorEnvelope(response, "synthesis oversized body", "REQUEST_TOO_LARGE");
});

test("unknown routes under /api/v1 answer the stable NOT_FOUND envelope", async (t) => {
  const server = await newServer(t);
  for (const url of ["/api/v1/routes/does-not-exist", "/api/v1/nope", "/api/v1/routes/synthesis/extra", "/api/v2/routes/synthesis"]) {
    const response = await server.app.inject({ method: "POST", url, payload: { flightId: "x" } });
    assert.equal(response.statusCode, 404, `POST ${url} must answer 404`);
    const envelope = assertClientErrorEnvelope(response, `POST ${url}`, "NOT_FOUND");
    // The bounded envelope must never reflect the raw method or path back.
    assert.equal(envelope.error.message.includes(url), false, "404 message must never echo the path");
  }
});

test("error codes are stable across repeated identical failures", async (t) => {
  const server = await newServer(t);
  const cases: Array<readonly [string, string, unknown, string, number]> = [
    [SYNTHESIS, "schema-invalid body", { flightId: 7 }, "INVALID_BODY", 400],
    [SYNTHESIS, "garbage flightId", { flightId: "garbage-token" }, "GENERATION_EXPIRED", 410],
    [OCCURRENCES, "garbage proofId", { proofId: "a.b.c" }, "PROOF_INVALID", 400],
    [OCCURRENCES, "schema-invalid body", {}, "INVALID_BODY", 400],
  ];
  for (const [url, label, payload, expectedCode, expectedStatus] of cases) {
    const first = await postExpectEnvelope(server, url, { payload }, `${label} first call`, expectedCode);
    assert.equal(first.statusCode, expectedStatus, `${label}: unexpected status`);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const again = await postExpectEnvelope(server, url, { payload }, `${label} repeat ${repeat + 1}`, expectedCode);
      assert.equal(again.statusCode, first.statusCode, `${label}: status must be stable across calls`);
      assert.equal(again.envelope.error.code, first.envelope.error.code, `${label}: code must be stable across calls`);
      assert.equal(again.envelope.error.message, first.envelope.error.message, `${label}: message must be stable across calls`);
    }
  }
});

test("error envelopes never leak internal snapshot ids or request inputs", async (t) => {
  const server = await newServer(t);
  const snapshot = server.store.requireSnapshot();
  // Craft a marked identifier: if the server ever reflects request input or
  // internal generation identity in an error, this marker surfaces it.
  const marker = `leak-probe-${snapshot.id.slice(0, 8)}`;
  const responses = [
    await server.app.inject({ method: "POST", url: SYNTHESIS, payload: { flightId: marker } }),
    await server.app.inject({ method: "POST", url: OCCURRENCES, payload: { proofId: marker } }),
    await server.app.inject({ method: "POST", url: SYNTHESIS, payload: { flightId: snapshot.id } }),
    await server.app.inject({ method: "POST", url: SYNTHESIS, payload: { flightId: marker, cursor: `${marker}.sig` } }),
  ];
  for (const response of responses) {
    assertClientErrorEnvelope(response, "privacy sweep");
    assert.equal(response.body.includes(marker), false, "error responses must never echo raw request identifiers");
    assert.equal(response.body.includes(snapshot.id), false, "error responses must never leak the internal snapshot id");
  }
});
