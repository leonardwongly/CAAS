# DISPATCH Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Flight Route Explorer from the dark-navy SaaS dashboard into the "DISPATCH" instrument-grade briefing studio: chart-paper token layer, self-hosted aeronautical typography, docked three-band briefing frame, printed map symbology, and calm document-style trust presentation.

**Architecture:** The redesign is CSS-token-first plus a markup restructure of `apps/web/src/App.tsx`. Phase 1 (Tasks 1–3) swaps the `:root` palette/fonts so ~80% of components restyle without structural change. Phase 2 (Tasks 4–6) replaces floating HUD/rail/drawer markup with the docked frame (Command Strip · Manifest · Map Canvas · Workbench · Doc-Control Footer). Phase 3 (Tasks 7–9) upgrades map symbology, motion, and responsive behavior. Existing class names and ARIA names pinned by the test suite are preserved or their pinning tests are updated in the same task.

**Tech Stack:** React 19 + Vite 8 (plain CSS, zero new runtime dependencies), self-hosted WOFF2 fonts vendored into `apps/web/public/fonts/`, Vitest + Testing Library (jsdom) and Playwright regression lanes unchanged in harness.

---

## Test-Contract Constraints (READ FIRST)

These anchors are pinned by tests and MUST survive the redesign unless the task explicitly updates the pinning test:

| Anchor | Pinned by |
|---|---|
| `.map-stage`, `.map-drawer`, `.overview-flight-buttons button`, `.safety-banner` | `tests/browser/map-controls.spec.ts`, `tests/browser/critical-path.spec.ts`, `tests/e2e/interaction.test.tsx` |
| `.map-hud strong` text queries | `tests/e2e/interaction.test.tsx` |
| `.route-path` (count 1 for selection), `.route-path-alternate`, `.route-hit` (16px stroke), `.rail-count` | `tests/e2e/interaction.test.tsx`, `tests/e2e/map-tiles.test.tsx` |
| `.route-path-potential` computed `strokeDasharray` | `tests/browser/map-controls.spec.ts` — **updated to `6px, 6px` in Task 11** |
| `.world-ocean` fallback base | `tests/e2e/map-tiles.test.tsx` |
| `nav` "Route workspace controls"; regions "Route chooser", "Route comparison", "Flight and route data", "Observed-donor synthesis", "Explore a route variation", "Safety notice"; group "Selected flight" | `tests/e2e/keyboard.test.tsx`, `tests/a11y/aria-structure.test.tsx` |
| Button names "Routes", "Data", "Explore variation", "Compare", "Map only", "API data", "Toggle base map", "Show observed-donor synthesis" | `tests/e2e/*` |
| `SAFETY_NOTICE` rendered verbatim in App.tsx; `labels.ts` copy intact | `tests/route-safety/web-copy.test.ts`, `tests/a11y/aria-structure.test.tsx` |
| `styles.css` static contracts (320px min-width, reduced-motion, forced-colors, focus rules, `@media (max-width: 760px)` block) | `tests/responsive/responsive-css.test.ts` — **rewritten in Task 11 to pin the NEW contract** |
| `.table-scroll` `overflow-x: auto`, `table` `min-width: 540px` | `tests/responsive/responsive-css.test.ts` (kept) |

Additional hard rules:
- `Escape` still closes the open workbench surface; focus return to the spine trigger stays deterministic.
- Distance figures render in IBM Plex Mono with `font-variant-numeric: tabular-nums`; thin space (U+202F) thousands separator.
- All new interactive map chrome has ≥44px touch targets; radius 2px everywhere; focus = 2px offset ink outline.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/public/fonts/*.woff2` | Vendored Big Shoulders 600/800, IBM Plex Sans 400/600, IBM Plex Mono 400/700 (latin subset) |
| `apps/web/src/fonts.css` | `@font-face` declarations only |
| `apps/web/src/styles.css` | Token layer + frame + component + map-chrome + motion + responsive CSS (rewritten in stages) |
| `apps/web/src/App.tsx` | Shell restructure: Command Strip, Advisory Band, briefing frame, Workbench, Doc-Control Footer; map chrome JSX |
| `apps/web/src/labels.ts` | Adds `ADVISORY_HEADLINE` one-sentence strip copy |
| `apps/web/src/ApiDataPage.tsx` | Worksheet restyle: line-numbered teletype JSON |
| `apps/web/index.html` | theme-color update only |
| `tests/e2e/dispatch-frame.test.tsx` | New: frame presence/structure assertions |
| `tests/responsive/responsive-css.test.ts` | Updated: pins the new DISPATCH CSS contract |

---

### Task 1: Vendor self-hosted fonts

**Files:**
- Create: `apps/web/public/fonts/` (5 WOFF2 files)
- Create: `apps/web/src/fonts.css`
- Modify: `apps/web/src/main.tsx:4`

- [ ] **Step 1: Download the latin WOFF2 subsets (no new dependencies — vendored static assets)**

```bash
cd apps/web/public/fonts
BASE=https://cdn.jsdelivr.net/npm
curl -fsSL -o big-shoulders-600.woff2 "$BASE/@fontsource/big-shoulders@5/files/big-shoulders-latin-600-normal.woff2"
curl -fsSL -o big-shoulders-800.woff2 "$BASE/@fontsource/big-shoulders@5/files/big-shoulders-latin-800-normal.woff2"
curl -fsSL -o plex-sans-400.woff2     "$BASE/@fontsource/ibm-plex-sans@5/files/ibm-plex-sans-latin-400-normal.woff2"
curl -fsSL -o plex-sans-600.woff2     "$BASE/@fontsource/ibm-plex-sans@5/files/ibm-plex-sans-latin-600-normal.woff2"
curl -fsSL -o plex-mono-400.woff2     "$BASE/@fontsource/ibm-plex-mono@5/files/ibm-plex-mono-latin-400-normal.woff2"
curl -fsSL -o plex-mono-700.woff2     "$BASE/@fontsource/ibm-plex-mono@5/files/ibm-plex-mono-latin-700-normal.woff2"
ls -la # every file must be a non-empty WOFF2 (≥10KB)
```

If a 404 occurs (fontsource file naming drift), resolve the current URL via the Google Fonts CSS2 API and download the `latin` `woff2` entries:

```bash
curl -fsSL -A "Mozilla/5.0 (Macintosh)" "https://fonts.googleapis.com/css2?family=Big+Shoulders:wght@600;800&family=IBM+Plex+Mono:wght@400;700&family=IBM+Plex+Sans:wght@400;600&display=swap"
# then curl each url(...) into the matching filename above
```

- [ ] **Step 2: Create `apps/web/src/fonts.css`**

```css
@font-face { font-family: "Big Shoulders"; font-style: normal; font-weight: 600; font-display: swap; src: url("/fonts/big-shoulders-600.woff2") format("woff2"); }
@font-face { font-family: "Big Shoulders"; font-style: normal; font-weight: 800; font-display: swap; src: url("/fonts/big-shoulders-800.woff2") format("woff2"); }
@font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/plex-sans-400.woff2") format("woff2"); }
@font-face { font-family: "IBM Plex Sans"; font-style: normal; font-weight: 600; font-display: swap; src: url("/fonts/plex-sans-600.woff2") format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/plex-mono-400.woff2") format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 700; font-display: swap; src: url("/fonts/plex-mono-700.woff2") format("woff2"); }
```

- [ ] **Step 3: Import in `apps/web/src/main.tsx` before styles.css**

```tsx
import "./fonts.css";
import "./styles.css";
```

- [ ] **Step 4: Verify build serves the fonts**

Run: `pnpm --filter @flight-route-explorer/web build`
Expected: build succeeds; `dist/fonts/*.woff2` present (Vite copies `public/`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/public/fonts apps/web/src/fonts.css apps/web/src/main.tsx
git commit -m "feat(web): vendor self-hosted DISPATCH typography (Big Shoulders, IBM Plex)"
```

---

### Task 2: Token layer + base surfaces (Phase 1)

**Files:**
- Modify: `apps/web/src/styles.css` (replace lines 1–125 root/base block; keep all later rule blocks for now)
- Modify: `apps/web/index.html:6`

The trick that makes ~80% of components restyle without markup change: the legacy variable names (`--panel`, `--line`, `--blue`, `--mint`, `--amber`, `--red`, `--muted`, `--subtle`) are re-pointed at the new DISPATCH palette. Hardcoded dark hexes in untouched rules get remapped by this same block because every later replacement in this plan swaps them; until then the aliases keep the app coherent.

- [ ] **Step 1: Replace the `:root` block (styles.css lines 1–16) with the DISPATCH token layer**

```css
/* DISPATCH token layer — printed briefing studio. Chart Room (light) is the
   default; [data-theme="night-ops"] maps the same roles to the night palette. */
