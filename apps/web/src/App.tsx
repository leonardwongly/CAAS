import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import {
  ApiError,
  fetchReadiness,
  fetchRouteOverview,
  fetchRouteOptions,
  fetchSynthesis,
  lookupPoint,
  refreshLiveData,
  searchCallsigns,
  validateDraft,
  type CallsignMatch,
  type Coordinate,
  type DraftComparison,
  type DraftSelection,
  type GenerationSummary,
  type PointMatch,
  type RouteLeg,
  type RouteOption,
  type SynthesisCandidate,
  type SynthesisResult,
  type SynthesisSegment,
} from "./api";
import {
  COMPLETE_GROUP_DESCRIPTION,
  COMPLETE_GROUP_TITLE,
  DRAFT_SAFETY_COPY,
  GAP_DISTANCE_ANNOTATION_CAVEAT,
  REFRESH_CONFIRM,
  ROUTE_COMPARISON_EXPLANATION,
  SAFETY_NOTICE,
} from "./labels";
import { clampZoom, DEFAULT_SIZE, fitViewToCoordinates, MAX_ZOOM, MIN_ZOOM, OSM_ATTRIBUTION, pixelFromView, projectWorldSegmentsMercator, TileLayer, viewFromPixelDelta, viewFromZoomAtPoint, type MapSize, type TileView } from "./TileMap";
import ApiDataPage from "./ApiDataPage";
import { compareDistanceOperands } from "@flight-route-explorer/route-engine/compare";
import { analyzeIncompleteRouteDistance, type IncompleteRouteDistanceAnalysis } from "./gapDistanceEstimate";
import { BUNDLED_GAP_DISTANCE_MODEL } from "./gapDistanceModel";

type Surface = "none" | "routes" | "route-data" | "editor" | "compare" | "synthesis";
type SearchState = { query: string; matches: CallsignMatch[]; loading: boolean; searched: boolean; error?: string | undefined };
const emptySearch: SearchState = { query: "", matches: [], loading: false, searched: false };
// Type-ahead settles this long after the last keystroke; Enter fires a search
// immediately (the timer is cancelled), so Enter flows stay deterministic.
const SEARCH_DEBOUNCE_MS = 250;
// Wheel zoom accepts one level per burst: a scroll gesture fires many wheel
// events, and accepting every one slams the map through the zoom range.
const WHEEL_ZOOM_DEBOUNCE_MS = 350;

function formatDistance(value: number | undefined): string {
  return value === undefined ? "Not supplied" : `${value.toFixed(1)} NM`;
}

function isCompleteRoute(route: RouteOption): boolean {
  return route.complete && route.gaps.length === 0;
}

/** A malformed timestamp must never render the literal "Invalid Date". */
function formatRetrievedAt(value: string | undefined): string {
  if (value === undefined) return "unknown time";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "unknown time" : parsed.toLocaleTimeString();
}

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  TOO_MANY_CANDIDATES: "Too many route options for this airport pair. Try a more specific flight.",
  TOO_MANY_MATCHES: "This reference matches too many locations. Use a narrower search term.",
  UPSTREAM_UNAVAILABLE: "Live route data is unavailable right now. Try refreshing in a moment.",
  GENERATION_STALE: "This source-data snapshot has expired. Refresh source data to acquire a new snapshot.",
  REQUEST_DEADLINE_EXCEEDED: "The route service timed out. Try again.",
};

function apiMessage(error: unknown): string {
  if (error instanceof ApiError) {
    // Some 503 envelopes (readiness/startup) carry a machine-readable code
    // without a human message; never surface a bare "Request failed (503)".
    const fallback = `Request failed (${error.status})`;
    if (error.code && CODE_MESSAGES[error.code]) return CODE_MESSAGES[error.code]!;
    if (error.message && error.message !== fallback) return error.message;
    return fallback;
  }
  return error instanceof Error ? error.message : "The route service could not be reached.";
}

function refreshFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "REFRESH_FAILED" && error.body) {
    const retained = error.body.retained;
    const generation = retained && typeof retained === "object" && "generation" in retained
      ? (retained as { generation?: { live?: { state?: string; retrievedAt?: string } } }).generation
      : undefined;
    const live = generation?.live;
    if (live?.retrievedAt) {
      if (live.state === "unusable") {
        return `Live data refresh failed and the prior generation is no longer usable (retrieved ${formatRetrievedAt(live.retrievedAt)}). No live data is serving requests — retry refresh.`;
      }
      return `Live data refresh failed. The prior generation retrieved at ${formatRetrievedAt(live.retrievedAt)} is still serving requests.`;
    }
  }
  return apiMessage(error);
}

function synthesisStatusCopy(result: SynthesisResult): string {
  switch (result.status) {
    case "not-needed":
      return "Source route is complete; no synthesis is needed.";
    case "full":
    case "ambiguous": {
      const count = result.candidates.length;
      return `${count} candidate${count === 1 ? "" : "s"} assembled from geometry observed on other recorded routes in this generation. Dotted segments are borrowed; nothing was interpolated.`;
    }
    case "partial":
      return "Only some gap corridors could be covered by observed donor geometry.";
    case "unavailable":
      return "No other recorded route in this generation contains the missing directed subpath.";
    case "over-limit":
    case "candidate-limit-exceeded":
      return "Too many donor combinations to list; narrowing is required. No candidate was truncated or silently chosen.";
  }
}

/** A candidate carries no donor roster; the largest per-segment donor count is the only client-defensible figure. */
function candidateDonorCount(candidate: SynthesisCandidate): number {
  return candidate.segments.reduce((maximum, segment) => Math.max(maximum, segment.donorCount), 0);
}

function borrowedSegmentProvenanceCopy(segment: SynthesisSegment): string {
  return `Observed subpath copied without modification from ${segment.donorCount} donor route(s); match by ${segment.matchMethod === "reference" ? "exact reference identity" : "exact coordinate"}${segment.donorTruncated ? "; additional donors not listed" : ""}.`;
}

/** Best-effort statistical annotation copy; kept strictly separate from synthesis candidate totals. */
function statisticalAnnotationNote(analysis: IncompleteRouteDistanceAnalysis | undefined): string | undefined {
  if (!analysis) return undefined;
  if (analysis.status === "unavailable") return analysis.message ?? "The statistical annotation is unavailable for this source route.";
  const aggregate = analysis.aggregateEstimate;
  const aggregateCopy = aggregate
    ? `Calibrated central value ${formatDistance(aggregate.centralNm)} with ${Math.round(aggregate.interval.confidenceLevel * 100)}% interval ${formatDistance(aggregate.interval.lowerNm)}–${formatDistance(aggregate.interval.upperNm)} (a sum of corridor medians, model ${aggregate.modelVersion}).`
    : `A calibrated statistical estimate is unavailable: ${analysis.message ?? "historical release gates were not met."}`;
  const corridorCopy = analysis.corridors.map((corridor) => `Gap position${corridor.gapSequences.length === 1 ? "" : "s"} ${corridor.gapSequences.map((sequence) => sequence + 1).join(", ")}: minimum ${formatDistance(corridor.minimumNm)}.`).join(" ");
  return `${aggregateCopy} Recorded geometry subtotal ${formatDistance(analysis.recordedGeometrySubtotalNm)}; gap anchor minimum ${formatDistance(analysis.gapMinimumSubtotalNm)}; continuous-route minimum ${formatDistance(analysis.continuousRouteMinimumNm)} (not an expected or source route total). ${corridorCopy}`;
}

