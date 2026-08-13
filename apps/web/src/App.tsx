import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  fetchRouteOptions,
  lookupPoint,
  searchCallsigns,
  validateDraft,
  type CallsignMatch,
  type Coordinate,
  type DraftComparison,
  type PointMatch,
  type RouteLeg,
  type RouteOption,
} from "./api";

type SearchState = { query: string; matches: CallsignMatch[]; loading: boolean; searched: boolean; error?: string | undefined };
const emptySearch: SearchState = { query: "", matches: [], loading: false, searched: false };
const RANK_CRITERION = "Routes are ranked by shortest recorded distance among routes with the same departure and arrival. Rank 1 is the shortest route in this retrieved set.";
const OPERATIONAL_PROXY_EXPLANATION = "This comparison uses route distance as a stand-in for operational preference. It does not account for weather, fuel, clearances, or airline decisions.";
const SAFETY_NOTICE = "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.";

function formatDistance(value: number | undefined): string {
  return value === undefined ? "Not supplied" : `${value.toFixed(1)} NM`;
}

function apiMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "TOO_MANY_CANDIDATES") return "Too many route options for this airport pair. Try a more specific flight.";
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "The route service could not be reached.";
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
  const [status, setStatus] = useState("");
  const routeRequest = useRef(0);
  const draftRequest = useRef<AbortController | undefined>(undefined);
  const searchRequest = useRef<AbortController | undefined>(undefined);

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
      .then((routes) => {
        if (requestId !== routeRequest.current) return;
        setOptions(routes);
        setSelectedRoute(routes[0]);
        setStatus(`${routes.length} route option${routes.length === 1 ? "" : "s"} returned for ${selectedFlight.callsign}.`);
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

  async function updateDraft(via: string[]) {
    if (!selectedRoute?.origin || !selectedRoute.destination) return;
    draftRequest.current?.abort();
    const controller = new AbortController();
    draftRequest.current = controller;
    setDraftLoading(true);
    setDraftError(undefined);
    setStatus("Validating the local draft against exact reference data.");
    try {
      const result = await validateDraft(selectedRoute.origin, selectedRoute.destination, via, controller.signal);
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
    setStatus("Session cleared.");
  }

  return (
    <div className="app-shell map-first-shell">
      <a className="skip-link" href="#flight-search">Skip to flight search</a>
      <div className="safety-banner compact-safety" role="note"><strong><span aria-hidden="true">⚠</span> Safety notice</strong><span>{SAFETY_NOTICE}</span></div>
      <header className="map-topbar">
        <div className="product-mark"><p className="eyebrow">FLIGHT ROUTE EXPLORER</p><h1>Map-first route comparison</h1></div>
        <div className="toolbar-search"><SearchBox selected={undefined} state={search} onFocus={() => undefined} onQuery={updateQuery} onSearch={() => void runSearch()} onSelect={chooseFlight} /></div>
        <div className="toolbar-flight" aria-label="Selected flight">
          {selectedFlight ? <><strong>{selectedFlight.callsign}</strong><span>{selectedFlight.departure} → {selectedFlight.destination}</span><small>{selectedRoute?.complete ? `${formatDistance(selectedRoute.distanceNm)} · ${selectedRoute.rank !== undefined ? `Rank ${selectedRoute.rank}` : "Unranked"}` : "Recorded route is incomplete and unranked"}</small></> : <span>Search for a recorded flight plan to begin.</span>}
        </div>
        <button className="quiet-button toolbar-clear" type="button" onClick={() => { setPrimarySurface("none"); resetAll(); }}>Clear session</button>
      </header>

      <main className="map-workspace">
        <section className="map-panel map-first-panel" aria-labelledby="map-heading">
          <h2 className="sr-only" id="map-heading">Global route map</h2>
          <RouteMap route={selectedRoute} callsign={selectedFlight?.callsign} />
          <div className="map-hud">{selectedRoute ? <><span className="eyebrow">ACTIVE RECORDED ROUTE</span><strong>{selectedRoute.label ?? selectedFlight?.callsign ?? "Selected route"}</strong><span>{selectedRoute.complete ? `${formatDistance(selectedRoute.distanceNm)} · ${selectedRoute.rank !== undefined ? `Rank ${selectedRoute.rank}` : RANK_CRITERION}` : "Incomplete · not included in ranking"}</span></> : <><span className="eyebrow">GLOBAL MAP</span><strong>Recorded routes appear after selection</strong><span>Only exact, server-resolved geometry is shown.</span></>}</div>
          <nav className="map-rail" aria-label="Route workspace controls">
            <button type="button" aria-pressed={primarySurface === "routes"} onClick={() => setPrimarySurface((surface) => surface === "routes" ? "none" : "routes")} disabled={!selectedFlight}>Routes</button>
            <button type="button" aria-pressed={primarySurface === "route-data"} onClick={() => setPrimarySurface((surface) => surface === "route-data" ? "none" : "route-data")} disabled={!selectedRoute}>Data</button>
            <button type="button" aria-pressed={primarySurface === "editor"} onClick={() => { if (!selectedRoute) return; setDraftActive(true); setPrimarySurface("editor"); void updateDraft([]); }} disabled={!selectedRoute}>Edit copy</button>
          </nav>
          {primarySurface !== "none" && <aside className="map-drawer" aria-label={primarySurface === "routes" ? "Route chooser" : primarySurface === "route-data" ? "Flight and route data" : "Local route editor"}>
            <div className="drawer-header"><p className="eyebrow">{primarySurface === "routes" ? "COMPARE RECORDED ROUTES" : primarySurface === "route-data" ? "INSPECT ROUTE" : "EDIT COPY"}</p><button className="quiet-button" type="button" onClick={() => { if (primarySurface === "editor") { draftRequest.current?.abort(); setDraftActive(false); setDraft(undefined); setDraftError(undefined); } setPrimarySurface("none"); }}>Close</button></div>
            {primarySurface === "routes" && <RouteOptions options={options} selected={selectedRoute} loading={routeLoading} error={routeError} onRetry={() => setRouteReload((current) => current + 1)} onSelect={(option) => { setSelectedRoute(option); setPrimarySurface("none"); setStatus(`Selected ${option.label ?? "route option"}.`); }} />}
            {primarySurface === "route-data" && selectedRoute && <RouteDetails route={selectedRoute} onStartDraft={() => { setDraftActive(true); setPrimarySurface("editor"); void updateDraft([]); }} />}
            {primarySurface === "editor" && selectedRoute && draftActive && <DraftEditor draft={draft} baseline={selectedRoute} loading={draftLoading} error={draftError} onUpdate={(via) => void updateDraft(via)} onClose={() => { draftRequest.current?.abort(); setDraftActive(false); setDraft(undefined); setDraftError(undefined); setPrimarySurface("none"); }} />}
          </aside>}
          <div className="map-legend" role="group" aria-label="Map legend"><span><i className="legend-line" /> Selected recorded route</span><span><i className="legend-gap" /> Unresolved gap</span><span><i className="legend-dot legend-origin" /> Departure</span><span><i className="legend-dot legend-destination" /> Arrival</span></div>
          <div className="sr-status" aria-live="polite">{routeLoading ? "Loading route options." : status}</div>
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
        }} aria-expanded={hasResults} aria-controls={hasResults ? resultId : undefined} aria-activedescendant={activeIndex >= 0 ? `flight-match-${activeIndex}` : undefined} placeholder="For example: SQ321" autoComplete="off" />
        <button className="search-button" type="button" onClick={onSearch} disabled={state.loading || !state.query.trim()} aria-label="Search flight plans">{state.loading ? <span className="spinner" /> : "↗"}</button>
      </div>
      {selected && <p className="selected-value"><span className="check">✓</span> Selected <strong>{selected.callsign}</strong> <span>{selected.departure} → {selected.destination}</span></p>}
      {state.error && <p className="field-error" role="alert">{state.error}</p>}
      {hasResults && <div className="duplicate-picker" id={resultId} role="listbox" aria-label="Choose an exact flight-plan match"><p className="picker-label">{state.matches.length > 1 ? "Multiple flight plans — choose the exact record" : "Flight-plan match"}</p>{state.matches.map((match, index) => <div className={`match-option ${activeIndex === index ? "is-active" : ""}`} id={`flight-match-${index}`} role="option" aria-selected={activeIndex === index} key={match.id} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => select(match)}><span><strong>{match.callsign}</strong><small>{match.departure} → {match.destination} · {match.routePointCount} recorded points</small></span><span aria-hidden="true">›</span></div>)}</div>}
      {state.searched && !state.loading && state.query.trim() && !state.error && !hasResults && !selected && <p className="helper-text">No matching flight plans returned.</p>}
    </div>
  );
}

