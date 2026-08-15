# UAT walkthrough protocol (issue #15)

Status: **Protocol ready; execution pending.** This document converts the
implementation improvements into a retained manual UAT script a human
reviewer can execute and file back. Deterministic content (exact strings,
expected states, acceptance criteria) is pre-filled from the north-star design
(design §0, §15.2, §15.4, §15.6, §15.7) so the reviewer records observations,
not opinions. Amended 2026-08-15: §1 corrected — the fixture values are
reproducible only through the automated vitest lanes; a live rehearsal runs
against real CAAS data. Actual UAT execution is tracked separately (issue #29)
and is not claimed here.

## 1. How to execute

The pre-filled exact values below are deterministic **fixture** values
(`FIXTURE1`, `KOR1`, `KDS1`, `MIDPT`). The runtime API has no synthetic-data
mode (binding design §0.1 / `AC-POC-LIVE-01`: no synthetic runtime/demo
fallback, fail-closed without a real CAAS credential), and `vite preview` has
no API proxy — so those values cannot be reproduced against a served
application. Two honest execution modes exist:

**Mode A — deterministic fixture rehearsal (automated).** The vitest lanes
run the §3 steps against the fixture harness and already prove them
mechanically: interaction lane (search, drawers, route data, editing, error
recovery, Clear session, Map Only) `pnpm run test:a11y`; keyboard lane
(focus return, retries, skip link) `pnpm run test:e2e`; responsive lane
`pnpm run test:responsive`. A pass there is the recorded evidence for every
pre-filled expectation below; no browser session can add to it.

**Mode B — live rehearsal (real CAAS data, authorized local run).** Build the
UI, boot the API (which serves the built assets), and execute the script
against real data:

```bash
pnpm --filter web build
NODE_ENV=production WEB_ASSET_DIR="$PWD/apps/web/dist" \
  node --experimental-strip-types apps/api/src/cli.ts --port 18080 --env-file .env
# open http://localhost:18080 (local .env CAAS credential; authorized loopback
# use; port 8080 is commonly occupied by other local services). Startup fails
# loudly with a bounded message when the credential is missing or a mandatory
# family is unusable.
```

In Mode B the exact fixture-specific values (search term, references, 512.4 NM
figures, fixture gap text) do **not** apply: record the observed real values in
the Result column instead. Data-independent expectations (safety copy, rank
criterion text, Rank-1 label, status announcements, focus behavior) apply
exactly in both modes. An executed Mode B record exists at
`docs/testing/artifacts/uat-execution-record-*.md` (2026-08-15, search subject
`SIA469`, 16/16 rows in Chromium and WebKit) — use it as the reference format.

Record one ☐ pass / ☐ fail + note per row; attach a screenshot or notes to
any fail and store it in `docs/testing/artifacts/`. Return the completed file
to the workstream owner.

Pre-filled data for this fixture set:

- 2 search matches (both `FIXTURE1`): `KOR1 → KDS1` (3 points) and
  `KOR1 → KDSS` (2 points).
- Route options for `KOR1 → KDS1`:
  - Ranked: `Recorded via MIDPT`, Rank 1, **512.4 NM**, 3 points, 3 legs,
    0 gaps — complete.
  - Unranked: `Recorded with unresolved gap`, **Unranked**, incomplete —
    gap at position 2, reason: `MIDPT could not be resolved to a single reference`.
- Draft comparison (endpoint-only): 2 legs `KOR1 → MIDPT` 240.5 NM and
  `MIDPT → KDS1` 271.9 NM; total **512.4 NM**, delta **+0.0 NM**,
  `Draft validation completed.`

## 2. Acceptance criteria (from north-star binding docs)

- AC-POC-LOCAL-01 (design §0.6): the "automated accessibility" clause of the
  loopback-only five-family container gate — automated a11y checks exist and
  run in the repo test lane; the full criterion also requires the CI OCI
  digest gate, which stays blocked until the authoritative subject is
  recorded. → The a11y clause is proved by the vitest lanes; see
  `docs/testing/accessibility-evidence.md` §2.
- Design §15.2: Map Only mode exists; deterministic focus return on close and
  on restore; desktop drawers are nonmodal (no focus trap); triggers expose
  `aria-pressed`.
- Design §15.4: color never the sole channel; forced-colors survival.
- Design §15.6: combobox/listbox contract for flight search and draft point
  search; live regions announce every state change; route-leg table sits in a
  named scrollable region.
- Design §15.7: 320 px and 400 % zoom/reflow without two-dimensional
  scrolling; reduced-motion fallback.

## 3. Walkthrough script

### 3.1 Initial state and search

| # | Action | Expected (exact) | Result |
|---|---|---|---|
| 1 | Load the app | Safety banner reads: `Safety notice — Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated.` | ☐ |
| 2 | Focus is on page load | Skip link present; flight search is the primary input | ☐ |
| 3 | Type `FIXTURE1`, Enter | Listbox `Choose an exact flight-plan match` with exactly 2 options: `FIXTURE1 · KOR1 → KDS1` and `FIXTURE1 · KOR1 → KDSS` | ☐ |
| 4 | Select the `KOR1 → KDS1` match | Status announces `2 route options returned`; HUD shows the flight; map shows endpoint chips `Departure KOR1` / `Arrival KDS1` | ☐ |
| 5 | Select the other match, then back | Map endpoints and HUD track the selection; no stale geometry | ☐ |

### 3.2 Route chooser

| # | Action | Expected (exact) | Result |
|---|---|---|---|
| 6 | Open "Routes" | Ranked group `Ranked routes` with 1 card `Recorded via MIDPT` — `Rank 1`, `512.4 NM`, `3 points · 3 legs · 0 visible gaps` | ☐ |
| 7 | Rank criterion text | `Routes are ranked by shortest recorded distance among routes with the same departure and arrival. Rank 1 is the shortest route in this retrieved set.` plus the dispatch caveat sentence | ☐ |
| 8 | Unranked group | `Unranked routes (incomplete data)` with card `Recorded with unresolved gap` — `Unranked`, badge `incomplete`, reason `This route has unresolved waypoints and cannot be ranked.` | ☐ |
| 9 | Select the unranked card | HUD strong reads `Recorded with unresolved gap`; status announces `Selected Recorded with unresolved gap.`; map draws the gap boundary | ☐ |
| 10 | Select the ranked card | HUD returns to `Recorded via MIDPT` with `512.4 NM · Rank 1` | ☐ |
| 11 | Close the drawer | Focus returns to the "Routes" trigger | ☐ |

### 3.3 Route data

| # | Action | Expected (exact) | Result |
|---|---|---|---|
| 12 | Open "Data" | Metrics: `Route data: All waypoints found`, `Distance: 512.4 NM`, `Route rank: Rank 1`, `Points: 3` | ☐ |
| 13 | Table | Columns `Sequence, From, To, Distance, Status`; rows: `1 KOR1 MIDPT 240.5 NM resolved`, `2 MIDPT KDS1 271.9 NM resolved` | ☐ |
| 14 | Evidence stack | `How route ranking works` = rank criterion; `Provenance`; `Safety boundary` = the §3.1 safety text; `Visible gaps` = `No gaps reported by the route service.` | ☐ |
| 15 | Select the unranked route, reopen Data | `Route data: Some waypoints missing`; `Route rank: Not ranked`; gap row shows `Unresolved gap — MIDPT could not be resolved to a single reference` | ☐ |

### 3.4 Editing and comparison

| # | Action | Expected (exact) | Result |
|---|---|---|---|
| 16 | Open "Edit copy" | Draft safety label: `Computationally complete; operational constraints not assessed. Endpoints are locked and every change is checked against exact reference data.` | ☐ |
| 17 | Draft metrics | `Draft status: complete`; `512.4 NM`; `+0.0 NM`; `Draft validation completed.` | ☐ |
| 18 | Add `MIDPT` | Point appears in `Intermediate points` with `Manual-direct segments are not airways.`; distance stays `512.4 NM`, delta `+0.0 NM` | ☐ |
| 19 | Reorder / remove | `Move up`, `Move down`, `Remove` controls behave; `Remove MIDPT` returns the draft to endpoint-only | ☐ |
| 20 | Trigger validation failure (stub) then Retry | Alert `Could not load route options.` / `Draft validation ... failed`; `Retry` revalidates and focus lands on the draft heading | ☐ |

### 3.5 Map Only and session

| # | Action | Expected (exact) | Result |
|---|---|---|---|
| 21 | "Map only", Enter | Header, search, rail, and legend disappear; map fills the viewport; focus is on `Restore controls`; page title `Map-first route comparison` | ☐ |
| 22 | "Restore controls", Enter | Full chrome returns; focus on the "Map only" trigger | ☐ |
| 23 | "Clear session" | Search input empty; HUD shows `Recorded routes appear after selection`; status `Session cleared.` | ☐ |

### 3.6 Error recovery

| # | Action | Expected (exact) | Result |
|---|---|---|---|
| 24 | Failed search (stub) | Alert with the exact stubbed message; retry succeeds without reload; no data loss | ☐ |
| 25 | Failed route options (stub) | `Could not load route options.` + `Retry route options`; retry shows the ranked list | ☐ |
| 26 | Failed draft validation (stub) | Explicit failure notice; `Retry draft validation`; draft state preserved | ☐ |

### 3.7 Accessibility spot checks (keyboard + zoom)

| # | Action | Expected | Result |
|---|---|---|---|
| 27 | Keyboard-only pass 1–26 | All steps reachable by Tab/Enter/arrows; focus never lost | ☐ |
| 28 | 320 px viewport | No horizontal page scroll; drawer becomes a bottom sheet; table scrolls inside its own region | ☐ |
| 29 | 400 % zoom (or equivalent) | Content reflows; no two-dimensional scrolling | ☐ |
| 30 | Reduced motion + forced colors on | No perceptible animation; map layers remain distinguishable | ☐ |

## 4. Evidence

- Pre-filled expectations are binding: any deviation must be filed with the
  exact observed value.
- Completed protocol, screenshots, and notes are retained under
  `docs/testing/artifacts/`; this file (or a copy) is returned with results.
- Automated coverage that already proves §3 steps (see
  `docs/testing/accessibility-evidence.md` §2): interaction lane (search,
  drawers, route data, editing, error recovery, Clear session, Map Only),
  keyboard lane (focus return, retries, skip link), aria-structure lane,
  axe lane (all states), responsive lane.
