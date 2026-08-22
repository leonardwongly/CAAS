// "API data" page (owner request 2026-08-15): live data summary with family
// counts (airways counts only — values never rendered anywhere), an endpoint
// explorer that runs each existing API and shows the raw JSON, and a bulk
// data browser over the /api/v1/data/* endpoints. Queries and cursors travel
// in POST bodies only; no token or query state appears in a URL.
import { useEffect, useState } from "react";
import {
  ApiError,
  browseAirports,
  browseFixes,
  browseFlights,
  browseNavaids,
  fetchDataSummary,
  fetchReadiness,
  fetchRouteData,
  fetchRouteOptions,
  lookupPoint,
  refreshLiveData,
  searchCallsigns,
  validateDraft,
  type BrowsePage,
  type CallsignMatch,
  type DataSummary,
  type FlightBrowseItem,
  type ReferenceBrowseItem,
  type RouteOption,
} from "./api";
import { REFRESH_CONFIRM } from "./labels";

function apiMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A malformed timestamp must never render the literal "Invalid Date". */
function formatRetrievedAt(value: string | undefined): string {
  if (value === undefined) return "unknown time";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "unknown time" : parsed.toLocaleTimeString();
}

type FamilyKey = "flights" | "fixes" | "airports" | "navaids";
const FAMILY_LABELS: Record<FamilyKey, string> = { flights: "Flight plans", fixes: "Fixes", airports: "Airports", navaids: "NAVAIDs" };
const FAMILY_KEYS = Object.keys(FAMILY_LABELS) as FamilyKey[];

type RunState = { loading: boolean; result?: unknown | undefined; error?: string | undefined };
const initialRun: RunState = { loading: false };