function RouteOptions({ options, selected, loading, error, onRetry, onSelect }: { options: RouteOption[]; selected?: RouteOption | undefined; loading: boolean; error?: string | undefined; onRetry: () => void; onSelect: (route: RouteOption) => void }) {
  if (!loading && !error && options.length === 0) return <section className="empty-options"><span className="empty-icon">⌁</span><div><h2>Route options will appear here</h2><p>Select one flight plan above to request its recorded route options.</p></div></section>;
  const ranked = options.filter((option) => option.operationalProxy?.eligible);
  const unranked = options.filter((option) => !option.operationalProxy?.eligible);
  return <section className="options-section" aria-labelledby="options-heading"><div className="section-title"><div><p className="eyebrow">COMPARE</p><h2 id="options-heading">Route options</h2></div>{options.length > 0 && <span className="count-label">{options.length} returned</span>}</div>{loading && <div className="loading-row"><span className="spinner dark" /> Asking for the selected flight’s options…</div>}{error && <div className="notice error-notice" role="alert"><strong>Could not load route options.</strong><span>{error}</span><button className="retry-button" type="button" onClick={onRetry}>Retry route options</button></div>}{!loading && !error && options.length === 0 && <p className="muted-copy">The service returned no route options. This is a visible gap, not an estimated route.</p>}{options.length > 0 && <p className="criterion-copy">{OPERATIONAL_PROXY_EXPLANATION}</p>}{ranked.length > 0 && <RouteGroup title="Ranked routes" description="All waypoints were found at known positions." count={`${ranked.length} ranked candidate${ranked.length === 1 ? "" : "s"}`} criterion={RANK_CRITERION} options={ranked} selected={selected} onSelect={onSelect} />}{unranked.length > 0 && <RouteGroup title="Unranked routes (incomplete data)" description="Some waypoints could not be located, so these routes cannot be compared fairly." count={`${unranked.length} unranked candidate${unranked.length === 1 ? "" : "s"}`} options={unranked} selected={selected} onSelect={onSelect} />}</section>;
}