function App() {
  const [overview, setOverview] = useState<RouteOption[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string>();
  const [overviewReload, setOverviewReload] = useState(0);
  const [selectedFlight, setSelectedFlight] = useState<CallsignMatch>();
  const [search, setSearch] = useState<SearchState>(emptySearch);
  const [options, setOptions] = useState<RouteOption[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<RouteOption>();
  const [synthesisRoute, setSynthesisRoute] = useState<RouteOption>();
  const [synthesis, setSynthesis] = useState<SynthesisResult>();
  const [synthesisLoading, setSynthesisLoading] = useState(false);
  const [synthesisError, setSynthesisError] = useState<string>();
  const [selectedCandidate, setSelectedCandidate] = useState<SynthesisCandidate>();
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string>();
  const [routeReload, setRouteReload] = useState(0);
  const [draft, setDraft] = useState<DraftComparison>();
  const [draftActive, setDraftActive] = useState(false);
  const [primarySurface, setPrimarySurface] = useState<Surface>("none");
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string>();
  const [mapOnly, setMapOnly] = useState(false);
  const [page, setPage] = useState<"map" | "api-data">("map");
  const [status, setStatus] = useState("");
  const [generation, setGeneration] = useState<GenerationSummary>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [readinessError, setReadinessError] = useState<string>();
  const routeRequest = useRef(0);
  const synthesisRequest = useRef(0);
  const synthesisController = useRef<AbortController | undefined>(undefined);
  const draftRequest = useRef<AbortController | undefined>(undefined);
  const searchRequest = useRef<AbortController | undefined>(undefined);
  const searchSeq = useRef(0);
  const searchTimer = useRef<number | undefined>(undefined);
  // Refresh completion and overview readiness are one user-visible operation.
  // Preserve the refresh announcement until traversal settles instead of
  // letting the overview effect replace it with a generic load message.
  const overviewStatusPrefix = useRef<string | undefined>(undefined);
  const routesTriggerRef = useRef<HTMLButtonElement>(null);
  const dataTriggerRef = useRef<HTMLButtonElement>(null);
  const editorTriggerRef = useRef<HTMLButtonElement>(null);
  const compareTriggerRef = useRef<HTMLButtonElement>(null);
  const mapOnlyTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreControlsRef = useRef<HTMLButtonElement>(null);
  const apiDataTriggerRef = useRef<HTMLButtonElement>(null);

  // Design §15.2: focus return is deterministic after closing a surface,
  // selecting a route, retrying an error, or leaving Map Only.
  function closeSurface(surface: Surface) {
    setPrimarySurface("none");
    const trigger = surface === "routes" ? routesTriggerRef : surface === "route-data" ? dataTriggerRef : surface === "editor" ? editorTriggerRef : surface === "compare" ? compareTriggerRef : undefined;
    if (trigger) requestAnimationFrame(() => trigger.current?.focus());
  }

  function resetDraftState() {
    draftRequest.current?.abort();
    // Invalidate the identity check too: a validation that already resolved
    // but has not yet applied must never land after a reset (it would render
    // the previous baseline's draft under a newly selected route).
    draftRequest.current = undefined;
    setDraftActive(false);
    setDraft(undefined);
    setDraftError(undefined);
  }

  function enterMapOnly() {
    setPrimarySurface("none");
    resetDraftState();
    setMapOnly(true);
    requestAnimationFrame(() => restoreControlsRef.current?.focus());
  }

  function leaveMapOnly() {
    setMapOnly(false);
    requestAnimationFrame(() => mapOnlyTriggerRef.current?.focus());
  }

  useEffect(() => {
    const controller = new AbortController();
    fetchReadiness(controller.signal)
      .then((readiness) => { if (!controller.signal.aborted && readiness.generation) setGeneration(readiness.generation); })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // A failed readiness (e.g. upstream unavailable at boot) must still
        // surface the refresh-recovery path instead of a dead app.
        setReadinessError(apiMessage(error));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setOverviewLoading(true);
    setOverviewError(undefined);
    fetchRouteOverview(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setOverview(result.routes);
        setGeneration(result.generation);
        const loadMessage = `${result.routes.length} source flight record${result.routes.length === 1 ? "" : "s"} loaded. This is a refreshed dataset, not real-time tracking.`;
        const prefix = overviewStatusPrefix.current;
        overviewStatusPrefix.current = undefined;
        setStatus(prefix ? `${prefix} ${loadMessage}` : loadMessage);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setOverviewError(apiMessage(error));
        const prefix = overviewStatusPrefix.current;
        overviewStatusPrefix.current = undefined;
        setStatus(prefix ? `${prefix} The refreshed overview could not be loaded.` : "The all-flight route overview could not be loaded.");
      })
      .finally(() => { if (!controller.signal.aborted) setOverviewLoading(false); });
    return () => controller.abort();
  }, [overviewReload]);

  function updateQuery(query: string) {
    // Abort any in-flight search and cancel the pending type-ahead timer:
    // matches from an older query must never land under the newly typed text.
    searchRequest.current?.abort();
    if (searchTimer.current !== undefined) { window.clearTimeout(searchTimer.current); searchTimer.current = undefined; }
    const trimmed = query.trim();
    if (!trimmed) { setSearch({ query, matches: [], loading: false, searched: false }); return; }
    // Keep the current matches visible while typing; the settled type-ahead
    // result replaces them once the debounce window elapses.
    setSearch((current) => ({ ...current, query, loading: false, error: undefined }));
    searchTimer.current = window.setTimeout(() => { searchTimer.current = undefined; void runSearch(trimmed); }, SEARCH_DEBOUNCE_MS);
  }

  /** Cancels the pending type-ahead without resetting the query text. */
  function cancelSearch() {
    if (searchTimer.current !== undefined) { window.clearTimeout(searchTimer.current); searchTimer.current = undefined; }
    searchRequest.current?.abort();
    searchSeq.current += 1;
    setSearch((current) => ({ ...current, loading: false }));
  }

  async function runSearch(override?: string) {
    const query = (override ?? search.query).trim();
    if (!query) return;
    if (searchTimer.current !== undefined) { window.clearTimeout(searchTimer.current); searchTimer.current = undefined; }
    searchRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    const requestId = ++searchSeq.current;
    setSearch((current) => ({ ...current, query, loading: true, searched: false, error: undefined }));
    try {
      const matches = await searchCallsigns(query, controller.signal);
      // A superseded search (newer keystrokes or a cancel) must never land:
      // the abort above usually stops it, and the sequence guard makes the
      // staleness deterministic even when the transport ignores the abort.
      if (requestId !== searchSeq.current) return;
      setSearch((current) => ({ ...current, loading: false, matches, searched: true }));
      setStatus(matches.length ? `${matches.length} flight plan match${matches.length === 1 ? "" : "es"} found. Choose one to continue.` : `No flight plans matched ${query}.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestId !== searchSeq.current) return;
      setSearch((current) => ({ ...current, loading: false, searched: false, error: apiMessage(error) }));
      setStatus("Flight-plan search failed.");
    }
  }

  function chooseFlight(match: CallsignMatch, preserveSearchFilter = false) {
    searchRequest.current?.abort();
    if (searchTimer.current !== undefined) { window.clearTimeout(searchTimer.current); searchTimer.current = undefined; }
    setSelectedFlight(match);
    clearSynthesis();
    setSelectedRoute(overview.find((route) => route.flightId === match.flightId && isCompleteRoute(route)));
    setSearch(preserveSearchFilter ? { query: match.callsign, matches: [], loading: false, searched: false } : emptySearch);
    setStatus(`Selected flight ${match.callsign}, departing ${match.departure} for ${match.destination}. Loading complete same-endpoint recorded routes.`);
  }

  function chooseOverviewRoute(route: RouteOption) {
    if (!isCompleteRoute(route)) return;
    clearSynthesis();
    chooseFlight({
      id: route.flightId,
      flightId: route.flightId,
      callsign: route.callsign,
      departure: route.origin ?? "Unknown departure",
      destination: route.destination ?? "Unknown destination",
      routePointCount: route.pointCount,
    });
    setSelectedRoute(route);
  }

  /** Invalidate and clear any in-flight or settled synthesis for the previous target. */
  function clearSynthesis() {
    synthesisRequest.current += 1;
    synthesisController.current?.abort();
    setSynthesisRoute(undefined);
    setSynthesis(undefined);
    setSynthesisError(undefined);
    setSelectedCandidate(undefined);
    setSynthesisLoading(false);
  }

  function openSynthesisChooser() {
    resetDraftState();
    setSelectedRoute(undefined);
    clearSynthesis();
    setPrimarySurface("synthesis");
  }

  function chooseSynthesisTarget(route?: RouteOption) {
    if (!route) {
      clearSynthesis();
      return;
    }
    if (isCompleteRoute(route)) return;
    resetDraftState();
    setSelectedRoute(undefined);
    setSynthesisRoute(route);
    void loadSynthesis(route);
  }

  async function loadSynthesis(route: RouteOption) {
    const requestId = ++synthesisRequest.current;
    synthesisController.current?.abort();
    const controller = new AbortController();
    synthesisController.current = controller;
    setSynthesisLoading(true);
    setSynthesisError(undefined);
    setSynthesis(undefined);
    setSelectedCandidate(undefined);
    setStatus(`Requesting observed-donor synthesis candidates for ${route.callsign}.`);
    try {
      const allCandidates: SynthesisCandidate[] = [];
      let cursor: string | undefined;
      let result: SynthesisResult | undefined;
      do {
        result = await fetchSynthesis(route.flightId, cursor, controller.signal);
        // A superseded or aborted request must never apply a late page.
        if (controller.signal.aborted || synthesisRequest.current !== requestId) return;
        allCandidates.push(...result.candidates);
        // Terminal guard: an empty page (or a misbehaving repeated cursor)
        // must not loop forever under a perpetual loading spinner.
        cursor = result.candidates.length > 0 ? result.nextCursor : undefined;
      } while (cursor);
      if (!result) return;
      // Last-page envelope: after paging to the terminal cursor the final
      // page carries status/counts, and candidates is the merged full set.
      const merged: SynthesisResult = { ...result, candidates: allCandidates };
      setSynthesis(merged);
      setSelectedCandidate(allCandidates[0]);
      setStatus(synthesisStatusCopy(merged));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (synthesisRequest.current === requestId) setSynthesisError(apiMessage(error));
    } finally {
      if (synthesisRequest.current === requestId) setSynthesisLoading(false);
    }
  }

  useEffect(() => {
    draftRequest.current?.abort();
    // Identity invalidation: a validation that already resolved must never
    // land under the newly selected flight/route baseline.
    draftRequest.current = undefined;
    setDraft(undefined);
    setDraftActive(false);
    setDraftError(undefined);
    if (!selectedFlight) {
      setOptions([]);
      setSelectedRoute(undefined);
      setRouteError(undefined);
      return;
    }
    // Clear the previous flight's options immediately: stale candidates must
    // never stay rendered or selectable under the newly selected flight.
    setOptions([]);
    setRouteError(undefined);
    const controller = new AbortController();
    const requestId = ++routeRequest.current;
    setRouteLoading(true);
    setRouteError(undefined);
    fetchRouteOptions(selectedFlight.flightId, controller.signal)
      .then((result) => {
        if (requestId !== routeRequest.current) return;
        const completeRoutes = result.options.filter(isCompleteRoute);
        setOptions(completeRoutes);
        if (result.generation) setGeneration(result.generation);
        const synchronized = completeRoutes.find((route) => route.flightId === selectedFlight.flightId)
          ?? overview.find((route) => route.flightId === selectedFlight.flightId && isCompleteRoute(route));
        setSelectedRoute(synchronized);
        setStatus(`${completeRoutes.length} complete same-endpoint recorded route${completeRoutes.length === 1 ? "" : "s"} returned for neutral comparison with ${selectedFlight.callsign}.`);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (requestId !== routeRequest.current) return;
        setRouteError(apiMessage(error));
        setStatus("Route options could not be loaded.");
      })
      .finally(() => {
        if (requestId === routeRequest.current) setRouteLoading(false);
      });
    return () => controller.abort();
  }, [selectedFlight, routeReload]);

  async function updateDraft(via: string[], selections: DraftSelection[] = []) {
    if (!selectedRoute?.origin || !selectedRoute.destination || !selectedRoute.flightId) return;
    draftRequest.current?.abort();
    const controller = new AbortController();
    draftRequest.current = controller;
    setDraftLoading(true);
    setDraftError(undefined);
    setStatus("Validating the local draft against exact reference data.");
    try {
      const result = await validateDraft(endpointReference(selectedRoute.origin), endpointReference(selectedRoute.destination), via, selections, selectedRoute.flightId, controller.signal);
      if (draftRequest.current !== controller) return;
      setDraft(result);
      setStatus(result.comparison.status === "complete" ? "Route variation validated against exact reference data." : "Route variation has unresolved gaps; distance comparison is unavailable.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (draftRequest.current === controller) setDraftError(apiMessage(error));
    } finally {
      if (draftRequest.current === controller) setDraftLoading(false);
    }
  }

  function resetAll() {
    searchRequest.current?.abort();
    if (searchTimer.current !== undefined) { window.clearTimeout(searchTimer.current); searchTimer.current = undefined; }
    draftRequest.current?.abort();
    draftRequest.current = undefined;
    routeRequest.current += 1;
    setSelectedFlight(undefined);
    setSearch(emptySearch);
    setOptions([]);
    setSelectedRoute(undefined);
    clearSynthesis();
    setRouteLoading(false);
    setRouteError(undefined);
    setStatus("Session reset.");
  }

  async function runRefresh() {
    if (refreshing) return;
    const confirmed = window.confirm(REFRESH_CONFIRM);
    if (!confirmed) return;
    setRefreshing(true);
    setRefreshError(undefined);
    setStatus("Refreshing the source-data snapshot. The current selection will be cleared.");
    try {
      const result = await refreshLiveData();
      setGeneration(result.generation);
      setReadinessError(undefined);
      resetAll();
      setOverview([]);
      const refreshMessage = `Source data refreshed at ${formatRetrievedAt(result.generation.retrievedAt)}; selection cleared. This is not real-time tracking.`;
      overviewStatusPrefix.current = refreshMessage;
      setOverviewReload((current) => current + 1);
      setStatus(`${refreshMessage} Overview reloading.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setRefreshError(refreshFailureMessage(error));
      setStatus("Live data refresh failed. The prior generation is still serving requests.");
    } finally {
      setRefreshing(false);
    }
  }

  const filteredOverview = useMemo(() => {
    const query = search.query.trim().toUpperCase();
    return query ? overview.filter((route) => route.callsign.toUpperCase().includes(query)) : overview;
  }, [overview, search.query]);

  const incompleteOverview = useMemo(() => filteredOverview.filter((route) => !isCompleteRoute(route)), [filteredOverview]);
  // Statistical annotation survives as a separate, best-effort descriptor: the
  // old endpoint coordinates were client midpoint artifacts, so it now runs
  // with an empty endpoint object and keeps its existing semantics.
  const statisticalAnnotation = useMemo(
    () => synthesisRoute ? analyzeIncompleteRouteDistance(synthesisRoute, {}, BUNDLED_GAP_DISTANCE_MODEL) : undefined,
    [synthesisRoute],
  );
  const statisticalNote = useMemo(() => statisticalAnnotationNote(statisticalAnnotation), [statisticalAnnotation]);

  return (
    <div className="app-shell map-first-shell">
      <div className="safety-banner compact-safety" role="region" aria-label="Safety notice"><strong><span aria-hidden="true">⚠</span> Safety notice</strong><span>{SAFETY_NOTICE}</span></div>
      {!mapOnly && page === "map" && <header className="map-topbar">
        <a className="skip-link" href="#flight-search">Skip to flight search</a>
        <div className="product-mark"><p className="eyebrow">FLIGHT ROUTE EXPLORER</p><h1>Map-first route comparison</h1></div>
        <div className="toolbar-search"><SearchBox selected={selectedFlight} state={search} onFocus={() => undefined} onQuery={updateQuery} onSearch={() => void runSearch()} onSelect={(match) => chooseFlight(match, true)} onCancelSearch={cancelSearch} /></div>
        <div className={`toolbar-flight ${selectedFlight ? "has-selection" : ""}`} role="group" aria-label="Selected flight">
          {selectedFlight ? <><div className="selected-route-label"><span className="selection-kicker">SELECTED ROUTE</span><strong>{selectedFlight.callsign}</strong></div><div className="selected-route-endpoints">{selectedFlight.departure} → {selectedFlight.destination}</div><div className="selected-route-distance">{selectedRoute?.complete ? formatDistance(selectedRoute.distanceNm) : "No complete recorded route available"}</div></> : <span>{overviewLoading ? "Loading the all-flight overview…" : `${filteredOverview.length} source flight record${filteredOverview.length === 1 ? "" : "s"} available. Select a route from the map or list.`}</span>}
        </div>
        <button ref={mapOnlyTriggerRef} className="quiet-button toolbar-map-action" type="button" onClick={enterMapOnly}>Map only</button>
        <button className="quiet-button toolbar-clear" ref={apiDataTriggerRef} type="button" onClick={() => { setPage("api-data"); requestAnimationFrame(() => document.getElementById("api-data-heading")?.focus()); }}>API data</button>
        <button className="quiet-button toolbar-clear" type="button" onClick={() => { setPrimarySurface("none"); resetAll(); }}>Clear session</button>
      </header>}

      {(generation || refreshError || readinessError) && (
        <div className="generation-strip" role="region" aria-label="Source data controls">
          {(refreshError || readinessError) && <span className="refresh-error" role="alert">{refreshError ?? readinessError}</span>}
          <button className="quiet-button" type="button" onClick={() => void runRefresh()} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh source data"}</button>
        </div>
      )}

      {page === "api-data" ? <ApiDataPage selectedFlight={selectedFlight} selectedRoute={selectedRoute} onBack={() => { setPage("map"); requestAnimationFrame(() => apiDataTriggerRef.current?.focus()); }} /> : <main className="map-workspace">
        {mapOnly && <h1 className="sr-only">Map-first route comparison</h1>}
        <section className="map-panel map-first-panel" aria-labelledby="map-heading">
          <h2 className="sr-only" id="map-heading">Global route map</h2>
          <RouteMap routes={filteredOverview} selectedRoute={selectedRoute} synthesisRoute={synthesisRoute} selectedCandidate={selectedCandidate} callsign={selectedFlight?.callsign} onSelectRoute={chooseOverviewRoute} />
          <div className="map-hud">{selectedRoute ? <><span className="eyebrow">SELECTED SOURCE ROUTE</span><strong>{selectedRoute.label ?? selectedFlight?.callsign ?? "Selected route"}</strong><span>{selectedRoute.complete ? formatDistance(selectedRoute.distanceNm) : "No complete source route available"}</span></> : synthesisRoute ? <><span className="eyebrow">OBSERVED-DONOR SYNTHESIS</span><strong>{synthesisRoute.label ?? synthesisRoute.callsign}</strong><span>Dotted segments were observed on other recorded routes in this generation—not estimates or suggestions.</span></> : <><span className="eyebrow">SOURCE ROUTE OVERVIEW</span><strong>{overviewLoading ? "Loading source route records…" : `${filteredOverview.length} of ${overview.length} source route records shown`}</strong><span>{overviewError ?? "Refreshed source data, not real-time tracking. Select a route from the map or list."}</span></>}</div>
          {!mapOnly && <div className={`map-left-stack ${selectedRoute ? "has-route-legs" : ""}`}>
            <FlightOverviewList routes={filteredOverview} incompleteRoutes={incompleteOverview} total={overview.length} selected={selectedRoute} loading={overviewLoading} error={overviewError} onRetry={() => setOverviewReload((current) => current + 1)} onSelect={chooseOverviewRoute} onSelectIncomplete={chooseSynthesisTarget} onExploreSynthesis={openSynthesisChooser} />
            {selectedRoute && <RouteLegPanel route={selectedRoute} />}
          </div>}
          {!mapOnly && <nav className="map-rail" aria-label="Route workspace controls">
            <div className="rail-entry">
              <button ref={routesTriggerRef} type="button" aria-pressed={primarySurface === "routes"} onClick={() => setPrimarySurface((surface) => surface === "routes" ? "none" : "routes")} disabled={!selectedFlight}>Routes</button>
              {options.length > 1 && <span className="toolbar-count rail-count" aria-hidden="true">{options.length}</span>}
            </div>
            <button ref={dataTriggerRef} type="button" aria-pressed={primarySurface === "route-data"} onClick={() => setPrimarySurface((surface) => surface === "route-data" ? "none" : "route-data")} disabled={!selectedRoute}>Data</button>
            <button ref={editorTriggerRef} type="button" aria-pressed={primarySurface === "editor"} onClick={() => { if (!selectedRoute) return; setDraftActive(true); setPrimarySurface("editor"); void updateDraft([]); }} disabled={!selectedRoute}>Explore variation</button>
            <button ref={compareTriggerRef} type="button" aria-pressed={primarySurface === "compare"} onClick={() => setPrimarySurface((surface) => surface === "compare" ? "none" : "compare")} disabled={!selectedRoute || options.length < 2}>Compare</button>
          </nav>}
          {mapOnly && <button ref={restoreControlsRef} className="restore-controls" type="button" onClick={leaveMapOnly} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); leaveMapOnly(); } }}>Restore controls</button>}
          {!mapOnly && primarySurface !== "none" && <aside className="map-drawer map-bottom-sheet" role="region" aria-label={primarySurface === "routes" ? "Route chooser" : primarySurface === "route-data" ? "Flight and route data" : primarySurface === "compare" ? "Route comparison" : primarySurface === "synthesis" ? "Observed-donor synthesis" : "Explore a route variation"}>
            <div className="drawer-header"><p className="eyebrow">{primarySurface === "compare" ? "COMPARE ROUTES" : primarySurface === "routes" ? "COMPARE RECORDED ROUTES" : primarySurface === "route-data" ? "INSPECT ROUTE" : primarySurface === "synthesis" ? "OBSERVED-DONOR SYNTHESIS" : "EXPLORE VARIATION"}</p><button className="quiet-button" type="button" onClick={() => { if (primarySurface === "editor") resetDraftState(); closeSurface(primarySurface); }}>Close</button></div>
            {primarySurface === "routes" && <RouteOptions options={options} selected={selectedRoute} loading={routeLoading} error={routeError} onRetry={() => { setRouteReload((current) => current + 1); requestAnimationFrame(() => document.getElementById("options-heading")?.focus()); }} onSelect={(option) => { resetDraftState(); chooseOverviewRoute(option); setStatus(`Selected flight ${option.callsign} from the neutral route comparison.`); closeSurface("routes"); }} />}
            {primarySurface === "synthesis" && <SynthesisExplorer routes={incompleteOverview} selected={synthesisRoute} synthesis={synthesis} selectedCandidate={selectedCandidate} loading={synthesisLoading} error={synthesisError} statisticalNote={statisticalNote} onSelect={chooseSynthesisTarget} onChooseCandidate={setSelectedCandidate} onRetry={() => { if (synthesisRoute) void loadSynthesis(synthesisRoute); }} />}
            {primarySurface === "compare" && selectedRoute && <RouteCompare baseline={selectedRoute} options={options} onSelect={(option) => { chooseOverviewRoute(option); setStatus(`Comparing ${selectedRoute.label ?? "route"} with ${option.label ?? "route option"}.`); }} />}
            {primarySurface === "route-data" && selectedRoute && <RouteDetails route={selectedRoute} onStartDraft={() => { setDraftActive(true); setPrimarySurface("editor"); void updateDraft([]); requestAnimationFrame(() => document.getElementById("draft-heading")?.focus()); }} />}
            {primarySurface === "editor" && selectedRoute && draftActive && <DraftEditor draft={draft} baseline={selectedRoute} loading={draftLoading} error={draftError} onUpdate={(via, selections) => void updateDraft(via, selections)} onClose={() => { resetDraftState(); closeSurface("editor"); }} />}
          </aside>}
          {!mapOnly && <div className="map-legend" role="group" aria-label="Map legend"><span><i className="legend-line" /> Selected source route</span><span><i className="legend-line legend-line-alt" /> Alternate source route</span><span><i className="legend-line legend-line-potential" /> Dotted segments: observed on another recorded route (same generation)</span><span><i className="legend-gap" /> Unresolved gap</span><span><i className="legend-dot legend-origin" /> Departure</span><span><i className="legend-dot legend-destination" /> Arrival</span></div>}
          <div className="sr-status" role="status" aria-live="polite">{routeLoading ? "Loading route options." : status}</div>
        </section>
      </main>}
    </div>
  );
}

