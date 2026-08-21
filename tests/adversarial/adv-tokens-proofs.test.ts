import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { createApiServer, type ApiServerOptions } from "../../apps/api/src/index.ts";
import { scopedToken, type Snapshot } from "../../apps/api/src/snapshot.ts";
import { overviewProjection } from "../../apps/api/src/projection.ts";
import { synthesisAdapter } from "../fixtures/synthesis-caas.ts";

// Adversarial sweep A6 — HMAC tokens, donor proofs, projection/snapshot
// integrity boundaries (owner: parallel adversarial agent, domain A6).
//
// Goes deeper than the existing suites without duplicating them:
// - sec-r5-synthesis.test.ts covers single-char forgery/tamper, one expired
//   proof, cross-generation proofs, and cursor flight-binding.
// - adv-api-malformed.test.ts covers structurally garbage tokens.
// - pagination/generation-lifecycle cover limit/query binding and refresh.
//
// This sweep pins, with access to the generation secret via the exported
// scopedToken/store surface:
// 1. Semantic field-level body tamper under the genuine signature, and
//    re-signing under guessed/wrong secrets.
// 2. Encoding edge cases with VALID signatures (standard base64, padding,
//    out-of-alphabet bytes, signed non-JSON/non-object payloads, duplicate
//    JSON keys, the 2048-char schema boundary, truncation, extra segments).
// 3. Exact expiry comparison semantics (`e < now()` — inclusive at e) on a
//    controlled monotonic clock, including non-finite/string expiries.
// 4. Type confusion across every consuming endpoint, and q-binding between
//    cursors of the same token type.
// 5. Projection/snapshot immutability boundaries (frozen surfaces, mutable
//    pockets that must never leak into later projections).
// 6. Cross-server generation identity (distinct secrets, foreign tokens
//    rejected as expired/invalid — never resolved).

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;

const DRAFT_TTL_MS = 15 * 60 * 1000;
const LIVE_UNUSABLE_MS = 30 * 60 * 1000;

async function newServer(options: Partial<ApiServerOptions> & { close: (server: ApiServer) => void }): Promise<ApiServer> {
  const { close, ...rest } = options;
  const server = await createApiServer({ adapter: synthesisAdapter(), refreshMinIntervalMs: 0, ...rest });
  close(server);
  return server;
}

async function flightIds(server: ApiServer): Promise<Map<string, string>> {
  const overview = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 25 } });
  assert.equal(overview.statusCode, 200);
  const map = new Map<string, string>();
  for (const route of (overview.json() as { data: Array<{ callsign: string; flightId: string }> }).data) map.set(route.callsign, route.flightId);
  return map;
}

async function firstProofId(server: ApiServer, ids: Map<string, string>): Promise<string> {
  const synthesis = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: ids.get("SYNTH3") } });
  assert.equal(synthesis.statusCode, 200);
  const body = synthesis.json() as { candidates: Array<{ segments: Array<{ proofIds?: string[] }> }> };
  const proofIds = body.candidates.flatMap((candidate) => candidate.segments).flatMap((segment) => segment.proofIds ?? []);
  assert.ok(proofIds.length > 0, "the fixture target must mint at least one donor proof");
  return proofIds[0]!;
}

function errorCode(response: { json: () => unknown }): string {
  return (response.json() as { error: { code: string } }).error.code;
}

function sign(snapshot: Snapshot, body: string): string {
  return `${body}.${createHmac("sha256", snapshot.tokenSecret).update(body).digest("base64url")}`;
}

function decodeBody(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

async function expectProofInvalid(server: ApiServer, proofId: string, context: string): Promise<void> {
  const response = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId } });
  assert.equal(response.statusCode, 400, `${context}: must fail closed with 400 (got ${response.statusCode})`);
  assert.equal(errorCode(response), "PROOF_INVALID", `${context}: rejection code must be PROOF_INVALID`);
}

