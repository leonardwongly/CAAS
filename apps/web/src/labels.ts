export const ROUTE_COMPARISON_EXPLANATION = "Recorded routes are shown in stable source order for neutral comparison. Modeled distance is descriptive only and does not identify a preferred route.";

export const COMPLETE_GROUP_TITLE = "Complete recorded routes";
export const COMPLETE_GROUP_DESCRIPTION = "All recorded route components resolved exactly. No route is labeled as preferred or first.";

export const INCOMPLETE_GROUP_TITLE = "Recorded routes with visible gaps";
export const INCOMPLETE_GROUP_DESCRIPTION = "Some references could not be resolved exactly. Resolved components remain visible and gaps are never bridged.";

export const SAFETY_NOTICE = "Demonstration only—not real-time operational tracking or route advice. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.";

/** Byte-identical mirror of `packages/contracts` DRAFT_SAFETY_COPY. */
export const DRAFT_SAFETY_COPY = "Computationally complete; operational constraints not assessed.";

export const REFRESH_CONFIRM = "Refresh the source-data snapshot? The current flight selection will be cleared. The app will retrieve a new CAAS dataset; it does not track live operations.";

export const GAP_DISTANCE_ANNOTATION_CAVEAT = "Visual estimate only. Exact-anchor spans are geometric minimums; any calibrated interval is a non-operational statistical descriptor, not source flight data, a route suggestion, or real-time tracking.";