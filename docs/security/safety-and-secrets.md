# Security, safety, and privacy boundary

## Non-operational safety boundary

Flight Route Explorer is decision-support visualization only. It must not claim the safest, fastest, least-fuel, legally valid, ATC-acceptable, or operationally optimal route. It must not file, dispatch, activate, approve, clear, or navigate a route.

The UI must permanently display:

> Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.

Use only this candidate label:

> Rank 1 by shortest modeled distance among complete candidates

“Rank 1” means the shortest modeled Haversine total among the admitted complete candidates after tie-key rounding. It does not mean valid, recommended, safe, cleared, suitable, or operationally usable. Avoid those words in candidate names, table headings, API fields, telemetry, and demo narration.

## Data trust boundary

The browser is untrusted and never supplies authoritative coordinates, geometry, endpoint identity, distance, provenance, completeness, or rank. The server recomputes these values from the active generation. Public DTOs are allow-listed and sanitized; raw Flight Plan objects and unnecessary fields never cross the BFF boundary.

The server alone owns the CAAS credential and performs bounded, allow-listed HTTPS GETs. Controls include:

- exact HTTPS origin/path/method allow-list;
- no redirects or proxy-controlled destinations;
- per-request timeout, body-size, record-count, coordinate, route-length, ambiguity, and generation-memory limits;
- strict runtime parsing and coordinate-range checks;
- discard unknown fields and raw buffers after normalization;
- atomic complete-generation admission;
- generation/revision-bound tokens and fail-closed mismatch handling; and
- telemetry allow-lists that exclude credentials, raw objects, airway values/types, callsigns where unnecessary, and sensitive user state.

Network-enforced outbound filtering is intentionally omitted for this least-complex POC. That is an accepted residual only for the private POC and a blocker for broader production access. Application-layer controls remain mandatory.

## Secret handling

The local `.env.example` contains only `apikey=replace-with-a-local-secret`. A real key belongs in an untracked local `.env` or an authorized runtime secret injection. It must never be:

- printed or placed in a URL or command-line argument;
- committed, copied into a Docker build context, image layer, source map, browser bundle, test fixture, or evidence artifact;
- returned by an API or included in logs, traces, error messages, screenshots, or telemetry; or
- exposed to the frontend.

The target Azure topology uses Key Vault-backed runtime injection and a runtime managed identity. A separate deployment identity may push the already-verified image and deploy only the exact app after bootstrap; it must not read Key Vault secrets or assign roles. OIDC is preferred over long-lived CI credentials. These are target controls, not currently evidenced controls.

## Airways and route integrity

Airways is fetched and validated for contract conformance, but its unproven values and types are a prohibited output field. Never expose or log them, use them in signatures/diffs/completeness/rank, or infer directed topology from names or adjacency. Exact Fix/Airport/NAVAID resolution preserves ambiguity and explicit gaps. Never connect a gap or select a nearby point silently.

## Map privacy

OpenStreetMap Standard raster tiles are the configurable default for the one-user POC. Show attribution and use the accepted origin-only cross-origin Referer behavior. Do not put callsigns, flight identifiers, coordinates, route state, or tokens in URLs. Permit only interactive viewport requests: no bulk download, prefetch, offline cache, proxy, or headless scan. Direct tile calls disclose the user's client IP and requested `z/x/y` viewport to the tile provider; this is an explicit POC tradeoff. Route data remains available if tiles fail.

A later production design must revisit tile-provider terms, privacy, quotas, and whether a privacy-preserving hosted/proxied model is required.

## Evidence and authorization

The PG-00 discovery manifest is secret-free aggregate evidence. It proves neither data redistribution rights nor implementation. No Challenge Data Use Record is present, so live CAAS-derived data may not be shown to a reviewer audience based solely on HTTP `200` or key possession. Public production requires the separate production gate covering redistribution/privacy authority, access, egress, edge protection, telemetry, retention, incident response, accessibility, and release ownership.

## Security status

No application security test, dependency scan, image scan, CI secret scan, deployed auth negative test, or Azure security control is evidenced. Future `PG-03`/`PG-04` evidence must bind results to the exact commit/OCI subject, environment, policy/validator hashes, measurements, artifact hashes, and failure fallback. A passing command exit alone is insufficient.
