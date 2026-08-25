import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ApiError,
  fetchAlternates,
  fetchReadiness,
  fetchRouteOverview,
  fetchRouteOptions,
  lookupPoint,
  refreshLiveData,
  searchCallsigns,
  validateDraft,
  type AlternateRoute,
  type CallsignMatch,
  type Coordinate,
  type DraftComparison,
  type DraftSelection,
  type GenerationSummary,
  type PointMatch,
  type RouteLeg,
  type RouteOption,
} from "./api";
import {
  ADVISORY_HEADLINE,
  COMPLETE_GROUP_DESCRIPTION,
  COMPLETE_GROUP_TITLE,
  DRAFT_SAFETY_COPY,
  REFRESH_CONFIRM,
  ROUTE_COMPARISON_EXPLANATION,
  SAFETY_NOTICE,
} from "./labels";
import { clampZoom, DEFAULT_SIZE, fitViewToCoordinates, MAX_ZOOM, MIN_ZOOM, OSM_ATTRIBUTION, pixelFromView, projectWorldSegmentsMercator, TILE_SIZE, TileLayer, viewFromPixelDelta, viewFromZoomAtPoint, worldPixel, type MapSize, type TileView } from "./TileMap";
import ApiDataPage from "./ApiDataPage";
import { compareDistanceOperands } from "@flight-route-explorer/route-engine/compare";

type Surface = "none" | "routes" | "route-data" | "editor" | "compare";
// Workbench region label + drawer eyebrow per surface; tests pin these strings
// byte-for-byte, so keep values identical when editing.
const WORKBENCH_SURFACES: Record<Surface, { label: string; eyebrow: string }> = {
  none: { label: "Workbench", eyebrow: "" },
  routes: { label: "Route chooser", eyebrow: "COMPARE RECORDED ROUTES" },
  "route-data": { label: "Flight and route data", eyebrow: "INSPECT ROUTE" },
  editor: { label: "Explore a route variation", eyebrow: "EXPLORE VARIATION" },
  compare: { label: "Route comparison", eyebrow: "COMPARE ROUTES" },
};
type SearchState = { query: string; matches: CallsignMatch[]; loading: boolean; searched: boolean; error?: string | undefined };
const emptySearch: SearchState = { query: "", matches: [], loading: false, searched: false };
// Type-ahead settles this long after the last keystroke; Enter fires a search
// immediately (the timer is cancelled), so Enter flows stay deterministic.
const SEARCH_DEBOUNCE_MS = 250;
// Wheel zoom accepts one level per burst: a scroll gesture fires many wheel
// events, and accepting every one slams the map through the zoom range.
const WHEEL_ZOOM_DEBOUNCE_MS = 350;

/** Tracks a viewport media query so copy can stay honest about which
 *  surfaces are actually visible (the flight manifest is display:none below
 *  1280px, so "map or list" would be a lie on narrower viewports). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const apply = () => setMatches(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [query]);
  return matches;
}

function formatDistance(value: number | undefined): string {
  return value === undefined ? "Not supplied" : `${value.toFixed(1)} NM`;
}

/** Instrument count-up for headline distance figures: rAF from 0 → value over
 * 320ms, re-run on value change, rAF cancelled on unmount/change. Reduced
 * motion (or environments without matchMedia, e.g. jsdom) renders the final
 * value directly. Thousands separator is an ASCII comma (English/Singapore
 * convention) so it renders in every vendored font subset. */
function formatTickValue(value: number): string {
  const fixed = value.toFixed(1);
  if (value < 1000) return fixed;
  const [integer, decimal] = fixed.split(".");
  return `${(integer ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decimal ?? "0"}`;
}