test("semantic field-level tamper keeps failing HMAC, and guessed-secret re-signing never verifies", async (t) => {
  const server = await newServer({ close: (s) => t.after(() => s.app.close()) });
  const snapshot = server.store.requireSnapshot();
  const ids = await flightIds(server);
  const proofId = await firstProofId(server, ids);
  const [body, signature] = proofId.split(".") as [string, string];
  const payload = decodeBody(proofId);

  // Every claim in the token body is bound by the signature: re-encoding any
  // single mutated field under the ORIGINAL signature must fail closed.
  const mutations: Array<[string, (fields: Record<string, unknown>) => Record<string, unknown>]> = [
    ["g (generation id)", (f) => ({ ...f, g: randomUUID() })],
    ["t (token type)", (f) => ({ ...f, t: "flight" })],
    ["e (expiry) extended", (f) => ({ ...f, e: (f.e as number) + 60_000 })],
    ["n (nonce)", (f) => ({ ...f, n: "attacker-nonce" })],
    ["i (donor flight index)", (f) => ({ ...f, i: (f.i as number) + 1 })],
    ["f (ordinal lower bound)", (f) => ({ ...f, f: (f.f as number) + 1 })],
    ["u (ordinal upper bound)", (f) => ({ ...f, u: (f.u as number) + 1 })],
  ];
  for (const [label, mutate] of mutations) {
    const tampered = `${Buffer.from(JSON.stringify(mutate(payload)), "utf8").toString("base64url")}.${signature}`;
    await expectProofInvalid(server, tampered, `tampered ${label}`);
  }

  // An attacker who knows the token anatomy but not the secret: re-sign the
  // tampered body under empty/short/very-long guesses and a random 32-byte
  // key. None may verify.
  const tamperedBody = Buffer.from(JSON.stringify({ ...payload, i: (payload.i as number) + 1 }), "utf8").toString("base64url");
  const guesses: Array<[string, Buffer]> = [
    ["empty secret", Buffer.from("")],
    ["short guess", Buffer.from("token-secret")],
    ["very-long guess", Buffer.from("x".repeat(4096))],
    ["random 32-byte key", Buffer.alloc(32, 7)],
  ];
  for (const [label, secret] of guesses) {
    const forged = `${tamperedBody}.${createHmac("sha256", secret).update(tamperedBody).digest("base64url")}`;
    await expectProofInvalid(server, forged, `re-signed with ${label}`);
  }

  // Sanity: the genuine proof still resolves on its own generation.
  const genuine = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId } });
  assert.equal(genuine.statusCode, 200);
});