function FlightOverviewList({ routes, incompleteRoutes, total, selected, loading, error, onRetry, onSelect, onSelectIncomplete, onExploreSynthesis }: { routes: RouteOption[]; incompleteRoutes: RouteOption[]; total: number; selected?: RouteOption | undefined; loading: boolean; error?: string | undefined; onRetry: () => void; onSelect: (route: RouteOption) => void; onSelectIncomplete: (route: RouteOption) => void; onExploreSynthesis: () => void }) {
  return <section className="flight-overview-list" aria-label="Full flight list">
    <div className="overview-list-heading"><div><span className="eyebrow">SOURCE FLIGHT RECORDS</span><strong>{routes.length} of {total}</strong></div></div>
    {loading && <div className="loading-row"><span className="spinner dark" /> Loading all route pages…</div>}
    {error && <div className="notice error-notice" role="alert"><span>{error}</span><button className="retry-button" type="button" onClick={onRetry}>Retry overview</button></div>}
    {!loading && !error && routes.length === 0 && <p className="muted-copy">No source flight records match the current filter.</p>}
    {!loading && !error && incompleteRoutes.length > 0 && <div className="potential-route-prompt"><div><span className="eyebrow">OBSERVED-DONOR SYNTHESIS</span><strong>{incompleteRoutes.length} source route record{incompleteRoutes.length === 1 ? "" : "s"} with gaps</strong><p>Synthesis shows geometry observed on other recorded routes in this generation—never interpolation, ranking, or a route suggestion.</p></div><button className="quiet-button" type="button" onClick={onExploreSynthesis}>Show observed-donor synthesis</button></div>}
    <div className="overview-flight-buttons">
      {routes.map((route) => {
        const complete = isCompleteRoute(route);
        return <button key={route.flightId} type="button" className={`${selected?.flightId === route.flightId ? "selected" : ""} ${complete ? "" : "has-gap"}`} aria-current={selected?.flightId === route.flightId ? "true" : undefined} onClick={() => complete ? onSelect(route) : onSelectIncomplete(route)}>
          <span><strong>{route.callsign}</strong><small>{route.origin ?? "Unknown departure"} → {route.destination ?? "Unknown destination"} · {complete ? "Complete source route" : `${route.gaps.length} visible gap${route.gaps.length === 1 ? "" : "s"}`}</small></span>
          <span>{complete ? formatDistance(route.distanceNm) : "Visible gap"}</span>
        </button>;
      })}
    </div>
  </section>;
}

