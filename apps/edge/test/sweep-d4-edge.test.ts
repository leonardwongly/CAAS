// Adversarial sweep — DOMAIN D4: upstream adapter & edge boundary.
// Owner: D4 — upstream adapter & edge boundary (parallel sweep).
// Scope: the Cloudflare Worker edge boundary — request classification,
// container delegation, the container secret-injection contract, and the
// Worker <-> wrangler.jsonc wiring. The routing logic was extracted into
// src/routing.ts (no cloudflare:* runtime imports) precisely because the
// `cloudflare:workers` virtual module cannot load under plain Node; this file
// is the hermetic proof of the behavior index.ts delegates to.
//
// Not covered here by design: Container sleep/awake is declarative runtime
// state managed by the Containers runtime; the hermetic boundary is pinning
// the declared config (CONTAINER_SLEEP_AFTER / CONTAINER_DEFAULT_PORT) and
// proving it matches the wrangler wiring below. Live container lifecycle is
// exercised by the container smoke lanes, not this unit lane.
//
// De-duped against: apps/edge/test/routing.test.ts (kept: the original four
// classification pins remain the minimal contract smoke).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  API_CONTAINER_NAME,
  CONTAINER_DEFAULT_PORT,
  CONTAINER_SLEEP_AFTER,
  containerEnvVars,
  isApiRequest,
  routeRequest,
  type EdgeBindings,
} from "../src/routing.ts";

function stubBindings() {
  const calls: { getByName: string[]; containerRequests: Request[]; assetRequests: Request[] } = {
    getByName: [],
    containerRequests: [],
    assetRequests: [],
  };
  const containerResponse = new Response("container", { status: 200 });
  const assetsResponse = new Response("assets", { status: 200 });
  const environment: EdgeBindings = {
    API_CONTAINER: {
      getByName(name) {
        calls.getByName.push(name);
        return {
          async fetch(request) {
            calls.containerRequests.push(request);
            return containerResponse;
          },
        };
      },
    },
    ASSETS: {
      async fetch(request) {
        calls.assetRequests.push(request);
        return assetsResponse;
      },
    },
  };
  return { calls, environment, containerResponse, assetsResponse };
}

// ---------------------------------------------------------------------------
// 1. Request classification: hostile, lookalike, and boundary pathnames.
// ---------------------------------------------------------------------------

test("classification admits only the literal /api/ prefix — lookalikes and escapes fall through to assets", () => {
  // Admitted: anything under the literal prefix, including the bare prefix.
  for (const pathname of ["/api/", "/api/v1/health/ready", "/api//double", "/api/x%20y"]) {
    assert.equal(isApiRequest(pathname), true, `${pathname} must route to the container`);
  }
  // Rejected: missing slash, case tricks, prefix smuggling, lookalikes.
  for (const pathname of [
    "/api",
    "/apix",
    "/API/",
    "/Api/v1",
    "//api/",
    "/x/api/",
    "/./api/",
    "/%61pi/", // percent-encoded "a" — pathname is never percent-decoded
    "/api%2F",
    "/арі/", // Cyrillic lookalike of "api"
    "/api\u200b/", // zero-width space after the prefix breaks the literal match
    "",
    "/",
    "api/", // no leading slash can arrive from URL.pathname, but pin it
  ]) {
    assert.equal(isApiRequest(pathname), false, `${JSON.stringify(pathname)} must fall through to assets`);
  }
});

// ---------------------------------------------------------------------------
// 2. Handler delegation: the original request object is forwarded unchanged
//    and exactly one binding is touched per request.
// ---------------------------------------------------------------------------

test("API requests delegate to the single named container with the identical Request object", async () => {
  const { calls, environment, containerResponse } = stubBindings();
  const request = new Request("https://edge.example/api/v1/flights/generation?cursor=abc", { method: "POST" });
  const response = await routeRequest(request, environment);
  assert.equal(response, containerResponse, "the container response must pass through unmodified (query strings never affect classification)");
  assert.deepEqual(calls.getByName, [API_CONTAINER_NAME], "exactly one container lookup, by the fixed name");
  assert.equal(calls.containerRequests.length, 1);
  assert.equal(calls.containerRequests[0], request, "the original Request must be forwarded, never cloned or rewritten");
  assert.equal(calls.assetRequests.length, 0, "assets must never see an API request");
});

test("non-API requests fall through to ASSETS with the identical Request object", async () => {
  for (const url of ["https://edge.example/", "https://edge.example/api", "https://edge.example/assets/index.js", "https://edge.example/%61pi/x", "https://edge.example/API/v1/x"]) {
    const { calls, environment, assetsResponse } = stubBindings();
    const request = new Request(url);
    const response = await routeRequest(request, environment);
    assert.equal(response, assetsResponse, `${url} must serve the assets response`);
    assert.equal(calls.assetRequests.length, 1);
    assert.equal(calls.assetRequests[0], request, `${url}: the original Request must be forwarded unchanged`);
    assert.deepEqual(calls.getByName, [], `${url}: no container lookup may occur`);
  }
});