test("encoding edge cases fail closed even with a valid signature from the real secret", async (t) => {
  const server = await newServer({ close: (s) => t.after(() => s.app.close()) });
  const snapshot = server.store.requireSnapshot();
  const proof = (fields: Record<string, unknown>): string =>
    scopedToken(snapshot, "donor-proof", { i: 1, f: 0, u: 3, ...fields }, snapshot.unusableAtMs);

  // The wire alphabet is base64url WITHOUT padding: standard-base64 bodies
  // containing '+' or '/' (forced via payload bytes) and an appended '='
  // must all be rejected even though each carries a genuine HMAC over its
  // body string. (A standard-base64 encoding that happens to avoid '+//=' is
  // byte-identical to base64url and legitimately verifies.)
  const payloadFor = (nonce: string): string => JSON.stringify({ g: snapshot.id, t: "donor-proof", e: snapshot.unusableAtMs, n: nonce, i: 1, f: 0, u: 3 });
  const forbidden = (nonce: string): string => sign(snapshot, Buffer.from(payloadFor(nonce), "utf8").toString("base64"));
  // Find payload nonces whose full standard-base64 body actually carries the
  // forbidden chars. Note the structural property this encodes: sextets 62
  // ('+') and 63 ('/') need a set high bit somewhere in a 3-byte group, so
  // ASCII-only JSON (all bytes <= 0x7A for this payload shape) can NEVER
  // encode them — only non-ASCII UTF-8 nonce bytes can.
  const nonceForcing = (char: "+" | "/"): string => {
    for (const suffix of ["þ", "ÿ", "þþ", "ÿþ", "þÿ"]) {
      for (let i = 0; i < 1000; i += 1) {
        const candidate = `adv${i}${suffix}`;
        if (Buffer.from(payloadFor(candidate), "utf8").toString("base64").includes(char)) return candidate;
      }
    }
    throw new Error(`no nonce found forcing ${char}`);
  };
  await expectProofInvalid(server, forbidden(nonceForcing("+")), "standard base64 body containing '+'");
  await expectProofInvalid(server, forbidden(nonceForcing("/")), "standard base64 body containing '/'");
  const genuine = proof({});
  const [genuineBody] = genuine.split(".") as [string, string];
  await expectProofInvalid(server, sign(snapshot, `${genuineBody}=`), "genuine body with appended '=' padding");
  await expectProofInvalid(server, sign(snapshot, "ab+cd/ef=="), "out-of-alphabet '+' and '/' bytes");

  // HMAC-valid bodies that are not a JSON object must never decode: non-JSON
  // bytes and JSON scalars/arrays/null all fail closed.
  await expectProofInvalid(server, sign(snapshot, Buffer.from("definitely { not json", "utf8").toString("base64url")), "signed non-JSON payload");
  for (const scalar of ["42", '"hello"', "null", "true", "[1,2]"]) {
    await expectProofInvalid(server, sign(snapshot, Buffer.from(scalar, "utf8").toString("base64url")), `signed non-object JSON payload ${scalar}`);
  }

  // Duplicate JSON keys: JSON.parse is deterministic last-key-wins. A signed
  // body whose trailing i key names a missing flight resolves to that flight
  // (410, never the earlier key's donor), and the reversed order resolves.
  const lastWins = sign(snapshot, Buffer.from(`{"g":"${snapshot.id}","t":"donor-proof","e":${snapshot.unusableAtMs},"n":"adv","f":0,"u":0,"i":1,"i":999}`, "utf8").toString("base64url"));
  const lastWinsResponse = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: lastWins } });
  assert.equal(lastWinsResponse.statusCode, 410, "duplicate keys: the LAST i key must win (999 names no flight)");
  assert.equal(errorCode(lastWinsResponse), "GENERATION_EXPIRED");
  const firstLoses = sign(snapshot, Buffer.from(`{"g":"${snapshot.id}","t":"donor-proof","e":${snapshot.unusableAtMs},"n":"adv","f":0,"u":0,"i":999,"i":1}`, "utf8").toString("base64url"));
  const firstLosesResponse = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: firstLoses } });
  assert.equal(firstLosesResponse.statusCode, 200, "duplicate keys: the earlier i key must be ignored");

  // Schema length boundary: exactly 2048 chars is schema-valid and must be
  // answered by the token layer (PROOF_INVALID); 2049 is rejected by the
  // request schema before any token processing (memory-safe, bounded).
  await expectProofInvalid(server, "ab".repeat(1024), "2048-char token at the schema boundary");
  const oversize = await server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId: `${"ab".repeat(1024)}a` } });
  assert.equal(oversize.statusCode, 400, "a 2049-char proofId must be rejected at the schema boundary");
  assert.equal(errorCode(oversize), "INVALID_BODY");

  // Structural surgery on a genuine token: truncation and segment-count
  // changes fail closed even though every remaining char is in-alphabet.
  const separator = genuine.indexOf(".");
  await expectProofInvalid(server, genuine.slice(0, separator), "genuine token truncated to its body only");
  await expectProofInvalid(server, `${genuineBody}.${genuine.slice(separator + 1).slice(0, 10)}`, "genuine token with truncated signature");
  await expectProofInvalid(server, `${genuine}.x`, "genuine token with an appended third segment");
});

test("expiry comparison is inclusive at e (`e < now`), monotone, and immune to non-finite expiries", async (t) => {
  const base = 1_800_000_000_000;
  const clock = { t: base };
  const server = await newServer({ now: () => clock.t, close: (s) => t.after(() => s.app.close()) });
  const snapshot = server.store.requireSnapshot();
  assert.equal(snapshot.unusableAtMs, base + LIVE_UNUSABLE_MS, "the generation unusable boundary anchors the controlled clock");

  const proofAt = (expiresAt: number): string => scopedToken(snapshot, "donor-proof", { i: 1, f: 0, u: 3 }, expiresAt);
  const resolve = async (proofId: string) => server.app.inject({ method: "POST", url: "/api/v1/routes/source-occurrences", payload: { proofId } });

  // expiresAt === now is still valid; the next millisecond is not.
  const boundary = proofAt(base + 60_000);
  clock.t = base + 60_000;
  assert.equal((await resolve(boundary)).statusCode, 200, "e === now must still be servable (inclusive boundary)");
  clock.t = base + 60_001;
  const justAfter = await resolve(boundary);
  assert.equal(justAfter.statusCode, 400, "one millisecond past e must fail closed");
  assert.equal(errorCode(justAfter), "PROOF_INVALID");

  // Already-past expiry, and non-finite/string expiries that serialize to
  // null or the wrong type, must never mint an immortal token.
  clock.t = base + 120_000;
  await expectProofInvalid(server, proofAt(clock.t - 1), "expiresAt one ms in the past");
  await expectProofInvalid(server, proofAt(Number.POSITIVE_INFINITY), "expiresAt = Infinity (serializes as null)");
  await expectProofInvalid(server, proofAt(Number.NaN), "expiresAt = NaN (serializes as null)");
  const stringExpiry = scopedToken(snapshot, "donor-proof", { i: 1, f: 0, u: 3, e: `${snapshot.unusableAtMs}` });
  await expectProofInvalid(server, stringExpiry, "string-typed expiry overriding e");

  // The service-issued default expiry IS the generation's unusable instant,
  // and it stays inclusive: at exactly unusableAtMs the generation is stale
  // but servable and the proof resolves; one ms later the whole surface is
  // 503 (the generation dies with its tokens — fail closed together).
  const ids = await flightIds(server);
  const issued = await firstProofId(server, ids);
  assert.equal(decodeBody(issued).e, snapshot.unusableAtMs, "issued proofs expire exactly at the generation unusable boundary");
  clock.t = base + LIVE_UNUSABLE_MS;
  assert.equal((await resolve(issued)).statusCode, 200, "at exactly unusableAtMs the default-expiry proof must still resolve");
  clock.t = base + LIVE_UNUSABLE_MS + 1;
  const dead = await resolve(issued);
  assert.equal(dead.statusCode, 503, "one ms past unusableAtMs the generation itself must fail closed");
  assert.equal(errorCode(dead), "GENERATION_STALE");
});

