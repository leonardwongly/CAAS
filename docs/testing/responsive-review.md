# Responsive, zoom/reflow, forced-colors, reduced-motion review (issue #18)

Status: **Proved in real browser (2026-08-14) plus deterministic CSS
regression lane; no failures. One defect found and fixed during review.**

## 1. Summary of findings

| Requirement (design §15.7) | Result | Evidence |
|---|---|---|
| 320 px minimum, no two-dimensional scrolling | Pass | measured, §2 |
| 400 % zoom reflow equivalence | Pass | measured, §2 |
| 200 % text zoom reflow | Pass | measured, §2 |
| Wide route table scrolls only inside its named region | Pass | measured, §2 |
| Zoom-capable viewport meta | Pass | asserted, §4 |
| Forced-colors survival (design §15.4) | Pass | measured + axe, §3 |
| Reduced-motion fallback for all animation/transition | Pass | measured + asserted, §3 |
| Visible focus at every viewport | Pass | asserted, §4 |
| Page heading present at mobile width | **Fixed** | §5 |

## 2. Real-browser measurements (proved)

Environment: Chrome 151.0.7922.138 headless, CDP emulation over the built app
at `http://localhost:4173/` (details and hashes in
`docs/testing/accessibility-evidence.md` §1, §5, §9).

| Measurement | Value | Contract |
|---|---|---|
| `document.documentElement.scrollWidth` @ 320×720 | **320 px** (equals `innerWidth`) | no horizontal page scroll at 320 px |
| `body.scrollWidth` @ 320×720 | **320 px** | no body-level overflow |
| Data drawer open @ 320×720 | page `scrollWidth` **320 px**; `.table-scroll` region has internal horizontal scroll (`scrollWidth > clientWidth` = true) | the 540 px-wide table scrolls within its named region only; the page never scrolls horizontally |
| Root font 32 px (≈200 % text zoom) @ 1280 | `scrollWidth` **1265 px < 1280** | text reflows without horizontal overflow |
| Viewport meta | `width=device-width, initial-scale=1`; no `user-scalable=no`; no `maximum-scale` | zoom remains user-controlled (WCAG 1.4.4) |

Retained screenshots: `artifacts/initial-320.png` (home at 320 px),
`artifacts/route-data-320.png` (data drawer at 320 px).

## 3. Forced colors and reduced motion (proved)

Emulation via `Emulation.setEmulatedMedia`.

Forced colors (`forced-colors: active`):

| Element | Computed | Means |
|---|---|---|
| `.route-path` stroke | CanvasText (white) | route distinguishable |
| `.route-shadow` stroke | transparent | decoration dropped |
| `.map-marker circle` fill | Canvas (black) | marker distinguishable |
| `.legend-line` background | CanvasText | legend line distinguishable |
| `.map-drawer` border | CanvasText | drawer boundary distinguishable |

axe under forced colors: **0 violations**. Screenshot:
`artifacts/forced-colors.png`. Note: route status is never conveyed by color
alone — incomplete routes also show "Unranked"/"incomplete data" text and a
gap row with the exact unresolved-reference reason (design §15.4).

Reduced motion (`prefers-reduced-motion: reduce`): `.route-card` computed
`transition-duration` = `1e-05s` (0.01 ms) — all transitions/animations
collapsed to imperceptible. axe: **0 violations**.

## 4. Deterministic CSS regression lane (proved)

`tests/responsive/responsive-css.test.ts` (8/8 passed) pins the contract in
source so CI fails on regression:

- `lang="en"`, title, zoom-capable viewport; no `user-scalable=no`/`maximum-scale`.
- `body { min-width: 320px }`.
- 760 px block: topbar grid `1fr auto`, drawer `calc(100% - 16px)` bottom
  sheet, legend row, endpoint chips.
- `.table-scroll { overflow-x: auto }` + `table { min-width: 540px }`, while
  `.map-first-shell` has no min-width (only the table's region scrolls).
- `prefers-reduced-motion: reduce` block with `animation-duration: .01ms`
  and `transition-duration: .01ms`.
- Forced-colors block covering 17 selectors + `outline-color: Highlight`.
- No unconditional `outline: none` — every such selector has a `:focus`/
  `:focus-visible` replacement.
- The page-title `h1` is never `display: none` at mobile (§5).

## 5. Defect found and fixed during review

**page-has-heading-one at 320 px (moderate).** The 760 px breakpoint hid the
brand block (`.product-mark { display: none; }`), removing the only `h1` from
the accessibility tree at mobile widths. Caught by the real-browser axe pass
(jsdom cannot catch it: vitest runs with CSS disabled).

Fix (`apps/web/src/styles.css`, 760 px block): `.product-mark` is now removed
from grid layout with `position: absolute` and visually hidden with the
`.sr-only` technique (clip + 1px + overflow hidden), so the `h1` remains the
announceable page title at every viewport while the visual layout is
identical (toolbar-search still 1fr, toolbar-clear auto).

Verified after fix: axe @ 320×720 — **0 violations** (`page-has-heading-one`
gone). Regression pinned in the responsive lane ("keeps the page-title h1 in
the accessibility tree at mobile").

## 6. Pending manual confirmation

Automated coverage uses emulation; a human pass on physical devices is
recommended before release (not an acceptance blocker for the POC):

- iPhone SE (375×667) and a 320 px-wide Android device: verify drawer sheet,
  legend row, endpoint chips, and table region scrolling at 100 % and 400 %.
- Windows High Contrast (forced colors): verify the §3 computed values
  visually, including the restore-controls button and rail buttons.
- macOS "Reduce Motion" + Windows animation off: verify no perceptible
  animation on route selection and HUD updates.

## 7. Evidence

Measurements and screenshots: `docs/testing/accessibility-evidence.md` §5–§9;
CSS lane: `tests/responsive/responsive-css.test.ts`; screenshots retained
under `docs/testing/artifacts/`.
