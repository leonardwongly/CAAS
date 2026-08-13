/**
 * Plan §6.2 runtime freshness windows for acquired data generations.
 *
 * Exact windows (do not change):
 * - Live flight generation: fresh <= 5 minutes; stale warning after 5 minutes;
 *   unusable after 30 minutes.
 * - Reference generation: fresh <= 24 hours; stale warning after 24 hours;
 *   unusable after 7 days.
 *
 * Boundary semantics are inclusive: a generation is "fresh" while the elapsed
 * time is at most the fresh window, "stale" while the elapsed time is at most
 * the unusable window, and "unusable" strictly after it. A stale generation is
 * still servable and must be visibly labeled stale; an unusable generation must
 * fail closed.
 */

export type GenerationState = "fresh" | "stale" | "unusable";

export const LIVE_FRESH_MS = 5 * 60 * 1000;
export const LIVE_UNUSABLE_MS = 30 * 60 * 1000;
export const REFERENCE_FRESH_MS = 24 * 60 * 60 * 1000;
export const REFERENCE_UNUSABLE_MS = 7 * 24 * 60 * 60 * 1000;

const STATE_SEVERITY: Record<GenerationState, number> = { fresh: 0, stale: 1, unusable: 2 };

export function freshnessState(elapsedMs: number, freshMs: number, unusableMs: number): GenerationState {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError("elapsedMs must be a finite, non-negative number");
  if (!Number.isFinite(freshMs) || freshMs < 0 || !Number.isFinite(unusableMs) || unusableMs <= freshMs) {
    throw new RangeError("freshness windows must satisfy 0 <= freshMs < unusableMs");
  }
  if (elapsedMs <= freshMs) return "fresh";
  if (elapsedMs <= unusableMs) return "stale";
  return "unusable";
}

export function liveFreshnessState(elapsedMs: number): GenerationState {
  return freshnessState(elapsedMs, LIVE_FRESH_MS, LIVE_UNUSABLE_MS);
}

export function referenceFreshnessState(elapsedMs: number): GenerationState {
  return freshnessState(elapsedMs, REFERENCE_FRESH_MS, REFERENCE_UNUSABLE_MS);
}

/** The more severe of two tier states; used for the overall generation state. */
export function worseGenerationState(left: GenerationState, right: GenerationState): GenerationState {
  return STATE_SEVERITY[left] >= STATE_SEVERITY[right] ? left : right;
}

export function isGenerationUsable(state: GenerationState): boolean {
  return state !== "unusable";
}