function DistanceTick({ nm }: { nm: number | undefined }) {
  const reducedMotion = typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [display, setDisplay] = useState<number>(nm ?? 0);
  useEffect(() => {
    const target = nm ?? 0;
    if (reducedMotion) { setDisplay(target); return; }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / 320);
      setDisplay(target * progress);
      if (progress < 1) frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [nm, reducedMotion]);
  return <>{nm === undefined ? "Not supplied" : `${formatTickValue(display)} NM`}</>;
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
  GENERATION_STALE: "This dataset has expired. Refresh data to acquire a new snapshot.",
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

function App() {
  const [overview, setOverview] = useState<RouteOption[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string>();
  const [overviewReload, setOverviewReload] = useState(0);
  const [selectedFlight, setSelectedFlight] = useState<CallsignMatch>();
  const [search, setSearch] = useState<SearchState>(emptySearch);
  const [options, setOptions] = useState<RouteOption[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<RouteOption>();
  const [alternates, setAlternates] = useState<AlternateRoute[]>([]);
  const [selectedAlternate, setSelectedAlternate] = useState<AlternateRoute>();
  const [alternateLoading, setAlternateLoading] = useState(false);
  const [alternateError, setAlternateError] = useState<string>();
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
  // The manifest (flight list) is display:none below 1280px, so the "select a
  // route" copy must not promise a list that is not on screen.
  const manifestVisible = useMediaQuery("(min-width: 1280px)");
  const selectRouteCopy = manifestVisible ? "Search a flight number, or select a flight from the list, to see its route." : "Search a flight number, or select a flight on the map, to see its route.";
  const restoreControlsRef = useRef<HTMLButtonElement>(null);
  const apiDataTriggerRef = useRef<HTMLButtonElement>(null);
  const legendKeyRef = useRef<HTMLDetailsElement>(null);

  // Task 9: the legend's Key disclosure stays open at >=761px (summary hidden)
  // so the absolutely-positioned legend is sized by its items; at <=760px it
  // folds natively behind the summary. `mapOnly` is a dependency because Map
  // Only unmounts the legend; leaving it remounts the <details> element closed
  // and the effect must re-run to re-open it at desktop widths (the body is
  // idempotent: toggleAttribute("open", shouldBeOpen)).
  useEffect(() => {
    // Environments without matchMedia (e.g. jsdom) keep the disclosure open.
    if (typeof window.matchMedia !== "function") {
      legendKeyRef.current?.setAttribute("open", "");
      return;
    }
    const media = window.matchMedia("(min-width: 761px)");
    const apply = () => legendKeyRef.current?.toggleAttribute("open", media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mapOnly]);

  // Design §15.2: focus return is deterministic after closing a surface,
  // selecting a route, retrying an error, or leaving Map Only.
  function closeSurface(surface: Surface) {
    setPrimarySurface("none");
    const trigger = surface === "routes" ? routesTriggerRef : surface === "route-data" ? dataTriggerRef : surface === "editor" ? editorTriggerRef : surface === "compare" ? compareTriggerRef : undefined;
    if (trigger) requestAnimationFrame(() => trigger.current?.focus());
  }

  // Escape closes the open workbench surface from anywhere on the page.
  // WebKit does not focus buttons on mouse click, so an aside-level onKeyDown
  // leaves a keyboard dead-end after clicking a spine trigger; a window-level
  // listener closes the gap. defaultPrevented events are skipped so controls
  // that own Escape (search type-ahead, point lookup, overlap chooser) keep
  // their exclusive behaviour.
  useEffect(() => {
    if (primarySurface === "none") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (primarySurface === "editor") resetDraftState();
      closeSurface(primarySurface);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primarySurface]);

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
        const loadMessage = `${result.routes.length} flight${result.routes.length === 1 ? "" : "s"} loaded. This is a refreshed dataset, not real-time tracking.`;
        const prefix = overviewStatusPrefix.current;
        overviewStatusPrefix.current = undefined;
        setStatus(prefix ? `${prefix} ${loadMessage}` : loadMessage);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setOverviewError(apiMessage(error));
        const prefix = overviewStatusPrefix.current;
        overviewStatusPrefix.current = undefined;
        setStatus(prefix ? `${prefix} The refreshed overview could not be loaded.` : "The all-flight overview could not be loaded.");
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
    setAlternates([]);
    setSelectedAlternate(undefined);
    setAlternateError(undefined);
    setSelectedRoute(overview.find((route) => route.flightId === match.flightId));
    setSearch(preserveSearchFilter ? { query: match.callsign, matches: [], loading: false, searched: false } : emptySearch);
    setStatus(`Selected flight ${match.callsign}, departing ${match.departure} for ${match.destination}.`);
  }

  function chooseOverviewRoute(route: RouteOption) {
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

  function clearAlternates() {
    setAlternates([]);
    setSelectedAlternate(undefined);
    setAlternateError(undefined);
    setAlternateLoading(false);
  }

  async function loadAlternates(route: RouteOption) {
    clearAlternates();
    setAlternateLoading(true);
    try {
      const candidates = await fetchAlternates(route.flightId);
      setAlternates(candidates);
      setSelectedAlternate(candidates[0]);
    } catch (error) {
      setAlternateError(apiMessage(error));
    } finally {
      setAlternateLoading(false);
    }
  }

  function selectAlternate(candidate: AlternateRoute) {
    setSelectedAlternate(candidate);
    setAlternateError(undefined);
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
        // The selected route is the flight's own recorded route, complete or
        // not; comparison options stay complete-only. Prefer the options
        // projection (same token) and fall back to the overview entry.
        const synchronized = result.options.find((route) => route.flightId === selectedFlight.flightId)
          ?? overview.find((route) => route.flightId === selectedFlight.flightId);
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
    setStatus("Refreshing the dataset. The current selection will be cleared.");
    try {
      const result = await refreshLiveData();
      setGeneration(result.generation);
      setReadinessError(undefined);
      resetAll();
      // The refresh clears every selection: an open drawer would otherwise
      // stay on screen holding an empty or stale surface for the new
      // generation (e.g. an editor panel with no selected route).
      setPrimarySurface("none");
      setOverview([]);
      const refreshMessage = `Data refreshed at ${formatRetrievedAt(result.generation.retrievedAt)}; selection cleared. This is not real-time tracking.`;
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

  return (
    <div className="app-shell map-first-shell dispatch-shell">
      {!mapOnly && <header className="command-strip" aria-label="Command strip">
        {page === "map" && <a className="skip-link" href="#flight-search">Skip to flight search</a>}
        <div className="product-mark"><p className="eyebrow">FLIGHT ROUTE EXPLORER</p><h1>Flight routes</h1></div>
        {page === "map" && <div className="toolbar-search"><SearchBox selected={selectedFlight} state={search} onFocus={() => undefined} onQuery={updateQuery} onSearch={() => void runSearch()} onSelect={(match) => chooseFlight(match, true)} onCancelSearch={cancelSearch} /></div>}
        <div className={`toolbar-flight ${selectedFlight ? "has-selection" : ""}`} role="group" aria-label="Selected flight">
          {selectedFlight ? <><div className="selected-route-label"><span className="selection-kicker">SELECTED ROUTE</span><strong>{selectedFlight.callsign}</strong></div><div className="selected-route-endpoints">{selectedFlight.departure} → {selectedFlight.destination}</div><div className="selected-route-distance">{selectedRoute?.complete ? <DistanceTick nm={selectedRoute.distanceNm} /> : `${selectedRoute?.gaps.length ?? 0} unresolved gap${(selectedRoute?.gaps.length ?? 0) === 1 ? "" : "s"} · distance unavailable`}</div><div className="alternate-controls">{alternates.length > 0 ? <><div className="alternate-options" role="group" aria-label="Alternate routes">{alternates.map((candidate) => <button key={`${candidate.kind}-${candidate.label}`} type="button" className={`alternate-option${selectedAlternate && selectedAlternate.kind === candidate.kind && selectedAlternate.label === candidate.label ? " is-active" : ""}`} aria-pressed={selectedAlternate?.kind === candidate.kind && selectedAlternate?.label === candidate.label} onClick={() => selectAlternate(candidate)}><span className="alternate-option-label">{candidate.label}</span><span className="alternate-option-distance">{formatDistance(candidate.distanceNm)} NM</span></button>)}</div><button className="quiet-button" type="button" onClick={clearAlternates}>Hide alternates</button></> : <button className="quiet-button" type="button" disabled={!selectedRoute || alternateLoading} onClick={() => { if (selectedRoute) void loadAlternates(selectedRoute); }}>{alternateLoading ? "Computing alternates…" : "Show alternates"}</button>}{selectedAlternate && <span className="alternate-distance" aria-label={`Selected alternate distance ${formatDistance(selectedAlternate.distanceNm)}`}>{selectedAlternate.label} · {formatDistance(selectedAlternate.distanceNm)} NM</span>}{alternateError && <span className="refresh-error" role="alert">{alternateError}</span>}</div></> : <span>{overviewLoading ? "Loading the all-flight overview…" : `${filteredOverview.length} flight${filteredOverview.length === 1 ? "" : "s"} available. ${selectRouteCopy}`}</span>}
        </div>
        {(generation || refreshError || readinessError) && (
          <div className="strip-gen" role="region" aria-label="Data controls">
            {(refreshError || readinessError) && <span className="refresh-error" role="alert">{refreshError ?? readinessError}</span>}
            <span className="gen-stamp machine-code" title="When the current dataset was retrieved">{generation ? `Data as of ${formatRetrievedAt(generation.retrievedAt)}` : "Data as of —"}</span>
            <button className="quiet-button" type="button" onClick={() => void runRefresh()} disabled={refreshing} title="Fetch a fresh dataset">{refreshing ? "Refreshing…" : "Refresh data"}</button>
          </div>
        )}
        <nav className="strip-pages" aria-label="View">
          <button ref={mapOnlyTriggerRef} className="quiet-button toolbar-map-action" type="button" onClick={enterMapOnly} disabled={page !== "map"} aria-pressed={mapOnly} title="Show the map only">Map only</button>
          <button className="quiet-button toolbar-clear" ref={apiDataTriggerRef} type="button" aria-pressed={page === "api-data"} onClick={() => { setPage("api-data"); requestAnimationFrame(() => document.getElementById("api-data-heading")?.focus()); }} title="Browse the data behind the app">API data</button>
          <button className="quiet-button toolbar-clear" type="button" onClick={() => { setPrimarySurface("none"); resetAll(); }} title="Reset the current selection">Clear session</button>
        </nav>
      </header>}
      <div className="safety-banner advisory-band" role="region" aria-label="Safety notice"><strong><span aria-hidden="true">⚠</span> Advisory</strong><span>{ADVISORY_HEADLINE}</span><details className="advisory-details"><summary tabIndex={-1}>Read advisory</summary><p>{SAFETY_NOTICE}</p></details></div>

      {page === "api-data" ? <main className="briefing-frame api-frame"><ApiDataPage selectedFlight={selectedFlight} selectedRoute={selectedRoute} onBack={() => { setPage("map"); requestAnimationFrame(() => apiDataTriggerRef.current?.focus()); }} /></main> : <main className={`briefing-frame ${mapOnly ? "no-workbench" : ""} ${!mapOnly && primarySurface === "none" ? "workbench-closed" : ""}`}>
        {mapOnly && <h1 className="sr-only">Map-first route comparison</h1>}
        {!mapOnly && <aside className="manifest" aria-label="Flight manifest">
          <FlightOverviewList routes={filteredOverview} total={overview.length} selected={selectedRoute} loading={overviewLoading} error={overviewError} onRetry={() => setOverviewReload((current) => current + 1)} onSelect={chooseOverviewRoute} />
        </aside>}
        <section className="map-panel map-first-panel map-cell" aria-labelledby="map-heading">
          <h2 className="sr-only" id="map-heading" tabIndex={-1}>Global route map</h2>
          <RouteMap routes={filteredOverview} selectedRoute={selectedRoute} alternateGeometry={selectedAlternate?.geometry} alternateLabel={selectedAlternate?.label} callsign={selectedFlight?.callsign} overviewFailed={Boolean(overviewError)} onSelectRoute={chooseOverviewRoute} />
          <div className="map-hud">{selectedRoute ? <><span className="eyebrow">SELECTED ROUTE</span><strong>{selectedRoute.label ?? selectedFlight?.callsign ?? "Selected route"}</strong><span>{selectedRoute.complete ? <DistanceTick nm={selectedRoute.distanceNm} /> : `${selectedRoute.gaps.length} unresolved gap${selectedRoute.gaps.length === 1 ? "" : "s"} · recorded distance unavailable`}</span></> : <><span className="eyebrow">ROUTE OVERVIEW</span><strong>{overviewLoading ? "Loading routes…" : `${filteredOverview.length} of ${overview.length} routes shown`}</strong><span>{overviewError ?? `Refreshed dataset, not real-time tracking. ${selectRouteCopy}`}</span></>}</div>
          {!mapOnly && selectedRoute && primarySurface !== "route-data" && <div className="map-left-stack"><RouteLegPanel route={selectedRoute} /></div>}
          {mapOnly && <button ref={restoreControlsRef} className="restore-controls" type="button" onClick={leaveMapOnly} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); leaveMapOnly(); } }}>Restore controls</button>}
          {!mapOnly && <div className="map-legend" role="group" aria-label="Map legend"><details ref={legendKeyRef} className="legend-key"><summary>Key</summary><span><i className="legend-line" /> Recorded route</span><span><i className="legend-line legend-line-alt" /> Other recorded routes</span><span><i className="legend-line legend-line-direct-alt" /> Direct alternate (great-circle)</span><span><i className="legend-gap" /> Unresolved gap (missing waypoint)</span><span><i className="legend-dot legend-origin" /> Departure</span><span><i className="legend-dot legend-destination" /> Arrival</span></details></div>}
        </section>
        {!mapOnly && <aside className={`workbench ${primarySurface !== "none" ? "is-open" : ""}`}>
          <nav className="workbench-spine" aria-label="Route workspace controls">
            <div className="rail-entry">
              <button ref={routesTriggerRef} type="button" aria-pressed={primarySurface === "routes"} onClick={() => setPrimarySurface((surface) => surface === "routes" ? "none" : "routes")} disabled={!selectedFlight}>Routes</button>
              {options.length > 1 && <span className="toolbar-count rail-count" aria-hidden="true">{options.length}</span>}
            </div>
            <button ref={dataTriggerRef} type="button" aria-pressed={primarySurface === "route-data"} onClick={() => setPrimarySurface((surface) => surface === "route-data" ? "none" : "route-data")} disabled={!selectedRoute}>Data</button>
            <button ref={compareTriggerRef} type="button" aria-pressed={primarySurface === "compare"} onClick={() => setPrimarySurface((surface) => surface === "compare" ? "none" : "compare")} disabled={!selectedRoute || options.length < 2}>Compare</button>
            <button ref={editorTriggerRef} type="button" aria-pressed={primarySurface === "editor"} onClick={() => { if (!selectedRoute) return; setDraftActive(true); setPrimarySurface("editor"); void updateDraft([]); }} disabled={!selectedRoute}>Explore variation</button>
          </nav>
          <div className="map-drawer workbench-panel" role="region" aria-label={WORKBENCH_SURFACES[primarySurface].label}>
            {primarySurface === "none" && <div className="workbench-empty"><span aria-hidden="true">⌖</span><strong>NO PANEL OPEN</strong><p>Select a route, then open Routes, Data, Compare, or Explore variation.</p></div>}
            {primarySurface !== "none" && <div className="drawer-header"><p className="eyebrow">{WORKBENCH_SURFACES[primarySurface].eyebrow}</p><button className="quiet-button" type="button" onClick={() => { if (primarySurface === "editor") resetDraftState(); closeSurface(primarySurface); }}>Close</button></div>}
            {primarySurface === "routes" && <RouteOptions options={options} selected={selectedRoute} loading={routeLoading} error={routeError} onRetry={() => { setRouteReload((current) => current + 1); requestAnimationFrame(() => document.getElementById("options-heading")?.focus()); }} onSelect={(option) => { resetDraftState(); chooseOverviewRoute(option); setStatus(`Selected flight ${option.callsign} from the neutral route comparison.`); closeSurface("routes"); }} />}
            {primarySurface === "compare" && selectedRoute && <RouteCompare baseline={selectedRoute} options={options} onSelect={(option) => { chooseOverviewRoute(option); setStatus(`Comparing ${selectedRoute.label ?? "route"} with ${option.label ?? "route option"}.`); }} />}
            {primarySurface === "route-data" && selectedRoute && <><RouteLegPanel route={selectedRoute} /><RouteDetails route={selectedRoute} onStartDraft={() => { setDraftActive(true); setPrimarySurface("editor"); void updateDraft([]); requestAnimationFrame(() => document.getElementById("draft-heading")?.focus()); }} /></>}
            {primarySurface === "editor" && selectedRoute && draftActive && <DraftEditor draft={draft} baseline={selectedRoute} loading={draftLoading} error={draftError} onUpdate={(via, selections) => void updateDraft(via, selections)} onClose={() => { resetDraftState(); closeSurface("editor"); }} />}
          </div>
        </aside>}
      </main>}
      <footer className="doc-control-footer"><span>SPEC-FRE-002</span><span>REV C</span><span className="footer-asof">DATA AS OF {generation?.retrievedAt ? formatRetrievedAt(generation.retrievedAt) : "—"}</span></footer>
      <div className="sr-status" role="status" aria-live="polite">{routeLoading ? "Loading route options." : status}</div>
    </div>
  );
}

function FlightOverviewList({ routes, total, selected, loading, error, onRetry, onSelect }: { routes: RouteOption[]; total: number; selected?: RouteOption | undefined; loading: boolean; error?: string | undefined; onRetry: () => void; onSelect: (route: RouteOption) => void }) {
  return <section className="flight-overview-list" aria-label="Full flight list">
    <div className="overview-list-heading"><div><span className="eyebrow">ALL FLIGHTS</span><strong>{routes.length} of {total}</strong></div></div>
    {loading && <div className="loading-row"><span className="spinner dark" /> Loading all route pages…</div>}
    {error && <div className="notice error-notice" role="alert"><span>{error}</span><button className="retry-button" type="button" onClick={onRetry}>Retry overview</button></div>}
    {!loading && !error && routes.length === 0 && <p className="muted-copy">No flights match the current filter.</p>}
    <div className="overview-flight-buttons">
      {routes.map((route) => {
        const complete = isCompleteRoute(route);
        return <button key={route.flightId} type="button" className={`${selected?.flightId === route.flightId ? "selected" : ""} ${complete ? "" : "has-gap"}`} aria-current={selected?.flightId === route.flightId ? "true" : undefined} onClick={() => onSelect(route)}>
          <span><strong>{route.callsign}</strong><small>{route.origin ?? "Unknown departure"} → {route.destination ?? "Unknown destination"} · {complete ? "Complete route" : `${route.gaps.length} visible gap${route.gaps.length === 1 ? "" : "s"}`}</small></span>
          <span>{complete ? formatDistance(route.distanceNm) : "Incomplete"}</span>
        </button>;
      })}
    </div>
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
        }} aria-expanded={hasResults} aria-controls={hasResults ? resultId : undefined} aria-activedescendant={activeIndex >= 0 ? `flight-match-${activeIndex}` : undefined} aria-autocomplete="list" placeholder="For example: SIA451" autoComplete="off" />
        <button className="search-button" type="button" onClick={onSearch} disabled={state.loading || !state.query.trim()} aria-label="Search flight plans">{state.loading ? <span className="spinner" /> : "Search"}</button>
      </div>
      {selected && <p className="selected-value"><span className="check">✓</span> Selected <strong>{selected.callsign}</strong> <span>{selected.departure} → {selected.destination}</span></p>}
      {state.error && <p className="field-error" role="alert">{state.error}</p>}
      {hasResults && <div className="duplicate-picker"><p className="picker-label">{state.matches.length > 1 ? `${state.matches.length} flight plans match — choose one` : "Flight-plan match"}</p><div id={resultId} role="listbox" aria-label="Choose an exact flight-plan match">{state.matches.map((match, index) => <div className={`match-option ${activeIndex === index ? "is-active" : ""}`} id={`flight-match-${index}`} role="option" aria-selected={activeIndex === index} key={match.id} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => select(match)}><span><strong>{match.callsign}</strong><small>{match.departure} → {match.destination} · {match.routePointCount > 0 ? `${match.routePointCount} recorded points` : "no route recorded"}</small></span><span aria-hidden="true">›</span></div>)}</div></div>}
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
      <div className="metric-grid"><Metric chip label="Change from selected route" value={delta === undefined ? "Unavailable" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} NM`} note={percentage !== undefined ? `Directed baseline → target · ${percentage >= 0 ? "+" : ""}${percentage.toFixed(1)}%` : "Directed baseline → target"} /></div>
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

function Metric({ label, value, note, chip }: { label: string; value: string; note?: string; chip?: boolean }) { return <div className="metric"><span>{label}</span>{chip ? <strong><span className="delta-chip">{value}</span></strong> : <strong>{value}</strong>}{note && <small>{note}</small>}</div>; }
function Evidence({ label, value, tone }: { label: string; value: string; tone: "blue" | "amber" | "red" | "green" }) { return <div className={`evidence evidence-${tone}`}><span>{label}</span><p>{value}</p></div>; }

function RouteTable({ legs }: { legs: RouteLeg[] }) {
  return legs.length ? <div className="table-scroll" role="group" tabIndex={0} aria-label="Scrollable route-leg table"><table aria-labelledby="route-legs-heading"><caption className="sr-only">Structured route legs and unresolved gaps</caption><thead><tr><th scope="col">Sequence</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Airway</th><th scope="col">Distance</th><th scope="col">Status</th></tr></thead><tbody>{legs.map((leg, index) => {
    const isGap = leg.status === "gap" || leg.kind === "gap" || !leg.from || !leg.to;
    return <tr className={isGap ? "gap-row" : undefined} key={leg.id}><th scope="row">{index + 1}</th>{isGap ? <td colSpan={3}><strong>Unresolved gap</strong><span className="gap-reason">{leg.reason ?? "The route service did not resolve this segment."}</span></td> : <><td>{leg.from}</td><td>{leg.to}</td><td>{leg.airway ? <span className="airway-badge" title={leg.airwayType ?? "airway"}>{leg.airway}</span> : "—"}</td></>}<td>{formatDistance(leg.distanceNm)}</td><td>{isGap ? "gap" : leg.status ?? "resolved"}</td></tr>;
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
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMatches([]); setLookupError(undefined); setActiveIndex(-1); }
    }} aria-expanded={hasMatches} aria-controls={hasMatches ? matchResultsId : undefined} aria-activedescendant={activeIndex >= 0 ? `draft-match-${activeIndex}` : undefined} aria-autocomplete="list" maxLength={64} placeholder="Search an exact fix, NAVAID, or airport" autoComplete="off" /><button className="search-button" type="button" onClick={() => void findReference()} disabled={lookupLoading || !query.trim()} aria-label="Find exact reference point">{lookupLoading ? <span className="spinner" /> : "Find"}</button></div>{lookupError && <p className="field-error" role="alert">{lookupError}</p>}<div className="sr-status" role="status" aria-live="polite">{lookupLoading ? "Looking up exact reference points." : matches.length ? `${matches.length} exact reference point${matches.length === 1 ? "" : "s"} available.` : ""}</div>
      {hasMatches && <div className="reference-picker" id={matchResultsId} role="listbox" aria-label="Resolved reference-point search results">{matches.map((match, index) => <div role="option" id={`draft-match-${index}`} aria-selected={activeIndex === index} className={activeIndex === index ? "is-active" : undefined} tabIndex={-1} key={`${match.identifier}-${match.coordinate.lat}-${match.coordinate.lon}`} onMouseDown={(event) => event.preventDefault()} onClick={() => commitMatch(match)}><span><strong>{match.identifier}</strong>{match.kind && <span className="kind-badge" aria-hidden="true">{match.kind}</span>}<small>{match.kind} · {match.coordinate.lat.toFixed(4)}, {match.coordinate.lon.toFixed(4)}{match.duplicateGroup ? " · multiple exact coordinates" : ""}</small></span><span>{match.duplicateGroup ? "Choose exact location" : "Add"}</span></div>)}</div>}
    </div>
    <div className="draft-points"><div className="group-heading"><h3>Intermediate points</h3><button className="text-button" type="button" onClick={() => commitUpdate([], [])} disabled={!via.length || loading}>Reset to endpoint-only draft</button></div>{via.length ? <ol role="list">{via.map((point, index) => <li key={`${point}-${index}`}><span><strong>{point}</strong><small>{selectedAt(index) ? "Exact coordinate selected from the ambiguous group." : "Manual-direct segments are not airways."}</small></span><span className="draft-row-actions"><button type="button" onClick={() => commitUpdate(via.map((value, position) => position === index - 1 ? point : position === index ? via[index - 1]! : value), remapMove(index, -1))} disabled={loading || index === 0} aria-label={`Move ${point} up`}>↑</button><button type="button" onClick={() => commitUpdate(via.map((value, position) => position === index + 1 ? point : position === index ? via[index + 1]! : value), remapMove(index, 1))} disabled={loading || index === via.length - 1} aria-label={`Move ${point} down`}>↓</button><button type="button" onClick={() => commitUpdate(via.filter((_, position) => position !== index), remapRemove(index))} disabled={loading} aria-label={`Remove ${point}`}>✕</button></span></li>)}</ol> : <p className="muted-copy">No intermediate points. This draft uses a direct modeled endpoint-to-endpoint segment.</p>}</div>
    {loading && <div className="loading-row"><span className="spinner dark" /> Validating the local draft…</div>}{error && <div className="notice error-notice" role="alert"><span>{error}</span><button className="retry-button" type="button" onClick={() => { commitUpdate(via, selections); requestAnimationFrame(() => document.getElementById("draft-heading")?.focus()); }} disabled={loading}>Retry draft validation</button></div>}
    {draft && <div className="draft-result"><Metric label="Draft status" value={draft.comparison.status === "complete" ? "Complete" : "Incomplete"} /><Metric label="Modeled distance" value={formatDistance(draft.route.distanceNm)} /><Metric label="Change from selected route" value={delta === undefined ? "Unavailable" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} NM`} note={percentage !== undefined ? `Directed baseline → target · ${percentage >= 0 ? "+" : ""}${percentage.toFixed(1)}%` : "Directed baseline → target"} /><Metric label="Draft gaps" value={String(draft.route.gaps.length)} note={draft.comparison.message} /></div>}
  </section>;
}

