# ADR-0003: Surface recorded airway labels and compute a direct alternate route

- **Status:** Accepted (owner direction 2026-08-23)
- **Decision authority:** User
- **Scope:** Challenge POC only; additive documentation capability, not production authorization
- **Review trigger:** Any change to airway-label surfacing, direct-alternate geometry, the `/api/v1/routes/alternate` contract, or the reversal of the hidden-airways boundary

## Context

The CAAS Tech Challenge (`CAAS Tech Challenge_v2.21.pdf`) requires drawing the selected flight's recorded route "using the Airways and Waypoints recorded in the flight plan" and, as the optional task, computing an alternate route from the departure airport to the destination.

ADR-0001 deliberately hid airway values: live discovery (`docs/evidence/pg-00-live-api-discovery.json`) observed that the separate Airways endpoint returns names only (9,319 strings, no coordinates) and that route-element airway association was inconsistent. The implemented "Borrowed Routes" feature (ADR-0002) then proposed alternates by borrowing exact subpaths from other recorded flights rather than by computing an alternate.

The owner direction of 2026-08-23 reverses that posture: the recorded route must again show the airway labels that the flight plan actually records on each leg, and the optional alternate must be a genuine computed path rather than a borrowed subpath.

## Decision

1. The recorded `airway` and `airwayType` fields on flight-plan route elements are retained in the normalizer (`packages/upstream-caas`) and surfaced on resolved route legs (`apps/api/src/projection.ts`) through the existing overview/options/detail DTOs. The web route-leg table gains an `Airway` column.
2. The separate Airways reference list remains counts-only. It still does not supply geometry, connectivity, or topology. The recorded airway label is a leg annotation; it never changes point resolution, completeness, distance, signature, or comparison.
3. A new `POST /api/v1/routes/alternate` endpoint returns the direct great-circle path between the resolved departure and destination airports, densified for correct geodesic rendering. This is a genuine coordinate-derived alternate, computed with the existing full-precision Haversine convention, and clearly labelled `direct-great-circle`.
4. The donor-subpath synthesis capability (ADR-0002) and the client-side statistical gap-distance annotation are removed. The direct alternate is the sole "alternate route" presentation.
5. Safety posture is unchanged: the direct alternate is not a recommendation, not a cleared route, and carries the persistent demonstration-only safety copy.

## Consequences

Recorded route legs now display their recorded airway labels alongside waypoint coordinates, matching the challenge's "Airways + Waypoints" wording. The airway-name reference list remains hidden as counts only, preserving the earlier data-use boundary for that dataset. A direct great-circle alternate is always computable from resolved airport coordinates, so the "alternate route" task no longer depends on the presence of a matching donor flight. The donor-subpath synthesis and statistical gap-distance code, endpoints, tests, and metrics were removed.

This ADR supersedes the "airway values are never surfaced" exclusion only for the recorded route-element airway label; it does not authorize airway-topology inference, ranking, persistence, or redistribution.
