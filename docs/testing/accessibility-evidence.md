# Accessibility and UAT evidence hub

Status: **In progress — deterministic evidence complete; assistive-technology and
live UAT steps pending manual execution** (issues #15–#19).

This document is the single entry point for accessibility and UAT evidence on
the map-first flight route explorer. It records exactly what was run, with
real results, retained artifacts (SHA-256 below), and the precise steps still
requiring a human reviewer. Nothing here is inferred: every claim below traces
to a command, a test suite, or a retained artifact listed in this file.

Per the testing evidence contract (`docs/testing/evidence-and-validation.md`),
the terms are used as follows:

- **Proved:** executed in this session against the built app with retained
  results (test suites, real-browser measurements, axe audits).
- **Pending manual:** procedure written, pass criteria fixed, not yet
  executed — requires a human with assistive technology and/or a live UAT
  session.

## 1. Environment (proved)

| Item | Value |
|---|---|
| Date | 2026-08-14 (all runs) |
| OS | macOS Darwin 27.0.0 (Apple Silicon) |
| Node | v26.7.0 |
| pnpm | 11.5.2 |
| Browser (real-browser lane) | Google Chrome 151.0.7922.138, headless (`--headless=new`), driven over CDP |
| Subject | Built web app served by `vite preview` at `http://localhost:4173/` (`pnpm --filter web build`, asset `dist/assets/index-DCls5O93.js` 223.82 kB / 69.69 kB gzip, `index-DpuJEj7R.css` 25.30 kB) |
| API | Deterministic local stub served over CDP `Fetch` interception, mirroring `tests/fixtures/web-app.ts` (same shapes, identifiers, exact coordinates, gap markers) |

## 2. Automated suites (proved)

All lanes run from the worktree root. Commands and real results:

```
pnpm run test:a11y        # vitest run --config vitest.config.ts a11y
#   Test Files 2 passed, Tests 15 passed
pnpm run test:e2e         # vitest run --config vitest.config.ts e2e
#   Test Files 2 passed, Tests 16 passed
pnpm run test:responsive  # vitest run --config vitest.config.ts responsive
#   Test Files 1 passed, Tests 8 passed
pnpm run validate:config  # "Root JSON, YAML, TypeScript config, and environment placeholders are valid."
pnpm run typecheck        # all packages Done
pnpm --filter web build   # dist built
```

Lanes:

- `tests/a11y/aria-structure.test.tsx` — ARIA contract: landmarks, combobox
  listbox contract (expanded/controls/activedescendant), drawer naming,
  `aria-pressed` sync, route chooser `aria-current`, route-leg table headers,
  draft combobox contract, binding strings, map-endpoints naming.
- `tests/a11y/axe.test.tsx` — axe-core 4.13.0, tags `wcag2a`, `wcag2aa`,
  `best-practice`, asserted **0 violations** in 7 UI states (jsdom; the
  layout-dependent `color-contrast` rule reports incomplete there, see §4).
- `tests/e2e/keyboard.test.tsx` — keyboard-only path: skip link, duplicate
  disambiguation, drawer close focus return, route selection focus return,
  Map Only enter/exit with deterministic focus, route retry, draft retry,
  draft point add/remove via keyboard.
- `tests/e2e/interaction.test.tsx` — pointer-path interaction review: search,
  duplicate selection, drawers, route data, unranked route + visible gap,
  comparison metrics, edit copy + reference point, failed-search recovery,
  Clear session, Map Only hide/restore, close-button focus return for all
  three drawers.
- `tests/responsive/responsive-css.test.ts` — static CSS contract for §15.7:
  zoom-capable viewport, 320 px minimum, 760 px reflow rules, named
  independently scrollable table region, reduced-motion fallback,
  forced-colors rules (17 selectors + `outline-color: Highlight`), visible
  focus outlines, and page-title h1 never `display:none` at mobile.

## 3. Real-browser axe audits (proved)

axe-core 4.13.0 injected into the headless Chrome session; same tags as the
jsdom lane. Ten states audited, each asserting **0 violations**:

| State | Violations | Passed checks |
|---|---|---|
| initial-desktop-1280 | 0 | 37 |
| initial-320px-reflow | 0 | 37 |
| flight-selected | 0 | 37 |
| route-chooser | 0 | 39 |
| route-data | 0 | 44 |
| draft-editor | 0 | 39 |
| draft-reference-listbox | 0 | 42 |
| draft-editor-with-point | 0 | 41 |
| forced-colors-active | 0 | 41 |
| reduced-motion | 0 | 41 |
| map-only | 0 | 29 |

Defect found and fixed during this lane: at 320 px the page had **no visible
`h1`** (`page-has-heading-one`, moderate) because the mobile breakpoint set
`.product-mark { display: none; }`, hiding the only page title. Fixed in
`apps/web/src/styles.css` (mobile block): the brand block is now removed from
grid layout with `position: absolute` and visually hidden with the `.sr-only`
technique, so the `h1` remains the page heading for assistive technology at
every viewport. Regression pinned in `tests/responsive/responsive-css.test.ts`
("keeps the page-title h1 in the accessibility tree at mobile").

## 4. Color contrast

- No `color-contrast` **violations** were reported in any state, jsdom or
  real browser.
- In the real browser the rule is **incomplete** (not violated) only on
  map-canvas elements where the computed background cannot be determined:
  "background gradient", "contains an image node", "overlapped by another
  element", and "contains only non-text characters". These are map imagery
  and non-text graphics, outside WCAG 1.4.3's text-contrast scope.
- Text and controls on the map and chrome are covered by the forced-colors
  layer (verified below) and by the design §15.4 requirement that color never
  be the sole channel (route states are also distinguished by line style and
  text labels — see route-card `is-complete`/`is-incomplete` styling and the
  gap row in the route table).

## 5. Responsive / reflow / zoom (proved, real browser)

Emulation: `Emulation.setDeviceMetricsOverride` (320×720) as the CSS-equivalent
of a 1280 viewport at 400 % zoom; text scale by doubling root font size
(16px→32px ≈ 200 % text zoom).

| Measurement | Result | Contract (design §15.7) |
|---|---|---|
| 320×720: `document.documentElement.scrollWidth` | 320 px (= `innerWidth`) | no two-dimensional scrolling at 320 px |
| 320×720: `body.scrollWidth` | 320 px | no page-level overflow |
| 320×720 with Data drawer open | page 320 px; `.table-scroll` region scrolls internally (`scrollWidth > clientWidth` = true) | wide table scrolls inside its own named region only |
| 200 % text scale (root font 32px) | `scrollWidth` 1265 px < 1280 px | text reflows without horizontal overflow |
| Viewport meta | `width=device-width, initial-scale=1`, no `user-scalable=no`, no `maximum-scale` | zoom capable |

Retained screenshots: `artifacts/initial-320.png`, `artifacts/route-data-320.png`.

## 6. Forced colors (proved, real browser)

Emulation: `Emulation.setEmulatedMedia` with `forced-colors: active`.
Computed styles on the map at that state:

| Element | Computed value | Meaning |
|---|---|---|
| `.route-path` stroke | `rgb(255,255,255)` | CanvasText — route stays distinguishable |
| `.route-shadow` stroke | `rgba(0,0,0,0)` | decorative shadow removed |
| `.map-marker circle:first-child` fill | `rgb(0,0,0)` | Canvas — markers stay distinguishable |
| `.legend-line` background | `rgb(255,255,255)` | CanvasText legend line |
| `.map-drawer` border | `rgb(255,255,255)` | CanvasText border keeps drawer distinct |

axe under forced colors: **0 violations** (41 checks passed). Retained
screenshot: `artifacts/forced-colors.png`. CSS contract pinned in
`tests/responsive/responsive-css.test.ts` (17 selectors + `outline-color:
Highlight`).

## 7. Reduced motion (proved, real browser)

Emulation: `prefers-reduced-motion: reduce`. `.route-card` computed
`transition-duration` = `1e-05s` (0.01 ms) — motion effectively disabled.
axe under reduced motion: **0 violations**. CSS contract pinned in
`tests/responsive/responsive-css.test.ts`.

## 8. Console errors (proved)

Real-browser session collected `Runtime.consoleAPICalled` errors and
`Log.entryAdded` errors for the entire 10-state run: **0 console errors**.

## 9. Retained artifacts (SHA-256, proved)

| Artifact | SHA-256 |
|---|---|
| `docs/testing/artifacts/initial-1280.png` | `aaa108d90a2f355658461b893c02d66a62838e6c0996c2dcb4161f6181eb40c7` |
| `docs/testing/artifacts/initial-320.png` | `917feee064a0cd8b8bc52b176324dbd337079d500861cb1fb80ac5b27919a230` |
| `docs/testing/artifacts/route-chooser.png` | `11d9fefaa9dcaffb44986f2362a7f7570cfb11507ed46cbeeb31c94938e34889` |
| `docs/testing/artifacts/route-data.png` | `67a4f61b6e6ae0766f553d450b33af5bfcd3d033c89a7e0fedd8b4ee3fc7d976` |
| `docs/testing/artifacts/route-data-320.png` | `3aae6088f1ec6729bd8482e3bc3f69b790dfd8f0bca98360169897c4595a3500` |
| `docs/testing/artifacts/draft-editor-point.png` | `9c53df3a7e7c8829de35285f58eb2e03eff0db28e96dfdc883e4405a85f52eab` |
| `docs/testing/artifacts/forced-colors.png` | `adb88e4e7888a12f50421fd8169eacd5185ff8e5a61f5b7771afcf5d88262501` |
| `docs/testing/artifacts/map-only.png` | `9754253308d0606df6f14752c22229b7f3678ea25b8fc21fbbacf626c8850cd0` |

## 10. Pending manual evidence

The following require a human with real assistive technology and/or a live
UAT session. Procedures and pass criteria are fully specified:

- `docs/testing/keyboard-review.md` — keyboard-only E2E review (issue #16):
  automated portion proved above; VoiceOver/NVDA-only steps pending.
- `docs/testing/screen-reader-review.md` — named SR/browser matrix
  (issue #17): VoiceOver + Safari and NVDA + Chrome procedures with pass
  criteria; not executed in this session.
- `docs/testing/uat-walkthrough.md` — retained manual UAT protocol (issue #15)
  with pre-filled deterministic content; actual UAT execution is tracked
  separately (issue #29) and remains pending.

## 11. Related documents

- `docs/testing/evidence-and-validation.md` — repository evidence contract
  (Release Evidence workstream; not modified by this workstream).
- `docs/testing/keyboard-review.md`, `docs/testing/screen-reader-review.md`,
  `docs/testing/responsive-review.md`, `docs/testing/uat-walkthrough.md` —
  workstream deliverables (issues #16, #17, #18, #15).
