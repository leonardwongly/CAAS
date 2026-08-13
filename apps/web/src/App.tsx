import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  fetchReadiness,
  fetchRouteOptions,
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
} from "./api";
import {
  COMPLETE_RANKED_GROUP_DESCRIPTION,
  COMPLETE_RANKED_GROUP_TITLE,
  INCOMPLETE_GROUP_DESCRIPTION,
  INCOMPLETE_GROUP_TITLE,
  OPERATIONAL_PROXY_EXPLANATION,
  RANK_CRITERION,
  RANK_ONE_GROUP_DESCRIPTION,
  RANK_ONE_LABEL,
  REFRESH_CONFIRM,
  REFRESH_STALE_BANNER,
  REFRESH_UNUSABLE_BANNER,
  SAFETY_NOTICE,
} from "./labels";

type SearchState = { query: string; matches: CallsignMatch[]; loading: boolean; searched: boolean; error?: string | undefined };
const emptySearch: SearchState = { query: "", matches: [], loading: false, searched: false };

function formatDistance(value: number | undefined): string {
  return value === undefined ? "Not supplied" : `${value.toFixed(1)} NM`;
}

function formatRankDistance(value: number | undefined): string {
  return value === undefined ? "Not supplied" : `${value.toFixed(6)} NM`;
}

function apiMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "TOO_MANY_CANDIDATES") return "Too many route options for this airport pair. Try a more specific flight.";
  if (error instanceof ApiError) return error.message;
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
      return `Live data refresh failed. The prior generation (retrieved ${new Date(live.retrievedAt).toLocaleTimeString()}, ${live.state ?? "state unknown"}) is still serving requests.`;
    }
  }
  return apiMessage(error);
}