type EndpointLocation = Pick<PointMatch, "coordinate" | "name">;

function endpointReference(label: string): string {
  return /\(([A-Z]{4})\)$/.exec(label)?.[1] ?? label;
}

function RouteMap({ routes, selectedRoute, alternateGeometry, alternateLabel, callsign, overviewFailed, onSelectRoute }: { routes: RouteOption[]; selectedRoute?: RouteOption | undefined; alternateGeometry?: Coordinate[] | undefined; alternateLabel?: string | undefined; callsign?: string | undefined; overviewFailed?: boolean | undefined; onSelectRoute: (route: RouteOption) => void }) {
  const [overlapChoices, setOverlapChoices] = useState<RouteOption[]>([]);
  const overlapCloseRef = useRef<HTMLButtonElement>(null);
  const overlapOpen = overlapChoices.length > 0;
  // The chooser opens from an SVG hit-line click that carries no focusable
  // target: move focus into the dialog (onto Close, the first focusable
  // control) so keyboard users can act on it, and let Escape dismiss it like
  // every other transient surface.
  useEffect(() => {
    if (overlapOpen) requestAnimationFrame(() => overlapCloseRef.current?.focus());
  }, [overlapOpen]);
  // Closing the chooser unmounts whichever button held focus; return focus to
  // the map heading so keyboard users are not dropped to the body (webkit)
  // or left on a ghost position (chromium).
  const closeOverlapChooser = () => {
    setOverlapChoices([]);
    requestAnimationFrame(() => document.getElementById("map-heading")?.focus());
  };
  const [endpoints, setEndpoints] = useState<{ departure?: EndpointLocation | undefined; arrival?: EndpointLocation | undefined }>({});
  const [view, setView] = useState<TileView>({ lat: 20, lon: 0, zoom: 2 });
  const [tilesEnabled, setTilesEnabled] = useState(true);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [stageSize, setStageSize] = useState<MapSize>(DEFAULT_SIZE);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; captured?: boolean } | null>(null);
  const [hovered, setHovered] = useState<{ route: RouteOption; x: number; y: number } | undefined>(undefined);
  const tilesOn = tilesEnabled && !tilesFailed;

  useEffect(() => {
    const measure = () => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) setStageSize({ width: rect.width, height: rect.height });
    };
    measure();
    window.addEventListener("resize", measure);
    // The docked workbench opening/closing resizes the stage without any
    // window resize, so observe the element itself, not just the viewport.
    const observer = typeof window !== "undefined" && "ResizeObserver" in window ? new window.ResizeObserver(measure) : undefined;
    if (observer && stageRef.current) observer.observe(stageRef.current);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
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
  const displayRoute = selectedRoute;
  // Draw-on lifecycle: .is-drawing runs the stroke-draw keyframes once per
  // displayed flight; the 460ms timeout (animation is 420ms) removes the
  // class so steady-state computed stroke-dasharray returns to `none`.
  const [drawing, setDrawing] = useState(false);
  useEffect(() => {
    const flightId = displayRoute?.flightId;
    if (!flightId) return;
    setDrawing(true);
    const timer = window.setTimeout(() => setDrawing(false), 460);
    return () => window.clearTimeout(timer);
  }, [displayRoute?.flightId]);
  const displayProjection = useMemo(() => {
    if (!displayRoute) return undefined;
    const sourceSegments = displayRoute.segments ?? (displayRoute.geometry ? [displayRoute.geometry] : []);
    return tilesOn ? projectWorldSegmentsMercator(sourceSegments, view, stageSize) : projectWorldSegments(sourceSegments);
  }, [displayRoute, tilesOn, view, stageSize]);
  const alternates = projections.flatMap(({ route, projection }) => route.flightId !== displayRoute?.flightId && projection && projection.segments.length ? [{ route, projection }] : []);
  // Chart-room graticule: every 10° meridian/parallel crossing the current
  // Mercator view, projected to stage pixels for the overlay lines + edge labels.
  const graticule = useMemo(() => {
    const scale = TILE_SIZE * 2 ** view.zoom;
    const center = worldPixel(view.lat, view.lon, view.zoom);
    const verticals: Array<{ lon: number; x: number }> = [];
    const start = Math.ceil((((view.lon - 180) % 360) + 360) % 360 / 10) * 10;
    // 36 meridians span exactly 360°; when the stage is wider than one world
    // at low zoom, wrapped copies of each meridian fill the repeat.
    for (let index = 0; index < 36; index += 1) {
      const lon = ((start + index * 10) % 360 + 360) % 360 - 180;
      let dx = worldPixel(view.lat, lon, view.zoom).x - center.x;
      if (dx > scale / 2) dx -= scale;
      if (dx < -scale / 2) dx += scale;
      const firstCopy = (((stageSize.width / 2 + dx) % scale) + scale) % scale;
      for (let copyX = firstCopy; copyX <= stageSize.width; copyX += scale) verticals.push({ lon, x: copyX });
    }
    const horizontals: Array<{ lat: number; y: number }> = [];
    for (let lat = -80; lat <= 80; lat += 10) {
      const y = stageSize.height / 2 + (worldPixel(lat, view.lon, view.zoom).y - center.y);
      if (y >= 0 && y <= stageSize.height) horizontals.push({ lat, y });
    }
    return { verticals, horizontals };
  }, [view, stageSize]);
  // Scale bar: the largest listed ground distance that still fits ≤160px at the
  // current meters-per-pixel, labelled in kilometres.
  const scaleBar = useMemo(() => {
    const metersPerPixel = 156543.03392 * Math.cos(view.lat * Math.PI / 180) / 2 ** view.zoom;
    let step = 50;
    let px = step / metersPerPixel;
    for (const meters of [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000]) {
      const candidate = meters / metersPerPixel;
      if (candidate <= 160) { step = meters; px = candidate; }
    }
    return { px, label: step < 1000 ? `${step} m` : `${step / 1000} km` };
  }, [view]);
  // A genuine computed direct great-circle alternate returned by the API;
  // drawn as a distinct dashed line and never generated client-side.
  const alternateProjection = useMemo(() => {
    if (!alternateGeometry || alternateGeometry.length < 2) return undefined;
    return tilesOn ? projectWorldSegmentsMercator([alternateGeometry], view, stageSize) : projectWorldSegments([alternateGeometry]);
  }, [alternateGeometry, tilesOn, view, stageSize]);
  function chooseProjectedRoute(route: RouteOption, projection: ProjectedSegments) {
    const signature = projection.segments.map((segment) => segment.path).join("|");
    const overlaps = projections.flatMap((candidate) => candidate.projection?.segments.map((segment) => segment.path).join("|") === signature ? [candidate.route] : []);
    if (overlaps.length > 1) setOverlapChoices(overlaps);
    else onSelectRoute(route);
  }
  const hasLine = Boolean(displayProjection?.segments.length);
  const alternateHasLine = Boolean(alternateProjection?.segments.length);
  const hasAnyLine = hasLine || alternates.length > 0 || alternateHasLine;
  const displayEndpoints = selectedRoute ? endpoints : {};
  const departure = displayRoute?.origin ?? "Not supplied";
  const arrival = displayRoute?.destination ?? "Not supplied";

  useEffect(() => {
    const controller = new AbortController();
    const exact = (matches: PointMatch[]): EndpointLocation | undefined => {
      const unique = matches.filter((match) => !match.duplicateGroup);
      return unique.length === 1 ? unique[0] : undefined;
    };
    // A new selection starts from a clean slate: the previous route's resolved
    // endpoint pins must never linger on the map (or under the new route's
    // identity) while the fresh lookups are still on the wire.
    setEndpoints({});
    if (!selectedRoute?.origin && !selectedRoute?.destination) { return () => controller.abort(); }
    void Promise.all([
      selectedRoute?.origin ? lookupPoint(endpointReference(selectedRoute.origin), controller.signal).then((result) => exact(result.matches)).catch(() => undefined) : Promise.resolve(undefined),
      selectedRoute?.destination ? lookupPoint(endpointReference(selectedRoute.destination), controller.signal).then((result) => exact(result.matches)).catch(() => undefined) : Promise.resolve(undefined),
    ]).then(([departurePoint, arrivalPoint]) => {
      if (!controller.signal.aborted) setEndpoints({ departure: departurePoint, arrival: arrivalPoint });
    });
    return () => controller.abort();
  }, [selectedRoute?.id, selectedRoute?.origin, selectedRoute?.destination]);

  useEffect(() => {
    if (!displayRoute) return;
    const sourceSegments = displayRoute.segments ?? (displayRoute.geometry ? [displayRoute.geometry] : []);
    // The fit bounds every drawn line: the selected route, the dimmed
    // alternates, the direct great-circle alternate, and the endpoint pins, so
    // nothing on the map is clipped after a selection.
    const alternateSegments = routes
      .filter((route) => isCompleteRoute(route) && route.flightId !== displayRoute.flightId)
      .flatMap((route) => route.segments ?? (route.geometry ? [route.geometry] : []));
    const coordinates = [
      ...sourceSegments.flat(),
      ...alternateSegments.flat(),
    ];
    if (endpoints.departure) coordinates.push(endpoints.departure.coordinate);
    if (endpoints.arrival) coordinates.push(endpoints.arrival.coordinate);
    const fitted = fitViewToCoordinates(coordinates, stageSize);
    if (fitted) setView(fitted);
    // tilesOn is intentionally not a dependency: the Mercator view drives tile
    // mode only, and toggling the base map must not reset the user's pan/zoom.
  }, [routes, displayRoute, endpoints, stageSize.width, stageSize.height]);

  const projectPoint = (coordinate: Coordinate): Point => tilesOn ? pixelFromView(coordinate, view, stageSize) : projectWorldPoint(coordinate);
  const departurePoint = displayEndpoints.departure ? projectPoint(displayEndpoints.departure.coordinate) : undefined;
  const arrivalPoint = displayEndpoints.arrival ? projectPoint(displayEndpoints.arrival.coordinate) : undefined;
  // The route DTO usually carries the canonical "Name (ICAO)" label for both
  // endpoints; when it is only a bare code (fixture/edge case), enrich it with
  // the looked-up airport name. The separate endpoint lookup also supplies the
  // map-pin coordinates.
  const hasIcaoCode = (value: string) => /\([A-Z0-9]{3,5}\)$/.test(value);
  const departureLabel = hasIcaoCode(departure) ? departure : (displayEndpoints.departure?.name ? `${displayEndpoints.departure.name} (${departure})` : departure);
  const arrivalLabel = hasIcaoCode(arrival) ? arrival : (displayEndpoints.arrival?.name ? `${displayEndpoints.arrival.name} (${arrival})` : arrival);
  const selectedSegmentCount = displayProjection?.segments.length ?? 0;
  const label = hasLine
    ? `${callsign ?? "Selected flight"} world map showing ${departureLabel} departure and ${arrivalLabel} arrival with ${selectedSegmentCount} resolved segment${selectedSegmentCount === 1 ? "" : "s"}${alternates.length ? `; ${alternates.length} alternate recorded route${alternates.length === 1 ? "" : "s"} shown dimmed` : ""}`
    : hasAnyLine
      ? `${callsign ?? "Selected flight"} world map showing ${routes.length} recorded route${routes.length === 1 ? "" : "s"}; select one to highlight it`
      : "World map waiting for server-returned route segments";
  const baseName = tilesOn ? "World map" : "Schematic base map";
  const banner = hasAnyLine ? `${baseName} · route geometry` : `${baseName} · no route geometry returned yet.`;
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!tilesOn) return;
    // Interactive controls inside the stage (zoom buttons, base-map toggle,
    // overlap chooser) must keep their native click. Capturing the pointer on
    // the stage would retarget pointerup/click to the stage and swallow the
    // control activation, so drags only begin on the map surface itself.
    if (event.target instanceof Element && event.target.closest("button, a, input, select, textarea, [role='dialog']")) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
    // Pointer capture is deferred until the drag actually moves (see
    // onPointerMove): capturing on pointerdown retargets the click event to
    // the stage and swallows route-selection clicks on the SVG hit lines.
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // A move with no button held is hover, never a drag. A press released
    // outside the stage before capture was acquired never delivers pointerup
    // here; drop that stale state instead of panning on bare hover.
    if (event.buttons === 0) { dragRef.current = null; return; }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) < 3) return;
    if (!drag.captured && typeof event.currentTarget.setPointerCapture === "function") {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
      drag.captured = true;
    }
    drag.startX = event.clientX; drag.startY = event.clientY;
    setView((current) => viewFromPixelDelta(dx, dy, current, stageSize));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };
  // A press that leaves the stage before capture was acquired releases its
  // pointerup on whatever element now owns the pointer, so the stage never
  // hears it. Drop that uncaptured drag here; while capture is held the
  // pointer never leaves (events stay retargeted to the stage), so an
  // in-flight captured drag is untouched.
  const onPointerLeave = () => {
    if (dragRef.current && !dragRef.current.captured) dragRef.current = null;
  };
  const wheelLockRef = useRef(0);
  // React registers wheel listeners as passive, where preventDefault is a
  // no-op that spams console errors and lets the page scroll mid-zoom. Attach
  // a native non-passive listener to the stage instead.
  const wheelStateRef = useRef({ tilesOn, view, stageSize });
  wheelStateRef.current = { tilesOn, view, stageSize };
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      const { tilesOn: on, view: currentView, stageSize: size } = wheelStateRef.current;
      if (!on) return;
      event.preventDefault();
      const nextZoom = clampZoom(currentView.zoom + (event.deltaY < 0 ? 1 : -1));
      if (nextZoom === currentView.zoom) return; // at a zoom bound: nothing to do
      // A scroll gesture fires many wheel events; accept at most one zoom
      // level per burst so the map does not slam through the whole range.
      const now = Date.now();
      if (now - wheelLockRef.current < WHEEL_ZOOM_DEBOUNCE_MS) return;
      wheelLockRef.current = now;
      const rect = stage.getBoundingClientRect();
      const cursor = rect.width > 0 ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: size.width / 2, y: size.height / 2 };
      setView(viewFromZoomAtPoint(cursor, currentView, nextZoom, size));
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, []);
  return <div className={`map-stage ${displayRoute ? "has-selected-route" : ""}`} ref={stageRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onPointerLeave}>
    <div className="map-canvas" role="img" aria-label={label}>
      {tilesOn && <TileLayer view={view} size={stageSize} onTileFailure={() => setTilesFailed(true)} />}
      <svg className="route-svg" viewBox={tilesOn ? `0 0 ${stageSize.width} ${stageSize.height}` : "0 0 800 440"} aria-hidden="true">
        <defs><pattern id="gap-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="transparent" /><line x1="0" y1="0" x2="0" y2="6" /></pattern></defs>
        {!tilesOn && <WorldMapBase />}
        {tilesOn && <g className="map-graticule-tile">{graticule.verticals.map((v) => <line key={`gv-${v.lon}-${Math.round(v.x)}`} x1={v.x} y1={0} x2={v.x} y2={stageSize.height} />)}{graticule.horizontals.map((h) => <line key={`gh-${h.lat}`} x1={0} y1={h.y} x2={stageSize.width} y2={h.y} />)}</g>}
        {alternates.map(({ route, projection }) => <g key={route.id} className={`route-line-alternate${hovered?.route.flightId === route.flightId ? " route-line-hover" : ""}`}>{projection.segments.map((segment, index) => <path key={`alternate-segment-${index}`} d={segment.path} className="route-path-alternate" />)}</g>)}
        {alternateProjection && <g className="route-line-direct-alternate" aria-label={alternateLabel ?? "Direct (great-circle) alternate"}>{alternateProjection.segments.map((segment, index) => <path key={`alternate-segment-${index}`} d={segment.path} className="route-path-direct-alternate" />)}</g>}
        {displayRoute && displayProjection && <g className={`route-line-selected${drawing ? " is-drawing" : ""}${hovered?.route.flightId === displayRoute.flightId ? " route-line-hover" : ""}`}>{displayProjection.segments.map((segment, index) => <g key={`segment-${index}`}><path d={segment.path} className="route-shadow" /><path d={segment.path} className="route-path" pathLength={1} /></g>)}</g>}
        {projections.map(({ route, projection }) => projection && <g key={`hit-${route.flightId}`} className="route-hit-lines">{projection.segments.map((segment, index) => <path key={`hit-segment-${index}`} d={segment.path} className="route-hit" onClick={(event) => { event.stopPropagation(); chooseProjectedRoute(route, projection); }} onMouseMove={(event) => { const rect = stageRef.current?.getBoundingClientRect(); const nextX = event.clientX - (rect?.left ?? 0); const nextY = event.clientY - (rect?.top ?? 0); setHovered((prev) => prev && prev.route.flightId === route.flightId && Math.abs(prev.x - nextX) < 3 && Math.abs(prev.y - nextY) < 3 ? prev : { route, x: nextX, y: nextY }); }} onMouseLeave={() => setHovered(undefined)} />)}</g>)}
        {departurePoint && <MapMarker point={departurePoint} label={departure} tone="origin" />}
        {arrivalPoint && <MapMarker point={arrivalPoint} label={arrival} tone="destination" />}
        {displayProjection?.gapBoundaries.map((point, index) => <g key={`gap-${index}`} className="gap-boundary"><circle cx={point.x} cy={point.y} r="7" /><text x={point.x + 12} y={point.y + 4}>Gap</text></g>)}
      </svg>
    </div>
    <span className="reg-mark reg-tl" aria-hidden="true" /><span className="reg-mark reg-tr" aria-hidden="true" /><span className="reg-mark reg-bl" aria-hidden="true" /><span className="reg-mark reg-br" aria-hidden="true" />
    {tilesOn && <div className="compass-rose" aria-hidden="true"><svg viewBox="0 0 36 36" width="36" height="36"><circle cx="18" cy="18" r="15" /><path d="M18 5 L21 18 L18 15 L15 18 Z" /><text x="18" y="33" textAnchor="middle">N</text></svg></div>}
    {tilesOn && Number.isFinite(view.lat) && <div className="map-scalebar" aria-hidden="true"><span className="scalebar-bar" style={{ width: scaleBar.px }} /><span className="scalebar-label">{scaleBar.label}</span></div>}
    {tilesOn && <div className="graticule-labels" aria-hidden="true">{graticule.verticals.map((v) => <span key={`v-${v.lon}-${Math.round(v.x)}`} className="grat-label" style={{ left: v.x }}>{`${Math.abs(Math.round(v.lon))}°${v.lon < 0 ? "W" : v.lon > 0 ? "E" : ""}`}</span>)}{graticule.horizontals.map((h) => <span key={`h-${h.lat}`} className="grat-label" style={{ top: h.y }}>{`${Math.abs(Math.round(h.lat))}°${h.lat < 0 ? "S" : h.lat > 0 ? "N" : ""}`}</span>)}</div>}
    {hovered && <div className="route-tooltip" aria-hidden="true" style={{ left: hovered.x + 12, top: hovered.y + 12 }}>{hovered.route.callsign} · {formatDistance(hovered.route.distanceNm)}</div>}
    {overlapChoices.length > 0 && <section className="map-overlap-chooser" role="dialog" aria-modal="false" aria-label="Choose an overlapping recorded flight" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeOverlapChooser(); } }}><div><strong>{overlapChoices.length} routes overlap here</strong><button ref={overlapCloseRef} type="button" className="quiet-button" onClick={closeOverlapChooser}>Close</button></div>{overlapChoices.map((route) => <button key={route.flightId} type="button" onClick={() => { closeOverlapChooser(); onSelectRoute(route); }}><strong>{route.callsign}</strong><span>{route.origin} → {route.destination}</span></button>)}</section>}
    <div className="map-fallback-banner"><span className="map-pin">◇</span><span>{banner}</span></div>
    <div className="map-zoom-controls" role="group" aria-label="Map zoom and base layer">
      <button type="button" aria-label="Zoom in" title={!tilesOn ? "Zoom is available on the tiled base map only" : undefined} disabled={!tilesOn || view.zoom >= MAX_ZOOM} onClick={() => setView((current) => ({ ...current, zoom: clampZoom(current.zoom + 1) }))}>+</button>
      <button type="button" aria-label="Zoom out" title={!tilesOn ? "Zoom is available on the tiled base map only" : undefined} disabled={!tilesOn || view.zoom <= MIN_ZOOM} onClick={() => setView((current) => ({ ...current, zoom: clampZoom(current.zoom - 1) }))}>−</button>
      <button type="button" aria-pressed={tilesEnabled} onClick={() => { setTilesEnabled((current) => !current); setTilesFailed(false); }}>Toggle base map</button>
      {!tilesOn && <span className="zoom-schematic-note">Zoom &amp; pan need the tiled base map</span>}
    </div>
    {displayRoute && <section className="map-endpoints" aria-label="Route endpoint locations"><div className="map-endpoint departure"><b>Departure</b><span>{departureLabel}</span></div><div className="map-endpoint arrival"><b>Arrival</b><span>{arrivalLabel}</span></div></section>}
    {!hasAnyLine && <div className="map-empty"><span>◎</span><strong>{routes.length ? "No resolved geometry returned" : overviewFailed ? "All-flight overview unavailable" : "No overview routes to display"}</strong><p>{routes.length ? "The world map does not infer a line across missing route data." : overviewFailed ? "The all-flight overview could not be loaded. Use Retry overview in the flight list." : "Clear the callsign filter or retry the all-flight overview."}</p></div>}
    <div className="map-attribution">{tilesOn ? OSM_ATTRIBUTION : "Schematic base map only"}</div>
  </div>;
}