test("URL normalization cannot smuggle an asset path into the container (dot segments resolve before classification)", async () => {
  // The handler classifies on `new URL(request.url).pathname`, so dot segments
  // are already resolved: /assets/../api/ becomes /api/ and routes to the
  // container — pin that normalization happens at the URL layer, not by
  // string matching on the raw path.
  const { calls, environment } = stubBindings();
  const request = new Request("https://edge.example/assets/../api/v1/x");
  await routeRequest(request, environment);
  assert.deepEqual(calls.getByName, [API_CONTAINER_NAME], "resolved /api/ pathnames must reach the container");
});

// ---------------------------------------------------------------------------
// 3. Container contract: secret injection is exactly one key; port/sleep
//    config is pinned because the Containers runtime reads it declaratively.
// ---------------------------------------------------------------------------

test("containerEnvVars injects exactly the apikey secret, unmodified, and nothing else", () => {
  const secret = "caas-secret-\u0000-with-hostile-shape";
  const vars = containerEnvVars({ apikey: secret });
  assert.equal(vars.apikey, secret, "the secret must arrive unmodified (no trimming, no encoding)");
  assert.deepEqual(Object.keys(vars), ["apikey"], "exactly one env var may cross into the container");
  // An env carrying more than the secret must not leak the extra values across.
  const varsFromRicherEnv = containerEnvVars({ apikey: secret, OTHER_BINDING: "leak-me" } as unknown as { apikey: string });
  assert.deepEqual(Object.keys(varsFromRicherEnv), ["apikey"], "no other binding may be forwarded to the container");
  assert.equal("OTHER_BINDING" in varsFromRicherEnv, false);
});

test("container port and sleep-after declarations are pinned to the deployed values", () => {
  // sleep/awake itself is Containers-runtime behavior; these declarations are
  // the hermetically testable boundary (a drift silently changes cost and
  // cold-start behavior in production).
  assert.equal(CONTAINER_DEFAULT_PORT, 8080, "the Fastify BFF listens on 8080");
  assert.equal(CONTAINER_SLEEP_AFTER, "10m", "the container sleeps after ten minutes idle");
});

// ---------------------------------------------------------------------------
// 4. Worker <-> wrangler.jsonc wiring: the names this code depends on must
//    match the deploy configuration.
// ---------------------------------------------------------------------------

function parseJsonc(text: string): Record<string, unknown> {
  const withoutLineComments = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(withoutLineComments) as Record<string, unknown>;
}

test("wrangler.jsonc wires the container name, DO binding, required secret, and asset binding the Worker code assumes", async () => {
  const wrangler = parseJsonc(await readFile(new URL("../../../wrangler.jsonc", import.meta.url), "utf8"));

  const containers = wrangler["containers"] as Array<{ name: string; class_name: string }>;
  assert.ok(Array.isArray(containers) && containers.length === 1, "exactly one container is declared");
  assert.equal(containers[0]?.name, API_CONTAINER_NAME, "getByName(API_CONTAINER_NAME) must match the declared container name");
  assert.equal(containers[0]?.class_name, "ApiContainer", "the container class export must match");

  const bindings = (wrangler["durable_objects"] as { bindings: Array<{ name: string; class_name: string }> })["bindings"];
  assert.ok(bindings?.some((binding) => binding.name === "API_CONTAINER" && binding.class_name === "ApiContainer"), "the API_CONTAINER DO binding must exist for environment.API_CONTAINER");

  const secrets = (wrangler["secrets"] as { required: string[] })["required"];
  assert.ok(secrets?.includes("apikey"), "secrets.required must declare apikey: the Worker reads env.apikey at container start");

  const assets = wrangler["assets"] as { binding: string; run_worker_first: string[] };
  assert.equal(assets["binding"], "ASSETS", "the assets binding name must match environment.ASSETS");
  assert.deepEqual(assets["run_worker_first"], ["/api/*"], "run_worker_first must keep /api/* on the Worker so classification sees every API request");

  // The staging environment must carry the same contract.
  const staging = (wrangler["env"] as Record<string, Record<string, unknown>>)["staging"];
  const stagingSecrets = (staging?.["secrets"] as { required: string[] } | undefined)?.["required"];
  assert.ok(stagingSecrets?.includes("apikey"), "staging must also require the apikey secret");
  const stagingBindings = (staging?.["durable_objects"] as { bindings: Array<{ name: string }> } | undefined)?.["bindings"];
  assert.ok(stagingBindings?.some((binding) => binding.name === "API_CONTAINER"), "staging must also bind API_CONTAINER");
});
