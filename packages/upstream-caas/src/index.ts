import { API_KEY_HEADER, FAMILY_POLICIES, MAX_RETRY_AFTER_MS, MAX_TOTAL_REFERENCE_RECORDS, familyUrl } from "./config.ts";
import { CaasAdapterError } from "./errors.ts";
import { normalizeAirways, normalizeDisplayAll, normalizeReferenceList } from "./normalizers.ts";
import { createLiveTransport, type CaasTransport, type CaasTransportResponse } from "./transport.ts";
import type { AirwayEvidence, CaasAdapter, CaasFamily, DisplayAllResult, ReferenceDatasetResult } from "./types.ts";

export * from "./config.ts";
export * from "./errors.ts";
export * from "./freshness.ts";
export * from "./normalizers.ts";
export * from "./transport.ts";
export * from "./types.ts";

export interface CaasAdapterOptions {
  readonly transport?: CaasTransport;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

function runtimeApiKey(): string {
  const processObject = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const key = processObject?.env?.apikey;
  if (!key || !key.trim()) throw new CaasAdapterError("CONFIGURATION", "The CAAS runtime credential is not configured.");
  return key.trim();
}

function mediaType(headers: Readonly<Record<string, string>>): string {
  const value = headers["content-type"] ?? headers["Content-Type"] ?? "";
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function retryAfterMs(headers: Readonly<Record<string, string>>, now: number): number {
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return 0;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.min(MAX_RETRY_AFTER_MS, at - now)) : 0;
}

function retryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CaasAdapterError("CANCELLED", "The upstream request was cancelled."));
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new CaasAdapterError("CANCELLED", "The upstream request was cancelled.")); }, { once: true });
  });
}

function requestCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CaasAdapterError("CANCELLED", "The upstream request was cancelled.");
}

export function createCaasAdapter(options: CaasAdapterOptions = {}): CaasAdapter {
  const apiKey = runtimeApiKey();
  const transport = options.transport ?? createLiveTransport();
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  async function fetchFamily(family: CaasFamily, signal?: AbortSignal): Promise<{ body: string; response: CaasTransportResponse; retried: boolean; durationMs: number }> {
    const policy = FAMILY_POLICIES[family];
    let retried = false;
    const startedAt = now();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      requestCancelled(signal);
      let response: CaasTransportResponse;
      try {
        response = await transport.get({
          family,
          method: "GET",
          url: familyUrl(family),
          headers: { accept: policy.expectedMediaType, [API_KEY_HEADER]: apiKey },
          maxBytes: policy.maxBytes,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (error instanceof CaasAdapterError) throw error;
        throw new CaasAdapterError("UPSTREAM_STATUS", "The upstream request failed.", { family });
      }
      requestCancelled(signal);
      if (response.status === 200) {
        if (typeof response.body !== "string") throw new CaasAdapterError("POLICY_REJECTED", "The upstream response body was not safely bounded.", { family });
        if (mediaType(response.headers) !== policy.expectedMediaType) throw new CaasAdapterError("MEDIA_TYPE", "The upstream media type was not accepted.", { family, status: response.status });
        const bytes = new TextEncoder().encode(response.body).byteLength;
        if (bytes > policy.maxBytes) throw new CaasAdapterError("RESPONSE_TOO_LARGE", "The upstream response exceeded its bounded size.", { family });
        return { body: response.body, response, retried, durationMs: Math.max(0, now() - startedAt) };
      }
      if (retryableStatus(response.status) && attempt === 0) {
        retried = true;
        await sleep(retryAfterMs(response.headers, now()), signal);
        continue;
      }
      throw new CaasAdapterError(retried ? "RETRY_EXHAUSTED" : "UPSTREAM_STATUS", "The upstream response was not successful.", { family, status: response.status });
    }
    throw new CaasAdapterError("RETRY_EXHAUSTED", "The upstream retry policy was exhausted.", { family });
  }

  async function displayAll(signal?: AbortSignal): Promise<DisplayAllResult> {
    const result = await fetchFamily("displayAll", signal);
    return normalizeDisplayAll(result.body, FAMILY_POLICIES.displayAll.maxRecords, result.retried, result.durationMs);
  }

  async function airways(signal?: AbortSignal): Promise<AirwayEvidence> {
    const result = await fetchFamily("airways", signal);
    return normalizeAirways(result.body, FAMILY_POLICIES.airways.maxRecords, result.retried, result.durationMs);
  }

  async function references(dataset: "fixes" | "airports" | "navaids", signal?: AbortSignal): Promise<ReferenceDatasetResult> {
    const result = await fetchFamily(dataset, signal);
    const normalized = normalizeReferenceList(result.body, dataset, FAMILY_POLICIES[dataset].maxRecords, result.retried, result.durationMs);
    if (normalized.points.length > MAX_TOTAL_REFERENCE_RECORDS) throw new CaasAdapterError("RECORD_LIMIT", "The combined reference response exceeded its bounded total.", { family: dataset });
    return normalized;
  }

  return Object.freeze({ displayAll, airways, fixes: (signal?: AbortSignal) => references("fixes", signal), airports: (signal?: AbortSignal) => references("airports", signal), navaids: (signal?: AbortSignal) => references("navaids", signal) });
}

export const createLiveCaasAdapter = createCaasAdapter;