function SynthesisExplorer({ routes, selected, synthesis, selectedCandidate, loading, error, statisticalNote, onSelect, onChooseCandidate, onRetry }: { routes: RouteOption[]; selected?: RouteOption | undefined; synthesis?: SynthesisResult | undefined; selectedCandidate?: SynthesisCandidate | undefined; loading: boolean; error?: string | undefined; statisticalNote?: string | undefined; onSelect: (route?: RouteOption) => void; onChooseCandidate: (candidate: SynthesisCandidate) => void; onRetry: () => void }) {
  const unavailableTone = Boolean(synthesis && (synthesis.status === "unavailable" || synthesis.status === "over-limit" || synthesis.status === "candidate-limit-exceeded"));
  return <section className="potential-route-section" aria-labelledby="synthesis-heading">
    {!selected ? <>
      <div className="section-title"><div><p className="eyebrow">OBSERVED-DONOR SYNTHESIS</p><h2 id="synthesis-heading">Choose a source route with gaps</h2></div><span className="count-label">{routes.length} available</span></div>
      <p className="criterion-copy">Synthesis assembles candidates from geometry observed on other recorded routes in the same data generation. Nothing is interpolated, ranked, or written back to the source record.</p>
      <div className="potential-route-options">{routes.map((route) => <button type="button" key={route.flightId} onClick={() => onSelect(route)}><span><strong>{route.callsign}</strong><small>{route.label ?? "Recorded route"} · {route.gaps.length} gap{route.gaps.length === 1 ? "" : "s"}</small></span><span>{route.origin ?? "Unknown departure"} → {route.destination ?? "Unknown destination"}</span></button>)}</div>
      {!routes.length && <p className="muted-copy">No incomplete recorded routes match the current filter.</p>}
    </> : <>
      <div className="section-title"><div><p className="eyebrow">OBSERVED-DONOR SYNTHESIS</p><h2 id="synthesis-heading">Synthesis result</h2></div><button className="quiet-button" type="button" onClick={() => onSelect()}>Choose another</button></div>
      <p className="sr-only" aria-live="polite">Solid segments are recorded for this flight; dotted segments were observed on other flights in the same data generation.</p>
      <p className="muted-copy">{selected.callsign} · {selected.origin ?? "Unknown departure"} → {selected.destination ?? "Unknown destination"}</p>
      {loading && <div className="loading-row"><span className="spinner dark" /> Requesting observed-donor synthesis candidates…</div>}
      {error && !loading && <div className="notice error-notice" role="alert"><span>{error}</span><button className="retry-button" type="button" onClick={onRetry}>Retry synthesis</button></div>}
      {synthesis && !loading && !error && <>
        <p className={`synthesis-status${unavailableTone ? " synthesis-unavailable" : ""}`}>{synthesisStatusCopy(synthesis)}</p>
        {synthesis.candidates.length > 0 && <div className="synthesis-candidates" role="group" aria-label="Synthesis candidates">{synthesis.candidates.map((candidate) => <button type="button" key={candidate.candidateId} aria-pressed={candidate.candidateId === selectedCandidate?.candidateId} onClick={() => onChooseCandidate(candidate)}><span><strong>Candidate {candidate.candidateId}</strong><small>Observed on {candidateDonorCount(candidate)} donor route(s) · borrowed {formatDistance(candidate.borrowedDistanceNm)}</small></span><span>{candidate.corridorsCovered} corridor{candidate.corridorsCovered === 1 ? "" : "s"} covered</span></button>)}</div>}
        {selectedCandidate && <>
          <div className="metric-grid">
            {selectedCandidate.estimatedTotalDistanceNm !== undefined && <Metric label="Estimated total (source + borrowed)" value={formatDistance(selectedCandidate.estimatedTotalDistanceNm)} note="Never a source record change" />}
            <Metric label="Source resolved" value={formatDistance(selectedCandidate.sourceResolvedDistanceNm)} />
            <Metric label="Borrowed" value={formatDistance(selectedCandidate.borrowedDistanceNm)} />
            <Metric label="Corridors covered" value={`${selectedCandidate.corridorsCovered}/${synthesis.corridorCount}`} />
          </div>
          <div className="evidence-stack">
            {selectedCandidate.segments.map((segment, index) => <Evidence key={`borrowed-provenance-${index}`} label="Borrowed segment provenance" value={borrowedSegmentProvenanceCopy(segment)} tone="blue" />)}
          </div>
        </>}
        <div className="evidence-stack">
          {synthesis.safety && <Evidence label="Synthesis safety" value={synthesis.safety} tone="amber" />}
          <Evidence label="Inspection aid" value="Synthesized candidates are inspection aids only. They are not operational routes and never modify the source record." tone="amber" />
        </div>
      </>}
      {statisticalNote && <div className="evidence-stack">
        <Evidence label="Separate statistical annotation (not synthesis)" value={GAP_DISTANCE_ANNOTATION_CAVEAT} tone="amber" />
        <Evidence label="Statistical annotation detail" value={statisticalNote} tone="blue" />
      </div>}
    </>}
  </section>;
}