function App() {
  const [selectedFlight, setSelectedFlight] = useState<CallsignMatch>();
  const [search, setSearch] = useState<SearchState>(emptySearch);
  const [options, setOptions] = useState<RouteOption[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<RouteOption>();
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string>();
  const [routeReload, setRouteReload] = useState(0);
  const [draft, setDraft] = useState<DraftComparison>();
  const [draftActive, setDraftActive] = useState(false);
  const [primarySurface, setPrimarySurface] = useState<"none" | "routes" | "route-data" | "editor">("none");
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string>();
  const [mapOnly, setMapOnly] = useState(false);
  const [status, setStatus] = useState("");
  const [generation, setGeneration] = useState<GenerationSummary>();
  const [rankLabel, setRankLabel] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const routeRequest = useRef(0);
  const draftRequest = useRef<AbortController | undefined>(undefined);
  const searchRequest = useRef<AbortController | undefined>(undefined);
  const routesTriggerRef = useRef<HTMLButtonElement>(null);
  const dataTriggerRef = useRef<HTMLButtonElement>(null);
  const editorTriggerRef = useRef<HTMLButtonElement>(null);
  const mapOnlyTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreControlsRef = useRef<HTMLButtonElement>(null);

  // Design §15.2: focus return is deterministic after closing a surface,
  // selecting a route, retrying an error, or leaving Map Only.
  function closeSurface(surface: "none" | "routes" | "route-data" | "editor") {
    setPrimarySurface("none");
    const trigger = surface === "routes" ? routesTriggerRef : surface === "route-data" ? dataTriggerRef : surface === "editor" ? editorTriggerRef : undefined;
    if (trigger) requestAnimationFrame(() => trigger.current?.focus());
  }

  function resetDraftState() {
    draftRequest.current?.abort();
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
      .catch((error) => { if (error instanceof DOMException && error.name === "AbortError") return; });
    return () => controller.abort();
  }, []);

  function updateQuery(query: string) {
    setSearch({ query, matches: [], loading: false, searched: false });
  }

  async function runSearch() {
    const query = search.query.trim();
    if (!query || search.loading) return;
    searchRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    setSearch((current) => ({ ...current, loading: true, matches: [], searched: false, error: undefined }));
    setStatus(`Searching flight plans for ${query}.`);
    try {
      const matches = await searchCallsigns(query, controller.signal);
      setSearch((current) => ({ ...current, loading: false, matches, searched: true }));
      setStatus(matches.length ? `${matches.length} flight plan match${matches.length === 1 ? "" : "es"} found. Choose one to continue.` : `No flight plans matched ${query}.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSearch((current) => ({ ...current, loading: false, searched: false, error: apiMessage(error) }));
      setStatus("Flight-plan search failed.");
    }
  }

  function chooseFlight(match: CallsignMatch) {
    searchRequest.current?.abort();
    setSelectedFlight(match);
    setSearch({ query: match.callsign, matches: [], loading: false, searched: false });
    setStatus(`Selected flight ${match.callsign}, departing ${match.departure} for ${match.destination}. Loading route options.`);
  }

  useEffect(() => {
    draftRequest.current?.abort();
    setDraft(undefined);
    setDraftActive(false);
    setDraftError(undefined);
    if (!selectedFlight) {
      setOptions([]);
      setSelectedRoute(undefined);
      setRouteError(undefined);
      return;
    }
    const controller = new AbortController();
    const requestId = ++routeRequest.current;
    setRouteLoading(true);
    setRouteError(undefined);
    setSelectedRoute(undefined);
    fetchRouteOptions(selectedFlight.flightId, controller.signal)
      .then((result) => {
        if (requestId !== routeRequest.current) return;
        const routes = result.options;
        setOptions(routes);
        setRankLabel(result.rankLabel);
        if (result.generation) setGeneration(result.generation);
        const rankOne = routes.filter((route) => route.rank === 1);
        if (rankOne.length === 1) setSelectedRoute(rankOne[0]);
        else if (rankOne.length === 0) setSelectedRoute(routes[0] ?? undefined);
        else setSelectedRoute(undefined);
        setStatus(rankOne.length > 1
          ? `${routes.length} route option${routes.length === 1 ? "" : "s"} returned for ${selectedFlight.callsign}. ${rankOne.length} candidates tie for Rank 1 — choose among them.`
          : `${routes.length} route option${routes.length === 1 ? "" : "s"} returned for ${selectedFlight.callsign}.`);
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
      const result = await validateDraft(selectedRoute.origin, selectedRoute.destination, via, selections, selectedRoute.flightId, controller.signal);
      if (draftRequest.current !== controller) return;
      setDraft(result);
      setStatus(result.comparison.status === "complete" ? "Local draft validated against exact reference data." : "Local draft has unresolved gaps and is not ranked.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (draftRequest.current === controller) setDraftError(apiMessage(error));
    } finally {
      if (draftRequest.current === controller) setDraftLoading(false);
    }
  }

  function resetAll() {
    searchRequest.current?.abort();
    draftRequest.current?.abort();
    routeRequest.current += 1;
    setSelectedFlight(undefined);
    setSearch(emptySearch);
    setOptions([]);
    setSelectedRoute(undefined);
    setRouteLoading(false);
    setRouteError(undefined);
    setRankLabel(undefined);
    setStatus("Session reset.");
  }

  async function runRefresh() {
    if (refreshing) return;
    const confirmed = window.confirm(REFRESH_CONFIRM);
    if (!confirmed) return;
    setRefreshing(true);
    setRefreshError(undefined);
    setStatus("Refreshing the live data generation. The current selection will be cleared.");
    try {
      const result = await refreshLiveData();
      setGeneration(result.generation);
      resetAll();
      setStatus(`Live data refreshed. New generation retrieved at ${new Date(result.generation.retrievedAt).toLocaleTimeString()}; selection cleared.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setRefreshError(refreshFailureMessage(error));
      setStatus("Live data refresh failed. The prior generation is still serving requests.");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="app-shell map-first-shell">
      <div className="safety-banner compact-safety" role="region" aria-label="Safety notice"><strong><span aria-hidden="true">⚠</span> Safety notice</strong><span>{SAFETY_NOTICE}</span></div>
      {!mapOnly && <header className="map-topbar">
        <a className="skip-link" href="#flight-search">Skip to flight search</a>
        <div className="product-mark"><p className="eyebrow">FLIGHT ROUTE EXPLORER</p><h1>Map-first route comparison</h1></div>
        <div className="toolbar-search"><SearchBox selected={undefined} state={search} onFocus={() => undefined} onQuery={updateQuery} onSearch={() => void runSearch()} onSelect={chooseFlight} /></div>
        <div className="toolbar-flight" role="group" aria-label="Selected flight">
          {selectedFlight ? <><strong>{selectedFlight.callsign}</strong><span>{selectedFlight.departure} → {selectedFlight.destination}</span><small>{selectedRoute?.complete ? `${formatDistance(selectedRoute.distanceNm)} · ${selectedRoute.rank !== undefined ? `Rank ${selectedRoute.rank}` : "Unranked"}` : "Recorded route is incomplete and unranked"}</small></> : <span>Search for a recorded flight plan to begin.</span>}
        </div>
        <button className="quiet-button toolbar-clear" type="button" onClick={() => { setPrimarySurface("none"); resetAll(); }}>Clear session</button>
      </header>}

      {(generation || refreshError) && (
        <div className="generation-strip" role="region" aria-label="Live data freshness">
          {generation && <span className={`status-chip freshness-chip freshness-${generation.live.state}`}>Live data {generation.live.state} · retrieved {new Date(generation.live.retrievedAt).toLocaleTimeString()}</span>}
          {refreshError && <span className="refresh-error" role="alert">{refreshError}</span>}
          <button className="quiet-button" type="button" onClick={() => void runRefresh()} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh live data"}</button>
        </div>
      )}
      {generation && (generation.live.state === "stale" || generation.live.state === "unusable") && (
        <div className={`notice freshness-banner ${generation.live.state === "unusable" ? "freshness-banner-unusable" : ""}`} role="status">{generation.live.state === "stale" ? REFRESH_STALE_BANNER : REFRESH_UNUSABLE_BANNER}</div>
      )}

      <main className="map-workspace">
        {mapOnly && <h1 className="sr-only">Map-first route comparison</h1>}
        <section className="map-panel map-first-panel" aria-labelledby="map-heading">
          <h2 className="sr-only" id="map-heading">Global route map</h2>
          <RouteMap route={selectedRoute} callsign={selectedFlight?.callsign} />
          <div className="map-hud">{selectedRoute ? <><span className="eyebrow">ACTIVE RECORDED ROUTE</span><strong>{selectedRoute.label ?? selectedFlight?.callsign ?? "Selected route"}</strong><span>{selectedRoute.complete ? `${formatDistance(selectedRoute.distanceNm)} · ${selectedRoute.rank === 1 ? RANK_ONE_LABEL : selectedRoute.rank !== undefined ? `Rank ${selectedRoute.rank}` : RANK_CRITERION}` : "Incomplete · not included in ranking"}</span></> : <><span className="eyebrow">GLOBAL MAP</span><strong>Recorded routes appear after selection</strong><span>Only exact, server-resolved geometry is shown.</span></>}</div>
          {!mapOnly && <nav className="map-rail" aria-label="Route workspace controls">
            <button ref={routesTriggerRef} type="button" aria-pressed={primarySurface === "routes"} onClick={() => setPrimarySurface((surface) => surface === "routes" ? "none" : "routes")} disabled={!selectedFlight}>Routes</button>
            <button ref={dataTriggerRef} type="button" aria-pressed={primarySurface === "route-data"} onClick={() => setPrimarySurface((surface) => surface === "route-data" ? "none" : "route-data")} disabled={!selectedRoute}>Data</button>
            <button ref={editorTriggerRef} type="button" aria-pressed={primarySurface === "editor"} onClick={() => { if (!selectedRoute) return; setDraftActive(true); setPrimarySurface("editor"); void updateDraft([]); }} disabled={!selectedRoute}>Edit copy</button>
            <button ref={mapOnlyTriggerRef} type="button" onClick={enterMapOnly}>Map only</button>
          </nav>}
          {mapOnly && <button ref={restoreControlsRef} className="restore-controls" type="button" onClick={leaveMapOnly} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); leaveMapOnly(); } }}>Restore controls</button>}
          {!mapOnly && primarySurface !== "none" && <aside className="map-drawer" role="region" aria-label={primarySurface === "routes" ? "Route chooser" : primarySurface === "route-data" ? "Flight and route data" : "Local route editor"}>
            <div className="drawer-header"><p className="eyebrow">{primarySurface === "routes" ? "COMPARE RECORDED ROUTES" : primarySurface === "route-data" ? "INSPECT ROUTE" : "EDIT COPY"}</p><button className="quiet-button" type="button" onClick={() => { if (primarySurface === "editor") resetDraftState(); closeSurface(primarySurface); }}>Close</button></div>
            {primarySurface === "routes" && <RouteOptions options={options} selected={selectedRoute} loading={routeLoading} error={routeError} rankLabel={rankLabel} onRetry={() => { setRouteReload((current) => current + 1); requestAnimationFrame(() => document.getElementById("options-heading")?.focus()); }} onSelect={(option) => { setSelectedRoute(option); setStatus(`Selected ${option.label ?? "route option"}.`); closeSurface("routes"); }} />}
            {primarySurface === "route-data" && selectedRoute && <RouteDetails route={selectedRoute} onStartDraft={() => { setDraftActive(true); setPrimarySurface("editor"); void updateDraft([]); }} />}
            {primarySurface === "editor" && selectedRoute && draftActive && <DraftEditor draft={draft} baseline={selectedRoute} loading={draftLoading} error={draftError} onUpdate={(via) => void updateDraft(via)} onClose={() => { resetDraftState(); closeSurface("editor"); }} />}
          </aside>}
          {!mapOnly && <div className="map-legend" role="group" aria-label="Map legend"><span><i className="legend-line" /> Selected recorded route</span><span><i className="legend-gap" /> Unresolved gap</span><span><i className="legend-dot legend-origin" /> Departure</span><span><i className="legend-dot legend-destination" /> Arrival</span></div>}
          <div className="sr-status" role="status" aria-live="polite">{routeLoading ? "Loading route options." : status}</div>
        </section>
      </main>
    </div>
  );
}