function RouteGroup({ title, description, count, criterion, options, selected, onSelect }: { title: string; description: string; count: string; criterion?: string | undefined; options: RouteOption[]; selected?: RouteOption | undefined; onSelect: (route: RouteOption) => void }) {
  return <div className="route-group"><div className="group-heading"><div><h3>{title}</h3><p className="criterion-copy">{description}</p>{criterion && <p className="criterion-copy">{criterion} It does not account for safety, clearance, legality, weather, fuel, or airline dispatch constraints.</p>}</div><span className="group-count">{count}</span></div><div className="option-grid">{options.map((option) => <button type="button" className={`route-card ${selected?.id === option.id ? "selected" : ""} ${option.operationalProxy?.eligible ? "is-complete" : "is-incomplete"}`} key={option.id} onClick={() => onSelect(option)} aria-current={selected?.id === option.id ? "true" : undefined}><span className="route-card-top"><strong>{option.label ?? "Route option"}</strong><span>{option.operationalProxy?.eligible && option.operationalProxy.rank !== undefined ? `Rank ${option.operationalProxy.rank}` : "Unranked"}</span></span><span className="route-card-distance">{formatDistance(option.distanceNm ?? option.rankDistanceNm)}</span><span className="route-card-meta">{option.pointCount} points · {option.legs.length} legs · {option.gaps.length} visible gaps</span><span className="route-card-meta">{option.operationalProxy?.eligible ? "All waypoints found. Included in ranking." : option.operationalProxy?.exclusion ?? "This route has unresolved waypoints and cannot be ranked."}</span></button>)}</div></div>;
}

