# Keyboard-only map-first E2E review (issue #16)

Status: **Automated portion proved (2026-08-14); a recorded keyboard-first
live-data pass exists (2026-08-15, `artifacts/uat-execution-record-*.md`,
16/16 rows in Chromium and WebKit); assistive-technology verification remains
pending manual execution.**

Scope (from issue #16): search, duplicate selection, drawers, route data,
comparison, editing, error recovery, retries, and Map Only — executed with the
keyboard only. The deterministic, machine-executed portion is covered by
`tests/e2e/keyboard.test.tsx` (vitest + jsdom + user-event, real tab/arrow
flows through the app's own focus logic). The screen-reader announcement
portion cannot be executed without assistive technology in this environment
and is specified below with exact expected announcements.

## 1. Deterministic keyboard tests (proved)

Suite: `tests/e2e/keyboard.test.tsx` — 8 tests, all passed
(`pnpm run test:e2e` → `Test Files 2 passed, Tests 15 passed`).

| Scenario | Key sequence exercised | Assertion (proved) |
|---|---|---|
| Skip link is the first tab stop | `Tab` | focus moves to "Skip to flight search" and its target `#flight-search` exists |
| Duplicate disambiguation | type `FIXTURE1`, `Enter`, `ArrowDown`, `Enter` | a `listbox` "Choose an exact flight-plan match" with 2 `option`s opens; selection announces "2 route options returned" in the live region |
| Close button focus return | `Tab` to "Routes", `Enter`, `Tab` to "Close", `Enter` | focus returns to the "Routes" trigger (design §15.2 deterministic focus return) |
| Route card selection focus | `Tab` to a route card, `Enter` | focus returns to the route chooser heading after selection; HUD updates |
| Map Only enter/exit | `Tab` to "Map only", `Enter`; then "Restore controls", `Enter` | chrome hidden (`banner`/`navigation` gone), focus lands on "Restore controls" immediately; on restore, focus returns to "Map only" |
| Route options retry | trigger options error (`failRoutes` stub), `Tab` to "Retry route options", `Enter` | error alert "Could not load route options." shown; after retry the ranked list loads and focus lands on the "Route options" heading |
| Draft validation retry | trigger draft error (`failDraft` stub), `Tab` to "Retry draft validation", `Enter` | focus lands on the "Local computational draft" heading; validation succeeds |
| Draft point add/remove | in "Add an exact reference point" combobox type `MIDPT`, `Enter`, `ArrowDown`, `Enter`, then `Tab` to "Remove MIDPT", `Enter` | option added to the draft via-list; removed again via keyboard |

## 2. Live-region announcement strings (proved via `role="status"`)

The same strings a screen reader will announce were asserted exactly:

- Search result count: `"N route options returned"` after exact-match selection.
- Route selection: `"Selected <label>."`
- Draft validation: `"Draft validation completed."`
- Session reset: `"Session cleared."`
- Search failure (role="alert"): the exact stubbed error message
  `"Search service unavailable (stub)."`
- Route options failure (role="alert"): `"Could not load route options."`

Both status regions are `role="status" aria-live="polite"` (App top level and
DraftEditor).

## 3. Pending manual: screen-reader announcement pass

Requires VoiceOver (macOS) or NVDA (Windows). Procedure:

1. Open the app at the built preview URL with the screen reader running.
2. With the keyboard only, replay scenario 1–9 from §1.
3. Record the announcement after each action in the table below.

Pass criteria (all must hold; this is the "SR announced as specified" gate):

| Action | Expected announcement (exact) | Result |
|---|---|---|
| Tab once | "Skip to flight search, link" | ☐ pass / ☐ fail + note |
| Type `FIXTURE1`, Enter | "Choose an exact flight-plan match, list box, 2 options" | ☐ pass / ☐ fail + note |
| ArrowDown, Enter | "2 route options returned" (polite) | ☐ pass / ☐ fail + note |
| Enter on "Routes" | "Route chooser, region" / rail button state "Routes, pressed" | ☐ pass / ☐ fail + note |
| Enter on "Data" | "Flight and route data, region" | ☐ pass / ☐ fail + note |
| Enter on "Edit copy" | "Local route editor, region" | ☐ pass / ☐ fail + note |
| Close draft, Enter | "Edit copy, button" (focus return) | ☐ pass / ☐ fail + note |
| "Map only", Enter | "Restore controls, button" announced; page title "Map-first route comparison" | ☐ pass / ☐ fail + note |

Retain: screenshot/notes of any failure; file in `docs/testing/artifacts/`.

## 4. Evidence

- Deterministic results: `tests/e2e/keyboard.test.tsx` (8/8 passed),
  `tests/e2e/interaction.test.tsx` (7/7 passed); command and output in
  `docs/testing/accessibility-evidence.md` §2.
- Real-browser states (same interaction paths, pointer-driven) proved with
  axe: 0 violations across flight-selected, route-chooser, route-data,
  draft-editor, draft-reference-listbox, map-only — screenshots retained
  (`artifacts/route-chooser.png`, `artifacts/route-data.png`,
  `artifacts/draft-editor-point.png`, `artifacts/map-only.png`).