function SearchBox({ selected, state, onFocus, onQuery, onSearch, onSelect }: { selected?: CallsignMatch | undefined; state: SearchState; onFocus: () => void; onQuery: (value: string) => void; onSearch: () => void; onSelect: (match: CallsignMatch) => void }) {
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
        <input ref={inputRef} id="flight-search" role="combobox" value={state.query} onFocus={onFocus} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "ArrowDown" && hasResults) { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, state.matches.length - 1)); }
          else if (event.key === "ArrowUp" && hasResults) { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
          else if (event.key === "Enter") { event.preventDefault(); if (activeIndex >= 0 && state.matches[activeIndex]) select(state.matches[activeIndex]); else onSearch(); }
          else if (event.key === "Escape") { event.preventDefault(); setActiveIndex(-1); setResultsOpen(false); }
        }} aria-expanded={hasResults} aria-controls={hasResults ? resultId : undefined} aria-activedescendant={activeIndex >= 0 ? `flight-match-${activeIndex}` : undefined} aria-autocomplete="list" placeholder="For example: SQ321" autoComplete="off" />
        <button className="search-button" type="button" onClick={onSearch} disabled={state.loading || !state.query.trim()} aria-label="Search flight plans">{state.loading ? <span className="spinner" /> : "↗"}</button>
      </div>
      {selected && <p className="selected-value"><span className="check">✓</span> Selected <strong>{selected.callsign}</strong> <span>{selected.departure} → {selected.destination}</span></p>}
      {state.error && <p className="field-error" role="alert">{state.error}</p>}
      {hasResults && <div className="duplicate-picker"><p className="picker-label">{state.matches.length > 1 ? "Multiple flight plans — choose the exact record" : "Flight-plan match"}</p><div id={resultId} role="listbox" aria-label="Choose an exact flight-plan match">{state.matches.map((match, index) => <div className={`match-option ${activeIndex === index ? "is-active" : ""}`} id={`flight-match-${index}`} role="option" aria-selected={activeIndex === index} key={match.id} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => select(match)}><span><strong>{match.callsign}</strong><small>{match.departure} → {match.destination} · {match.routePointCount} recorded points</small></span><span aria-hidden="true">›</span></div>)}</div></div>}
      {state.searched && !state.loading && state.query.trim() && !state.error && !hasResults && !selected && <p className="helper-text">No matching flight plans returned.</p>}
    </div>
  );
}