// Regression: the donor-proof path must enforce the same string-nonce gate as
// every other scoped-token consumer (decodeScoped, cursorOffset, getDraft,
// selectedLocation), failing closed with PROOF_INVALID on a numeric or missing
// nonce. (Found by adversarial sweep A6.)
test("a donor proof with a non-string nonce fails closed like every other token surface", async (t) => {
  const server = await newServer({ close: (s) => t.after(() => s.app.close()) });
  const snapshot = server.store.requireSnapshot();
  const numericNonce = scopedToken(snapshot, "donor-proof", { i: 1, f: 0, u: 3, n: 12345 });
  await expectProofInvalid(server, numericNonce, "numeric nonce overriding n");
  const missingNonce = sign(snapshot, Buffer.from(JSON.stringify({ g: snapshot.id, t: "donor-proof", e: snapshot.unusableAtMs, i: 1, f: 0, u: 3 }), "utf8").toString("base64url"));
  await expectProofInvalid(server, missingNonce, "missing nonce");
});

test("tokens are type- and context-bound: no token of one kind is usable where another is expected", async (t) => {
  const server = await newServer({ close: (s) => t.after(() => s.app.close()) });
  const ids = await flightIds(server);
  const flightToken = ids.get("SYNTH1")!;
  const proofToken = await firstProofId(server, ids);

  // A location token is not a flight token on any flight-consuming surface.
  const point = await server.app.inject({ method: "POST", url: "/api/v1/points", payload: { reference: "X" } });
  assert.equal(point.statusCode, 200);
  const locationToken = (point.json() as { data: { id: string } }).data.id;
  const detailWithLocation = await server.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: locationToken } });
  assert.equal(detailWithLocation.statusCode, 410, "a location token must not resolve as a flight id");
  assert.equal(errorCode(detailWithLocation), "GENERATION_EXPIRED");
  const synthesisWithLocation = await server.app.inject({ method: "POST", url: "/api/v1/routes/synthesis", payload: { flightId: locationToken } });
  assert.equal(synthesisWithLocation.statusCode, 410, "a location token must not select a synthesis target");

  // A flight token is not a location token for endpoint selection.
  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { originId: flightToken, destinationId: flightToken } });
  assert.equal(options.statusCode, 410, "a flight token must not resolve as an endpoint location id");
  assert.equal(errorCode(options), "GENERATION_EXPIRED");

  // A donor-proof token is neither a flight id nor a proof-of-anything else.
  const detailWithProof = await server.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: proofToken } });
  assert.equal(detailWithProof.statusCode, 410, "a donor-proof token must not resolve as a flight id");
  const draft = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "A", destination: "D" } });
  assert.equal(draft.statusCode, 201);
  const draftToken = (draft.json() as { id: string }).id;
  await expectProofInvalid(server, draftToken, "a draft token replayed as a donor proof");
  await expectProofInvalid(server, flightToken, "a flight token replayed as a donor proof");

  // Cursor types do not cross: a search (flight-cursor) cursor cannot page
  // the overview, and a same-type browse cursor is still q-bound (the GET
  // browse context "" is not the POST data/flights context "flights").
  const search = await server.app.inject({ method: "POST", url: "/api/v1/search", payload: { query: "SYNTH", limit: 2 } });
  assert.equal(search.statusCode, 200);
  const searchCursor = (search.json() as { nextCursor?: string }).nextCursor;
  assert.ok(searchCursor, "7 matches at limit 2 must mint a search cursor");
  const overviewWithSearchCursor = await server.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 2, cursor: searchCursor } });
  assert.equal(overviewWithSearchCursor.statusCode, 409, "a flight-cursor must not page the overview");
  assert.equal(errorCode(overviewWithSearchCursor), "CURSOR_EXPIRED");

  const browse = await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=2" });
  assert.equal(browse.statusCode, 200);
  const browseCursor = (browse.json() as { nextCursor?: string }).nextCursor;
  assert.ok(browseCursor, "7 flights at limit 2 must mint a browse cursor");
  const crossContext = await server.app.inject({ method: "POST", url: "/api/v1/data/flights", payload: { limit: 2, cursor: browseCursor } });
  assert.equal(crossContext.statusCode, 409, "a browse cursor must bind its query context even within one token type");
  assert.equal(errorCode(crossContext), "CURSOR_EXPIRED");
  const ownContext = await server.app.inject({ method: "GET", url: `/api/v1/routes?limit=2&cursor=${encodeURIComponent(browseCursor)}` });
  assert.equal(ownContext.statusCode, 200, "the browse cursor must still page its own surface");
});