function SearchBox({ selected, state, onFocus, onQuery, onSearch, onSelect, onCancelSearch }: { selected?: CallsignMatch | undefined; state: SearchState; onFocus: () => void; onQuery: (value: string) => void; onSearch: () => void; onSelect: (match: CallsignMatch) => void; onCancelSearch: () => void }) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const [resultsOpen, setResultsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasResults = resultsOpen && state.matches.length > 0;
  const resultId = "flight-search-results";

  useEffect(() => {
    setActiveIndex(-1);
    setResultsOpen(state.matches.length > 0);
  }, [state.matches]);

  function select(match: CallsignMatch) {
    onSelect(match);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <div className={`search-block ${hasResults ? "is-active" : ""}`}>
      <label htmlFor="flight-search">Flight number or code</label>
      <div className="search-input-row">
        <input ref={inputRef} id="flight-search" role="combobox" value={state.query} maxLength={64} onFocus={onFocus} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "ArrowDown" && hasResults) { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, state.matches.length - 1)); }
          else if (event.key === "ArrowUp" && hasResults) { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
          else if (event.key === "Enter") { event.preventDefault(); if (activeIndex >= 0 && state.matches[activeIndex]) select(state.matches[activeIndex]); else onSearch(); }
          else if (event.key === "Escape") { event.preventDefault(); onCancelSearch(); setActiveIndex(-1); setResultsOpen(false); }
        }} aria-expanded={hasResults} aria-controls={hasResults ? resultId : undefined} aria-activedescendant={activeIndex >= 0 ? `flight-match-${activeIndex}` : undefined} aria-autocomplete="list" placeholder="For example: SQ321" autoComplete="off" />
        <button className="search-button" type="button" onClick={onSearch} disabled={state.loading || !state.query.trim()} aria-label="Search flight plans">{state.loading ? <span className="spinner" /> : "↗"}</button>
      </div>
      {selected && <p className="selected-value"><span className="check">✓</span> Selected <strong>{selected.callsign}</strong> <span>{selected.departure} → {selected.destination}</span></p>}
      {state.error && <p className="field-error" role="alert">{state.error}</p>}
      {hasResults && <div className="duplicate-picker"><p className="picker-label">{state.matches.length > 1 ? "Multiple flight plans — choose the exact record" : "Flight-plan match"}</p><div id={resultId} role="listbox" aria-label="Choose an exact flight-plan match">{state.matches.map((match, index) => <div className={`match-option ${activeIndex === index ? "is-active" : ""}`} id={`flight-match-${index}`} role="option" aria-selected={activeIndex === index} key={match.id} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => select(match)}><span><strong>{match.callsign}</strong><small>{match.departure} → {match.destination} · {match.routePointCount} recorded points</small></span><span aria-hidden="true">›</span></div>)}</div></div>}
      {state.searched && !state.loading && state.query.trim() && !state.error && !hasResults && state.matches.length === 0 && !selected && <p className="helper-text">No matching flight plans returned.</p>}
    </div>
  );
}

function RouteOptions({ options, selected, loading, error, onRetry, onSelect }: { options: RouteOption[]; selected?: RouteOption | undefined; loading: boolean; error?: string | undefined; onRetry: () => void; onSelect: (route: RouteOption) => void }) {
  const complete = options.filter(isCompleteRoute);
  if (!loading && !error && complete.length === 0) return <section className="empty-options"><span className="empty-icon">⌁</span><div><h2>No complete routes available</h2><p>Select a recorded flight with fully resolved route references.</p></div></section>;
  return <section className="options-section" aria-labelledby="options-heading"><div className="section-title"><div><p className="eyebrow">COMPARE</p><h2 id="options-heading" tabIndex={-1}>Complete recorded route options</h2></div>{complete.length > 0 && <span className="count-label">{complete.length} returned</span>}</div>{loading && <div className="loading-row"><span className="spinner dark" /> Loading complete same-endpoint recorded routes…</div>}{error && <div className="notice error-notice" role="alert"><strong>Could not load route options.</strong><span>{error}</span><button className="retry-button" type="button" onClick={onRetry}>Retry route options</button></div>}{complete.length > 0 && <p className="criterion-copy">{ROUTE_COMPARISON_EXPLANATION}</p>}{complete.length > 0 && <p className="criterion-copy">Only routes with every recorded reference resolved exactly are shown.</p>}{complete.length > 0 && <RouteGroup title={COMPLETE_GROUP_TITLE} description={COMPLETE_GROUP_DESCRIPTION} count={`${complete.length} complete route${complete.length === 1 ? "" : "s"}`} options={complete} selected={selected} onSelect={onSelect} />}</section>;
}

function RouteGroup({ title, description, count, options, selected, onSelect }: { title: string; description: string; count: string; options: RouteOption[]; selected?: RouteOption | undefined; onSelect: (route: RouteOption) => void }) {
  return <div className="route-group"><div className="group-heading"><div><h3>{title}</h3><p className="criterion-copy">{description}</p></div><span className="group-count">{count}</span></div><div className="option-grid">{options.map((option) => <button type="button" className={`route-card ${selected?.flightId === option.flightId ? "selected" : ""} ${option.complete ? "is-complete" : "is-incomplete"}`} key={option.id} onClick={() => onSelect(option)} aria-current={selected?.flightId === option.flightId ? "true" : undefined}><span className="route-card-top"><strong>{option.label ?? "Route option"}</strong><span>{option.complete ? "Complete" : "Visible gaps"}</span></span><span className="route-card-distance">{formatDistance(option.distanceNm)}</span><span className="route-card-meta">{option.pointCount} points · {option.legs.length} legs · {option.gaps.length} visible gaps · {option.provenance ?? "provenance not supplied"}</span><span className="route-card-meta">{option.complete ? "All recorded references resolved exactly." : "Resolved components remain visible; gaps are not bridged."}</span></button>)}</div></div>;
}