function rankOf(option: RouteOption): number | undefined {
  return option.rank ?? option.operationalProxy?.rank;
}

function isCompleteCandidate(option: RouteOption): boolean {
  return option.complete ?? option.operationalProxy?.eligible ?? false;
}

function RouteOptions({ options, selected, loading, error, rankLabel, onRetry, onSelect }: { options: RouteOption[]; selected?: RouteOption | undefined; loading: boolean; error?: string | undefined; rankLabel?: string | undefined; onRetry: () => void; onSelect: (route: RouteOption) => void }) {
  if (!loading && !error && options.length === 0) return <section className="empty-options"><span className="empty-icon">⌁</span><div><h2>Route options will appear here</h2><p>Select one flight plan above to request its recorded route options.</p></div></section>;
  const ranked = options.filter(isCompleteCandidate);
  const rankOne = ranked.filter((option) => rankOf(option) === 1);
  const otherRanked = ranked.filter((option) => (rankOf(option) ?? 0) > 1);
  const unranked = options.filter((option) => !isCompleteCandidate(option));
  return <section className="options-section" aria-labelledby="options-heading"><div className="section-title"><div><p className="eyebrow">COMPARE</p><h2 id="options-heading" tabIndex={-1}>Route options</h2></div>{options.length > 0 && <span className="count-label">{options.length} returned</span>}</div>{loading && <div className="loading-row"><span className="spinner dark" /> Asking for the selected flight’s options…</div>}{error && <div className="notice error-notice" role="alert"><strong>Could not load route options.</strong><span>{error}</span><button className="retry-button" type="button" onClick={onRetry}>Retry route options</button></div>}{!loading && !error && options.length === 0 && <p className="muted-copy">The service returned no route options. This is a visible gap, not an estimated route.</p>}{options.length > 0 && <p className="criterion-copy">{OPERATIONAL_PROXY_EXPLANATION}</p>}{rankOne.length > 0 && <RouteGroup title={rankLabel ?? RANK_ONE_LABEL} description={RANK_ONE_GROUP_DESCRIPTION} count={`${rankOne.length} tied first-place candidate${rankOne.length === 1 ? "" : "s"}`} options={rankOne} selected={selected} onSelect={onSelect} />}{otherRanked.length > 0 && <RouteGroup title={COMPLETE_RANKED_GROUP_TITLE} description={COMPLETE_RANKED_GROUP_DESCRIPTION} count={`${otherRanked.length} ranked candidate${otherRanked.length === 1 ? "" : "s"}`} criterion={RANK_CRITERION} options={otherRanked} selected={selected} onSelect={onSelect} />}{unranked.length > 0 && <RouteGroup title={INCOMPLETE_GROUP_TITLE} description={INCOMPLETE_GROUP_DESCRIPTION} count={`${unranked.length} unranked candidate${unranked.length === 1 ? "" : "s"}`} options={unranked} selected={selected} onSelect={onSelect} />}</section>;
}

