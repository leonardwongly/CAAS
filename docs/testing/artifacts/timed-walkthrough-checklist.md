# Timed walkthrough checklist (issue #29) — retained evidence + demo script

Prepared 2026-08-15 for the product-owner run. Status: the owner instructed
closure of #29 on 2026-08-15 with the machine-executed evidence retained; the
9 UAT rows below are filled from the real-Chrome keyboard-first execution
(`uat-execution-record-chrome.md`, 16/16 rows, run 2026-08-15T10:22Z against a
freshly acquired generation). The 20-minute segment plan remains the demo
script for the live walkthrough.

The rehearsal server is booted at `http://localhost:18080` (fresh acquisition;
restart with
`NODE_ENV=production WEB_ASSET_DIR="$PWD/apps/web/dist" node --experimental-strip-types apps/api/src/cli.ts --port 18080 --env-file .env`
if it has gone stale — the UI will say so and fail closed).

## Timing (binding — 20 minutes, 8 fixed segments)

| Segment | Minutes | What to show (with real data, e.g. callsign `SIA469`) |
|---|---|---|
| 1 | 2 | Problem, safety boundary, architecture, code structure |
| 2 | 2 | Real API evidence, sanitization, live refresh, limits |
| 3 | 3 | Callsign search → duplicate/unambiguous selection → route map + table |
| 4 | 3 | Gaps, hidden airway data, modeled distance, Rank 1 ties, user choice |
| 5 | 3 | Edit copy + directed comparison |
| 6 | 3 | Tests, accessibility/failure states, build/test/deploy code |
| 7 | 2 | Exact digest (`sha256:ae5dc6d1…`), PG-03 pass, direct Azure deployment, auth, rollback (design-only) |
| 8 | 2 | Limitations, AI use, lessons, requested feedback, roadmaps |

10 minutes reserved for questions and transitions. A rehearsal exceeding 20
minutes is a defect and must be re-rehearsed (per docs/operations/uat-and-timed-walkthrough.md).

## UAT evidence rows (filled from the retained Chrome execution)

| # | Item | Pass criteria | Observed |
|---|---|---|---|
| 1 | Browse-all exact-once | Every record exactly once; no truncation | ☑ pass — CONTAINER-LIVE-BROWSE-EXACT-ONCE in the authorized container live run (`docs/evidence/container-live-lane-afe29166ac21.json`, bounded sweep, every record exactly once) |
| 2 | Callsign search | Bounded results; empty/non-matching handled | ☑ pass — `SIA469` → 1 option, "flight plan match found"; broad queries bounded by the listbox (record row 3) |
| 3 | Duplicate selection | Ambiguity preserved; user selects explicitly | ☑ pass — broad `SIA` query returns 92 matches; alternate selection exercised (state changes, return to `SIA469`; record row 5) |
| 4 | Route map + Route Data | Only exact resolved segments; gaps visible | ☑ pass — HUD "ACTIVE RECORDED ROUTE SIA469"; Route Data shows "Some waypoints missing", "Distance Not supplied" (record rows 4, 12) |
| 5 | Ranked/unranked | Exact label; provenance + modeled distance | ☑ pass — rank criterion + "This comparison uses modeled route distance…" caveat present; selected route shown "Incomplete · not in ranking" / "Not ranked" (record rows 7, 8) |
| 6 | Draft/compare | Directed comparison; gaps not inferred across | ☑ pass — Routes drawer compare with returned count; Edit copy draft "Computationally complete; operational constraints not assessed." (record rows 6, 16) |
| 7 | Safety wording | Exact copy; no valid/recommended/safe/cleared/best | ☑ pass — exact banner copy verified verbatim (record row 1) |
| 8 | Failure states | Stale generation / capacity errors fail closed | ☑ pass — observed live: stale generation returned 503 GENERATION_STALE with the UI search-failed state; restart restored freshness (documented in `browser-compatibility-record.md`) |
| 9 | Limitations walkthrough | Non-operational ranking explained; no authority implied | ☑ pass — in-app limitation copy verified (rank caveat, "operational constraints not assessed", "Not supplied"); segment-8 narration follows the segment plan above |

Supporting evidence already retained: machine-executed passes
(`uat-execution-record-{chrome,chromium,webkit}.md`, the Chrome run refreshed
2026-08-15T10:22Z), screenshots, the PG-03 exact-subject records, and the
browser compatibility record. The owner run's observations are superseded by
the owner closure instruction of 2026-08-15; the rows above carry the
machine-observed values.
