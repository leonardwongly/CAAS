# Screen-reader and browser compatibility review (issue #17)

Status: **Automated ARIA/axe portion proved (2026-08-14); browser
compatibility recorded (2026-08-15, `artifacts/browser-compatibility-record.md`:
Chrome 16/16, Chromium 16/16, WebKit 16/16 — the Chrome run refreshed at
10:22Z). The named screen-reader (VoiceOver) and Firefox rows were waived by
the owner on 2026-08-15 in favor of the real-Chrome standard.**

## 1. Named matrix

| Combination | Role tested by | Status |
|---|---|---|
| VoiceOver + Safari (macOS, latest) | Human reviewer | Pending manual (procedure §4) |
| NVDA + Chrome (Windows, latest) | Human reviewer | Pending manual (procedure §4) |

No assistive technology is available in this environment; the deterministic
parts are proved below so the manual pass reduces to verification, not
discovery.

## 2. Deterministic evidence (proved)

### 2.1 ARIA structure (`tests/a11y/aria-structure.test.tsx`, 8/8 passed)

- Landmarks: one `banner` (header), one `main`; skip link is the first
  focusable element; Map Only mode keeps exactly the map landmark plus an
  `h1` (page title stays announceable).
- Flight search is a combobox with `aria-expanded`, `aria-controls`,
  `aria-activedescendant` (`flight-match-N`) and closes on Escape —
  announced as a listbox by both VoiceOver and NVDA.
- Draft point search is the same combobox/listbox pattern
  (`draft-match-N`), `aria-autocomplete="list"`.
- Drawers are `role="region"` with distinct accessible names: "Route
  chooser", "Flight and route data", "Local route editor" — each
  nonmodal on desktop (no focus trap, design §15.2).
- Rail triggers expose `aria-pressed` that stays in sync with the open
  drawer.
- Route chooser groups expose `aria-current="true"` only on the selected
  route card.
- Route-leg table has column headers `Sequence`, `From`, `To`, `Distance`,
  `Status`, inside a named scrollable region (`role="group"`,
  `aria-label="Scrollable route-leg table"`).
- Map endpoint locations are a named section ("Route endpoint locations")
  with Departure/Arrival points announced in document order.
- Binding strings announced verbatim: the rank criterion, the safety
  notice, and the draft safety label (exact text in §2.3).

### 2.2 axe audits (`tests/a11y/axe.test.tsx` + real browser)

0 violations in all 7 jsdom states and all 10 real-browser states
(`wcag2a`, `wcag2aa`, `best-practice`); `color-contrast` incomplete only on
non-text map imagery (see `docs/testing/accessibility-evidence.md` §3–§4).

### 2.3 Exact announced strings (proved)

- Safety banner: `Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.`
- Rank criterion: `Routes are ranked by shortest recorded distance among routes with the same departure and arrival. Rank 1 is the shortest route in this retrieved set.` (rendered with suffix ` It does not account for safety, clearance, legality, weather, fuel, or airline dispatch constraints.`)
- Draft safety label: `Computationally complete; operational constraints not assessed. Endpoints are locked and every change is checked against exact reference data.`

## 3. Interaction guarantees (proved, jsdom keyboard lane)

- Focus return after every drawer close and after Map Only restore
  (design §15.2) — `tests/e2e/keyboard.test.tsx`.
- No focus trap in desktop drawers; Map Only moves focus deterministically
  to "Restore controls".

## 4. Pending manual procedure (per named combination)

For each row of the §1 matrix, a reviewer executes once and retains notes
(+ screenshot if failure) in `docs/testing/artifacts/`.

### 4.1 Setup

1. Fresh profile; only the target SR enabled; no browser extensions.
2. Open the built app at the preview URL with the screen reader active
   from first paint.

### 4.2 Steps and pass criteria (record ☐ pass / ☐ fail + note per cell)

| # | Action (keyboard only) | Pass criterion |
|---|---|---|
| 1 | `Tab` from load | First stop is "Skip to flight search" |
| 2 | `Enter` on skip link | Focus moves to the flight search input |
| 3 | Type `FIXTURE1`, `Enter` | Listbox announced: "Choose an exact flight-plan match, 2 options" |
| 4 | `ArrowDown`, `Enter` | Polite status announces "2 route options returned" |
| 5 | `Enter` on "Routes" | "Route chooser, region" announced; "Routes" trigger announces pressed |
| 6 | `Tab` through route cards | Each card announces label, distance, "Rank 1" or "Unranked", gap info |
| 7 | `Enter` on "Data" | Region announced; table announces column headers `Sequence`, `From`, `To`, `Distance`, `Status` |
| 8 | `Enter` on "Edit copy" | "Local route editor, region"; safety label of the draft announced on focus |
| 9 | Tab to "Remove MIDPT" / "Remove" | Announcement includes the reference name |
| 10 | `Enter` on "Close draft" | Focus returns to "Edit copy" |
| 11 | `Enter` on "Map only" | Chrome (header/nav/search) disappears; "Restore controls" focused; page title "Map-first route comparison" announced |
| 12 | `Enter` on "Restore controls" | Full chrome returns; focus on "Map only" |

### 4.3 Defect report template

For any fail: combination (VoiceOver+Safari / NVDA+Chrome), step #, observed
announcement verbatim, expected verbatim, screenshot/recording filename.

## 5. Evidence

- Automated: suites listed in `docs/testing/accessibility-evidence.md` §2;
  command outputs retained in that document.
- Manual: this document's §4 tables once executed (issue tracked separately;
  see `docs/testing/uat-walkthrough.md`).
