import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApiServer } from "../../apps/api/src/index.ts";
// The §6.2 freshness-window constants themselves are pinned by
// packages/upstream-caas/test/freshness.test.ts (the package owns its
// constants); this suite pins the server-side deadline and the runtime
// behaviors instead.
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";
import { searchCallsigns } from "../../apps/web/src/api.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const apiSource = readFileSync(resolve(ROOT, "apps/web/src/api.ts"), "utf8");
const appSource = readFileSync(resolve(ROOT, "apps/web/src/App.tsx"), "utf8");
const serverSource = readFileSync(resolve(ROOT, "apps/api/src/server.ts"), "utf8");

/** Candidate-qualifying copy must never call a candidate valid, recommended, safe, cleared, or best. */
const FORBIDDEN_QUALIFIERS = /\b(valid|recommended|safe|cleared|best)\b/i;

test("pins the plan §6.2 5-second warm request deadline", () => {
  assert.match(serverSource, /DEFAULT_WARM_DEADLINE_MS = 5 \* 1000/, "warm API requests must have a 5-second hard deadline");
});

test("callsign search sends the query in the POST body and never in the URL", async (t) => {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? input);
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "opaque-flight-1", callsign: "SQ321", departure: "WSSS", destination: "WSSS", routePointCount: 4 }] }),
    } as unknown as Response;
  }) as typeof fetch;

  const matches = await searchCallsigns("SQ321");
  assert.equal(matches.length, 1);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "/api/v1/callsigns/search", "the fetch URL must be exactly the endpoint path");
  assert.ok(!call.url.includes("?"), "no query string may carry flight identifiers");
  assert.ok(!call.url.includes("SQ321"), "the callsign must never appear in the URL");
  assert.equal(call.init?.method, "POST");
  const body = JSON.parse(String(call.init?.body)) as { query: string };
  assert.equal(body.query, "SQ321", "the query travels in the request body");
});

test("the web client never pushes flight state into the browser URL", () => {
  // Plan §2.4: URLs must contain no live flight identifiers, callsigns,
  // coordinates, tokens, or query state — the client never navigates or
  // rewrites history with search or selection state.
  assert.ok(!apiSource.includes("pushState"), "api.ts must never push navigation state");
  assert.ok(!apiSource.includes("location.search"), "api.ts must never read URL query state");
  assert.ok(!appSource.includes("history.pushState"), "App.tsx must never push the callsign into browser history");
  assert.ok(!appSource.includes("window.location"), "App.tsx must never navigate with flight state");
});

test("nothing persists across server restart: old cursors, routes, and drafts fail closed", async (t) => {
  const first = await createApiServer({ adapter: sanitizedAdapter() });
  const browse = await first.app.inject({ method: "GET", url: "/api/v1/routes?limit=1" });
  assert.equal(browse.statusCode, 200);
  const browseBody = browse.json() as { nextCursor?: string; data: Array<{ id: string }> };
  assert.ok(browseBody.nextCursor);
  assert.ok(browseBody.data[0]?.id);
  const flightId = browseBody.data[0]!.id;
  const draft = await first.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KOR1", via: ["MISSING"], destination: "KDS1" } });
  assert.equal(draft.statusCode, 201);
  const draftId = (draft.json() as { id: string }).id;
  await first.app.close();

  const second = await createApiServer({ adapter: sanitizedAdapter() });
  t.after(() => second.app.close());

  const staleCursor = await second.app.inject({ method: "GET", url: `/api/v1/routes?limit=1&cursor=${encodeURIComponent(browseBody.nextCursor!)}` });
  assert.equal(staleCursor.statusCode, 409);
  assert.equal((staleCursor.json() as { error: { code: string } }).error.code, "CURSOR_EXPIRED");
  const staleRoute = await second.app.inject({ method: "GET", url: `/api/v1/routes/${encodeURIComponent(flightId)}` });
  assert.equal(staleRoute.statusCode, 410);
  assert.equal((staleRoute.json() as { error: { code: string } }).error.code, "GENERATION_EXPIRED");
  const staleDraft = await second.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });
  assert.equal(staleDraft.statusCode, 410);
  assert.equal((staleDraft.json() as { error: { code: string } }).error.code, "DRAFT_EXPIRED");
});

test("route options preserve selected-first neutral order, provenance, and descriptive distance", async (t) => {
  const server = await createApiServer({ adapter: sanitizedAdapter() });
  t.after(() => server.app.close());

  const search = await server.app.inject({ method: "POST", url: "/api/v1/callsigns/search", payload: { query: "FIXTURE1" } });
  assert.equal(search.statusCode, 200);
  const flightId = String((search.json() as { data: Array<{ id: unknown }> }).data[0]?.id);
  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId } });
  assert.equal(options.statusCode, 200);
  const body = options.json() as { data: Array<{ flightId: string; complete: boolean; distanceNm?: number; provenance?: string }> };

  assert.equal(body.data[0]?.flightId, flightId, "the explicitly selected flight must remain first");
  assert.ok(body.data.length >= 1);
  for (const candidate of body.data) {
    if (candidate.complete) assert.equal(typeof candidate.distanceNm, "number", "complete routes carry descriptive modeled distance");
    assert.ok(candidate.provenance, "every route carries provenance");
  }
  const serialized = JSON.stringify(body);
  for (const field of ["rank", "rankDistanceNm", "rankLabel", "operationalProxy"]) {
    assert.equal(serialized.includes(`"${field}"`), false, `${field} must not be emitted`);
  }
  const forbidden = serialized.match(FORBIDDEN_QUALIFIERS);
  assert.equal(forbidden, null, `the route-options response qualifies a candidate: ${forbidden?.[0]}`);
});