function RouteCompare({ baseline, options, onSelect }: { baseline: RouteOption; options: RouteOption[]; onSelect: (option: RouteOption) => void }) {
  const [targetId, setTargetId] = useState<string>();
  // Snapshot the click-time baseline: onSelect promotes the chosen option to
  // the selected route, so the side-by-side must keep comparing against the
  // route that was selected before the click.
  const [source, setSource] = useState<RouteOption>(baseline);
  const candidates = options.filter((option) => option.id !== source.id && isCompleteRoute(option));
  const target = candidates.find((option) => option.id === targetId);
  const comparison = target ? compareDistanceOperands(source.distanceNm, target.distanceNm) : undefined;
  const delta = comparison?.distanceDeltaNm;
  const percentage = comparison?.percentageDistanceDelta;
  return <section className="compare-section" aria-labelledby="compare-heading">
    <div className="section-title"><div><p className="eyebrow">COMPARE</p><h2 id="compare-heading" tabIndex={-1}>Side-by-side route comparison</h2></div></div>
    <div className="compare-baseline"><p className="eyebrow">SELECTED ROUTE</p><strong>{source.label ?? "Selected route"}</strong><span>{formatDistance(source.distanceNm)}</span><span>No preferred route is declared.</span></div>
    {candidates.length > 0 && <div className="compare-candidates"><p className="criterion-copy">Choose a route option to compare against the selected route.</p><div className="option-grid">{candidates.map((option) => <button type="button" className="route-card" key={option.id} onClick={() => { setSource(baseline); setTargetId(option.id); onSelect(option); }} aria-label={`Compare ${source.label ?? "selected route"} with ${option.label ?? "route option"}`}><span className="route-card-top"><strong>{option.label ?? "Route option"}</strong><span>{option.complete ? "Complete" : "Incomplete"}</span></span><span className="route-card-distance">{formatDistance(option.distanceNm)}</span></button>)}</div></div>}
    {target && comparison && <div className="compare-result">
      <div className="compare-columns">
        <div className="metric-grid"><Metric label="Baseline" value={source.label ?? "Selected route"} /><Metric label="Distance" value={formatDistance(source.distanceNm)} /><Metric label="Points" value={String(source.pointCount)} /><Metric label="Legs" value={String(source.legs.length)} /><Metric label="Gaps" value={String(source.gaps.length)} /><Metric label="Status" value={source.complete ? "Complete" : "Incomplete"} /></div>
        <div className="metric-grid"><Metric label="Target" value={target.label ?? "Route option"} /><Metric label="Distance" value={formatDistance(target.distanceNm)} /><Metric label="Points" value={String(target.pointCount)} /><Metric label="Legs" value={String(target.legs.length)} /><Metric label="Gaps" value={String(target.gaps.length)} /><Metric label="Status" value={target.complete ? "Complete" : "Incomplete"} /></div>
      </div>
      <div className="metric-grid"><Metric label="Change from selected route" value={delta === undefined ? "Unavailable" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} NM`} note={percentage !== undefined ? `Directed baseline → target · ${percentage >= 0 ? "+" : ""}${percentage.toFixed(1)}%` : "Directed baseline → target"} /></div>
      {(comparison.status !== "complete" || comparison.unavailable?.includes("INCOMPLETE_OPERAND")) && <div className="evidence-stack"><Evidence label="Comparison limitation" value="Both routes must be complete for a modeled-distance difference." tone="amber" /></div>}
    </div>}
  </section>;
}

function RouteLegPanel({ route }: { route: RouteOption }) {
  return <section className="route-leg-panel" aria-labelledby="route-legs-heading"><div className="route-leg-panel-heading"><div><p className="eyebrow">SELECTED ROUTE</p><h2 id="route-legs-heading">Route legs</h2></div><span>{route.legs.length} leg{route.legs.length === 1 ? "" : "s"}</span></div><RouteTable legs={route.legs} /></section>;
}

function RouteDetails({ route, onStartDraft }: { route: RouteOption; onStartDraft: () => void }) {
  return <section className="details-section" aria-labelledby="details-heading"><div className="section-title"><div><p className="eyebrow">INSPECT</p><h2 id="details-heading">Route data</h2></div><div className="detail-actions"><button className="edit-copy-button" type="button" onClick={onStartDraft}>Explore variation</button><span className="opaque-id" title="Opaque server flight ID">Flight ID {route.flightId}</span></div></div><div className="metric-grid"><Metric label="Route data" value={route.complete ? "All references resolved" : "Some references unresolved"} /><Metric label="Modeled distance" value={formatDistance(route.distanceNm)} /><Metric label="Points" value={String(route.pointCount)} note="Server-reported count" /><Metric label="Visible gaps" value={String(route.gaps.length)} /></div><div className="evidence-stack"><Evidence label="Neutral comparison" value={ROUTE_COMPARISON_EXPLANATION} tone="blue" /><Evidence label="Provenance" value={route.provenance ?? "Not supplied by the route service."} tone="blue" /><Evidence label="Safety boundary" value={SAFETY_NOTICE} tone="amber" /><Evidence label={`Visible gaps${route.gaps.length ? ` · ${route.gaps.length}` : ""}`} value={route.gaps.length ? route.gaps.map((gap) => `Route position ${gap.sequence + 1}: ${gap.reason}`).join(" ") : "No gaps reported by the route service."} tone={route.gaps.length ? "red" : "green"} /></div></section>;
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>; }
function Evidence({ label, value, tone }: { label: string; value: string; tone: "blue" | "amber" | "red" | "green" }) { return <div className={`evidence evidence-${tone}`}><span>{label}</span><p>{value}</p></div>; }

function RouteTable({ legs }: { legs: RouteLeg[] }) {
  return legs.length ? <div className="table-scroll" role="group" tabIndex={0} aria-label="Scrollable route-leg table"><table aria-labelledby="route-legs-heading"><caption className="sr-only">Structured route legs and unresolved gaps</caption><thead><tr><th scope="col">Sequence</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Distance</th><th scope="col">Status</th></tr></thead><tbody>{legs.map((leg, index) => {
    const isGap = leg.status === "gap" || leg.kind === "gap" || !leg.from || !leg.to;
    return <tr className={isGap ? "gap-row" : undefined} key={leg.id}><th scope="row">{index + 1}</th>{isGap ? <td colSpan={2}><strong>Unresolved gap</strong><span className="gap-reason">{leg.reason ?? "The route service did not resolve this segment."}</span></td> : <><td>{leg.from}</td><td>{leg.to}</td></>}<td>{formatDistance(leg.distanceNm)}</td><td>{isGap ? "gap" : leg.status ?? "resolved"}</td></tr>;
  })}</tbody></table></div> : <p className="muted-copy">No leg data was supplied for this route. Nothing has been inferred.</p>;
}

function DraftEditor({ draft, baseline, loading, error, onUpdate, onClose }: { draft?: DraftComparison | undefined; baseline: RouteOption; loading: boolean; error?: string | undefined; onUpdate: (via: string[], selections: DraftSelection[]) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PointMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string>();
  const lookupRequest = useRef(0);
  // Optimistic mirrors for via AND selections: every update commits through
  // them, so rapid consecutive edits never compute from (and silently drop)
  // a stale server response, a reset is mirrored immediately (an in-flight
  // commit cannot resurrect removed waypoints), and an earlier commit's
  // explicit selection survives the next commit.
  const committedRef = useRef<string[] | null>(null);
  const selectionsRef = useRef<DraftSelection[] | null>(null);
  const via = committedRef.current ?? draft?.draft.via ?? [];
  useEffect(() => {
    if (draft === undefined) { committedRef.current = null; selectionsRef.current = null; return; }
    if (committedRef.current !== null && JSON.stringify(draft.draft.via) === JSON.stringify(committedRef.current)) committedRef.current = null;
    if (selectionsRef.current !== null && JSON.stringify(draft.draft.selections) === JSON.stringify(selectionsRef.current)) selectionsRef.current = null;
  }, [draft]);
  // Every state-changing edit funnels through here so the mirrors stay ahead
  // of the server round-trip.
  function commitUpdate(nextVia: string[], nextSelections: DraftSelection[]) {
    committedRef.current = nextVia;
    selectionsRef.current = nextSelections;
    onUpdate(nextVia, nextSelections);
  }
  const selections = selectionsRef.current ?? draft?.draft.selections ?? [];
  const delta = draft?.comparison.distanceDeltaNm;
  const percentage = draft?.comparison.percentageDistanceDelta;
  const selectedAt = (sequence: number) => selections.some((selection) => selection.sequence === sequence);
  const matchResultsId = "draft-point-results";
  const hasMatches = matches.length > 0;

  function remapMove(index: number, direction: -1 | 1): DraftSelection[] {
    const target = index + direction;
    return selections.map((selection) => selection.sequence === index
      ? { sequence: target, locationId: selection.locationId }
      : selection.sequence === target
        ? { sequence: index, locationId: selection.locationId }
        : selection);
  }

  function remapRemove(index: number): DraftSelection[] {
    return selections.flatMap((selection) => selection.sequence === index
      ? []
      : [selection.sequence > index ? { sequence: selection.sequence - 1, locationId: selection.locationId } : selection]);
  }

  function commitMatch(match: PointMatch) {
    lookupRequest.current += 1;
    const nextVia = [...via, match.identifier];
    commitUpdate(nextVia, match.locationId ? [...selections, { sequence: via.length, locationId: match.locationId }] : selections);
    setQuery("");
    setMatches([]);
    setActiveIndex(-1);
  }

  async function findReference() {
    const value = query.trim();
    if (!value || lookupLoading) return;
    const requestId = ++lookupRequest.current;
    setLookupLoading(true);
    setLookupError(undefined);
    setMatches([]);
    setActiveIndex(-1);
    try {
      const found = await lookupPoint(value);
      if (requestId !== lookupRequest.current) return; // a newer lookup superseded this one
      setMatches(found.matches);
      if (!found.matches.length) setLookupError("No exact reference point was returned. Free-form points cannot be added.");
      else if (found.truncated) setLookupError("More than 50 exact matches exist for this reference. Narrow the search term.");
    } catch (lookupFailure) {
      if (requestId !== lookupRequest.current) return;
      setLookupError(apiMessage(lookupFailure));
    } finally {
      if (requestId === lookupRequest.current) setLookupLoading(false);
    }
  }

  return <section className="draft-section" aria-labelledby="draft-heading">
    <div className="section-title"><div><p className="eyebrow">EDIT COPY</p><h2 id="draft-heading" tabIndex={-1}>Local computational draft</h2></div><button className="quiet-button" type="button" onClick={onClose}>Close draft</button></div>
    <p className="draft-safety">{DRAFT_SAFETY_COPY} Endpoints are locked and every change is checked against exact reference data.</p>
    <div className="draft-endpoints"><span><strong>From</strong> {baseline.origin ?? "Selected origin"}</span><span><strong>To</strong> {baseline.destination ?? "Selected destination"}</span></div>
    <div className="draft-search"><label htmlFor="draft-point-search">Add an exact reference point</label><div className="search-input-row"><input id="draft-point-search" role="combobox" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
      if (event.key === "ArrowDown" && hasMatches) { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, matches.length - 1)); }
      else if (event.key === "ArrowUp" && hasMatches) { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
      else if (event.key === "Enter") { event.preventDefault(); if (activeIndex >= 0 && matches[activeIndex]) commitMatch(matches[activeIndex]!); else void findReference(); }
      else if (event.key === "Escape") { event.preventDefault(); setMatches([]); setLookupError(undefined); setActiveIndex(-1); }
    }} aria-expanded={hasMatches} aria-controls={hasMatches ? matchResultsId : undefined} aria-activedescendant={activeIndex >= 0 ? `draft-match-${activeIndex}` : undefined} aria-autocomplete="list" maxLength={64} placeholder="Search an exact fix, NAVAID, or airport" autoComplete="off" /><button className="search-button" type="button" onClick={() => void findReference()} disabled={lookupLoading || !query.trim()} aria-label="Find exact reference point">{lookupLoading ? <span className="spinner" /> : "Find"}</button></div>{lookupError && <p className="field-error" role="alert">{lookupError}</p>}<div className="sr-status" role="status" aria-live="polite">{lookupLoading ? "Looking up exact reference points." : matches.length ? `${matches.length} exact reference point${matches.length === 1 ? "" : "s"} available.` : ""}</div>
      {hasMatches && <div className="reference-picker" id={matchResultsId} role="listbox" aria-label="Resolved reference-point search results">{matches.map((match, index) => <div role="option" id={`draft-match-${index}`} aria-selected={activeIndex === index} className={activeIndex === index ? "is-active" : undefined} tabIndex={-1} key={`${match.identifier}-${match.coordinate.lat}-${match.coordinate.lon}`} onMouseDown={(event) => event.preventDefault()} onClick={() => commitMatch(match)}><span><strong>{match.identifier}</strong><small>{match.kind} · {match.coordinate.lat.toFixed(4)}, {match.coordinate.lon.toFixed(4)}{match.duplicateGroup ? " · multiple exact coordinates" : ""}</small></span><span>{match.duplicateGroup ? "Choose exact location" : "Add"}</span></div>)}</div>}
    </div>
    <div className="draft-points"><div className="group-heading"><h3>Intermediate points</h3><button className="text-button" type="button" onClick={() => commitUpdate([], [])} disabled={!via.length || loading}>Reset to endpoint-only draft</button></div>{via.length ? <ol role="list">{via.map((point, index) => <li key={`${point}-${index}`}><span><strong>{point}</strong><small>{selectedAt(index) ? "Exact coordinate selected from the ambiguous group." : "Manual-direct segments are not airways."}</small></span><span className="draft-row-actions"><button type="button" onClick={() => commitUpdate(via.map((value, position) => position === index - 1 ? point : position === index ? via[index - 1]! : value), remapMove(index, -1))} disabled={loading || index === 0} aria-label={`Move ${point} up`}>Move up</button><button type="button" onClick={() => commitUpdate(via.map((value, position) => position === index + 1 ? point : position === index ? via[index + 1]! : value), remapMove(index, 1))} disabled={loading || index === via.length - 1} aria-label={`Move ${point} down`}>Move down</button><button type="button" onClick={() => commitUpdate(via.filter((_, position) => position !== index), remapRemove(index))} disabled={loading} aria-label={`Remove ${point}`}>Remove</button></span></li>)}</ol> : <p className="muted-copy">No intermediate points. This draft uses a direct modeled endpoint-to-endpoint segment.</p>}</div>
    {loading && <div className="loading-row"><span className="spinner dark" /> Validating the local draft…</div>}{error && <div className="notice error-notice" role="alert"><span>{error}</span><button className="retry-button" type="button" onClick={() => { commitUpdate(via, selections); requestAnimationFrame(() => document.getElementById("draft-heading")?.focus()); }} disabled={loading}>Retry draft validation</button></div>}
    {draft && <div className="draft-result"><Metric label="Draft status" value={draft.comparison.status === "complete" ? "Complete" : "Incomplete"} /><Metric label="Modeled distance" value={formatDistance(draft.route.distanceNm)} /><Metric label="Change from selected route" value={delta === undefined ? "Unavailable" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} NM`} note={percentage !== undefined ? `Directed baseline → target · ${percentage >= 0 ? "+" : ""}${percentage.toFixed(1)}%` : "Directed baseline → target"} /><Metric label="Draft gaps" value={String(draft.route.gaps.length)} note={draft.comparison.message} /></div>}
  </section>;
}