function RouteDetails({ route, onStartDraft }: { route: RouteOption; onStartDraft: () => void }) {
  const proxy = route.operationalProxy;
  return <section className="details-section" aria-labelledby="details-heading"><div className="section-title"><div><p className="eyebrow">INSPECT</p><h2 id="details-heading">Route data</h2></div><div className="detail-actions"><button className="edit-copy-button" type="button" onClick={onStartDraft}>Edit copy</button><span className="opaque-id" title="Opaque server flight ID">Flight ID {route.flightId}</span></div></div><div className="metric-grid"><Metric label="Route data" value={route.complete ? "All waypoints found" : "Some waypoints missing"} /><Metric label="Distance" value={formatDistance(route.distanceNm)} /><Metric label="Route rank" value={proxy?.eligible && proxy.rank !== undefined ? `Rank ${proxy.rank}` : "Not ranked"} /><Metric label="Points" value={String(route.pointCount)} note="Server-reported count" /></div><div className="detail-columns"><div className="table-wrap"><h3 id="route-legs-heading">Structured route detail</h3><RouteTable legs={route.legs} /></div><div className="evidence-stack"><Evidence label="How route ranking works" value={proxy?.eligible ? RANK_CRITERION : proxy?.exclusion ?? "This route has unresolved waypoints and cannot be ranked."} tone={proxy?.eligible ? "blue" : "red"} /><Evidence label="Provenance" value={route.provenance ?? "Not supplied by the route service."} tone="blue" /><Evidence label="Safety boundary" value={SAFETY_NOTICE} tone="amber" /><Evidence label={`Visible gaps${route.gaps.length ? ` · ${route.gaps.length}` : ""}`} value={route.gaps.length ? route.gaps.map((gap) => `Route position ${gap.sequence + 1}: ${gap.reason}`).join(" ") : "No gaps reported by the route service."} tone={route.gaps.length ? "red" : "green"} /></div></div></section>;
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>; }
function Evidence({ label, value, tone }: { label: string; value: string; tone: "blue" | "amber" | "red" | "green" }) { return <div className={`evidence evidence-${tone}`}><span>{label}</span><p>{value}</p></div>; }

function RouteTable({ legs }: { legs: RouteLeg[] }) {
  return legs.length ? <div className="table-scroll" tabIndex={0} aria-label="Scrollable route-leg table"><table aria-labelledby="route-legs-heading"><caption className="sr-only">Structured route legs and unresolved gaps</caption><thead><tr><th scope="col">Sequence</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Distance</th><th scope="col">Status</th></tr></thead><tbody>{legs.map((leg, index) => {
    const isGap = leg.status === "gap" || leg.kind === "gap" || !leg.from || !leg.to;
    return <tr className={isGap ? "gap-row" : undefined} key={leg.id}><th scope="row">{index + 1}</th>{isGap ? <td colSpan={2}><strong>Unresolved gap</strong><span className="gap-reason">{leg.reason ?? "The route service did not resolve this segment."}</span></td> : <><td>{leg.from}</td><td>{leg.to}</td></>}<td>{formatDistance(leg.distanceNm)}</td><td>{isGap ? "gap" : leg.status ?? "resolved"}</td></tr>;
  })}</tbody></table></div> : <p className="muted-copy">No leg data was supplied for this route. Nothing has been inferred.</p>;
}

