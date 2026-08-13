/**
 * UI copy for the route-ranking presentation, kept in one module so the
 * forbidden-words regression tests can pin the exact strings. The rank-1
 * group heading comes from the route service (rankLabel) when present;
 * RANK_ONE_LABEL below is the identical fallback for offline rendering.
 */

/** Rank-1 group heading; matches the service-issued rankLabel exactly. */
export const RANK_ONE_LABEL = "Rank 1 by shortest modeled distance among complete candidates.";

export const RANK_CRITERION = "Routes are ranked by shortest modeled distance among complete candidates with the same departure and arrival. Ties share a rank; the ranking does not assess operational safety.";

export const RANK_ONE_GROUP_DESCRIPTION = "Every complete candidate tied for the shortest modeled distance is presented together for the user to choose among. This is a mathematical comparison of modeled coordinates, not operational advice.";

export const COMPLETE_RANKED_GROUP_TITLE = "Complete routes — ranked by modeled distance";
export const COMPLETE_RANKED_GROUP_DESCRIPTION = "Complete candidates that are not tied for first place.";

export const INCOMPLETE_GROUP_TITLE = "Incomplete routes — not ranked";
export const INCOMPLETE_GROUP_DESCRIPTION = "Some waypoints could not be located, so these routes cannot be compared fairly.";

export const OPERATIONAL_PROXY_EXPLANATION = "This comparison uses modeled route distance as a stand-in for operational preference. It does not account for weather, fuel, clearances, or airline decisions.";

export const SAFETY_NOTICE = "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.";

export const REFRESH_CONFIRM = "Refresh the live data generation? The current flight selection and route will be cleared, and the service will re-acquire the latest flight and reference data.";

export const REFRESH_STALE_BANNER = "Live flight data is stale — refresh recommended.";
export const REFRESH_UNUSABLE_BANNER = "Live flight data is no longer usable — refresh required.";
