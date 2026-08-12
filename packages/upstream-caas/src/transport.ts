import {
  API_KEY_HEADER,
  CAAS_ORIGIN,
  CONNECT_TIMEOUT_MS,
  FAMILY_POLICIES,
  REQUEST_TIMEOUT_MS,
  type FamilyPolicy,
} from "./config.ts";
import { CaasAdapterError } from "./errors.ts";
import type { CaasFamily } from "./types.ts";

export interface CaasTransportRequest {
  readonly family: CaasFamily;
  readonly method: "GET";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface CaasTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface CaasTransport {
  get(request: CaasTransportRequest): Promise<CaasTransportResponse>;
}

function assertFixedRequest(request: CaasTransportRequest): FamilyPolicy {
  const policy = FAMILY_POLICIES[request.family];
  if (!policy || request.method !== "GET" || request.url !== `${CAAS_ORIGIN}${policy.path}` || request.maxBytes !== policy.maxBytes) {
    throw new CaasAdapterError("POLICY_REJECTED", "The upstream request is outside the fixed CAAS policy.", { family: request.family });
  }
  const parsed = new URL(request.url);
  if (parsed.protocol !== "https:" || parsed.origin !== CAAS_ORIGIN || parsed.search || parsed.hash) {
    throw new CaasAdapterError("POLICY_REJECTED", "The upstream request is outside the fixed CAAS policy.", { family: request.family });
  }
  return policy;
}

function headerValue(headers: Headers, name: string): string {
  return headers.get(name) ?? "";
}

async function readResponseBody(response: Response, maxBytes: number, family: CaasFamily): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number.isFinite(Number(contentLength)) && Number(contentLength) > maxBytes) {
    throw new CaasAdapterError("RESPONSE_TOO_LARGE", "The upstream response exceeded its bounded size.", { family });
  }
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new CaasAdapterError("RESPONSE_TOO_LARGE", "The upstream response exceeded its bounded size.", { family });
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CaasAdapterError("POLICY_REJECTED", "The upstream response was not valid UTF-8.", { family });
  }
}

export function createLiveTransport(): CaasTransport {
  return {
    async get(request) {
      const policy = assertFixedRequest(request);
      const controller = new AbortController();
      const startedAt = Date.now();
      const totalTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
      const forwardAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", forwardAbort, { once: true });
      try {
        const response = await fetch(request.url, {
          method: "GET",
          headers: request.headers,
          redirect: "error",
          signal: controller.signal,
        });
        clearTimeout(connectTimer);
        if (Date.now() - startedAt >= REQUEST_TIMEOUT_MS) {
          throw new CaasAdapterError("TIMEOUT", "The upstream request timed out.", { family: request.family });
        }
        const body = response.ok ? await readResponseBody(response, policy.maxBytes, request.family) : "";
        if (!response.ok && response.body) await response.body.cancel();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
        return { status: response.status, headers, body };
      } catch (error) {
        if (error instanceof CaasAdapterError) throw error;
        if (request.signal?.aborted) throw new CaasAdapterError("CANCELLED", "The upstream request was cancelled.", { family: request.family });
        if (controller.signal.aborted) throw new CaasAdapterError("TIMEOUT", "The upstream request timed out.", { family: request.family });
        throw new CaasAdapterError("UPSTREAM_STATUS", "The upstream request failed.", { family: request.family });
      } finally {
        clearTimeout(totalTimer);
        clearTimeout(connectTimer);
        request.signal?.removeEventListener("abort", forwardAbort);
      }
    },
  };
}

export { assertFixedRequest };
export const LIVE_API_KEY_HEADER = API_KEY_HEADER;
