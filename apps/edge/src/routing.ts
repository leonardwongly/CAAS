/**
 * Cloudflare-independent edge routing logic.
 *
 * This module must stay free of `cloudflare:*` and `@cloudflare/*` runtime
 * imports so the Worker's request-classification, container-delegation, and
 * secret-wiring decisions can be proven hermetically under the plain Node
 * test runner (the `cloudflare:workers` virtual module cannot be loaded
 * outside the Workers runtime). Bindings are therefore typed structurally.
 */

/** Only the literal `/api/` prefix routes to the API container. */
export function isApiRequest(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

/**
 * The single named container every API request is delegated to. Must match
 * the container `name` and the `API_CONTAINER` durable-object binding wired
 * in wrangler.jsonc (proven by apps/edge/test/sweep-d4-edge.test.ts).
 */
export const API_CONTAINER_NAME = "api";

/** Structural binding contract for the Worker `fetch` handler. */
export interface EdgeBindings {
  readonly API_CONTAINER: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

/**
 * Routes one inbound request: `/api/*` goes to the named API container,
 * everything else (including `/api` without the trailing slash) falls
 * through to static assets. The original request object is forwarded
 * unchanged in both directions.
 */
export function routeRequest(request: Request, environment: EdgeBindings): Promise<Response> {
  const url = new URL(request.url);
  if (isApiRequest(url.pathname)) {
    return environment.API_CONTAINER.getByName(API_CONTAINER_NAME).fetch(request);
  }
  return environment.ASSETS.fetch(request);
}

/** Fixed container service port (the Fastify BFF listens here). */
export const CONTAINER_DEFAULT_PORT = 8080;

/** Declarative container idle policy: sleep after ten minutes of inactivity. */
export const CONTAINER_SLEEP_AFTER = "10m" as const;

/**
 * The container secret-injection contract: the Worker secret `apikey` is the
 * ONLY value handed to the container environment. Nothing else from `env` may
 * cross into the container, and the secret must arrive unmodified.
 */
export function containerEnvVars(env: { readonly apikey: string }): { readonly apikey: string } {
  return { apikey: env.apikey };
}