export default function ApiDataPage({ selectedFlight, selectedRoute, onBack }: { selectedFlight?: CallsignMatch | undefined; selectedRoute?: RouteOption | undefined; onBack: () => void }) {
  const [summary, setSummary] = useState<DataSummary>();
  const [summaryError, setSummaryError] = useState<string>();
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [searchQuery, setSearchQuery] = useState("SIA");
  const [lookupQuery, setLookupQuery] = useState("");
  const [family, setFamily] = useState<FamilyKey>("flights");
  const [limit, setLimit] = useState(50);
  const [items, setItems] = useState<Array<FlightBrowseItem | ReferenceBrowseItem>>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [history, setHistory] = useState<Array<string | undefined>>([undefined]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetchDataSummary(controller.signal)
      .then((loaded) => { if (!controller.signal.aborted) setSummary(loaded); })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!controller.signal.aborted) setSummaryError(apiMessage(error));
      });
    return () => controller.abort();
  }, []);

  async function run(key: string, action: () => Promise<unknown>) {
    setRuns((current) => ({ ...current, [key]: { loading: true } }));
    try {
      const result = await action();
      setRuns((current) => ({ ...current, [key]: { loading: false, result } }));
    } catch (error) {
      setRuns((current) => ({ ...current, [key]: { loading: false, error: apiMessage(error) } }));
    }
  }

  function browsePage(familyKey: FamilyKey, cursor: string | undefined): Promise<BrowsePage<FlightBrowseItem | ReferenceBrowseItem>> {
    const request = familyKey === "flights" ? browseFlights(limit, cursor) : familyKey === "fixes" ? browseFixes(limit, cursor) : familyKey === "airports" ? browseAirports(limit, cursor) : browseNavaids(limit, cursor);
    return request as Promise<BrowsePage<FlightBrowseItem | ReferenceBrowseItem>>;
  }

  async function loadPage(familyKey: FamilyKey, cursor: string | undefined) {
    setBrowseLoading(true);
    setBrowseError(undefined);
    try {
      const page = await browsePage(familyKey, cursor);
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (error instanceof ApiError && error.code === "CURSOR_EXPIRED") {
        // A refresh invalidated the held cursor: fail closed back to page one.
        setBrowseError("The browse cursor expired after a data refresh. Restarting from the first page.");
        setHistory([undefined]);
        setItems([]);
        setNextCursor(undefined);
      } else {
        setBrowseError(apiMessage(error));
      }
    } finally {
      setBrowseLoading(false);
    }
  }

  useEffect(() => {
    // The family and limit drive the page; history resets with them.
    setHistory([undefined]);
    void loadPage(family, undefined);
  }, [family, limit]);

  const goNext = () => { if (!nextCursor) return; setHistory((current) => [...current, nextCursor]); void loadPage(family, nextCursor); };
  const goBack = () => {
    if (history.length < 2) return;
    const previous = history[history.length - 2];
    setHistory((current) => current.slice(0, -1));
    void loadPage(family, previous);
  };

  const explorerCards: Array<{ key: string; method: string; path: string; disabled?: boolean; disabledHint?: string; run: () => void }> = [
    { key: "readiness", method: "GET", path: "/api/v1/readiness", run: () => void run("readiness", () => fetchReadiness()) },
    { key: "search", method: "POST", path: "/api/v1/callsigns/search", run: () => void run("search", () => searchCallsigns(searchQuery)) },
    {
      key: "options",
      method: "POST",
      path: "/api/v1/routes/options",
      disabled: !selectedFlight,
      disabledHint: "Select a flight on the map first.",
      run: () => { if (selectedFlight) void run("options", () => fetchRouteOptions(selectedFlight.flightId)); },
    },
    {
      key: "detail",
      method: "POST",
      path: "/api/v1/routes/detail",
      disabled: !selectedRoute,
      disabledHint: "Select a route on the map first.",
      run: () => { if (selectedRoute) void run("detail", () => fetchRouteData(selectedRoute.id)); },
    },
    { key: "lookup", method: "POST", path: "/api/v1/points/lookup", run: () => void run("lookup", () => lookupPoint(lookupQuery)) },
    {
      key: "compare",
      method: "POST",
      path: "/api/v1/routes/compare",
      disabled: !selectedRoute,
      disabledHint: "Select a route on the map first.",
      run: () => {
        if (!selectedRoute?.origin || !selectedRoute.destination || !selectedRoute.flightId) return;
        void run("compare", () => validateDraft(selectedRoute.origin!, selectedRoute.destination!, [], [], selectedRoute.flightId));
      },
    },
    {
      key: "refresh",
      method: "POST",
      path: "/api/v1/refresh",
      run: () => { if (window.confirm(REFRESH_CONFIRM)) void run("refresh", () => refreshLiveData()); },
    },
  ];

  const runState = (key: string): RunState => runs[key] ?? initialRun;

  return <div className="api-data-page">
    <div className="api-data-header" role="region" aria-label="API data overview">
      <div>
        <p className="eyebrow">FLIGHT ROUTE EXPLORER</p>
        <h2 id="api-data-heading" tabIndex={-1}>API data</h2>
        <p className="lede">Live generation summary, every application endpoint with raw responses, and bulk browsing of the normalized datasets. Airway values are never exposed — counts only.</p>
      </div>
      <button className="quiet-button" type="button" onClick={onBack}>Back to map</button>
    </div>

    <section className="api-data-section" aria-labelledby="summary-heading">
      <h2 id="summary-heading">Live data summary</h2>
      {summaryError && <div className="notice error-notice" role="alert"><strong>Could not load the data summary.</strong><span>{summaryError}</span></div>}
      {!summary && !summaryError && <div className="loading-row"><span className="spinner dark" /> Loading the data summary…</div>}
      {summary && <>
        <div className="summary-generation" role="status">Live data <strong>{summary.generation.live.state}</strong> · retrieved {formatRetrievedAt(summary.generation.live.retrievedAt)}</div>
        <table className="api-data-table" aria-label="Family record counts">
          <caption className="sr-only">Record counts per data family in the active generation</caption>
          <thead><tr><th scope="col">Family</th><th scope="col">Records</th><th scope="col">Accepted</th><th scope="col">Rejected</th></tr></thead>
          <tbody>
            {summary.families.map((row) => <tr key={row.family}><th scope="row">{row.family}</th><td>{row.records.toLocaleString()}</td><td>{row.acceptedRecords !== undefined ? row.acceptedRecords.toLocaleString() : "—"}</td><td>{row.rejectedRecords !== undefined ? row.rejectedRecords.toLocaleString() : "—"}</td></tr>)}
            <tr className="airway-row"><th scope="row">airways</th><td>{summary.airway.records.toLocaleString()}</td><td>{summary.airway.acceptedRecords !== undefined ? summary.airway.acceptedRecords.toLocaleString() : "—"}</td><td>{summary.airway.rejectedRecords !== undefined ? summary.airway.rejectedRecords.toLocaleString() : "—"}</td></tr>
          </tbody>
        </table>
        <p className="helper-text">Airways: {summary.airway.records.toLocaleString()} records parsed and count-validated{summary.airway.uniqueRecords !== undefined ? `, ${summary.airway.uniqueRecords.toLocaleString()} unique` : ""}. Airway values are not exposed.</p>
      </>}
    </section>

    <section className="api-data-section" aria-labelledby="explorer-heading">
      <h2 id="explorer-heading">Endpoint explorer</h2>
      <div className="explorer-grid">
        {explorerCards.map((card) => {
          const state = runState(card.key);
          return <div className={`explorer-card ${state.error ? "has-error" : ""}`} key={card.key}>
            <div className="explorer-card-head"><span className="explorer-method">{card.method}</span><code>{card.path}</code></div>
            {card.key === "search" && <label className="explorer-input">Query<input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} maxLength={64} /></label>}
            {card.key === "lookup" && <label className="explorer-input">Reference<input value={lookupQuery} onChange={(event) => setLookupQuery(event.target.value)} maxLength={64} /></label>}
            <button className="retry-button explorer-run" type="button" onClick={card.run} disabled={state.loading || card.disabled}>{state.loading ? <span className="spinner dark" /> : "Run"}</button>
            {card.disabled && card.disabledHint && <p className="helper-text">{card.disabledHint}</p>}
            {state.error && <div className="notice error-notice" role="alert"><span>{state.error}</span></div>}
            {state.result !== undefined && <pre className="explorer-json">{JSON.stringify(state.result, null, 2).split("\n").map((line, index) => <span className="json-line" key={index}>{line}</span>)}</pre>}
          </div>;
        })}
      </div>
    </section>

    <section className="api-data-section" aria-labelledby="browse-heading">
      <h2 id="browse-heading">Bulk data browser</h2>
      <div className="browse-controls" role="group" aria-label="Bulk browser controls">
        <div className="browse-tabs" role="tablist" aria-label="Data family">
          {FAMILY_KEYS.map((key) => <button key={key} type="button" role="tab" aria-selected={family === key} className={family === key ? "is-active" : undefined} onClick={() => setFamily(key)}>{FAMILY_LABELS[key]}</button>)}
        </div>
        <label className="browse-limit">Page size<select value={String(limit)} onChange={(event) => setLimit(Number(event.target.value))}><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label>
      </div>
      {browseError && <div className="notice error-notice" role="alert"><span>{browseError}</span></div>}
      <div className="table-scroll" role="group" tabIndex={0} aria-label={`Scrollable ${FAMILY_LABELS[family]} browse table`}>
        <table aria-label={`${FAMILY_LABELS[family]} browse results`}>
          <caption className="sr-only">{FAMILY_LABELS[family]} records, normalized public fields only</caption>
          {family === "flights" ? <thead><tr><th scope="col">Callsign</th><th scope="col">Route</th><th scope="col">Recorded points</th></tr></thead> : <thead><tr><th scope="col">Identifier</th><th scope="col">Kind</th><th scope="col">Latitude</th><th scope="col">Longitude</th></tr></thead>}
          <tbody>
            {family === "flights"
              ? (items as FlightBrowseItem[]).map((item) => <tr key={item.id}><th scope="row">{item.callsign}</th><td>{item.departure} → {item.destination}</td><td>{item.pointCount}</td></tr>)
              : (items as ReferenceBrowseItem[]).map((item) => <tr key={item.id}><th scope="row">{item.identifier}</th><td>{item.kind}</td><td>{item.coordinate.lat.toFixed(4)}</td><td>{item.coordinate.lon.toFixed(4)}</td></tr>)}
          </tbody>
        </table>
      </div>
      <div className="browse-pager">
        <button className="quiet-button" type="button" onClick={goBack} disabled={browseLoading || history.length < 2}>Previous</button>
        <span aria-live="polite">{browseLoading ? "Loading…" : items.length ? `${items.length} rows shown` : "No rows returned"}</span>
        <button className="quiet-button" type="button" onClick={goNext} disabled={browseLoading || !nextCursor}>Next</button>
      </div>
    </section>
  </div>;
}
