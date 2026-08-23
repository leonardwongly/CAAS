import { Container } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import {
  CONTAINER_DEFAULT_PORT,
  CONTAINER_SLEEP_AFTER,
  containerEnvVars,
  routeRequest,
  type EdgeBindings,
} from "./routing.js";

interface EdgeEnv {
  readonly API_CONTAINER: DurableObjectNamespace<ApiContainer>;
  readonly ASSETS: Fetcher;
}

// Wrangler validates this binding before deploy through `secrets.required`.
const requiredSecrets = env as unknown as { readonly apikey: string };

/**
 * The existing Fastify service remains unchanged inside the container. The
 * upstream CAAS credential is a Worker secret and is injected only at
 * container start; it is never made available to browser assets or responses.
 * The routing, container-name, and secret-injection logic lives in
 * ./routing.ts so it stays hermetically testable under plain Node.
 */
export class ApiContainer extends Container<EdgeEnv> {
  defaultPort = CONTAINER_DEFAULT_PORT;
  sleepAfter = CONTAINER_SLEEP_AFTER;
  envVars = containerEnvVars(requiredSecrets);
}

export default {
  async fetch(request, environment): Promise<Response> {
    return routeRequest(request, environment as unknown as EdgeBindings);
  },
} satisfies ExportedHandler<EdgeEnv>;
