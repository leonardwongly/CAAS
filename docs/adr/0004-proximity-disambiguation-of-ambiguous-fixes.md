# ADR-0004: Route-context proximity disambiguation of duplicate fix references

- **Status:** Accepted (owner direction 2026-08-25)
- **Decision authority:** User
- **Scope:** Challenge POC only; resolves the fail-closed "ambiguous" gap class in route projections, not the draft selection protocol
- **Review trigger:** Any change to `resolveAmbiguousByProximity`, its cap/margin constants, the two-pass resolution in `routeProjection`, or the ambiguity semantics of the points-lookup/draft endpoints

## Context

Route projections resolve each flight-plan reference against the fixes/airports/navaids index. A reference whose identifier matches several distinct coordinates is reported as a fail-closed `ambiguous` gap: the engine refuses to pick one (the "never resolved-last-wins" invariant). Live inspection showed this class is common (SIA469, SIA242, SIA27, SIA503, SIA530 and others), and the challenge asks for the recorded route to be drawn from Airways and Waypoints resolved by coordinates.

The ambiguity is usually spurious in the recorded-route context: the flight plan names a fix that exists in the reference dataset twice, but the route itself already knows where the fix must sit — between the two resolved neighbours on the great-circle arc of that leg.

## Decision

1. A new route-engine primitive `distanceToGreatCircleArcNm` computes the perpendicular great-circle distance from a point to the arc between two positions, clamped to the nearer endpoint (antimeridian-safe, degenerate-arc safe, full-precision Haversine convention).
2. `routeProjection` resolves in two passes: ambiguous references are collected with their candidate locations, then each is auto-resolved only when the route supplies **two resolved neighbours** and exactly one candidate is within 200 NM of the arc between them (`AMBIGUOUS_PROXIMITY_CAP_NM`) and at least 1 NM closer than every runner-up (`AMBIGUOUS_PROXIMITY_MARGIN_NM`).
3. Ties, weak separations, far-field candidates, and missing neighbour context all keep the honest `ambiguous` gap. The chosen point is always a real recorded location — never an invented or interpolated coordinate.
4. The draft waypoint comparison flow is **unchanged**: user-entered waypoints still require an explicit generation-bound selection when ambiguous, because user intent cannot be inferred from route context.
5. The rule applies to route projections only (overview, options, detail, comparison baselines). Endpoint airport resolution and the points-lookup endpoint keep their existing ambiguity semantics.

## Consequences

Recorded routes with duplicate-fix references now draw the leg and include the waypoint where the route context makes the correct candidate unambiguous; previously they showed a gap. Genuine ambiguities remain visible rather than guessed. The web DTO shape is unchanged, so no frontend, contract-schema, or evidence-format change is required. The cap and margin are conservative by design: they err toward keeping a gap when confidence is low.

This ADR does not authorize airway-topology inference (ADR-0003's counts-only boundary for the separate Airways dataset is untouched) and does not change the draft selection protocol.