type EndpointLocation = Pick<PointMatch, "coordinate" | "name">;

function endpointReference(label: string): string {
  return /\(([A-Z]{4})\)$/.exec(label)?.[1] ?? label;
}

function RouteMap({ routes, selectedRoute, synthesisRoute, selectedCandidate, callsign, onSelectRoute }: { routes: RouteOption[]; selectedRoute?: RouteOption | undefined; synthesisRoute?: RouteOption | undefined; selectedCandidate?: SynthesisCandidate | undefined; callsign?: string | undefined; onSelectRoute: (route: RouteOption) => void }) {
  const [overlapChoices, setOverlapChoices] = useState<RouteOption[]>([]);
  const [endpoints, setEndpoints] = useState<{ departure?: EndpointLocation | undefined; arrival?: EndpointLocation | undefined }>({});
  const [view, setView] = useState<TileView>({ lat: 20, lon: 0, zoom: 2 });
  const [tilesEnabled, setTilesEnabled] = useState(true);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [stageSize, setStageSize] = useState<MapSize>(DEFAULT_SIZE);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const tilesOn = tilesEnabled && !tilesFailed;

  useEffect(() => {
    const measure = () => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) setStageSize({ width: rect.width, height: rect.height });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Every server-returned candidate is drawn on the map: the selected route
  // highlighted on top, every other candidate with geometry dimmed underneath.
  // Candidates without resolved geometry are intentionally not drawn. In tile
  // mode the overlay is projected through the Web Mercator view; the
  // equirectangular projection remains for the schematic fallback.
  const projections = useMemo(() => routes.filter(isCompleteRoute).map((route) => {
    const sourceSegments = route.segments ?? (route.geometry ? [route.geometry] : []);
    return { route, projection: tilesOn ? projectWorldSegmentsMercator(sourceSegments, view, stageSize) : projectWorldSegments(sourceSegments) };
  }), [routes, tilesOn, view, stageSize]);
  const displayRoute = selectedRoute ?? synthesisRoute;
  const displayProjection = useMemo(() => {
    if (!displayRoute) return undefined;
    const sourceSegments = displayRoute.segments ?? (displayRoute.geometry ? [displayRoute.geometry] : []);
    return tilesOn ? projectWorldSegmentsMercator(sourceSegments, view, stageSize) : projectWorldSegments(sourceSegments);
  }, [displayRoute, tilesOn, view, stageSize]);
  const alternates = projections.flatMap(({ route, projection }) => route.flightId !== displayRoute?.flightId && projection && projection.segments.length ? [{ route, projection }] : []);
  // Borrowed donor geometry comes exclusively from the synthesis API response;
  // the client never generates coordinates for it.
  const borrowedProjection = useMemo(() => {
    const borrowedSegments = selectedCandidate?.segments.map((segment) => segment.geometry) ?? [];
    if (!borrowedSegments.length) return undefined;
    return tilesOn ? projectWorldSegmentsMercator(borrowedSegments, view, stageSize) : projectWorldSegments(borrowedSegments);
  }, [selectedCandidate, tilesOn, view, stageSize]);
  function chooseProjectedRoute(route: RouteOption, projection: ProjectedSegments) {
    const signature = projection.segments.map((segment) => segment.path).join("|");
    const overlaps = projections.flatMap((candidate) => candidate.projection?.segments.map((segment) => segment.path).join("|") === signature ? [candidate.route] : []);
    if (overlaps.length > 1) setOverlapChoices(overlaps);
    else onSelectRoute(route);
  }
  const hasLine = Boolean(displayProjection?.segments.length);
  const borrowedHasLine = Boolean(borrowedProjection?.segments.length);
  const hasAnyLine = hasLine || alternates.length > 0 || borrowedHasLine;
  const displayEndpoints = selectedRoute ? endpoints : {};
  const departure = displayRoute?.origin ?? "Not supplied";
  const arrival = displayRoute?.destination ?? "Not supplied";

  useEffect(() => {
    const controller = new AbortController();
    const exact = (matches: PointMatch[]): EndpointLocation | undefined => {
      const unique = matches.filter((match) => !match.duplicateGroup);
      return unique.length === 1 ? unique[0] : undefined;
    };
    if (!selectedRoute?.origin && !selectedRoute?.destination) { setEndpoints({}); return () => controller.abort(); }
    void Promise.all([
      selectedRoute?.origin ? lookupPoint(endpointReference(selectedRoute.origin), controller.signal).then((result) => exact(result.matches)).catch(() => undefined) : Promise.resolve(undefined),
      selectedRoute?.destination ? lookupPoint(endpointReference(selectedRoute.destination), controller.signal).then((result) => exact(result.matches)).catch(() => undefined) : Promise.resolve(undefined),
    ]).then(([departurePoint, arrivalPoint]) => {
      if (!controller.signal.aborted) setEndpoints({ departure: departurePoint, arrival: arrivalPoint });
    });
    return () => controller.abort();
  }, [selectedRoute?.id, selectedRoute?.origin, selectedRoute?.destination]);

  useEffect(() => {
    if (!tilesOn || !displayRoute) return;
    const sourceSegments = displayRoute.segments ?? (displayRoute.geometry ? [displayRoute.geometry] : []);
    const coordinates = [
      ...sourceSegments.flat(),
      ...(selectedCandidate?.segments.flatMap((segment) => segment.geometry) ?? []),
    ];
    if (endpoints.departure) coordinates.push(endpoints.departure.coordinate);
    if (endpoints.arrival) coordinates.push(endpoints.arrival.coordinate);
    const fitted = fitViewToCoordinates(coordinates, stageSize);
    if (fitted) setView(fitted);
  }, [displayRoute, selectedCandidate, endpoints, stageSize.width, stageSize.height, tilesOn]);

  const projectPoint = (coordinate: Coordinate): Point => tilesOn ? pixelFromView(coordinate, view, stageSize) : projectWorldPoint(coordinate);
  const departurePoint = displayEndpoints.departure ? projectPoint(displayEndpoints.departure.coordinate) : undefined;
  const arrivalPoint = displayEndpoints.arrival ? projectPoint(displayEndpoints.arrival.coordinate) : undefined;
  const departureLabel = displayEndpoints.departure?.name && displayEndpoints.departure.name !== departure ? `${displayEndpoints.departure.name} (${departure})` : departure;
  const arrivalLabel = displayEndpoints.arrival?.name && displayEndpoints.arrival.name !== arrival ? `${displayEndpoints.arrival.name} (${arrival})` : arrival;
  const selectedSegmentCount = displayProjection?.segments.length ?? 0;
  const label = synthesisRoute
    ? `${callsign ?? synthesisRoute.callsign} world map showing observed-donor synthesis for ${departureLabel} to ${arrivalLabel}; dotted segments were observed on other recorded routes in this generation, not estimates or suggestions`
    : hasLine
      ? `${callsign ?? "Selected flight"} world map showing ${departureLabel} departure and ${arrivalLabel} arrival with ${selectedSegmentCount} resolved segment${selectedSegmentCount === 1 ? "" : "s"}${alternates.length ? `; ${alternates.length} alternate recorded route${alternates.length === 1 ? "" : "s"} shown dimmed` : ""}`
      : hasAnyLine
        ? `${callsign ?? "Selected flight"} world map showing ${routes.length} recorded route${routes.length === 1 ? "" : "s"}; select one to highlight it`
        : "World map waiting for server-returned route segments";
  const baseName = tilesOn ? "World map" : "Schematic base map";
  const banner = synthesisRoute ? `${baseName} · observed-donor synthesis · dotted segments were observed on other recorded routes in this generation.` : hasAnyLine ? `${baseName} · source route geometry` : `${baseName} · no route geometry returned yet.`;
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!tilesOn) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
    if (typeof event.currentTarget.setPointerCapture === "function") event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.startX = event.clientX; drag.startY = event.clientY;
    setView((current) => viewFromPixelDelta(dx, dy, current, stageSize));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };
  const wheelLockRef = useRef(0);
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!tilesOn) return;
    event.preventDefault();
    const nextZoom = clampZoom(view.zoom + (event.deltaY < 0 ? 1 : -1));
    if (nextZoom === view.zoom) return; // at a zoom bound: nothing to do
    // A scroll gesture fires many wheel events; accept at most one zoom
    // level per burst so the map does not slam through the whole range.
    const now = Date.now();
    if (now - wheelLockRef.current < WHEEL_ZOOM_DEBOUNCE_MS) return;
    wheelLockRef.current = now;
    const rect = stageRef.current?.getBoundingClientRect();
    const cursor = rect && rect.width > 0 ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: stageSize.width / 2, y: stageSize.height / 2 };
    setView(viewFromZoomAtPoint(cursor, view, nextZoom, stageSize));
  };
  return <div className={`map-stage ${displayRoute ? "has-selected-route" : ""}`} ref={stageRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel}>
    <div className="map-canvas" role="img" aria-label={label}>
      {tilesOn && <TileLayer view={view} size={stageSize} onTileFailure={() => setTilesFailed(true)} />}
      <svg className="route-svg" viewBox={tilesOn ? `0 0 ${stageSize.width} ${stageSize.height}` : "0 0 800 440"} aria-hidden="true">
        {!tilesOn && <WorldMapBase />}
        {alternates.map(({ route, projection }) => <g key={route.id} className="route-line-alternate">{projection.segments.map((segment, index) => <path key={`alternate-segment-${index}`} d={segment.path} className="route-path-alternate" />)}</g>)}
        {borrowedProjection && <g className="route-line-potential-inferred">{borrowedProjection.segments.map((segment, index) => <path key={`borrowed-segment-${index}`} d={segment.path} className="route-path-potential" />)}</g>}
        {displayRoute && displayProjection && <g className="route-line-selected">{displayProjection.segments.map((segment, index) => <g key={`segment-${index}`}><path d={segment.path} className="route-shadow" filter="url(#glow)" /><path d={segment.path} className="route-path" /></g>)}</g>}
        {projections.map(({ route, projection }) => projection && <g key={`hit-${route.flightId}`} className="route-hit-lines">{projection.segments.map((segment, index) => <path key={`hit-segment-${index}`} d={segment.path} className="route-hit" onClick={(event) => { event.stopPropagation(); chooseProjectedRoute(route, projection); }} />)}</g>)}
        {departurePoint && <MapMarker point={departurePoint} label={departure} tone="origin" />}
        {arrivalPoint && <MapMarker point={arrivalPoint} label={arrival} tone="destination" />}
        {displayProjection?.gapBoundaries.map((point, index) => <g key={`gap-${index}`} className="gap-boundary"><circle cx={point.x} cy={point.y} r="7" /><text x={point.x + 12} y={point.y + 4}>Gap</text></g>)}
      </svg>
    </div>
    {overlapChoices.length > 0 && <section className="map-overlap-chooser" role="dialog" aria-modal="false" aria-label="Choose an overlapping recorded flight"><div><strong>{overlapChoices.length} routes overlap here</strong><button type="button" className="quiet-button" onClick={() => setOverlapChoices([])}>Close</button></div>{overlapChoices.map((route) => <button key={route.flightId} type="button" onClick={() => { setOverlapChoices([]); onSelectRoute(route); }}><strong>{route.callsign}</strong><span>{route.origin} → {route.destination}</span></button>)}</section>}
    <div className="map-fallback-banner"><span className="map-pin">◇</span><span>{banner}</span></div>
    <div className="map-zoom-controls" role="group" aria-label="Map zoom and base layer">
      <button type="button" aria-label="Zoom in" disabled={!tilesOn || view.zoom >= MAX_ZOOM} onClick={() => setView((current) => ({ ...current, zoom: clampZoom(current.zoom + 1) }))}>+</button>
      <button type="button" aria-label="Zoom out" disabled={!tilesOn || view.zoom <= MIN_ZOOM} onClick={() => setView((current) => ({ ...current, zoom: clampZoom(current.zoom - 1) }))}>−</button>
      <button type="button" aria-pressed={tilesOn} onClick={() => { setTilesEnabled((current) => !current); setTilesFailed(false); }}>Toggle base map</button>
    </div>
    {displayRoute && <section className="map-endpoints" aria-label="Route endpoint locations"><div className="map-endpoint departure"><b>Departure</b><span>{departureLabel}</span></div><div className="map-endpoint arrival"><b>Arrival</b><span>{arrivalLabel}</span></div></section>}
    {!hasAnyLine && <div className="map-empty"><span>◎</span><strong>{routes.length ? "No resolved geometry returned" : "No overview routes to display"}</strong><p>{routes.length ? "The world map does not infer a line across missing route data." : "Clear the callsign filter or retry the all-flight overview."}</p></div>}
    <div className="map-attribution">{tilesOn ? OSM_ATTRIBUTION : "Schematic base map only"}</div>
  </div>;
}

