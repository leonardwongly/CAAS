import { Container } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import { isApiRequest } from "./routing.js";

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
 */
export class ApiContainer extends Container<EdgeEnv> {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars = {
    apikey: requiredSecrets.apikey,
  };
}

export default {
  async fetch(request, environment): Promise<Response> {
    const url = new URL(request.url);
    if (isApiRequest(url.pathname)) {
      return environment.API_CONTAINER.getByName("api").fetch(request);
    }
    return environment.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<EdgeEnv>;
