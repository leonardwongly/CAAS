# CAAS data-use and five-family contract

## Authorization and handling

The retained discovery record is classified as secret-free aggregate evidence. Discovery used the local `apikey` environment variable for bounded read-only requests; the value was not printed or retained. A successful HTTP response or possession of the key is not data-redistribution authorization. No Challenge Data Use Record is present in this repository, so live CAAS-derived data must remain in an authorized operator environment until that record exists.

The runtime contract is server-only. The browser never calls CAAS, receives the CAAS key, or receives raw upstream objects. The server must stream bounded responses through a parser and sanitization step, retain only the fields needed by the stable contract, release raw buffers, and emit aggregate diagnostics without identifiers or sensitive fields.

## Allowed request contract

Only HTTPS `GET` requests to the printed CAAS host and these exact path families are allowed:

| Family | Path | Declared media/body observed | Runtime use |
|---|---|---|---|
| Flight Plan | `/flight-manager/displayAll` | `application/json` containing a bounded collection | Search, callsign selection, recorded routes |
| Airways | `/geopoints/list/airways` | `text/plain` containing a JSON array | Mandatory fetch, parse, schema/count validation; no product values |
| Fixes | `/geopoints/list/fixes` | `text/plain` containing a JSON array of `IDENTIFIER (latitude,longitude)` strings | Exact intermediate resolution |
| Airports | `/geopoints/list/airports` | `text/plain` containing the same bounded coordinate-string form | Exact endpoint resolution |
| NAVAIDs | `/geopoints/list/navaids` | `text/plain` containing the same bounded coordinate-string form | Exact intermediate resolution |

Reject legacy HTTP/IP targets, redirects, proxy-selected destinations, arbitrary methods, and arbitrary paths. The observed `text/plain` declaration does not permit treating an unbounded body as safe JSON; size, record, coordinate, and total-count limits apply before admission.

## Retained discovery facts

Discovery began at `2026-08-12T09:30:06Z` and recorded these aggregate observations:

- Flight Plan: 222,298 bytes and 115 records.
- Airways: 66,243 bytes and 9,319 records.
- Fixes: 5,655,307 bytes and 247,419 records.
- Airports: 288,573 bytes and 13,175 records.
- NAVAIDs: 206,841 bytes and 10,195 records.
- All 270,789 reference records passed the bounded identifier/coordinate parser and coordinate-range checks.
- Airports resolved all 115 observed departures and 114 of 115 destinations.
- Of 891 designated route occurrences, Fixes matched 577, NAVAIDs matched 243 (234 NAVAID-only), 9 matched multiple datasets, and 80 remained unresolved.
- Fifty-nine flights had 927 ordered route elements, with a maximum of 39; 89 callsign groups existed and 24 were duplicated.

The full secret-free aggregate record and response-hash locators are [here](../evidence/pg-00-live-api-discovery.json). A hash prefix is an evidence locator, not an upstream version identifier.

## Hidden Airways semantics

Discovery observed `DIRECT`, `NAMED`, `SID`, and `STAR` types. There were 889 route elements with airway values; 653 values appeared in the separate airway list and 236 did not. Route-text association was inconsistent, and no authoritative occurrence/inbound-leg/outbound-leg relation was established.

Implementation consequences:

1. Always acquire and validate Airways because it is a required family.
2. Count it in internal generation-health evidence without returning its values/types.
3. Do not put airway fields in public DTOs, error details, logs, signatures, route diffs, map labels, geometry, completeness, or ranking.
4. Do not infer a directed graph from adjacency or name matching.
5. Record the user-approved graphical-airway variance honestly in evidence.

## Schema and resolution rules

Treat OpenAPI as discovery material, not the runtime trust boundary. The observed data may use aliases such as `enroute` where a schema says `enRoute`, string coordinates where a schema suggests numbers, and extra fields. Map accepted aliases deliberately, discard unknown fields, reject malformed values, and keep the normalized contract versioned.

For each reference string, parse a bounded identifier plus latitude/longitude and reject out-of-range coordinates. Index all exact matches, preserving multiplicity. Resolve endpoints with Airports and intermediate identifiers with Fixes/NAVAIDs. If an identifier is absent or ambiguous, return an explicit unresolved/ambiguous state. No proximity inference, airway-name inference, or silent repair is permitted.

## What this evidence does not prove

The discovery record does not prove quotas, retries, pagination, induced-failure behavior, long-term stability, redistribution rights, or implementation. No throttling or upstream-fault probe was deliberately performed, and no pagination metadata or Flight response rate-limit/retry headers were observed. Those behaviors require later deterministic adapter tests and any separately authorized live evidence.
