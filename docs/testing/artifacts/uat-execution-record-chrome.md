# UAT execution record — Mode B (real CAAS data, keyboard-first)

Executed 2026-08-15T10:22:59.122Z by a Playwright-driven chrome against the served application
(http://localhost:18080) with real CAAS data (search subject `SIA469`). This is a
machine-executed keyboard pass recorded as supplementary evidence: the
pre-filled fixture values of the protocol (§1, Mode A) do not apply to real
data; observed values are recorded per row. Human product-owner review and
assistive-technology verification remain separate manual steps (issues
#15/#29/#17).

Summary: 16/16 rows pass.

| # | Action | Expected | Result | Observed |
|---|---|---|---|---|
| 1 | Load the app | Safety banner with the exact demonstration copy | ☑ pass | ⚠ Safety notice Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated. Skip to flight se |
| 2 | Focus on page load | Skip link present; flight search is the primary input | ☑ pass | skip links: 1 |
| 3 | Type SIA469, Enter | Listbox with flight-plan matches | ☑ pass | 1 option(s); status: flight plan match found. |
| 4 | Select the first match (ArrowDown+Enter) | HUD shows the active recorded route | ☑ pass | ACTIVE RECORDED ROUTE SIA469 route Incomplete · not included in ranking Routes Data Edit copy Map only Selected recorded |
| 5 | Select the other match, then back | Map endpoints and HUD track the selection; no stale geometry | ☑ pass | SIA matches: 92 |
| 6 | Open Routes (Enter) | Route-options drawer opens with the returned count | ☑ pass | options returned: 1 |
| 7 | Rank criterion text | Rank criterion plus the dispatch caveat | ☑ pass | This comparison uses modeled route distance as a stand-in for operational preference. It does not account for weather, fuel, clearances, or  |
| 8 | Route card state | Selected real route's completeness state shown honestly | ☑ pass | incomplete and unranked Clear session Live data fresh · retrieved 6:22:41 PM Refresh live  |
| 11 | Close the drawer (Escape) | Focus returns to the Routes trigger | ☑ pass | focus: BUTTON "Routes" |
| 12 | Open Data (Enter) | Metrics: route data, rank, points, distance | ☑ pass | Route data Edit copy Route data Some waypoints missing Distance Not su ; distance Not supplied Full-precision modeled dis ; Route rank Not ranked Points 8 Server-reported cou ; DIS |
| 13 | Data metrics for the selected route | Completeness state stated honestly | ☑ pass |  |
| 16 | Open Edit copy (Enter) | Draft safety label present | ☑ pass | t Close draft Computationally complete; operational constraints not assessed. Endpoints are locked and every change  |
| 21 | Map only, Enter | Restore controls trigger present | ☑ pass | restore trigger: 1 |
| 22 | Restore controls, Enter | Full chrome returns | ☑ pass |  |
| 23 | Clear session (Enter) | Search input reset; HUD reset | ☑ pass |  |
| 27 | Keyboard-only pass | All controls reachable by Tab; focus never lost | ☑ pass | 60 stops: BUTTON:Refresh live data \| BUTTON:Map only \| BODY:⚠ Safety noticeDemonstration only. Operational weather, NOTA \| A:Skip to flight search \| INPUT: \| BUTTON:Clear session \| BUTTON:Refresh live data \| BUTTON:Map only \| A:Skip to flight search \| INPUT: \| BUTTON:Clear session \| BUTTON:Refresh live data  |

Screenshots: uat-chrome-01-load.png, uat-chrome-02-search.png, uat-chrome-03-selected.png, uat-chrome-04-routes.png, uat-chrome-05-data.png, uat-chrome-06-edit.png, uat-chrome-07-map-only.png, uat-chrome-08-cleared.png
