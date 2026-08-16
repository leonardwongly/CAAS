# UAT walkthrough protocol (issue #15)

Status: **Current protocol and revised live execution retained.** The focused automated coverage and the separate loopback browser run pass for the overview-first journey. The new subject-bound record is `docs/evidence/uat-overview-first-local-e965c728fe45.json`. Historical machine-executed records under `docs/testing/artifacts/` are immutable and prove only the older subject and wording they captured; they do not get relabeled by this run.

## 1. Execution modes

### Mode A — deterministic automated rehearsal

Run the fixture-backed suites:

```bash
cd tests
node_modules/.bin/vitest run --config vitest.config.ts \
  e2e/overview-api.test.tsx \
  e2e/interaction.test.tsx \
  e2e/keyboard.test.tsx \
  a11y/aria-structure.test.tsx \
  a11y/axe.test.tsx \
  responsive/responsive-css.test.ts
```

The fixture harness is test-only. It is never a runtime/demo fallback.

### Mode B — authorized loopback rehearsal with real CAAS data

Build the UI, boot the API on loopback, and use the ignored local credential:

```bash
pnpm --filter web build
NODE_ENV=production WEB_ASSET_DIR="$PWD/apps/web/dist" \
  node --experimental-strip-types apps/api/src/cli.ts --port 18080 --env-file .env
# open http://127.0.0.1:18080
```

Record observed real values rather than fixture callsigns, counts, names, or distances. Do not retain raw upstream data. Startup must fail closed if any mandatory family is unusable.

## 2. Binding acceptance criteria

- The ready state traverses every generation-bound overview cursor exactly once and shows every safe flight plus every available resolved component. There is no 10-route cap or silent truncation.
- Map, full list, callsign filter, HUD, and details share one selected `flightId`. Exact overlapping rendered paths use an explicit chooser; the list is the keyboard-equivalent selection path.
- Airport endpoints display `Full Airport Name (ICAO)` from the pinned OurAirports exact-ICAO bundle or `Name unavailable (ICAO)`. No fuzzy, proximity, generated-code, or runtime lookup is allowed.
- Same-endpoint routes use selected-first immutable source order, neutral complete/incomplete groups, and descriptive modeled distance only. No best/winner label or public `rank`, `rankDistanceNm`, `rankLabel`, or `operationalProxy` field appears.
- Unresolved endpoints and intermediate points remain explicit gaps. Independently resolvable interior components remain visible and no line bridges a gap.
- The optional editor is **Explore variation** / **Explore a route variation**, local and unsaved.
- Persistent safety copy is exact: `Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.`

## 3. Walkthrough script

Record one pass/fail plus an observed value or artifact reference for every row.

| # | Action | Pass criterion | Result |
|---|---|---|---|
| 1 | Load after readiness | Populated map and full list appear without entering a callsign; HUD reports shown/total route count | ☐ |
| 2 | Exercise a fixture with 12 routes (Mode A) | 12 full-list buttons and 12 map hit paths; text says `12 of 12 recorded routes shown` | ☐ |
| 3 | Inspect overview traversal failure fixtures | Duplicate flight identity, generation drift, and non-progressing cursor pages fail explicitly; no partial overview is returned | ☐ |
| 4 | Type a callsign substring | Existing overview filters in place; map and full list show the same subset; HUD retains total count | ☐ |
| 5 | Choose a flight from the full list | List row has `aria-current="true"`; map emphasis, HUD, and details show the same flight identity | ☐ |
| 6 | Choose a different map route | Corresponding list row, HUD, and details update together | ☐ |
| 7 | Activate exactly overlapping paths | Dialog `Choose an overlapping recorded flight` lists every exact overlap; selecting one synchronizes map/list/HUD | ☐ |
| 8 | Repeat list selection with keyboard | Enter selects the focused full-list row and updates `aria-current` and HUD | ☐ |
| 9 | Inspect endpoint labels | Exact bundle matches use `Full Airport Name (ICAO)`; absent matches use `Name unavailable (ICAO)` | ☐ |
| 10 | Open Routes | Neutral `Complete recorded routes` / `Incomplete recorded routes` groups appear as applicable | ☐ |
| 11 | Inspect route order | Selected route is first; remaining routes preserve source order; modeled distance does not reorder them | ☐ |
| 12 | Inspect route payload/UI | No best/winner preference copy and no removed preference field is present | ☐ |
| 13 | Select an incomplete route | Explicit gaps/unavailable values remain visible; no total distance or geometry is fabricated across gaps | ☐ |
| 14 | Inspect unresolved-endpoint fixture | Endpoint gaps remain explicit, resolvable interior segment remains visible, and no gap is bridged | ☐ |
| 15 | Open Data | Ordered legs, point/gap status, provenance, freshness, and descriptive distance (when complete) match the map | ☐ |
| 16 | Open Compare | Same-endpoint facts are side by side without a winner; incomplete values remain unavailable | ☐ |
| 17 | Open Explore variation | Region is named `Explore a route variation`; local/unsaved and non-operational boundaries are visible | ☐ |
| 18 | Add/remove/reorder an exact point | Endpoints remain locked; variation recalculates only from exact selections | ☐ |
| 19 | Trigger variation validation failure and retry | Local edits are retained when still generation-valid; focus returns predictably after retry | ☐ |
| 20 | Clear session/focus | Focused selection, filter, drawers, and local variation clear; populated overview remains | ☐ |
| 21 | Refresh successfully | Refresh announcement is preserved until the new overview traversal settles | ☐ |
| 22 | Trigger refresh failure | Still-usable complete generation remains; failure and recovery action are explicit | ☐ |
| 23 | Enter and exit Map only | Chrome hides/restores; focus moves to `Restore controls` then back to `Map only` | ☐ |
| 24 | Disable or fail OSM tiles | Schematic map appears and Route Data remains usable | ☐ |
| 25 | Keyboard-only pass | Core journey completes through list controls with no focus loss | ☐ |
| 26 | 320 px / 400% zoom | No two-dimensional page scrolling; drawers/tables reflow or scroll within named regions | ☐ |
| 27 | Forced colors / reduced motion | Selection, gaps, and controls remain perceivable without color alone or required animation | ☐ |
| 28 | Inspect network/privacy | Browser calls only same-origin application APIs plus constrained OSM tile image URLs; no CAAS key/raw object or route state appears in URLs | ☐ |
| 29 | Inspect safety language | Persistent exact safety sentence is present; no valid/recommended/safe/cleared/best/winner route claim appears | ☐ |
| 30 | Restart | Ephemeral selection/variation is gone; a complete real generation is reacquired before the populated overview appears | ☐ |

## 4. Evidence rules

- Record exact subject, environment, timestamps, observed counts, browser, and artifact SHA-256 values.
- Screenshots and notes go under `docs/testing/artifacts/` only after checking that they contain no credential, raw upstream object, or unauthorized identifier list.
- A focused test pass is not a live-browser or human-assistive-technology pass.
- Do not edit historical generated evidence to match this protocol. Retain it as older audit history and create a new subject-bound result for the revised journey.
- Azure execution remains prohibited until separately authorized; local UAT does not evidence Azure auth, deployment, rollback, or teardown.