test("projections and snapshots expose no shared mutable state: frozen surfaces, contained mutable pockets", async (t) => {
  const server = await newServer({ close: (s) => t.after(() => s.app.close()) });
  const snapshot = server.store.requireSnapshot();
  const flight = snapshot.flightByIndex.get(2);
  assert.ok(flight, "fixture flight index 2 (SYNTH3) must exist");

  // Snapshot internals handed to projections are deep-frozen: locations,
  // their coordinates/aliases, flights, and the index map values. The index
  // map itself exposes no mutation API at all.
  assert.equal(Object.isFrozen(snapshot.flights), true);
  assert.equal(Object.isFrozen(snapshot.locations), true);
  const location = snapshot.locations[0];
  assert.ok(location);
  assert.equal(Object.isFrozen(location), true, "snapshot locations must be frozen");
  assert.equal(Object.isFrozen(location.coordinate), true, "location coordinates must be frozen");
  assert.equal(Object.isFrozen(location.aliases), true, "location aliases must be frozen");
  assert.equal(typeof (snapshot.locationTokens as Map<string, readonly number[]>).set, "undefined", "the location index map must expose no setter");
  const indexes = snapshot.locationTokens.get("X");
  assert.ok(indexes, "fix X must be indexed");
  assert.equal(Object.isFrozen(indexes), true, "index map values must be frozen arrays");

  // Projection surface: every exposed aggregate is frozen, and endpoints are
  // the frozen snapshot locations themselves (shared by reference, safe).
  const first = overviewProjection(snapshot, flight);
  for (const [label, value] of [["projection", first], ["legs", first.legs], ["waypoints", first.waypoints], ["segments", first.segments], ["gaps", first.gaps], ["occurrences", first.occurrences]] as const) {
    assert.equal(Object.isFrozen(value), true, `${label} must be frozen`);
  }
  assert.equal(Object.isFrozen(first.segments[0]), true, "inner segment arrays must be frozen");
  assert.equal(Object.isFrozen(first.origin), true, "projection endpoints must be frozen snapshot locations");
  assert.throws(() => (first.legs as unknown as unknown[]).push(undefined), TypeError, "legs must reject pushes");
  assert.throws(() => { (first.waypoints as unknown as unknown[])[0] = undefined; }, TypeError, "waypoints must reject index writes");
  assert.throws(() => (first.segments[0] as unknown as unknown[]).push(undefined), TypeError, "segment arrays must reject pushes");
  assert.throws(() => (first.occurrences as unknown as unknown[]).push(undefined), TypeError, "occurrences must reject pushes");

  // Mutable pockets (individual leg/gap/occurrence items are not deep-frozen)
  // are acceptable ONLY because they are freshly constructed per projection:
  // mutating them must never leak into a later projection or the snapshot.
  const pristineOccurrences = JSON.parse(JSON.stringify(first.occurrences)) as unknown;
  const pristineDistance = first.legs[0]!.distanceNm;
  (first.legs[0] as unknown as { distanceNm: number }).distanceNm = -1;
  (first.gaps[0] as unknown as { reason: string }).reason = "injected";
  const pointOccurrence = first.occurrences.find((occurrence) => "point" in occurrence);
  assert.ok(pointOccurrence && "point" in pointOccurrence);
  (pointOccurrence as { point: { label: string } }).point.label = "INJECTED";

  const second = overviewProjection(snapshot, flight);
  assert.equal(second.legs[0]!.distanceNm, pristineDistance, "leg mutation must not leak into the next projection");
  assert.notEqual(second.gaps[0]!.reason, "injected", "gap mutation must not leak into the next projection");
  assert.deepEqual(JSON.parse(JSON.stringify(second.occurrences)), pristineOccurrences, "occurrence mutation must not leak into the next projection");
  assert.equal(second.signature, first.signature, "projection signatures must be deterministic across calls");

  // Coordinates referenced by occurrences are the frozen snapshot copies: an
  // attempt to rewrite geometry through a projection must throw, not leak.
  const secondPoint = second.occurrences.find((occurrence) => "point" in occurrence);
  assert.ok(secondPoint && "point" in secondPoint);
  assert.throws(() => { (secondPoint as { point: { coordinate: { lat: number } } }).point.coordinate.lat = 99; }, TypeError, "occurrence coordinates must be the frozen snapshot copies");
});