function WorldMapBase() {
  return <><defs><filter id="glow"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs><rect className="world-ocean" width="800" height="440" /><g className="world-graticule"><path d="M 0 73 H 800 M 0 147 H 800 M 0 220 H 800 M 0 293 H 800 M 0 367 H 800 M 133 0 V 440 M 267 0 V 440 M 400 0 V 440 M 533 0 V 440 M 667 0 V 440" /></g><g className="world-land"><path d="M 54 91 L 93 58 L 153 37 L 210 51 L 252 83 L 245 109 L 220 118 L 202 151 L 174 163 L 151 146 L 126 157 L 110 137 L 81 128 Z" /><path d="M 239 178 L 267 187 L 281 221 L 279 265 L 266 306 L 246 340 L 232 314 L 236 272 L 218 232 Z" /><path d="M 322 58 L 350 29 L 384 39 L 391 77 L 364 91 Z" /><path d="M 375 89 L 412 68 L 478 74 L 528 57 L 606 76 L 678 99 L 727 128 L 712 154 L 664 157 L 633 180 L 588 174 L 557 193 L 514 176 L 480 189 L 449 171 L 415 178 L 396 147 Z" /><path d="M 424 185 L 470 188 L 494 224 L 482 286 L 447 322 L 417 279 L 405 231 Z" /><path d="M 637 273 L 682 259 L 730 283 L 744 322 L 716 347 L 666 333 L 635 306 Z" /><path d="M 505 294 L 518 308 L 512 332 L 500 325 Z" /></g><g className="world-land island"><path d="M 707 190 L 716 182 L 723 195 L 715 205 Z" /><path d="M 761 221 L 770 228 L 764 243 L 755 236 Z" /><path d="M 164 186 L 175 190 L 176 204 L 166 208 Z" /><path d="M 747 365 L 763 367 L 770 379 L 754 384 L 742 376 Z" /></g></>;
}

function MapMarker({ point, label, tone }: { point: Point; label: string; tone: "origin" | "destination" }) { return <g className={`map-marker marker-${tone}`}><circle cx={point.x} cy={point.y} r="8" /><circle cx={point.x} cy={point.y} r="15" className="marker-ring" /><text x={point.x + 16} y={point.y - 12}>{label}</text></g>; }
type Point = { x: number; y: number };
type ProjectedSegments = { segments: Array<{ path: string }>; start?: Point | undefined; end?: Point | undefined; gapBoundaries: Point[] };
function projectWorldPoint(coordinate: Coordinate): Point { return { x: ((coordinate.lon + 180) / 360) * 800, y: ((90 - coordinate.lat) / 180) * 440 }; }
function projectWorldSegments(segments: Coordinate[][]): ProjectedSegments | undefined {
  const validSegments = segments.filter((segment) => segment.length >= 2);
  if (!validSegments.length) return undefined;
  const project = projectWorldPoint;
  const projected = validSegments.map((segment) => segment.map(project));
  return {
    segments: validSegments.map((segment, segmentIndex) => ({ path: segment.map((coordinate, pointIndex) => {
      const previous = segment[pointIndex - 1];
      const move = pointIndex === 0 || (previous !== undefined && Math.abs(coordinate.lon - previous.lon) > 180);
      const point = projected[segmentIndex]![pointIndex]!;
      return `${move ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    }).join(" ") })),
    start: projected[0]?.[0],
    end: projected.at(-1)?.at(-1),
    gapBoundaries: projected.slice(0, -1).flatMap((segment, index) => projected[index + 1] ? [segment.at(-1)!, projected[index + 1]![0]!] : []),
  };
}

export default App;