function WorldMapBase() {
  return <><rect className="world-ocean" width="800" height="440" /><g className="world-graticule"><path d="M 0 73 H 800 M 0 147 H 800 M 0 220 H 800 M 0 293 H 800 M 0 367 H 800 M 133 0 V 440 M 267 0 V 440 M 400 0 V 440 M 533 0 V 440 M 667 0 V 440" /></g><g className="world-land"><path d="M 54 91 L 93 58 L 153 37 L 210 51 L 252 83 L 245 109 L 220 118 L 202 151 L 174 163 L 151 146 L 126 157 L 110 137 L 81 128 Z" /><path d="M 239 178 L 267 187 L 281 221 L 279 265 L 266 306 L 246 340 L 232 314 L 236 272 L 218 232 Z" /><path d="M 322 58 L 350 29 L 384 39 L 391 77 L 364 91 Z" /><path d="M 375 89 L 412 68 L 478 74 L 528 57 L 606 76 L 678 99 L 727 128 L 712 154 L 664 157 L 633 180 L 588 174 L 557 193 L 514 176 L 480 189 L 449 171 L 415 178 L 396 147 Z" /><path d="M 424 185 L 470 188 L 494 224 L 482 286 L 447 322 L 417 279 L 405 231 Z" /><path d="M 637 273 L 682 259 L 730 283 L 744 322 L 716 347 L 666 333 L 635 306 Z" /><path d="M 505 294 L 518 308 L 512 332 L 500 325 Z" /></g><g className="world-land island"><path d="M 707 190 L 716 182 L 723 195 L 715 205 Z" /><path d="M 761 221 L 770 228 L 764 243 L 755 236 Z" /><path d="M 164 186 L 175 190 L 176 204 L 166 208 Z" /><path d="M 747 365 L 763 367 L 770 379 L 754 384 L 742 376 Z" /></g></>;
}

function MapMarker({ point, label, tone }: { point: Point; label: string; tone: "origin" | "destination" }) {
  return <g className={`map-marker marker-${tone}`}>
    {tone === "origin"
      ? <><circle cx={point.x} cy={point.y} r="7" /><circle cx={point.x} cy={point.y} r="2.5" className="marker-core" /></>
      : <rect x={point.x - 5.5} y={point.y - 5.5} width="11" height="11" transform={`rotate(45 ${point.x} ${point.y})`} />}
    <text x={point.x + 14} y={point.y - 10}>{label}</text>
  </g>;
}
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