function RouteGroup({ title, description, count, criterion, options, selected, onSelect }: { title: string; description: string; count: string; criterion?: string | undefined; options: RouteOption[]; selected?: RouteOption | undefined; onSelect: (route: RouteOption) => void }) {
  return <div className="route-group"><div className="group-heading"><div><h3>{title}</h3><p className="criterion-copy">{description}</p>{criterion && <p className="criterion-copy">{criterion} It does not account for safety, clearance, legality, weather, fuel, or airline dispatch constraints.</p>}</div><span className="group-count">{count}</span></div><div className="option-grid">{options.map((option) => <button type="button" className={`route-card ${selected?.id === option.id ? "selected" : ""} ${option.operationalProxy?.eligible ? "is-complete" : "is-incomplete"}`} key={option.id} onClick={() => onSelect(option)} aria-current={selected?.id === option.id ? "true" : undefined}><span className="route-card-top"><strong>{option.label ?? "Route option"}</strong><span>{option.operationalProxy?.eligible && option.operationalProxy.rank !== undefined ? `Rank ${option.operationalProxy.rank}` : "Unranked"}</span></span><span className="route-card-distance">{formatDistance(option.distanceNm ?? option.rankDistanceNm)}</span><span className="route-card-meta">{option.pointCount} points · {option.legs.length} legs · {option.gaps.length} visible gaps · {option.provenance ?? "provenance not supplied"}</span><span className="route-card-meta">{option.operationalProxy?.eligible ? "All waypoints found. Included in ranking." : option.operationalProxy?.exclusion ?? "This route has unresolved waypoints and cannot be ranked."}</span></button>)}</div></div>;
}