:root {
  /* §3 palette — Chart Room */
  --paper: #F5F2EA; --sheet: #FCFAF4; --ink: #1E2A38; --ink-60: #5C6B7A;
  --hairline: #D8D2C4; --chart-magenta: #C4326E; --graphite: #41546A;
  --signal-orange: #D96C2C; --alert-red: #C03A2B; --survey-teal: #1F7A72;
  --contour-sand: #EDE6D4; --water: #DCE4E6;
  /* §2 typography */
  --font-display: "Big Shoulders", "Arial Narrow", ui-sans-serif, sans-serif;
  --font-body: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", monospace;
  --text-hero: 2.6rem; --text-h1: 1.9rem; --text-h2: 1.15rem;
  --text-body: .875rem; --text-data: .78rem; --text-micro: .66rem;
  --track-kicker: .14em;
  /* Legacy aliases re-pointed at the palette so un-restyled rules stay coherent. */
  --muted: var(--ink-60); --subtle: var(--ink-60);
  --panel: var(--sheet); --panel-raised: var(--sheet);
  --line: var(--hairline);
  --blue: var(--chart-magenta); --mint: var(--survey-teal);
  --amber: var(--signal-orange); --red: var(--alert-red);
  color: var(--ink); background: var(--paper);
  font-family: var(--font-body); font-synthesis: none;
  color-scheme: light;
}
[data-theme="night-ops"] {
  --paper: #10151C; --sheet: #171E27; --ink: #DCE6EE; --ink-60: #93A5B4;
  --hairline: #2A3542; --chart-magenta: #F0558F; --graphite: #8FA6BC;
  --signal-orange: #F09A54; --alert-red: #EF7B6F; --survey-teal: #4CC2B4;
  --contour-sand: #232E3B; --water: #15202B;
  color-scheme: dark;
}
```

- [ ] **Step 2: Replace base element rules (styles.css lines 17–21 area)**

```css
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: var(--paper); }
button, input, select { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .5; }
:where(button, input, select, textarea, a, [tabindex]):focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: 2px; }
strong, b, .metric strong, .route-card-distance, .draft-result .metric strong, table td, table th, .map-endpoint span, .explorer-json, .opaque-id { font-variant-numeric: tabular-nums; }
```

Note: `body { ... min-width: 320px ... }` MUST keep that exact declaration — `tests/responsive/responsive-css.test.ts` asserts `body\s*\{[^}]*min-width:\s*320px`.

- [ ] **Step 3: Replace dark-surface base rules with chart-paper equivalents**

Apply these replacements across styles.css (each is exact `old → new` on the noted rule):

```css
.app-shell { max-width: none; margin: 0; padding: 0; min-height: 100vh; }
.eyebrow { color: var(--graphite); font-family: var(--font-display); font-size: .72rem; font-weight: 600; letter-spacing: var(--track-kicker); margin: 0 0 8px; text-transform: uppercase; }
h1 { color: var(--ink); font-family: var(--font-display); font-size: var(--text-h1); letter-spacing: .02em; text-transform: uppercase; }
h2 { color: var(--ink); font-size: var(--text-h2); letter-spacing: 0; }
h3 { color: var(--ink); font-size: .95rem; }
.lede { color: var(--ink-60); font-size: var(--text-body); line-height: 1.6; }
```

Then delete (replace with nothing) the body radial-gradient backgrounds:
- `body { ... radial-gradient(...) ... }` → already replaced in Step 2.
- `.map-first-shell { background: radial-gradient(...), #07131f; }` (line ~361) → `.map-first-shell { background: var(--paper); }`

And remap the recurring hardcoded dark fills (search-and-replace, exact strings):

| Old | New |
|---|---|
| `#0a1a28` | `var(--sheet)` |
| `#081824` | `var(--paper)` |
| `#102638` | `var(--sheet)` |
| `#274256` | `var(--hairline)` |
| `#294256` | `var(--hairline)` |
| `#38556b` | `var(--hairline)` |
| `rgba(7, 19, 31, .92)` / `.9` / `.94` / `.96` / `.97` / `.98` / `.88` | `var(--sheet)` |
| `rgba(12, 28, 43, .94)` | `var(--sheet)` |
| `rgba(9, 24, 37, .97)` | `var(--sheet)` |
| `#eef7fc`, `#eff8ff`, `#f5fcff`, `#e5f1f7`, `#e9fff8`, `#dbeaf4`, `#eef7fc` | `var(--ink)` |
| `#bdcfdb`, `#bdd4e2`, `#aec3d3`, `#dceefa` | `var(--ink-60)` |
| `#607c91`, `#2d5c73` | `var(--hairline)` |
| `#062033` (on-accent text) | `var(--sheet)` |
| `border-radius: 12px` / `16px` / `9px` / `8px` / `7px` / `6px` / `5px` | `border-radius: 2px` (all component corners; keep `99px` pills only for `.spinner`) |
| `box-shadow: 0 12px 28px rgba(0, 0, 0, .2)`, `box-shadow: 0 18px 55px rgba(0, 0, 0, .2)`, `box-shadow: 16px 18px 42px rgba(0, 0, 0, .33)` | remove (no glows; 1px hairlines only) |

Replace every translucent accent fill with solid outlined treatment:
```css
.route-card:hover, .route-card.selected { background: var(--sheet); border-color: var(--chart-magenta); transform: none; }
.route-card.selected { outline: 2px solid var(--chart-magenta); outline-offset: -2px; }
.overview-flight-buttons button:hover, .overview-flight-buttons button.selected { background: var(--paper); }
.overview-flight-buttons button.selected { box-shadow: inset 3px 0 var(--chart-magenta); }
.match-option:hover, .match-option.is-active, .match-option:focus-visible { background: var(--paper); }
.match-option:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
```

- [ ] **Step 4: Flat stamp chips + buttons**

```css
.status-chip, .count-label { background: transparent; border: 1px solid var(--survey-teal); border-radius: 2px; color: var(--survey-teal); font-family: var(--font-display); font-size: var(--text-micro); letter-spacing: var(--track-kicker); padding: 5px 8px; text-transform: uppercase; }
.quiet-button { background: transparent; border: 1px solid var(--hairline); border-radius: 2px; color: var(--ink-60); padding: 9px 14px; }
.quiet-button:hover { border-color: var(--ink); color: var(--ink); }
.search-button { background: var(--ink); border: 0; border-radius: 2px; color: var(--paper); }
.retry-button { border-color: var(--alert-red); color: var(--alert-red); }
.retry-button:hover { background: transparent; border-color: var(--alert-red); }
```

- [ ] **Step 5: Ruled search form field + numbered match picker (§5)**

```css
/* Search is a ruled form field: baseline underline, not a box. */
.search-input-row input { background: transparent; border: 0; border-bottom: 1px solid var(--ink); border-radius: 0; color: var(--ink); font-family: var(--font-mono); font-size: var(--text-body); padding: 9px 2px; }
.search-input-row input:focus { border-bottom-color: var(--chart-magenta); box-shadow: none; outline: none; }
.search-input-row input:focus-visible { outline: none; } /* baseline IS the focus indicator; paired rule below satisfies the outline-none contract test */
.search-input-row input:focus-visible { border-bottom: 2px solid var(--chart-magenta); }
.search-input-row input::placeholder { color: var(--ink-60); }
/* Duplicate-match picker: numbered ledger rows; kind badges in mono microtype. */
.duplicate-picker, .reference-picker { background: var(--sheet); border: 1px solid var(--hairline); border-radius: 2px; }
.duplicate-picker { counter-reset: matchrow; }
.match-option::before { color: var(--ink-60); content: counter(matchrow, decimal-leading-zero); counter-increment: matchrow; font-family: var(--font-mono); font-size: var(--text-micro); margin-right: 10px; }
.match-option { counter-increment: matchrow; }
.kind-badge { border: 1px solid var(--graphite); border-radius: 2px; color: var(--graphite); font-family: var(--font-mono); font-size: var(--text-micro); padding: 1px 5px; }
```

Note: the `outline: none` rules above require the adjacent `:focus-visible` replacement rule in the same selector set — `tests/responsive/responsive-css.test.ts` enforces that pairing.

In the `SearchBox` duplicate-match options and the `DraftEditor` reference-picker options, render a kind badge where a `kind` exists: `{match.kind && <span className="kind-badge">{match.kind}</span>}` (callsign matches have no kind — the badge appears for APT/FIX/NDB/VOR in the reference picker; `PointMatch.kind` already carries the value).

- [ ] **Step 6: index.html theme-color**

`apps/web/index.html`: `<meta name="theme-color" content="#F5F2EA" />`

- [ ] **Step 7: Verify**

Run: `pnpm --filter @flight-route-explorer/web build && pnpm run test:responsive`
Expected: build passes. `test:responsive` may FAIL on the legacy `@media (max-width: 760px)` pins — that is expected until Task 11 rewrites the contract; record the failures. Typecheck: `pnpm --filter @flight-route-explorer/web typecheck` must pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/styles.css apps/web/index.html
git commit -m "feat(web): DISPATCH token layer — chart-paper palette, Plex/Big Shoulders, flat stamps"
```

---

### Task 3: Advisory Band

**Files:**
- Modify: `apps/web/src/labels.ts`
- Modify: `apps/web/src/App.tsx:521` (safety banner block)
- Modify: `apps/web/src/styles.css` (`.safety-banner` rules)

- [ ] **Step 1: Add the one-sentence headline to labels.ts**

```ts
export const ADVISORY_HEADLINE = "Demonstration only — not for filing, dispatch, or route advice.";
```

(`SAFETY_NOTICE` and all other exports stay byte-identical — `tests/route-safety/web-copy.test.ts` pins them.)

- [ ] **Step 2: Replace the App.tsx safety banner line with the Advisory Band**

Import `ADVISORY_HEADLINE` from `./labels`, then replace the `.safety-banner.compact-safety` div:

```tsx
<div className="safety-banner advisory-band" role="region" aria-label="Safety notice"><strong><span aria-hidden="true">⚠</span> Advisory</strong><span>{ADVISORY_HEADLINE}</span><details className="advisory-details"><summary>Read advisory</summary><p>{SAFETY_NOTICE}</p></details></div>
```

The class `safety-banner` is retained (`tests/browser/critical-path.spec.ts` locator); `SAFETY_NOTICE` stays verbatim in the DOM inside the disclosure (`tests/a11y/aria-structure.test.tsx` getByText).

- [ ] **Step 3: Advisory Band CSS (replace all `.safety-banner` rules, incl. the audit-remediation block)**

```css
/* Advisory Band: full-width strip, sheet background, 3px signal-orange left rule. */
.advisory-band { align-items: center; background: var(--sheet); border: 0; border-bottom: 1px solid var(--hairline); border-left: 3px solid var(--signal-orange); border-radius: 0; color: var(--ink); display: flex; flex-wrap: wrap; font-size: var(--text-data); gap: 8px 12px; line-height: 1.45; margin: 0; padding: 8px 18px; }
.advisory-band strong { color: var(--signal-orange); font-family: var(--font-display); font-size: .7rem; letter-spacing: var(--track-kicker); text-transform: uppercase; }
.advisory-details { margin-left: auto; }
.advisory-details summary { color: var(--ink-60); cursor: pointer; font-size: var(--text-micro); text-decoration: underline; text-underline-offset: 2px; }
.advisory-details p { color: var(--ink-60); flex-basis: 100%; font-size: var(--text-micro); line-height: 1.5; margin: 6px 0 0; max-width: 980px; }
.machine-code { background: transparent; border: 1px solid var(--hairline); border-radius: 2px; color: var(--ink-60); font-family: var(--font-mono); font-size: var(--text-micro); padding: 2px 6px; }
```

- [ ] **Step 4: Verify** — `pnpm run test:a11y` passes; `pnpm --filter @flight-route-explorer/web build` passes.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): advisory band replaces amber safety banner"`

---

### Task 4: Docked briefing frame — Command Strip, Manifest, Doc-Control Footer

**Files:**
- Modify: `apps/web/src/App.tsx` (shell JSX, lines ~519–575; FlightOverviewList wrapper)
- Modify: `apps/web/src/styles.css` (new frame block appended)
- Test: `tests/e2e/dispatch-frame.test.tsx` (new)

- [ ] **Step 1: Write the failing frame test** `tests/e2e/dispatch-frame.test.tsx`

Follow the fixture pattern of `tests/e2e/interaction.test.tsx` (same imports/render helper with the overview fixture):

```tsx
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
// render helper + api mocks: copy the setup block from tests/e2e/interaction.test.tsx verbatim
describe("DISPATCH briefing frame", () => {
  it("renders the command strip, manifest, workbench spine, and doc-control footer", async () => {
    // render(…) per interaction.test.tsx setup
    expect(screen.getByRole("banner", { name: "Command strip" })).toBeTruthy();
    expect(document.querySelector(".briefing-frame")).toBeTruthy();
    expect(document.querySelector(".manifest")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Route workspace controls" })).toBeTruthy();
    expect(screen.getByText("SPEC-FRE-002")).toBeTruthy();
    expect(screen.getByText(/REV C/)).toBeTruthy();
    for (const tab of ["Routes", "Data", "Compare", "Synthesis"]) {
      expect(screen.getByRole("button", { name: tab })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Explore variation" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm run test:e2e -- dispatch-frame` → FAIL (no `.briefing-frame`).

- [ ] **Step 3: Restructure the App shell JSX**

Replace the return of `App()` (keep ALL state/handlers unchanged). Structure:

```tsx
return (
  <div className="app-shell map-first-shell dispatch-shell">
    <header className="command-strip" role="banner" aria-label="Command strip">
      {!mapOnly && <a className="skip-link" href="#flight-search">Skip to flight search</a>}
      <div className="product-mark"><p className="eyebrow">FLIGHT ROUTE EXPLORER</p><h1>Dispatch briefing</h1></div>
      {!mapOnly && page === "map" && <div className="toolbar-search"><SearchBox …unchanged props… /></div>}
      <div className={`toolbar-flight ${selectedFlight ? "has-selection" : ""}`} role="group" aria-label="Selected flight">
        {/* unchanged inner content from the old topbar */}
      </div>
      <div className="strip-gen">{(generation || refreshError || readinessError) && <>
        {(refreshError || readinessError) && <span className="refresh-error" role="alert">{refreshError ?? readinessError}</span>}
        <span className="gen-stamp machine-code">{generation ? `GEN ${formatRetrievedAt(generation.retrievedAt)}` : "GEN —"}</span>
        <button className="quiet-button" type="button" onClick={() => void runRefresh()} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh source data"}</button>
      </>}</div>
      <nav className="strip-pages" aria-label="View">
        <button ref={mapOnlyTriggerRef} className="quiet-button toolbar-map-action" type="button" onClick={enterMapOnly}>Map only</button>
        <button className="quiet-button toolbar-clear" ref={apiDataTriggerRef} type="button" aria-pressed={page === "api-data"} onClick={() => { setPage("api-data"); requestAnimationFrame(() => document.getElementById("api-data-heading")?.focus()); }}>API data</button>
        <button className="quiet-button toolbar-clear" type="button" onClick={() => { setPrimarySurface("none"); resetAll(); }}>Clear session</button>
      </nav>
    </header>
    <div className="safety-banner advisory-band" …Task 3 markup…></div>
    {page === "api-data" ? <ApiDataPage …unchanged… /> : <main className="briefing-frame">
      {mapOnly && <h1 className="sr-only">Map-first route comparison</h1>}
      {!mapOnly && page === "map" && <aside className="manifest" aria-label="Flight manifest">
        <FlightOverviewList …unchanged props… />
      </aside>}
      <section className="map-panel map-first-panel map-cell" aria-labelledby="map-heading">
        {/* RouteMap + map-hud + restore-controls: moved in Task 7; for now keep
            map-left-stack/map-rail/map-drawer markup exactly as today inside */}
        …existing map section children, unchanged…
      </section>
      {!mapOnly && page === "map" && <Workbench …Task 5… />}
    </main>}
    <footer className="doc-control-footer"><span>SPEC-FRE-002</span><span>REV C</span><span className="footer-asof">DATA AS OF {generation?.retrievedAt ? formatRetrievedAt(generation.retrievedAt) : "—"}</span></footer>
    <div className="sr-status" role="status" aria-live="polite">{routeLoading ? "Loading route options." : status}</div>
  </div>
);
```

Notes:
- The old `generation-strip` block is removed from body flow (absorbed into `.strip-gen`). Keep the `generation-strip` class unused — Task 11 removes its CSS.
- `.sr-status` moves to shell level so it survives across pages (it was inside the map section).
- In mapOnly mode the frame renders map-cell full width; `restore-controls` stays inside the stage (Task 7).

- [ ] **Step 4: Frame CSS (append to styles.css)**

```css
/* DISPATCH docked frame: command strip · manifest · map · workbench · footer. */
.dispatch-shell { display: flex; flex-direction: column; min-height: 100vh; }
.command-strip { align-items: center; background: var(--sheet); border-bottom: 1px solid var(--hairline); display: flex; flex-wrap: wrap; gap: 10px 18px; height: auto; min-height: 56px; padding: 8px 18px; }
.command-strip .product-mark h1 { font-size: 1.05rem; margin: 0; white-space: nowrap; }
.strip-gen { align-items: center; display: flex; gap: 10px; margin-left: auto; }
.gen-stamp { white-space: nowrap; }
.strip-pages { display: flex; gap: 8px; }
.briefing-frame { display: grid; flex: 1; grid-template-columns: 280px minmax(0, 1fr) 380px; min-height: 0; }
.briefing-frame.no-workbench { grid-template-columns: 280px minmax(0, 1fr); }
.manifest { background: var(--sheet); border-right: 1px solid var(--hairline); display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.map-cell { border-radius: 0; border: 0; min-width: 0; position: relative; }
.map-cell .map-stage { height: 100%; min-height: 520px; }
.doc-control-footer { align-items: center; background: var(--sheet); border-top: 1px solid var(--hairline); color: var(--ink-60); display: flex; font-family: var(--font-mono); font-size: var(--text-micro); gap: 18px; height: 28px; padding: 0 18px; }
.doc-control-footer .footer-asof { margin-left: auto; }
/* Manifest list docked (keeps pinned .flight-overview-list/.overview-flight-buttons classes). */
.manifest .flight-overview-list { background: transparent; border: 0; border-radius: 0; bottom: auto; display: flex; flex-direction: column; left: auto; max-height: none; overflow: hidden; padding: 12px; position: static; right: auto; top: auto; width: auto; }
.manifest .overview-flight-buttons { flex: 1; }
.manifest .overview-flight-buttons button { background: transparent; border: 0; border-bottom: 1px solid var(--hairline); border-radius: 0; min-width: 0; padding: 10px 8px; }
.manifest .overview-flight-buttons button strong { font-family: var(--font-display); font-size: .86rem; letter-spacing: .04em; text-transform: uppercase; }
.manifest .overview-flight-buttons button small { font-family: var(--font-mono); font-size: var(--text-micro); }
.manifest .overview-flight-buttons button > span:last-child { font-family: var(--font-mono); font-size: var(--text-data); }
/* Unresolved routes: hollow signal-orange triangle glyph (never hue alone). */
.overview-flight-buttons button.has-gap > span:first-child strong::after { border-bottom: 9px solid transparent; border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 9px solid transparent; border: 0; content: ""; display: inline-block; height: 0; margin-left: 8px; position: relative; top: 1px; width: 0; }
.overview-flight-buttons button.has-gap > span:first-child strong::before { border-left: 7px solid transparent; border-right: 7px solid transparent; border-top: 11px solid var(--signal-orange); content: ""; display: inline-block; height: 0; margin-right: 7px; vertical-align: -1px; width: 0; }
.overview-flight-buttons button.has-gap > span:first-child strong::after { content: none; }
```

(Simplify Step 4 triangle rules in implementation to just the `::before` solid-triangle rule plus an inner `background: transparent` mask is unnecessary — the glyph reads as a filled warning triangle; if a true hollow triangle is required, use `border-top-color` on `::before` and overlay a smaller paper-colored `::after` triangle. Keep only rules that render; delete the unused `::after` block.)

- [ ] **Step 5: Run test to verify it passes** — `pnpm run test:e2e -- dispatch-frame` → PASS (Workbench stub may be a minimal `<aside className="workbench">` until Task 5; the test's spine queries require Task 5 buttons — if running strictly TDD, implement Task 5 Step 3 before re-running).
- [ ] **Step 6: Commit** — `git commit -m "feat(web): docked DISPATCH briefing frame — command strip, manifest, doc-control footer"`

---

### Task 5: Workbench — docked panel with tabbed spine

**Files:**
- Modify: `apps/web/src/App.tsx` (remove `.map-rail`, `.map-drawer` floating markup; add Workbench)
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add the Workbench markup** replacing the old `map-rail` nav and `map-drawer` aside (App.tsx lines ~551–568). Spine buttons reuse the exact refs and handlers; region labels and `drawer-header` content stay byte-identical (keyboard test pins):

```tsx
{!mapOnly && <aside className={`workbench ${primarySurface !== "none" ? "is-open" : ""}`}>
  <nav className="workbench-spine" aria-label="Route workspace controls">
    <button ref={routesTriggerRef} type="button" aria-pressed={primarySurface === "routes"} onClick={() => setPrimarySurface((surface) => surface === "routes" ? "none" : "routes")} disabled={!selectedFlight}>Routes</button>
    <button ref={dataTriggerRef} type="button" aria-pressed={primarySurface === "route-data"} onClick={() => setPrimarySurface((surface) => surface === "route-data" ? "none" : "route-data")} disabled={!selectedRoute}>Data</button>
    <button ref={compareTriggerRef} type="button" aria-pressed={primarySurface === "compare"} onClick={() => setPrimarySurface((surface) => surface === "compare" ? "none" : "compare")} disabled={!selectedRoute || options.length < 2}>Compare</button>
    <button type="button" aria-pressed={primarySurface === "synthesis"} onClick={() => setPrimarySurface((surface) => surface === "synthesis" ? "none" : "synthesis")}>Synthesis</button>
    <button ref={editorTriggerRef} type="button" aria-pressed={primarySurface === "editor"} aria-label="Explore variation" onClick={() => { if (!selectedRoute) return; setDraftActive(true); setPrimarySurface("editor"); void updateDraft([]); }} disabled={!selectedRoute}>Draft</button>
  </nav>
  <div className="map-drawer workbench-panel" role="region" aria-label={primarySurface === "routes" ? "Route chooser" : primarySurface === "route-data" ? "Flight and route data" : primarySurface === "compare" ? "Route comparison" : primarySurface === "synthesis" ? "Observed-donor synthesis" : primarySurface === "editor" ? "Explore a route variation" : "Workbench"}>
    {primarySurface === "none" && <div className="workbench-empty"><span aria-hidden="true">⌖</span><strong>NO PANEL OPEN</strong><p>Select a route, then open Routes, Data, Compare, Synthesis, or Draft.</p></div>}
    {primarySurface !== "none" && <div className="drawer-header"><p className="eyebrow">{/* unchanged eyebrow switch */}</p><button className="quiet-button" type="button" onClick={() => { if (primarySurface === "editor") resetDraftState(); closeSurface(primarySurface); }}>Close</button></div>}
    {/* the five surface blocks — JSX unchanged from the old drawer */}
  </div>
</aside>}
```

Behavior preserved: `Escape` closes the open surface (keep the existing global/`closeSurface` paths), focus returns to the spine trigger, `rail-count` badge moves onto the Routes spine button (`options.length > 1 && <span className="toolbar-count rail-count">…`).

The `map-left-stack` / `RouteLegPanel` block: remove from the map overlay; render `<RouteLegPanel route={selectedRoute} />` inside the Data surface (top of `route-data`, before `RouteDetails`) so the region "Route legs" remains reachable.

- [ ] **Step 2: Workbench CSS (append)**

```css
.workbench { background: var(--sheet); border-left: 1px solid var(--hairline); display: grid; grid-template-columns: 44px minmax(0, 1fr); min-height: 0; }
.workbench-spine { border-right: 1px solid var(--hairline); display: flex; flex-direction: column; }
.workbench-spine button { background: transparent; border: 0; border-left: 2px solid transparent; border-radius: 0; color: var(--ink-60); font-family: var(--font-display); font-size: .6rem; letter-spacing: .1em; min-height: 56px; padding: 8px 2px; text-transform: uppercase; writing-mode: vertical-rl; transform: rotate(180deg); }
.workbench-spine button:hover { color: var(--ink); }
.workbench-spine button[aria-pressed="true"] { border-left-color: var(--chart-magenta); color: var(--chart-magenta); }
.workbench-panel { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; padding: 16px; }
.workbench-empty { align-items: center; color: var(--ink-60); display: flex; flex-direction: column; gap: 8px; margin: auto; text-align: center; }
.workbench-empty span { color: var(--hairline); font-size: 2rem; }
.workbench-empty strong { font-family: var(--font-display); letter-spacing: var(--track-kicker); }
/* When the API page is open the same frame hosts it at 50% (Task 10). */
.briefing-frame.api-frame { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
```

Remove the now-dead `.map-rail`, `.map-left-stack`, `.map-drawer.map-bottom-sheet`, `.flight-overview-list` floating-position rules they replace (keep `.rail-count` badge styles).

- [ ] **Step 3: Verify** — `pnpm run test:e2e && pnpm run test:a11y` → PASS (keyboard focus-return tests exercise the spine).
- [ ] **Step 4: Commit** — `git commit -m "feat(web): workbench panel with tabbed spine replaces floating rail/drawer"`

---

### Task 6: Component restyle — data blocks, ledger, stamps, worksheet

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/App.tsx` (DraftEditor row affordances only)

- [ ] **Step 1: Data blocks (metric grid)**

```css
.metric-grid { background: var(--sheet); border-bottom: 1px solid var(--hairline); border-top: 1px solid var(--hairline); }
.metric span { color: var(--ink-60); font-family: var(--font-display); font-size: var(--text-micro); letter-spacing: var(--track-kicker); text-transform: uppercase; }
.metric strong { color: var(--ink); font-family: var(--font-mono); font-size: 1.15rem; }
.metric small { color: var(--ink-60); font-size: var(--text-micro); }
```

- [ ] **Step 2: Leg table as ruled ledger — sequence margin column + diagonal hatch gap rows**

```css
table tbody th { color: var(--chart-magenta); font-family: var(--font-mono); }
.gap-row { background: repeating-linear-gradient(45deg, rgba(192, 58, 43, .08) 0 6px, transparent 6px 12px); }
.gap-row th, .gap-row td { color: var(--alert-red); }
tr:not(.gap-row) td:last-child::before { color: var(--survey-teal); content: "✓ "; }
```

(The teal tick on resolved legs uses the Status column cell; gate it with `tbody tr:not(.gap-row) td:last-child::before`.)

- [ ] **Step 3: Provenance stamps (evidence stack)**

```css
.evidence { background: transparent; border-left-width: 3px; border-radius: 0; }
.evidence span { font-family: var(--font-display); font-size: var(--text-micro); letter-spacing: var(--track-kicker); }
.evidence p { font-size: .73rem; }
.evidence-blue { border-color: var(--graphite); } .evidence-blue span { color: var(--graphite); }
.evidence-green { border-color: var(--survey-teal); } .evidence-green span { color: var(--survey-teal); }
.evidence-amber { border-color: var(--signal-orange); } .evidence-amber span { color: var(--signal-orange); }
.evidence-red { border-color: var(--alert-red); } .evidence-red span { color: var(--alert-red); }
.evidence { background: transparent; } /* kill legacy translucent fills */
```

- [ ] **Step 4: Borrowing manifest (synthesis candidates) — coverage bar + magenta stamp**

In `SynthesisExplorer` candidate buttons, add after the `<small>` copy:

```tsx
<span className="coverage-bar" aria-hidden="true">{Array.from({ length: (synthesis?.corridorCount ?? candidate.corridorsCovered) }).map((_, corridorIndex) => <i key={corridorIndex} className={corridorIndex < candidate.corridorsCovered ? "covered" : ""} />)}</span>
```

```css
.synthesis-candidates button { background: var(--sheet); border: 1px solid var(--hairline); border-radius: 2px; }
.synthesis-candidates button[aria-pressed="true"] { border: 0; outline: 2px solid var(--chart-magenta); outline-offset: -2px; }
.coverage-bar { display: inline-flex; gap: 2px; }
.coverage-bar i { background: var(--hairline); display: inline-block; height: 8px; width: 5px; }
.coverage-bar i.covered { background: var(--signal-orange); }
```

- [ ] **Step 5: Draft worksheet — ✕ remove affordance (Move up/down buttons stay in the DOM for Alt+↑/↓ parity but become icon-styled)**

In `DraftEditor` point rows, change the three action buttons' visible labels to `↑`, `↓`, `✕` while keeping the existing `aria-label`s (`Move ${point} up`, etc.) and handlers untouched. Add pinned footer styling:

```css
.draft-points li { background: var(--sheet); border: 0; border-bottom: 1px solid var(--hairline); border-radius: 0; }
.draft-row-actions button { border: 0; color: var(--ink-60); font-size: .8rem; min-height: 44px; min-width: 44px; }
.draft-row-actions button:hover { color: var(--alert-red); }
.draft-result { border-top: 1px solid var(--hairline); bottom: 0; position: sticky; background: var(--sheet); }
```

- [ ] **Step 6: Compare delta spine**

```css
.compare-result { position: relative; }
.compare-columns { display: grid; gap: 0; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.compare-columns .metric-grid { border: 0; }
.compare-columns .metric-grid:first-child { border-right: 1px solid var(--hairline); }
.compare-result > .metric-grid { border-top: 1px solid var(--hairline); }
.delta-chip { border: 1px solid var(--graphite); border-radius: 2px; color: var(--graphite); font-family: var(--font-mono); font-size: var(--text-data); padding: 2px 6px; }
```

(`Metric` already renders the signed delta as its value; wrap it in `.delta-chip` by adding an optional `chip` prop to `Metric` used only in the compare result row.)

- [ ] **Step 7: Empty states**

```css
.empty-options { background: var(--sheet); border: 1px solid var(--hairline); border-radius: 2px; }
.map-empty strong { font-family: var(--font-display); letter-spacing: var(--track-kicker); text-transform: uppercase; }
.map-empty > span { color: var(--hairline); }
```

- [ ] **Step 8: Verify** — `pnpm run test:e2e && pnpm --filter @flight-route-explorer/web build` → PASS.
- [ ] **Step 9: Commit** — `git commit -m "feat(web): DISPATCH component restyle — data blocks, ledger, provenance stamps, worksheet"`

---

### Task 7: Map symbology (Phase 3)

**Files:**
- Modify: `apps/web/src/App.tsx` (RouteMap render + chrome components)
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Route line symbology — ink casing beneath chart-magenta**

In the selected-route group render, keep class names (`route-shadow` becomes the casing; tests only assert dasharray/count):

```css
.route-path { stroke: var(--chart-magenta); stroke-width: 4; }
.route-shadow { filter: none; opacity: 1; stroke: var(--ink); stroke-width: 6; } /* 1px casing each side */
.route-line-selected .route-path { stroke: var(--chart-magenta); stroke-width: 4; }
.map-stage.has-selected-route .route-line-selected .route-path { stroke: var(--chart-magenta); stroke-width: 4; }
.map-stage.has-selected-route .route-line-selected .route-shadow { stroke-width: 6; }
.route-path-alternate { stroke: var(--graphite); opacity: .55; stroke-width: 2; }
.map-stage.has-selected-route .route-line-alternate { opacity: .15; }
.route-path-potential { stroke: var(--signal-orange); stroke-dasharray: 6 6; stroke-width: 3; }
.route-line-hover .route-path, .route-line-hover .route-path-alternate { stroke-width: 5; } /* hover +1px via JS state class */
```

Remove the `filter="url(#glow)"` attribute from the selected path JSX and delete the `<filter id="glow">` def (keep `<defs>` for the hatch pattern below).

- [ ] **Step 2: Gap boundary — hollow red circle, dashed stroke, hatch fill**

Add to `<defs>`:

```tsx
<pattern id="gap-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="transparent" /><line x1="0" y1="0" x2="0" y2="6" stroke="var(--alert-red)" strokeOpacity=".2" strokeWidth="2" /></pattern>
```

```css
.gap-boundary circle { fill: url(#gap-hatch); stroke: var(--alert-red); stroke-dasharray: 3 3; stroke-width: 1.5; }
.gap-boundary text { fill: var(--alert-red); font-family: var(--font-mono); font-size: 10px; }
```

- [ ] **Step 3: Endpoint markers — teal departure circle w/ white dot, ink diamond arrival**

Replace `MapMarker` render per tone:

```tsx
function MapMarker({ point, label, tone }: { point: Point; label: string; tone: "origin" | "destination" }) {
  return <g className={`map-marker marker-${tone}`}>
    {tone === "origin"
      ? <><circle cx={point.x} cy={point.y} r="7" /><circle cx={point.x} cy={point.y} r="2.5" className="marker-core" /></>
      : <rect x={point.x - 5.5} y={point.y - 5.5} width="11" height="11" transform={`rotate(45 ${point.x} ${point.y})`} />}
    <text x={point.x + 14} y={point.y - 10}>{label}</text>
  </g>;
}
```

```css
.marker-origin circle:first-child { fill: var(--survey-teal); stroke: var(--sheet); stroke-width: 1.5; }
.marker-origin .marker-core { fill: var(--sheet); }
.marker-destination rect { fill: var(--ink); stroke: var(--sheet); stroke-width: 1.5; }
.map-marker text { fill: var(--ink); font-family: var(--font-mono); font-size: 11px; font-weight: 700; paint-order: stroke; stroke: var(--sheet); stroke-width: 3px; }
```

Keep `g.map-marker.marker-origin` / `.marker-destination` classes (Playwright pins them). `.world-ocean`/`.world-land` fallback recolor: land `var(--contour-sand)` stroke `var(--hairline)`, ocean `var(--water)`.

- [ ] **Step 4: Tile chart-paper filter**

```css
.tile-layer img { filter: saturate(.55) contrast(1.05) sepia(.08); }
```

- [ ] **Step 5: Map chrome — corner registration marks, compass rose, scale bar, zoom stamps, key block, graticule labels**

JSX additions inside `.map-stage` (after the canvas div):

```tsx
<span className="reg-mark reg-tl" aria-hidden="true" /><span className="reg-mark reg-tr" aria-hidden="true" /><span className="reg-mark reg-bl" aria-hidden="true" /><span className="reg-mark reg-br" aria-hidden="true" />
<div className="compass-rose" aria-hidden="true"><svg viewBox="0 0 36 36" width="36" height="36"><circle cx="18" cy="18" r="15" /><path d="M18 5 L21 18 L18 15 L15 18 Z" /><text x="18" y="33" textAnchor="middle">N</text></svg></div>
<div className="map-scalebar" aria-hidden="true"><span className="scalebar-bar" style={{ width: scaleBarPx }} /><span className="scalebar-label">{scaleBarLabel}</span></div>
<div className="graticule-labels" aria-hidden="true">{graticule.verticals.map((v) => <span key={`v-${v.lon}`} className="grat-label" style={{ left: v.x }}>{`${Math.abs(Math.round(v.lon))}°${v.lon < 0 ? "W" : v.lon > 0 ? "E" : ""}`}</span>)}{graticule.horizontals.map((h) => <span key={`h-${h.lat}`} className="grat-label" style={{ top: h.y }}>{`${Math.abs(Math.round(h.lat))}°${h.lat < 0 ? "S" : "N" : ""}`}</span>)}</div>
```

Compute in RouteMap (memo on `[view, stageSize]`):
- Graticule: every 10° lon whose world-x falls in view → `x`; every 10° lat → `y` via `worldPixel` (import from TileMap). Render 0.5px lines in the overlay `<svg>` too (`<g className="map-graticule-tile">`).
- Scale bar: `metersPerPixel = 156543.03392 * Math.cos(view.lat * Math.PI / 180) / 2 ** view.zoom`; choose the largest step in `[50,100,200,500,1000,2000,5000,100000,200000,500000,1000000,2000000]` (meters) with `px = meters / metersPerPixel` ≤ 160; label in km; `scaleBarPx = px`.

Move zoom controls to bottom-left above the scale bar; buttons become ≥44px square stamps; keep labels `+`, `−`, "Toggle base map" (Playwright pins the last name).

Legend `.map-legend` stays a child of `.map-first-panel` (responsive test selector) but positions as a bordered key block bottom-right:

```css
.map-first-panel > .map-legend { background: var(--sheet); border: 1px solid var(--hairline); border-radius: 2px; bottom: 14px; display: flex; left: auto; padding: 10px 14px; position: absolute; right: 14px; top: auto; z-index: 3; }
```

Chrome CSS:

```css
.reg-mark { border-color: var(--ink-60); border-style: solid; border-width: 0; height: 14px; position: absolute; width: 14px; z-index: 3; }
.reg-tl { border-left-width: 1px; border-top-width: 1px; left: 10px; top: 10px; }
.reg-tr { border-right-width: 1px; border-top-width: 1px; right: 10px; top: 10px; }
.reg-bl { border-bottom-width: 1px; border-left-width: 1px; bottom: 10px; left: 10px; }
.reg-br { border-bottom-width: 1px; border-right-width: 1px; bottom: 10px; right: 10px; }
.compass-rose { position: absolute; right: 16px; top: 16px; z-index: 3; }
.compass-rose svg { fill: none; stroke: var(--ink); }
.compass-rose text { fill: var(--ink); font-family: var(--font-display); font-size: 9px; stroke: none; }
.map-scalebar { align-items: center; bottom: 16px; display: flex; gap: 8px; left: 16px; position: absolute; z-index: 3; }
.scalebar-bar { border-bottom: 2px solid var(--ink); border-left: 1px solid var(--ink); border-right: 1px solid var(--ink); display: inline-block; height: 5px; }
.scalebar-label { color: var(--ink); font-family: var(--font-mono); font-size: var(--text-micro); }
.grat-label { color: var(--ink-60); font-family: var(--font-mono); font-size: 9px; position: absolute; }
.map-graticule-tile line { stroke: var(--ink); stroke-opacity: .12; stroke-width: .5; }
.map-zoom-controls { bottom: 44px; flex-direction: column; left: 16px; top: auto; transform: none; }
.map-zoom-controls button { background: var(--sheet); border: 1px solid var(--hairline); border-radius: 2px; color: var(--ink); min-height: 44px; min-width: 44px; }
```

- [ ] **Step 6: Hover tooltip stamp + hover thickening**

Add `const [hovered, setHovered] = useState<{ route: RouteOption; x: number; y: number } | undefined>(undefined);` to RouteMap. On each `.route-hit` path: `onMouseMove={(event) => { const rect = stageRef.current?.getBoundingClientRect(); setHovered({ route, x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }); }}` and `onMouseLeave={() => setHovered(undefined)}`; add `route-line-hover` to the matching projected `<g>` when `hovered?.route.flightId === route.flightId`. Render:

```tsx
{hovered && <div className="route-tooltip" style={{ left: hovered.x + 12, top: hovered.y + 12 }}>{hovered.route.callsign} · {formatDistance(hovered.route.distanceNm)}</div>}
```

```css
.route-tooltip { background: var(--ink); border-radius: 2px; color: var(--paper); font-family: var(--font-mono); font-size: var(--text-micro); padding: 4px 8px; pointer-events: none; position: absolute; z-index: 6; }
```

- [ ] **Step 7: MapOnly restore control stays a square stamp top-right (44px min).**
- [ ] **Step 8: Verify** — `pnpm run test:e2e && pnpm run test:a11y && pnpm --filter @flight-route-explorer/web build` → PASS. (Browser lane updates land in Task 11.)
- [ ] **Step 9: Commit** — `git commit -m "feat(web): DISPATCH map symbology — casing, hatch, rose, scale bar, graticule, key block"`

---

### Task 8: Motion (CSS-only, reduced-motion safe)

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/App.tsx` (draw class lifecycle + distance tick)

- [ ] **Step 1: Keyframes + application rules (append before the reduced-motion block)**

```css
@keyframes dispatch-strip-in { from { transform: translateY(-100%); } to { transform: translateY(0); } }
@keyframes dispatch-row-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes dispatch-map-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes dispatch-route-draw { from { stroke-dasharray: 1 1; stroke-dashoffset: 1; } to { stroke-dasharray: 1 1; stroke-dashoffset: 0; } }
@keyframes dispatch-search-ring { from { box-shadow: 0 0 0 0 rgba(30, 42, 56, .35); } to { box-shadow: 0 0 0 8px rgba(30, 42, 56, 0); } }
.command-strip { animation: dispatch-strip-in 160ms ease-out; }
.manifest .overview-flight-buttons button { animation: dispatch-row-in 180ms ease-out backwards; }
.manifest .overview-flight-buttons button:nth-child(1) { animation-delay: 0ms; } /* …nth-child(2..8): 24ms steps; no delay from row 9 on */
.map-stage { animation: dispatch-map-in 240ms ease-out; }
.route-line-selected.is-drawing .route-path { animation: dispatch-route-draw 420ms ease-out; }
.search-block.is-active .search-button { animation: dispatch-search-ring 360ms ease-out 1; }
.gap-boundary circle { animation: dispatch-row-in 200ms ease-out 420ms backwards; } /* hatch reveal after draw */
```

`pathLength={1}` attribute on the selected `.route-path` elements so dasharray `1 1` spans the full path.

- [ ] **Step 2: Draw lifecycle in RouteMap** — on `displayRoute?.flightId` change set `drawing=true`, `const timer = window.setTimeout(() => setDrawing(false), 460)` (cleanup on unmount/change). Apply `is-drawing` to the selected `<g>`. The 460ms cleanup restores computed `stroke-dasharray: none` for the Playwright contract (Task 11).

- [ ] **Step 3: Distance tick** — add `useEffect`-driven rAF count-up (0 → value, 320ms) in a small `DistanceTick({ nm })` component used by the `.map-hud` distance line and the toolbar distance; guard with `window.matchMedia("(prefers-reduced-motion: reduce)").matches` → render final value directly. Format with thin space: `nm.toLocaleString("en-US").replace(/,/g, "\u202F")` then `.toFixed(1)` handling: format `value.toFixed(1)` and insert `\u202F` before the last three integer digits when ≥1000.

- [ ] **Step 4: Verify reduced-motion pin still passes** — `pnpm run test:responsive` reduced-motion test expects `animation-duration: .01ms` / `transition-duration: .01ms` inside the block (kept untouched).
- [ ] **Step 5: Commit** — `git commit -m "feat(web): instrument-grade motion — strip/row/draw animations, reduced-motion safe"`

---

### Task 9: Responsive breakpoints (§9)

**Files:**
- Modify: `apps/web/src/styles.css` (replace ALL legacy `@media` blocks for the frame with the new set)

- [ ] **Step 1: Implement the three-breakpoint contract**

```css
/* 761–1279px: manifest folds away (list reachable via workbench/search); workbench becomes a bottom sheet ≤55vh. */
@media (max-width: 1279px) {
  .briefing-frame { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
  .manifest { display: none; }
  .workbench { border-left: 0; border-top: 1px solid var(--hairline); grid-template-columns: 44px minmax(0, 1fr); max-height: 55vh; overflow: auto; }
  .workbench-spine { flex-direction: column; }
}
/* ≤760px: single column strip → map (55vh) → sheet; legend folds to Key disclosure; footer keeps timestamp only. */
@media (max-width: 760px) {
  .briefing-frame { display: flex; flex-direction: column; }
  .map-cell .map-stage { height: 55vh; min-height: 320px; }
  .workbench { max-height: none; }
  .map-first-panel > .map-legend { bottom: 10px; right: 10px; }
  .map-first-panel > .map-legend .legend-item:not(:first-child) { display: none; } /* folded behind a <details class="legend-key"> "Key" wrapper rendered by RouteMap */
  .doc-control-footer span:not(.footer-asof) { display: none; }
  .command-strip { padding: 8px 12px; }
  .product-mark { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
}
```

The `.product-mark` rule MUST keep the exact sr-only property set — `tests/responsive/responsive-css.test.ts` pins it (pattern `clip: rect(0 0 0 0); clip-path: inset(50%); ... height: 1px; ... position: absolute; ... width: 1px`).

Wrap the legend items in RouteMap with `<details className="legend-key"><summary>Key</summary>…items…</details>` only at small viewports via CSS (details/summary always rendered; ≥761px `summary { display: none; display: contents }` — implement as `.legend-key summary { display: none; }` desktop / `display: list-item` mobile).

- [ ] **Step 2: Verify** — `pnpm --filter @flight-route-explorer/web build` passes; manual check at 320/760/1100/1440 via `pnpm dev` + browser screenshots.
- [ ] **Step 3: Commit** — `git commit -m "feat(web): DISPATCH responsive contract — bottom sheet workbench, folded manifest"`

---

### Task 10: API data worksheet (frame reuse)

**Files:**
- Modify: `apps/web/src/App.tsx` (page switch: render ApiDataPage inside `.briefing-frame.api-frame`)
- Modify: `apps/web/src/ApiDataPage.tsx` (line-numbered JSON)
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1:** Render `<ApiDataPage …/>` as the full-width child of `<main className="briefing-frame api-frame">` (single child spanning both columns on map layout; on `page === "api-data"` the grid is `1fr`). The explorer cards keep classes (`explorer-card`, `explorer-json`) — restyle as ruled worksheet:

```css
.explorer-card { background: var(--sheet); border: 1px solid var(--hairline); border-radius: 2px; }
.explorer-card-head code { font-family: var(--font-mono); color: var(--ink); }
.explorer-method { background: transparent; border: 1px solid var(--graphite); border-radius: 2px; color: var(--graphite); }
.explorer-input input { background: var(--paper); border: 0; border-bottom: 1px solid var(--ink); border-radius: 0; }
.explorer-json { background: var(--paper); border: 1px solid var(--hairline); border-radius: 2px; color: var(--ink); counter-reset: jsonline; font-family: var(--font-mono); }
.explorer-json .json-line { counter-increment: jsonline; display: block; white-space: pre-wrap; }
.explorer-json .json-line::before { color: var(--hairline); content: counter(jsonline, decimal-leading-zero) " "; display: inline-block; margin-right: 10px; min-width: 2.4em; text-align: right; user-select: none; }
```

- [ ] **Step 2:** In ApiDataPage replace the JSON `<pre>` body:

```tsx
<pre className="explorer-json">{JSON.stringify(state.result, null, 2).split("\n").map((line, index) => <span className="json-line" key={index}>{line}</span>)}</pre>
```

- [ ] **Step 3: Verify** — `pnpm run test:e2e -- api-data` PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(web): API explorer worksheet — ruled fields, line-numbered teletype JSON"`

---

### Task 11: Regression contract updates + full verification

**Files:**
- Modify: `tests/browser/map-controls.spec.ts:325` (dasharray `6px, 6px`)
- Modify: `tests/responsive/responsive-css.test.ts` (new DISPATCH contract)
- Modify: `apps/web/src/styles.css` (delete dead legacy blocks: old `.map-topbar` grids, `.generation-strip`, floating `.flight-overview-list` positions, glow shadows)

- [ ] **Step 1: Update the borrowed-geometry dasharray pin** to `toBe("6px, 6px")` (spec §6: signal-orange 3px dashed 6/6).

- [ ] **Step 2: Rewrite `responsive-css.test.ts` pins** for the new frame, keeping the same test titles/structure:

```ts
it("ships the DISPATCH breakpoints", () => {
  const mid = blockAfter("@media (max-width: 1279px)");
  expect(mid).toMatch(/\.workbench\s*\{[^}]*max-height:\s*55vh/);
  expect(mid).toMatch(/\.manifest\s*\{\s*display:\s*none/);
  const mobile = blockAfter("@media (max-width: 760px)");
  expect(mobile).toMatch(/\.map-cell \.map-stage\s*\{\s*height:\s*55vh/);
  expect(mobile).toMatch(/\.product-mark\s*\{\s*clip:\s*rect\(0\s+0\s+0\s+0\);\s*clip-path:\s*inset\(50%\);[^}]*height:\s*1px;[^}]*overflow:\s*hidden;[^}]*position:\s*absolute;[^}]*width:\s*1px/);
  expect(mobile).toMatch(/\.doc-control-footer span:not\(\.footer-asof\)/);
});
```

Keep the index.html, body min-width, reduced-motion, forced-colors, table-scroll, and outline-none tests; extend the forced-colors selector list with `.workbench-spine button`, `.compass-rose`, `.map-scalebar`, and add forced-colors rules for them in styles.css.

- [ ] **Step 3: Full offline verification**

```bash
pnpm run validate        # config, policy, typecheck, tests, offline, evidence, lint, container smoke
```

Expected: all green. Then the real-browser lane:

```bash
pnpm run test:browser    # Playwright map-controls + critical-path against the built app
```

- [ ] **Step 4: Visual evidence** — capture screenshots at 1440px (full frame), 1100px (bottom sheet), 375px (single column) via the existing Playwright harness into `temp-screenshots/dispatch/`; verify ≥90% paper/ink ratio by eye and magenta-only-on-selection.
- [ ] **Step 5: Commit** — `git commit -m "test: pin DISPATCH contracts — dasharray 6/6, new responsive frame"`

---

## Test Plan

1. **Unit/e2e (jsdom):** `pnpm run test:e2e`, `pnpm run test:a11y`, `pnpm run test:responsive` — all existing behavior tests pass unchanged except the two deliberately updated pins (Task 11).
2. **Real browser:** `pnpm run test:browser` — map controls, zoom bounds, wheel debounce, base-map toggle, synthesis dasharray (new 6/6).
3. **Full lane:** `pnpm run validate` before PR.
4. **Visual:** screenshots at 1440/1100/375 stored under `temp-screenshots/dispatch/`.

## Assumptions

- Night Ops is delivered as the `[data-theme="night-ops"]` token mapping only; no UI theme toggle (the spec defines the mapping but no control).
- Spec §6 dasharray 6/6 supersedes the previously pinned 4/7 (pinning test updated in Task 11).
- "Draft" spine tab keeps accessible name "Explore variation"; "Synthesis" spine tab is new (no existing test references that name).
- Font downloads use the fontsource CDN (or Google Fonts css2 fallback) at build-prep time; committed WOFF2 assets keep runtime zero-dependency.
- All safety/legal copy strings remain byte-identical; only their visual container changes.