function DraftEditor({ draft, baseline, loading, error, onUpdate, onClose }: { draft?: DraftComparison | undefined; baseline: RouteOption; loading: boolean; error?: string | undefined; onUpdate: (via: string[]) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PointMatch[]>([]);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string>();
  const via = draft?.draft.via ?? [];
  const delta = draft?.route.distanceNm !== undefined && baseline.distanceNm !== undefined ? draft.route.distanceNm - baseline.distanceNm : undefined;

  async function findReference() {
    const value = query.trim();
    if (!value) return;
    setLookupLoading(true);
    setLookupError(undefined);
    setMatches([]);
    try {
      const found = await lookupPoint(value);
      const uniquelyResolved = found.filter((match) => !match.duplicateGroup);
      setMatches(uniquelyResolved);
      if (!found.length) setLookupError("No exact reference point was returned. Free-form points cannot be added.");
      else if (!uniquelyResolved.length) setLookupError("This reference has multiple exact coordinates. It cannot be added until the service supports an explicit coordinate selection.");
    } catch (lookupFailure) {
      setLookupError(apiMessage(lookupFailure));
    } finally {
      setLookupLoading(false);
    }
  }

  return <section className="draft-section" aria-labelledby="draft-heading">
    <div className="section-title"><div><p className="eyebrow">EDIT COPY</p><h2 id="draft-heading">Local computational draft</h2></div><button className="quiet-button" type="button" onClick={onClose}>Close draft</button></div>
    <p className="draft-safety">Computationally complete; operational constraints not assessed. Endpoints are locked and every change is checked against exact reference data.</p>
    <div className="draft-endpoints"><span><strong>From</strong> {baseline.origin ?? "Selected origin"}</span><span><strong>To</strong> {baseline.destination ?? "Selected destination"}</span></div>
    <div className="draft-search"><label htmlFor="draft-point-search">Add an exact reference point</label><div className="search-input-row"><input id="draft-point-search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void findReference(); } else if (event.key === "Escape") { setMatches([]); setLookupError(undefined); } }} placeholder="Search an exact fix, NAVAID, or airport" /><button className="search-button" type="button" onClick={() => void findReference()} disabled={lookupLoading || !query.trim()} aria-label="Find exact reference point">{lookupLoading ? <span className="spinner" /> : "Find"}</button></div>{lookupError && <p className="field-error" role="alert">{lookupError}</p>}<div className="sr-status" aria-live="polite">{lookupLoading ? "Looking up exact reference points." : matches.length ? `${matches.length} exact reference point${matches.length === 1 ? "" : "s"} available.` : ""}</div>
      {matches.length > 0 && <div className="reference-picker" role="group" aria-label="Resolved reference-point search results">{matches.map((match) => <button type="button" key={`${match.identifier}-${match.coordinate.lat}-${match.coordinate.lon}`} onClick={() => { onUpdate([...via, match.identifier]); setQuery(""); setMatches([]); }}><span><strong>{match.identifier}</strong><small>{match.kind} · {match.coordinate.lat.toFixed(4)}, {match.coordinate.lon.toFixed(4)}</small></span><span>{match.duplicateGroup ? "Choose exact location" : "Add"}</span></button>)}</div>}
    </div>
    <div className="draft-points"><div className="group-heading"><h3>Intermediate points</h3><button className="text-button" type="button" onClick={() => onUpdate([])} disabled={!via.length || loading}>Reset to endpoint-only draft</button></div>{via.length ? <ol role="list">{via.map((point, index) => <li key={`${point}-${index}`}><span><strong>{point}</strong><small>Manual-direct segments are not airways.</small></span><span className="draft-row-actions"><button type="button" onClick={() => onUpdate(via.map((value, position) => position === index - 1 ? point : position === index ? via[index - 1]! : value))} disabled={loading || index === 0} aria-label={`Move ${point} up`}>Move up</button><button type="button" onClick={() => onUpdate(via.map((value, position) => position === index + 1 ? point : position === index ? via[index + 1]! : value))} disabled={loading || index === via.length - 1} aria-label={`Move ${point} down`}>Move down</button><button type="button" onClick={() => onUpdate(via.filter((_, position) => position !== index))} disabled={loading} aria-label={`Remove ${point}`}>Remove</button></span></li>)}</ol> : <p className="muted-copy">No intermediate points. This draft uses a direct modeled endpoint-to-endpoint segment.</p>}</div>
    {loading && <div className="loading-row"><span className="spinner dark" /> Validating the local draft…</div>}{error && <div className="notice error-notice" role="alert"><span>{error}</span><button className="retry-button" type="button" onClick={() => onUpdate(via)} disabled={loading}>Retry draft validation</button></div>}
    {draft && <div className="draft-result"><Metric label="Draft status" value={draft.comparison.status === "complete" ? "Complete" : "Incomplete"} /><Metric label="Modeled distance" value={formatDistance(draft.route.distanceNm)} /><Metric label="Change from selected route" value={delta === undefined ? "Unavailable" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} NM`} /><Metric label="Draft gaps" value={String(draft.route.gaps.length)} note={draft.comparison.message} /></div>}
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
    {route && <div className="map-endpoints" aria-label="Route endpoint locations"><div className="map-endpoint departure"><b>Departure</b><span>{departureLabel}</span></div><div className="map-endpoint arrival"><b>Arrival</b><span>{arrivalLabel}</span></div></div>}
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
