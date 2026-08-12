import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  fetchRouteOptions,
  searchCallsigns,
  type CallsignMatch,
  type Coordinate,
  type RouteLeg,
  type RouteOption,
} from "./api";

type SearchState = { query: string; matches: CallsignMatch[]; loading: boolean; error?: string | undefined };
const emptySearch: SearchState = { query: "", matches: [], loading: false };
const RANK_CRITERION = "Rank 1 by shortest modeled distance among complete candidates.";
const SAFETY_NOTICE = "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.";

function formatDistance(value: number | undefined): string {
  return value === undefined ? "Not supplied" : `${value.toFixed(1)} NM`;
}

function apiMessage(error: unknown): string {
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
  const [status, setStatus] = useState("");
  const routeRequest = useRef(0);
  const searchRequest = useRef<AbortController | undefined>(undefined);

  function updateQuery(query: string) {
    setSearch({ query, matches: [], loading: false });
  }

  async function runSearch() {
    const query = search.query.trim();
    if (!query) return;
    searchRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    setSearch((current) => ({ ...current, loading: true, matches: [], error: undefined }));
    setStatus(`Searching flight plans for ${query}.`);
    try {
      const matches = await searchCallsigns(query, controller.signal);
      setSearch((current) => ({ ...current, loading: false, matches }));
      setStatus(matches.length ? `${matches.length} flight plan match${matches.length === 1 ? "" : "es"} found. Choose one to continue.` : `No flight plans matched ${query}.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSearch((current) => ({ ...current, loading: false, error: apiMessage(error) }));
      setStatus("Flight-plan search failed.");
    }
  }

  function chooseFlight(match: CallsignMatch) {
    searchRequest.current?.abort();
    setSelectedFlight(match);
    setSearch({ query: match.callsign, matches: [], loading: false });
    setStatus(`Selected flight ${match.callsign}, departing ${match.departure} for ${match.destination}. Loading route options.`);
  }

  useEffect(() => {
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
  }, [selectedFlight]);

  function resetAll() {
    searchRequest.current?.abort();
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
    <div className="app-shell">
      <div className="safety-banner" role="note"><span>{SAFETY_NOTICE}</span></div>
      <header className="topbar">
        <div>
          <p className="eyebrow">FLIGHT ROUTE EXPLORER</p>
          <h1>Inspect a recorded flight plan.</h1>
          <p className="lede">Search a real callsign, disambiguate duplicate flight plans, and inspect only the route data returned by the service.</p>
        </div>
        <button className="quiet-button" type="button" onClick={resetAll}>Clear session</button>
      </header>

      <main className="workspace">
        <section className="map-panel" aria-labelledby="map-heading">
          <div className="panel-heading">
            <div><p className="eyebrow">MAP VIEW</p><h2 id="map-heading">Route overview</h2></div>
            <span className="status-chip"><span className="status-dot" /> Server-returned data</span>
          </div>
          <RouteMap route={selectedRoute} callsign={selectedFlight?.callsign} />
          <div className="map-legend" aria-label="Map legend"><span><i className="legend-line" /> Resolved route segment</span><span><i className="legend-gap" /> Unresolved gap</span></div>
        </section>

        <aside className="control-panel" aria-label="Flight-plan controls">
          <div className="panel-heading compact"><div><p className="eyebrow">SELECT A FLIGHT PLAN</p><h2>Which callsign?</h2></div></div>
          <SearchBox selected={selectedFlight} state={search} onFocus={() => undefined} onQuery={updateQuery} onSearch={() => void runSearch()} onSelect={chooseFlight} />
          {selectedFlight && <div className="selected-flight" aria-label="Selected flight plan"><span className="check">✓</span><div><strong>{selectedFlight.callsign}</strong><span>{selectedFlight.departure} → {selectedFlight.destination}</span><small>{selectedFlight.routePointCount} recorded route points · opaque ID retained for this session</small></div></div>}
          <div className="privacy-note"><span aria-hidden="true">◌</span> Nothing is saved beyond this browser session.</div>
          <div className="sr-status" aria-live="polite">{routeLoading ? "Loading route options." : status}</div>
        </aside>
      </main>

      <section className="below-fold" aria-live="polite">
        <RouteOptions options={options} selected={selectedRoute} loading={routeLoading} error={routeError} onSelect={(option) => { setSelectedRoute(option); setStatus(`Selected ${option.label ?? "route option"}.`); }} />
        {selectedRoute && <RouteDetails route={selectedRoute} />}
      </section>
    </div>
  );
}

function SearchBox({ selected, state, onFocus, onQuery, onSearch, onSelect }: { selected?: CallsignMatch | undefined; state: SearchState; onFocus: () => void; onQuery: (value: string) => void; onSearch: () => void; onSelect: (match: CallsignMatch) => void }) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasResults = state.matches.length > 0;
  const resultId = "flight-search-results";

  useEffect(() => setActiveIndex(-1), [state.matches]);

  function select(match: CallsignMatch) {
    onSelect(match);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <div className={`search-block ${hasResults ? "is-active" : ""}`}>
      <label htmlFor="flight-search">Callsign or flight-plan identifier</label>
      <div className="search-input-row">
        <input ref={inputRef} id="flight-search" role="combobox" value={state.query} onFocus={onFocus} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "ArrowDown" && hasResults) { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, state.matches.length - 1)); }
          else if (event.key === "ArrowUp" && hasResults) { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
          else if (event.key === "Enter") { event.preventDefault(); if (activeIndex >= 0 && state.matches[activeIndex]) select(state.matches[activeIndex]); else onSearch(); }
          else if (event.key === "Escape") setActiveIndex(-1);
        }} aria-expanded={hasResults} aria-controls={hasResults ? resultId : undefined} aria-activedescendant={activeIndex >= 0 ? `flight-match-${activeIndex}` : undefined} placeholder="Search by callsign" autoComplete="off" />
        <button className="search-button" type="button" onClick={onSearch} disabled={state.loading || !state.query.trim()} aria-label="Search flight plans">{state.loading ? <span className="spinner" /> : "↗"}</button>
      </div>
      {selected && <p className="selected-value"><span className="check">✓</span> Selected <strong>{selected.callsign}</strong> <span>{selected.departure} → {selected.destination}</span></p>}
      {state.error && <p className="field-error" role="alert">{state.error}</p>}
      {hasResults && <div className="duplicate-picker" id={resultId} role="listbox" aria-label="Choose an exact flight-plan match"><p className="picker-label">{state.matches.length > 1 ? "Multiple flight plans — choose the exact record" : "Flight-plan match"}</p>{state.matches.map((match, index) => <button className={`match-option ${activeIndex === index ? "is-active" : ""}`} id={`flight-match-${index}`} type="button" role="option" aria-selected={activeIndex === index} key={match.id} onMouseDown={(event) => event.preventDefault()} onClick={() => select(match)}><span><strong>{match.callsign}</strong><small>{match.departure} → {match.destination} · {match.routePointCount} recorded points</small></span><span aria-hidden="true">›</span></button>)}</div>}
      {!state.loading && state.query.trim() && !state.error && !hasResults && !selected && <p className="helper-text">No matching flight plans returned.</p>}
    </div>
  );
}

function RouteOptions({ options, selected, loading, error, onSelect }: { options: RouteOption[]; selected?: RouteOption | undefined; loading: boolean; error?: string | undefined; onSelect: (route: RouteOption) => void }) {
  if (!loading && !error && options.length === 0) return <section className="empty-options"><span className="empty-icon">⌁</span><div><h2>Route options will appear here</h2><p>Select one flight plan above to request its recorded route options.</p></div></section>;
  const complete = options.filter((option) => option.complete);
  const incomplete = options.filter((option) => !option.complete);
  return <section className="options-section" aria-labelledby="options-heading"><div className="section-title"><div><p className="eyebrow">COMPARE</p><h2 id="options-heading">Route options</h2></div>{options.length > 0 && <span className="count-label">{options.length} returned</span>}</div>{loading && <div className="loading-row"><span className="spinner dark" /> Asking for the selected flight’s options…</div>}{error && <div className="notice error-notice" role="alert"><strong>Could not load route options.</strong><span>{error}</span></div>}{!loading && !error && options.length === 0 && <p className="muted-copy">The service returned no route options. This is a visible gap, not an estimated route.</p>}{complete.length > 0 && <RouteGroup title="Complete routes — ranked by modeled distance" count={`${complete.length} ranked candidate${complete.length === 1 ? "" : "s"}`} criterion={RANK_CRITERION} options={complete} selected={selected} onSelect={onSelect} />}{incomplete.length > 0 && <RouteGroup title="Incomplete routes — not ranked" count={`${incomplete.length} incomplete candidate${incomplete.length === 1 ? "" : "s"}`} options={incomplete} selected={selected} onSelect={onSelect} />}</section>;
}

function RouteGroup({ title, count, criterion, options, selected, onSelect }: { title: string; count: string; criterion?: string | undefined; options: RouteOption[]; selected?: RouteOption | undefined; onSelect: (route: RouteOption) => void }) {
  return <div className="route-group"><div className="group-heading"><div><h3>{title}</h3>{criterion && <p className="criterion-copy">{criterion} It is a mathematical comparison only, not a safety, clearance, legality, or recommendation claim.</p>}</div><span className="group-count">{count}</span></div><div className="option-grid">{options.map((option) => <button type="button" className={`route-card ${selected?.id === option.id ? "selected" : ""} ${option.complete ? "is-complete" : "is-incomplete"}`} key={option.id} onClick={() => onSelect(option)} aria-pressed={selected?.id === option.id}><span className="route-card-top"><strong>{option.label ?? "Route option"}</strong><span>{option.complete && option.rank !== undefined ? `Rank ${option.rank}` : "Unranked"}</span></span><span className="route-card-distance">{formatDistance(option.distanceNm ?? option.rankDistanceNm)}</span><span className="route-card-meta">{option.pointCount} points · {option.legs.length} legs · {option.gaps.length} visible gaps</span><span className="route-card-meta">{option.provenance ?? "Provenance not supplied"}</span></button>)}</div></div>;
}

function RouteDetails({ route }: { route: RouteOption }) {
  return <section className="details-section" aria-labelledby="details-heading"><div className="section-title"><div><p className="eyebrow">INSPECT</p><h2 id="details-heading">Route data</h2></div><span className="opaque-id" title="Opaque server flight ID">Flight ID {route.flightId}</span></div><div className="metric-grid"><Metric label="Status" value={route.complete ? "Complete" : "Incomplete"} /><Metric label="Distance" value={formatDistance(route.distanceNm)} /><Metric label="Rank" value={route.rank !== undefined ? `Rank ${route.rank}` : "Unranked"} /><Metric label="Points" value={String(route.pointCount)} note="Server-reported count" /></div><div className="detail-columns"><div className="table-wrap"><h3>Structured route detail</h3><RouteTable legs={route.legs} /></div><div className="evidence-stack"><Evidence label="Ranking criterion" value={route.complete && route.rank === 1 ? RANK_CRITERION : route.complete ? "Complete candidate; rank is based on modeled distance." : "Incomplete candidate; not included in ranking."} tone="blue" /><Evidence label="Provenance" value={route.provenance ?? "Not supplied by the route service."} tone="blue" /><Evidence label="Safety boundary" value={SAFETY_NOTICE} tone="amber" /><Evidence label={`Visible gaps${route.gaps.length ? ` · ${route.gaps.length}` : ""}`} value={route.gaps.length ? route.gaps.map((gap) => `Segment ${gap.sequence}: ${gap.reason}`).join(" ") : "No gaps reported by the route service."} tone={route.gaps.length ? "red" : "green"} /></div></div></section>;
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>; }
function Evidence({ label, value, tone }: { label: string; value: string; tone: "blue" | "amber" | "red" | "green" }) { return <div className={`evidence evidence-${tone}`}><span>{label}</span><p>{value}</p></div>; }

function RouteTable({ legs }: { legs: RouteLeg[] }) {
  return legs.length ? <div className="table-scroll"><table><caption className="sr-only">Structured route legs and unresolved gaps</caption><thead><tr><th scope="col">Sequence</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Distance</th><th scope="col">Status</th></tr></thead><tbody>{legs.map((leg, index) => {
    const isGap = leg.status === "gap" || leg.kind === "gap" || !leg.from || !leg.to;
    return <tr className={isGap ? "gap-row" : undefined} key={leg.id}><th scope="row">{leg.sequence ?? index + 1}</th>{isGap ? <td colSpan={2}><strong>Unresolved gap</strong><span className="gap-reason">{leg.reason ?? "The route service did not resolve this segment."}</span></td> : <><td>{leg.from}</td><td>{leg.to}</td></>}<td>{formatDistance(leg.distanceNm)}</td><td>{isGap ? "gap" : leg.status ?? "resolved"}</td></tr>;
  })}</tbody></table></div> : <p className="muted-copy">No leg data was supplied for this route. Nothing has been inferred.</p>;
}

function RouteMap({ route, callsign }: { route?: RouteOption | undefined; callsign?: string | undefined }) {
  const sourceSegments = useMemo(() => route?.segments ?? (route?.geometry ? [route.geometry] : []), [route]);
  const projection = useMemo(() => projectSegments(sourceSegments), [sourceSegments]);
  const hasLine = Boolean(projection?.segments.length);
  const incomplete = route && !route.complete;
  const label = hasLine ? `${callsign ?? "Selected flight"} route diagram with ${projection?.segments.length} resolved segment${projection?.segments.length === 1 ? "" : "s"}${incomplete ? " and visible unresolved gaps" : ""}` : "Route map waiting for server-returned route segments";
  return <div className="map-stage" role="img" aria-label={label}><div className="map-fallback-banner"><span className="map-pin">◇</span><span>{incomplete ? "Showing resolved segments only; gaps are not connected." : hasLine ? "Server route geometry" : "No route geometry returned yet."}</span></div><svg className="route-svg" viewBox="0 0 800 440" aria-hidden="true"><defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeOpacity=".08" strokeWidth="1" /></pattern><filter id="glow"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs><rect width="800" height="440" fill="url(#grid)" />{projection?.segments.map((segment, index) => <g key={`segment-${index}`}><path d={segment.path} className="route-shadow" filter="url(#glow)" /><path d={segment.path} className="route-path" /></g>)}{projection?.start && <MapMarker point={projection.start} label={callsign ?? "Start"} tone="origin" />}{projection?.end && <MapMarker point={projection.end} label="End" tone="destination" />}{projection?.gapBoundaries.map((point, index) => <g key={`gap-${index}`} className="gap-boundary"><circle cx={point.x} cy={point.y} r="7" /><text x={point.x + 12} y={point.y + 4}>Gap</text></g>)}</svg>{!hasLine && <div className="map-empty"><span>◎</span><strong>{route ? "No resolved geometry returned" : "Select a flight plan"}</strong><p>{route ? "The map does not infer a line across missing route data." : "The map will use only coordinates and route segments returned by the server."}</p></div>}<div className="map-attribution">No external map tiles or API keys · Data from same-origin route service</div></div>;
}

function MapMarker({ point, label, tone }: { point: Point; label: string; tone: "origin" | "destination" }) { return <g className={`map-marker marker-${tone}`}><circle cx={point.x} cy={point.y} r="8" /><circle cx={point.x} cy={point.y} r="15" className="marker-ring" /><text x={point.x + 16} y={point.y - 12}>{label}</text></g>; }
type Point = { x: number; y: number };
type ProjectedSegments = { segments: Array<{ path: string }>; start?: Point | undefined; end?: Point | undefined; gapBoundaries: Point[] };
function projectSegments(segments: Coordinate[][]): ProjectedSegments | undefined {
  const validSegments = segments.filter((segment) => segment.length >= 2);
  const points = validSegments.flat();
  if (points.length < 2) return undefined;
  const lats = points.map((point) => point.lat); const lons = points.map((point) => point.lon);
  const minLat = Math.min(...lats); const maxLat = Math.max(...lats); const minLon = Math.min(...lons); const maxLon = Math.max(...lons);
  const latSpan = Math.max(maxLat - minLat, 1); const lonSpan = Math.max(maxLon - minLon, 1); const pad = 85;
  const x = (lon: number) => pad + ((lon - minLon) / lonSpan) * (800 - pad * 2); const y = (lat: number) => 440 - pad - ((lat - minLat) / latSpan) * (440 - pad * 2);
  const projected = validSegments.map((segment) => segment.map((point) => ({ x: x(point.lon), y: y(point.lat) })));
  return {
    segments: projected.map((segment) => ({ path: segment.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ") })),
    start: projected[0]?.[0],
    end: projected.at(-1)?.at(-1),
    gapBoundaries: projected.slice(0, -1).flatMap((segment, index) => projected[index + 1] ? [segment.at(-1)!, projected[index + 1]![0]!] : []),
  };
}

export default App;
