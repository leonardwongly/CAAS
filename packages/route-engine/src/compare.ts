export type DistanceComparisonStatus = "complete" | "incomplete";
export type DistanceComparisonUnavailable = "INCOMPLETE_OPERAND" | "ZERO_BASELINE";

export interface DistanceComparison {
  status: DistanceComparisonStatus;
  /** Exactly one of distanceDeltaNm / percentageDistanceDelta is present per status. */
  distanceDeltaNm?: number;
  percentageDistanceDelta?: number;
  unavailable: DistanceComparisonUnavailable[];
}

/**
 * Directed difference of two modeled route distances at full precision.
 * `target` is always the second operand: distanceDeltaNm = target - baseline.
 * Either operand missing (incomplete geometry) makes both metrics unavailable
 * with code INCOMPLETE_OPERAND; a zero-distance baseline makes the percentage
 * unavailable with code ZERO_BASELINE. Display rounding is a caller concern and
 * is never applied here.
 */
export function compareDistanceOperands(
  baselineDistanceNm: number | undefined,
  targetDistanceNm: number | undefined,
): DistanceComparison {
  const baselineAvailable = baselineDistanceNm !== undefined && Number.isFinite(baselineDistanceNm) && baselineDistanceNm >= 0;
  const targetAvailable = targetDistanceNm !== undefined && Number.isFinite(targetDistanceNm) && targetDistanceNm >= 0;
  if (!baselineAvailable || !targetAvailable) {
    return { status: "incomplete", unavailable: ["INCOMPLETE_OPERAND"] };
  }
  const distanceDeltaNm = targetDistanceNm! - baselineDistanceNm!;
  const percentageDistanceDelta = baselineDistanceNm === 0
    ? undefined
    : (100 * distanceDeltaNm) / baselineDistanceNm;
  return {
    status: "complete",
    distanceDeltaNm,
    ...(percentageDistanceDelta === undefined ? {} : { percentageDistanceDelta }),
    unavailable: baselineDistanceNm === 0 ? ["ZERO_BASELINE"] : [],
  };
}