test("independently created servers mint distinct generations: foreign tokens are expired, never resolved", async (t) => {
  const serverA = await newServer({ close: (s) => t.after(() => s.app.close()) });
  const serverB = await newServer({ close: (s) => t.after(() => s.app.close()) });
  const snapshotA = serverA.store.requireSnapshot();
  const snapshotB = serverB.store.requireSnapshot();

  // The design contract at its edge: same fixture, two processes — distinct
  // generation ids and distinct HMAC secrets, so nothing crosses over.
  assert.notEqual(snapshotA.id, snapshotB.id, "independent servers must mint distinct generation ids");
  assert.equal(snapshotA.tokenSecret.equals(snapshotB.tokenSecret), false, "independent servers must rotate distinct token secrets");

  const idsA = await flightIds(serverA);
  const foreignFlightToken = idsA.get("SYNTH1")!;
  const crossDetail = await serverB.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: foreignFlightToken } });
  assert.equal(crossDetail.statusCode, 410, "a foreign flight token must fail as GENERATION_EXPIRED — never 200 or 404-resolved");
  assert.equal(errorCode(crossDetail), "GENERATION_EXPIRED");

  const overviewA = await serverA.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 2 } });
  const foreignCursor = (overviewA.json() as { nextCursor?: string }).nextCursor;
  assert.ok(foreignCursor, "server A must mint an overview cursor at limit 2");
  const crossCursor = await serverB.app.inject({ method: "POST", url: "/api/v1/routes/overview", payload: { limit: 2, cursor: foreignCursor } });
  assert.equal(crossCursor.statusCode, 409, "a foreign cursor must fail closed as CURSOR_EXPIRED");
  assert.equal(errorCode(crossCursor), "CURSOR_EXPIRED");

  // Sanity: server B resolves its own tokens on its own generation.
  const idsB = await flightIds(serverB);
  const own = await serverB.app.inject({ method: "POST", url: "/api/v1/routes/detail", payload: { routeId: idsB.get("SYNTH1") } });
  assert.equal(own.statusCode, 200);
});

test("draft tokens share the inclusive expiry semantics at the 15-minute TTL boundary", async (t) => {
  const base = 1_800_000_000_000;
  const clock = { t: base };
  const server = await newServer({ now: () => clock.t, close: (s) => t.after(() => s.app.close()) });

  const created = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "A", destination: "D" } });
  assert.equal(created.statusCode, 201);
  const draftId = (created.json() as { id: string }).id;
  const expiry = decodeBody(draftId).e;
  assert.equal(expiry, base + DRAFT_TTL_MS, "a fresh draft's TTL (15 min) must beat the generation unusable boundary");
  assert.equal(decodeBody(draftId).t, "draft", "the draft token must carry the draft type");

  const compare = () => server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });

  clock.t = base + DRAFT_TTL_MS;
  assert.equal((await compare()).statusCode, 200, "at exactly e the draft token must still be servable (inclusive boundary)");
  clock.t = base + DRAFT_TTL_MS + 1;
  const expired = await compare();
  assert.equal(expired.statusCode, 410, "one ms past e the draft must be expired");
  assert.equal(errorCode(expired), "DRAFT_EXPIRED");
});
