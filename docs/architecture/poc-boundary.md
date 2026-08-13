# Binding POC architecture and legacy reconciliation

## Authority

Section 0 of the system design is the binding challenge/POC contract. It supersedes conflicting challenge-path language in later sections. The implementation plan is the operational companion. The documents are design commitments and evidence instructions; they are not proof that code or infrastructure exists.

The POC is one private, single-user, real-data Azure demonstration with local-first delivery. It has no synthetic runtime/demo fallback, separate staging environment, reviewer audience, or staging-to-production promotion. Automated tests may use minimized, irreversibly sanitized captures of real responses and pure mathematical vectors only.

## Runtime topology

```text
CAAS five-family HTTPS APIs
          ^
          | bounded allow-listed GETs; server-side key only
React/Vite browser <--> same-origin Fastify BFF
                              |
                              +--> validate/sanitize
                              +--> immutable complete generation
                              +--> route resolution/ranking/diff
                              +--> stable DTOs and errors
                              +--> dependency-free SVG route diagram (no external tiles)
```

The Fastify server is the only CAAS client. It acquires Flight Plan, Airways, Fixes, Airports, and NAVAIDs data, validates every response, discards unknown/unneeded fields, and builds a complete generation. The implemented UI uses a dependency-free SVG route diagram rather than external map tiles; this is a deliberate local-first POC variance from the design's configurable Leaflet/OpenStreetMap option. A generation is admitted only when every mandatory family is usable. A refresh builds a separate candidate and atomically swaps it after complete validation; a failed refresh retains a still-usable prior generation only within the defined freshness and memory limits. Restart loses the generation and requires a fresh real acquisition.

The target package boundary is:

- `apps/api`: BFF, request validation, generation lifecycle, upstream adapter composition.
- `apps/web`: presentation, map/table parity, keyboard and focus behavior.
- `packages/contracts`: stable DTOs, runtime schemas, error codes, token shapes.
- `packages/route-engine`: exact resolution, geometry, Haversine distance, ranking, local-draft validation, and server-computed delta rules.
- `packages/upstream-caas`: HTTPS origin/path/method allow-list, bounded parsing, sanitization, response evidence aggregates.

The final POC may package these responsibilities in one non-root Linux image. Packaging does not merge the source or trust boundaries. There is no application database, Blob snapshot store, scheduled publisher/validator Job, queue, Service Bus, controller, attestor, mutable pointer, or application data rollback.

## Data and route behavior

Flight Plan records support callsign search, duplicate disambiguation, selection, and recorded-route display. Fixes and NAVAIDs resolve intermediate identifiers; Airports resolve endpoints. Resolution is exact and ambiguity-preserving. A missing or multiply matched point is an explicit gap/diagnostic, not a nearest-neighbor choice. A continuous line must never cross a gap.

Distance uses full-precision Haversine legs and totals with Earth radius `3440.065 NM`. Only ranking equality uses `rankDistanceNm = round(total, 0.000001 NM)`. Complete same-endpoint recorded routes alone compete. Equal rank distances share rank; point count and canonical signature are deterministic display tie-breakers only. A locally edited draft is separately server-validated and may expose a delta only when both computations are complete. Incomplete candidates stay visible but unranked.

The only qualified first-place label is **“Rank 1 by shortest modeled distance among complete candidates.”** This is a mathematical comparison of modeled coordinates. It is not operational validity, safety, clearance, legality, dispatch fitness, or a recommendation.

## Airways variance

Airways is a mandatory runtime input and must be fetched, parsed, schema/count validated, and represented in sanitized internal acquisition evidence. Discovery found 9,319 airway-list records; route elements reported 889 airway values, of which 236 were absent from the separate list. The relationship between a route occurrence and a directed leg was not proved.

Therefore `airway` and `airwayType` are hidden from every product-facing DTO and from logs, signatures, diffs, route tables, map labels, geometry, completeness, and ranking. Route graphics use only exact resolved waypoint/reference coordinates. This is an explicit safety-driven POC variance from a literal requirement to draw recorded airway topology. Never infer topology from adjacency, list membership, name similarity, or route text. Do not claim airway-topology conformance unless a later authoritative contract proves the relation.

## Safety boundary

Persistent UI copy must say:

> Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.

The system must not write to CAAS or file, dispatch, activate, approve, clear, or navigate a route. It must not claim safest, fastest, least-fuel, legally valid, ATC-acceptable, or operationally optimal. It must not expose raw upstream objects, credentials, unnecessary personal fields, or inferred airway information.

## Legacy reconciliation matrix

The older design sections intentionally remain historical production-hardening analysis. They must not be interpreted as POC implementation instructions.

| Legacy text/mechanism | Binding POC interpretation |
|---|---|
| Staging and staging-to-production promotion | No staging environment; direct deployment of the unchanged verified digest to one private POC. |
| Snapshot publisher, shadow validator, Blob store, mutable pointer | Replaced by one bounded server adapter and active/previous in-memory generations. |
| Container Apps Job, Service Bus, controller, orchestrator, attestor | Not part of the POC. Revisit only under a separate production decision. |
| Synthetic runtime/demo fallback | Prohibited. Sanitized captures are for deterministic tests only. |
| Reviewer audience or anonymous access | Replaced by one allowed Entra user; no live redistribution is authorized without a Data Use Record. |
| Snapshot/data rollback | Not available. First deployment aborts and cleans up; later code/config rollback reacquires current CAAS data. |
| Network-enforced egress | Omitted as an accepted POC residual; strict application-level origin/path/method/redirect/proxy controls remain mandatory and production access is blocked without enforced egress. |
| Multi-environment production topology | Separate future production gate, not a challenge path. |

ADR-001 records these dispositions in more detail. Do not edit the existing design merely to remove its historical sections; use Section 0 and this reconciliation as the interpretation boundary.

## Evidence status

The retained discovery manifest proves only bounded read-only observations. The local implementation and validation results are reported separately in the repository work log and command output; this document does not prove CI, Azure deployment, or production operational controls. Every implementation claim needs a subject-bound evidence record at the appropriate gate.
