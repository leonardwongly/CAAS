# Keyboard-only map-first E2E review (issue #16)

Status: **Current automated portion passes: 11/11 keyboard tests.** Historical 2026-08-15 browser/UAT records remain older-subject evidence and are not relabeled as proof of the revised overview-first journey. Human assistive-technology narration remains separate.

## 1. Deterministic keyboard scenarios

Suite: `tests/e2e/keyboard.test.tsx`.

| Scenario | Keyboard action | Assertion |
|---|---|---|
| Skip link | `Tab`, `Enter` | First stop is `Skip to flight search`; focus reaches the callsign filter |
| Initial overview | Navigate without searching | Populated full flight list is reachable after overview readiness |
| Full-list selection | Focus a route row, `Enter` | Row gains `aria-current="true"`; HUD and selected `flightId` update |
| Callsign duplicate choice | Type fixture callsign, `Enter`, arrows, `Enter` | Exact match listbox is explicit; selected flight loads same-endpoint neutral options |
| Route option selection | Open Routes, tab to a route, `Enter` | Selected route and HUD synchronize; focus returns predictably |
| Drawer close | Open each drawer, activate its close button | Focus returns to Routes, Data, Explore variation, or Compare trigger |
| Explore variation | Open region; add/remove an exact reference | Combobox/listbox and remove button work with keyboard only |
| Retry | Trigger route/variation failure and activate Retry | State is preserved where valid and focus lands on the affected heading |
| Map Only | Activate `Map only`, then `Restore controls` | Chrome hides/restores and focus moves deterministically |
| Clear/reset | Activate reset control | Focused selection/filter/variation clears while populated overview remains |
| API data page | Open API data, then return | Focus moves to page heading and back to the rail trigger |

## 2. Current status strings

The role-status assertions cover:

- `<N> recorded flight route(s) loaded in the overview.`
- `Selected flight <callsign>, departing <origin> for <destination>. Loading same-endpoint recorded routes.`
- `<N> same-endpoint recorded route(s) returned for neutral comparison with <callsign>.`
- `Selected flight <callsign> from the neutral route comparison.`
- `Route variation validated against exact reference data.` or the explicit unresolved-gap alternative.
- `Session reset.`
- refresh success/failure plus final overview readiness.

Alerts remain action-specific. No status announces a rank, winner, or preferred route.

## 3. Pending human announcement pass

Against an exact named subject, replay the core journey with VoiceOver or NVDA and record verbatim output:

| Action | Expected meaning | Result |
|---|---|---|
| Load | Overview readiness count announced once | ☐ |
| Enter on full-list route | Selected identity and neutral route-load status | ☐ |
| Filter callsign | Map/list subset and shown/total count remain understandable | ☐ |
| Enter on Routes | `Route chooser, region`; neutral complete/incomplete grouping | ☐ |
| Enter on Data | `Flight and route data, region`; table headers announced | ☐ |
| Enter on Explore variation | `Explore a route variation, region`; local/unsaved safety meaning | ☐ |
| Exact-overlap route | `Choose an overlapping recorded flight, dialog` and each choice | ☐ |
| Enter Map only / restore | `Restore controls` then focus return to `Map only` | ☐ |

## 4. Evidence boundary

Automated focus and DOM semantics do not prove a real screen reader. Retain a new result for the revised journey and do not edit historical records. Azure and production behavior remain outside this local keyboard claim.
