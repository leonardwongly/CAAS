import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Security sweep round-2 deferred candidates, fixed by triage:
// - /startup must report started whenever a servable generation exists,
//   including during an in-flight refresh (the retained generation serves).
// - state-changing requests carrying a mismatched Origin are rejected 403
//   (cross-site form POST defense; GET stays read-only).

test("/startup reports started while a refresh is in flight and the retained generation serves", async () => {
  const base = sanitizedAdapter();
  let gateResolve: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { gateResolve = resolve; });
  let displayCalls = 0;
  let armed = false;
  const adapter = {
    ...base,
    // First displayAll call serves server initialization; the second (the
    // refresh acquisition) parks until the test releases the gate.
    displayAll: async (signal?: AbortSignal) => {
      displayCalls += 1;
      if (displayCalls === 2) {
        armed = true;
        await gate;
      }
      return base.displayAll(signal);
    },
  };
  const server = await createApiServer({ adapter, initialize: false });
  try {
    await server.store.initialize();
    const started = await server.app.inject({ method: "GET", url: "/api/v1/startupz" });
    assert.equal(started.statusCode, 200, "a cold server with a complete generation reports started");

    // Park the refresh inside acquisition: the retained generation still serves.
    const refresh = server.app.inject({ method: "POST", url: "/api/v1/refresh" });
    while (!armed) await new Promise((resolve) => setTimeout(resolve, 1));
    const during = await server.app.inject({ method: "GET", url: "/api/v1/startupz" });
    assert.equal(during.statusCode, 200, "startup must report started while the retained generation serves during a refresh");
    gateResolve?.();
    const finished = await refresh;
    assert.equal(finished.statusCode, 200);
  } finally {
    gateResolve?.();
    await server.app.close();
  }
});

test("a state-changing request with a mismatched Origin header is rejected 403", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter() });
  try {
    const evil = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { origin: "https://evil.example" } });
    assert.equal(evil.statusCode, 403, "a cross-origin refresh attempt must be denied");
    assert.equal((evil.json() as { error: { code: string } }).error.code, "CROSS_ORIGIN_DENIED");

    const sameOrigin = await server.app.inject({ method: "POST", url: "/api/v1/refresh", headers: { origin: "http://127.0.0.1:1", host: "127.0.0.1:1" } });
    assert.notEqual(sameOrigin.statusCode, 403, "a same-origin refresh must not be blocked by the origin defense");

    const noOrigin = await server.app.inject({ method: "POST", url: "/api/v1/refresh" });
    assert.notEqual(noOrigin.statusCode, 403, "non-browser clients without an Origin header remain allowed (single-user access model)");
  } finally {
    await server.app.close();
  }
});
