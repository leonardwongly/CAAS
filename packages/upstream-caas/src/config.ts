import { MAX_ROUTE_POINTS } from "@flight-route-explorer/contracts";
import type { CaasFamily } from "./types.ts";

export const CAAS_ORIGIN = "https://api.swimapisg.info" as const;
export const API_KEY_HEADER = "apikey" as const;
export const CONNECT_TIMEOUT_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RETRY_AFTER_MS = 5_000;
export const MAX_TOTAL_REFERENCE_RECORDS = 700_000;
export const MAX_ROUTE_ELEMENTS = MAX_ROUTE_POINTS - 2;

export interface FamilyPolicy {
  readonly path: string;
  readonly expectedMediaType: "application/json" | "text/plain";
  readonly maxBytes: number;
  readonly maxRecords: number;
}

export const FAMILY_POLICIES: Readonly<Record<CaasFamily, FamilyPolicy>> = Object.freeze({
  displayAll: { path: "/flight-manager/displayAll", expectedMediaType: "application/json", maxBytes: 10 * 1024 * 1024, maxRecords: 10_000 },
  airways: { path: "/geopoints/list/airways", expectedMediaType: "text/plain", maxBytes: 5 * 1024 * 1024, maxRecords: 100_000 },
  fixes: { path: "/geopoints/list/fixes", expectedMediaType: "text/plain", maxBytes: 96 * 1024 * 1024, maxRecords: 500_000 },
  airports: { path: "/geopoints/list/airports", expectedMediaType: "text/plain", maxBytes: 32 * 1024 * 1024, maxRecords: 100_000 },
  navaids: { path: "/geopoints/list/navaids", expectedMediaType: "text/plain", maxBytes: 32 * 1024 * 1024, maxRecords: 100_000 },
});

export function familyUrl(family: CaasFamily): string {
  return `${CAAS_ORIGIN}${FAMILY_POLICIES[family].path}`;
}