function RouteDetails({ route, onStartDraft }: { route: RouteOption; onStartDraft: () => void }) {
  const proxy = route.operationalProxy;
  return <section className="details-section" aria-labelledby="details-heading"><div className="section-title"><div><p className="eyebrow">INSPECT</p><h2 id="details-heading">Route data</h2></div><div className="detail-actions"><button className="edit-copy-button" type="button" onClick={onStartDraft}>Edit copy</button><span className="opaque-id" title="Opaque server flight ID">Flight ID {route.flightId}</span></div></div><div className="metric-grid"><Metric label="Route data" value={route.complete ? "All waypoints found" : "Some waypoints missing"} /><Metric label="Distance" value={formatDistance(route.distanceNm)} /><Metric label="Ranked distance" value={formatRankDistance(route.rankDistanceNm)} note="Full-precision modeled distance used for ranking" /><Metric label="Route rank" value={proxy?.eligible && proxy.rank !== undefined ? `Rank ${proxy.rank}` : "Not ranked"} /><Metric label="Points" value={String(route.pointCount)} note="Server-reported count" /></div><div className="detail-columns"><div className="table-wrap"><h3 id="route-legs-heading">Structured route detail</h3><RouteTable legs={route.legs} /></div><div className="evidence-stack"><Evidence label="How route ranking works" value={proxy?.eligible ? (proxy.rank === 1 ? RANK_ONE_LABEL : RANK_CRITERION) : proxy?.exclusion ?? "This route has unresolved waypoints and cannot be ranked."} tone={proxy?.eligible ? "blue" : "red"} /><Evidence label="Provenance" value={route.provenance ?? "Not supplied by the route service."} tone="blue" /><Evidence label="Safety boundary" value={SAFETY_NOTICE} tone="amber" /><Evidence label={`Visible gaps${route.gaps.length ? ` · ${route.gaps.length}` : ""}`} value={route.gaps.length ? route.gaps.map((gap) => `Route position ${gap.sequence + 1}: ${gap.reason}`).join(" ") : "No gaps reported by the route service."} tone={route.gaps.length ? "red" : "green"} /></div></div></section>;
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
  const via = draft?.draft.via ?? [];
  const selections = draft?.draft.selections ?? [];
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
    onUpdate([...via, match.identifier], match.locationId ? [...selections, { sequence: via.length, locationId: match.locationId }] : selections);
    setQuery("");
    setMatches([]);
    setActiveIndex(-1);
  }

  async function findReference() {
    const value = query.trim();
    if (!value) return;
    setLookupLoading(true);
    setLookupError(undefined);
    setMatches([]);
    setActiveIndex(-1);
    try {
      const found = await lookupPoint(value);
      setMatches(found);
      if (!found.length) setLookupError("No exact reference point was returned. Free-form points cannot be added.");
    } catch (lookupFailure) {
      setLookupError(apiMessage(lookupFailure));
    } finally {
      setLookupLoading(false);
    }
  }

  return <section className="draft-section" aria-labelledby="draft-heading">
    <div className="section-title"><div><p className="eyebrow">EDIT COPY</p><h2 id="draft-heading" tabIndex={-1}>Local computational draft</h2></div><button className="quiet-button" type="button" onClick={onClose}>Close draft</button></div>
    <p className="draft-safety">Computationally complete; operational constraints not assessed. Endpoints are locked and every change is checked against exact reference data.</p>
    <div className="draft-endpoints"><span><strong>From</strong> {baseline.origin ?? "Selected origin"}</span><span><strong>To</strong> {baseline.destination ?? "Selected destination"}</span></div>
    <div className="draft-search"><label htmlFor="draft-point-search">Add an exact reference point</label><div className="search-input-row"><input id="draft-point-search" role="combobox" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
      if (event.key === "ArrowDown" && hasMatches) { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, matches.length - 1)); }
      else if (event.key === "ArrowUp" && hasMatches) { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
      else if (event.key === "Enter") { event.preventDefault(); if (activeIndex >= 0 && matches[activeIndex]) commitMatch(matches[activeIndex]!); else void findReference(); }
      else if (event.key === "Escape") { event.preventDefault(); setMatches([]); setLookupError(undefined); setActiveIndex(-1); }
    }} aria-expanded={hasMatches} aria-controls={hasMatches ? matchResultsId : undefined} aria-activedescendant={activeIndex >= 0 ? `draft-match-${activeIndex}` : undefined} aria-autocomplete="list" placeholder="Search an exact fix, NAVAID, or airport" autoComplete="off" /><button className="search-button" type="button" onClick={() => void findReference()} disabled={lookupLoading || !query.trim()} aria-label="Find exact reference point">{lookupLoading ? <span className="spinner" /> : "Find"}</button></div>{lookupError && <p className="field-error" role="alert">{lookupError}</p>}<div className="sr-status" role="status" aria-live="polite">{lookupLoading ? "Looking up exact reference points." : matches.length ? `${matches.length} exact reference point${matches.length === 1 ? "" : "s"} available.` : ""}</div>
      {hasMatches && <div className="reference-picker" id={matchResultsId} role="listbox" aria-label="Resolved reference-point search results">{matches.map((match, index) => <div role="option" id={`draft-match-${index}`} aria-selected={activeIndex === index} className={activeIndex === index ? "is-active" : undefined} tabIndex={-1} key={`${match.identifier}-${match.coordinate.lat}-${match.coordinate.lon}`} onMouseDown={(event) => event.preventDefault()} onClick={() => commitMatch(match)}><span><strong>{match.identifier}</strong><small>{match.kind} · {match.coordinate.lat.toFixed(4)}, {match.coordinate.lon.toFixed(4)}{match.duplicateGroup ? " · multiple exact coordinates" : ""}</small></span><span>{match.duplicateGroup ? "Choose exact location" : "Add"}</span></div>)}</div>}
    </div>
    <div className="draft-points"><div className="group-heading"><h3>Intermediate points</h3><button className="text-button" type="button" onClick={() => onUpdate([], [])} disabled={!via.length || loading}>Reset to endpoint-only draft</button></div>{via.length ? <ol role="list">{via.map((point, index) => <li key={`${point}-${index}`}><span><strong>{point}</strong><small>{selectedAt(index) ? "Exact coordinate selected from the ambiguous group." : "Manual-direct segments are not airways."}</small></span><span className="draft-row-actions"><button type="button" onClick={() => onUpdate(via.map((value, position) => position === index - 1 ? point : position === index ? via[index - 1]! : value), remapMove(index, -1))} disabled={loading || index === 0} aria-label={`Move ${point} up`}>Move up</button><button type="button" onClick={() => onUpdate(via.map((value, position) => position === index + 1 ? point : position === index ? via[index + 1]! : value), remapMove(index, 1))} disabled={loading || index === via.length - 1} aria-label={`Move ${point} down`}>Move down</button><button type="button" onClick={() => onUpdate(via.filter((_, position) => position !== index), remapRemove(index))} disabled={loading} aria-label={`Remove ${point}`}>Remove</button></span></li>)}</ol> : <p className="muted-copy">No intermediate points. This draft uses a direct modeled endpoint-to-endpoint segment.</p>}</div>
    {loading && <div className="loading-row"><span className="spinner dark" /> Validating the local draft…</div>}{error && <div className="notice error-notice" role="alert"><span>{error}</span><button className="retry-button" type="button" onClick={() => { onUpdate(via, selections); requestAnimationFrame(() => document.getElementById("draft-heading")?.focus()); }} disabled={loading}>Retry draft validation</button></div>}
    {draft && <div className="draft-result"><Metric label="Draft status" value={draft.comparison.status === "complete" ? "Complete" : "Incomplete"} /><Metric label="Modeled distance" value={formatDistance(draft.route.distanceNm)} /><Metric label="Change from selected route" value={delta === undefined ? "Unavailable" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} NM`} note={percentage !== undefined ? `Directed baseline → target · ${percentage >= 0 ? "+" : ""}${percentage.toFixed(1)}%` : "Directed baseline → target"} /><Metric label="Draft gaps" value={String(draft.route.gaps.length)} note={draft.comparison.message} /></div>}
  </section>;
}

type EndpointLocation = Pick<PointMatch, "coordinate" | "name">;

function RouteMap({ route, callsign }: { route?: RouteOption | undefined; callsign?: string | undefined }) {
  const [endpoints, setEndpoints] = useState<{ departure?: EndpointLocation | undefined; arrival?: EndpointLocation | undefined }>({});
  const sourceSegments = useMemo(() => route?.segments ?? (route?.geometry ? [route.geometry] : []), [route]);
  const projection = useMemo(() => projectWorldSegments(sourceSegments), [sourceSegments]);
  const hasLine = Boolean(projection?.segments.length);
  const incomplete = route && !route.complete;
  const departure = route?.origin ?? "Not supplied";
  const arrival = route?.destination ?? "Not supplied";

  useEffect(() => {
    const controller = new AbortController();
    const exact = (matches: PointMatch[]): EndpointLocation | undefined => {
      const unique = matches.filter((match) => !match.duplicateGroup);
      return unique.length === 1 ? unique[0] : undefined;
    };
    if (!route?.origin && !route?.destination) { setEndpoints({}); return () => controller.abort(); }
    void Promise.all([
      route?.origin ? lookupPoint(route.origin, controller.signal).then(exact).catch(() => undefined) : Promise.resolve(undefined),
      route?.destination ? lookupPoint(route.destination, controller.signal).then(exact).catch(() => undefined) : Promise.resolve(undefined),
    ]).then(([departurePoint, arrivalPoint]) => {
      if (!controller.signal.aborted) setEndpoints({ departure: departurePoint, arrival: arrivalPoint });
    });
    return () => controller.abort();
  }, [route?.id, route?.origin, route?.destination]);

  const departurePoint = endpoints.departure ? projectWorldPoint(endpoints.departure.coordinate) : undefined;
  const arrivalPoint = endpoints.arrival ? projectWorldPoint(endpoints.arrival.coordinate) : undefined;
  const departureLabel = endpoints.departure?.name && endpoints.departure.name !== departure ? `${endpoints.departure.name} (${departure})` : departure;
  const arrivalLabel = endpoints.arrival?.name && endpoints.arrival.name !== arrival ? `${endpoints.arrival.name} (${arrival})` : arrival;
  const label = hasLine ? `${callsign ?? "Selected flight"} world map showing ${departureLabel} departure and ${arrivalLabel} arrival with ${projection?.segments.length} resolved segment${projection?.segments.length === 1 ? "" : "s"}${incomplete ? " and visible unresolved gaps" : ""}` : "World map waiting for server-returned route segments";
  return <div className="map-stage" role="img" aria-label={label}>
    <div className="map-fallback-banner"><span className="map-pin">◇</span><span>{incomplete ? "World map · showing resolved segments only; gaps are not connected." : hasLine ? "World map · server route geometry" : "World map · no route geometry returned yet."}</span></div>
    <svg className="route-svg" viewBox="0 0 800 440" aria-hidden="true">
      <WorldMapBase />
      {projection?.segments.map((segment, index) => <g key={`segment-${index}`}><path d={segment.path} className="route-shadow" filter="url(#glow)" /><path d={segment.path} className="route-path" /></g>)}
      {departurePoint && <MapMarker point={departurePoint} label={departure} tone="origin" />}
      {arrivalPoint && <MapMarker point={arrivalPoint} label={arrival} tone="destination" />}
      {projection?.gapBoundaries.map((point, index) => <g key={`gap-${index}`} className="gap-boundary"><circle cx={point.x} cy={point.y} r="7" /><text x={point.x + 12} y={point.y + 4}>Gap</text></g>)}
    </svg>
    {route && <section className="map-endpoints" aria-label="Route endpoint locations"><div className="map-endpoint departure"><b>Departure</b><span>{departureLabel}</span></div><div className="map-endpoint arrival"><b>Arrival</b><span>{arrivalLabel}</span></div></section>}
    {!hasLine && <div className="map-empty"><span>◎</span><strong>{route ? "No resolved geometry returned" : "Select a flight plan"}</strong><p>{route ? "The world map does not infer a line across missing route data." : "The map will use only coordinates and route segments returned by the server."}</p></div>}
    <div className="map-attribution">Geographic reference only · no external map tiles or API keys</div>
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
