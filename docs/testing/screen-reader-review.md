# Screen-reader and browser compatibility review (issue #17)

Status: **Automated ARIA/axe portion passes for the current overview-first UI.** Historical browser records from 2026-08-15 remain valid only for the older subject and wording they captured. Revised human VoiceOver/NVDA execution remains pending or separately waived by the owner; automated checks do not prove real announcements.

## 1. Current automated evidence

- `tests/a11y/aria-structure.test.tsx`: 8 tests pass.
- `tests/a11y/axe.test.tsx`: 9 tests pass, zero violations in every audited state. jsdom reports expected incomplete color-contrast checks because canvas pixel analysis is unavailable.
- Combined accessibility run: 17/17 tests.
- `tests/e2e/keyboard.test.tsx`: 11/11 tests, including keyboard selection from the full flight list.
- `tests/e2e/interaction.test.tsx`: 17/17 tests, including >10 routes, map/list/HUD synchronization, shared filtering, and the exact-overlap chooser.

Automated evidence covers semantics and deterministic focus/state. It does not substitute for VoiceOver, NVDA, visual contrast judgment, or comprehension testing.

## 2. Semantic structure pinned by tests

- One banner and one main landmark; skip link remains first in tab order.
- The callsign control is a combobox/filter over the populated overview, with listbox semantics for exact flight-plan matches.
- The full flight list is always the keyboard-equivalent route-selection path and selected rows use `aria-current="true"`.
- Drawers are named nonmodal regions: `Route chooser`, `Flight and route data`, `Explore a route variation`, and `Route comparison`.
- Neutral route groups are `Complete recorded routes` and `Recorded routes with visible gaps` as applicable.
- The route-leg table remains inside `Scrollable route-leg table` with `Sequence`, `From`, `To`, `Distance`, and `Status` headers.
- The exact-overlap dialog is named `Choose an overlapping recorded flight`.
- Map Only keeps an announceable page title and moves focus deterministically to `Restore controls`; restore returns focus to `Map only`.

## 3. Exact current strings

- Safety: `Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.`
- Neutral comparison: `Recorded routes are shown in stable source order for neutral comparison. Modeled distance is descriptive only and does not identify a preferred route.`
- Complete group: `All recorded route components resolved exactly. No route is labeled as preferred or first.`
- Incomplete group: `Some references could not be resolved exactly. Resolved components remain visible and gaps are never bridged.`
- Variation safety: `Computationally complete; operational constraints not assessed.`
- Overview load: `<N> recorded flight route(s) loaded in the overview.`
- Selected flight options: `<N> same-endpoint recorded route(s) returned for neutral comparison with <callsign>.`

## 4. Pending human procedure

Run once for each owner-required screen-reader/browser pairing against an exact named subject.

| # | Keyboard action | Pass criterion | Result |
|---|---|---|---|
| 1 | Load and `Tab` | First stop is `Skip to flight search`; overview load status is announced once | ☐ |
| 2 | Continue to full flight list | Each route button includes callsign, endpoints, completeness/distance information, and selected state | ☐ |
| 3 | Press Enter on a list route | HUD and `aria-current` update to the same identity; neutral route-load status is announced | ☐ |
| 4 | Type a callsign substring | Full list and map subset change together; shown/total count remains understandable | ☐ |
| 5 | Open Routes | `Route chooser, region`; complete/incomplete group names and neutral explanation are announced | ☐ |
| 6 | Move through route options | No rank/winner announcement; distance is described only when available; gap state is explicit | ☐ |
| 7 | Open Data | `Flight and route data, region`; table headers and gap rows are announced | ☐ |
| 8 | Open Explore variation | `Explore a route variation, region`; local/unsaved and safety state are announced | ☐ |
| 9 | Add/remove an exact point | Result and remove button include the exact reference identifier | ☐ |
| 10 | Trigger exact-overlap chooser | Dialog name, overlap count, and each flight choice are announced | ☐ |
| 11 | Enter Map only | `Restore controls` receives focus and the map-first page title remains announceable | ☐ |
| 12 | Restore controls | Focus returns to `Map only`; populated overview remains available | ☐ |

For a failure, retain pairing, exact subject, step number, observed announcement verbatim, expected wording, impact, and a safe screenshot/recording reference.

## 5. Evidence boundary

Do not rewrite historical execution records to use current copy. A revised human pass requires a new subject-bound record. Azure and production accessibility remain unevidenced unless separately executed and authorized.
