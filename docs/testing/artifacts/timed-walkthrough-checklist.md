# Timed walkthrough checklist (issue #29) — ready to execute

Prepared 2026-08-15 for the product-owner run. The rehearsal server is booted
at `http://localhost:18080` (fresh acquisition; restart with
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

## UAT evidence rows (fill during the run)

| # | Item | Pass criteria | Observed |
|---|---|---|---|
| 1 | Browse-all exact-once | Every record exactly once; no truncation | |
| 2 | Callsign search | Bounded results; empty/non-matching handled | |
| 3 | Duplicate selection | Ambiguity preserved; user selects explicitly | |
| 4 | Route map + Route Data | Only exact resolved segments; gaps visible | |
| 5 | Ranked/unranked | Exact label; provenance + modeled distance | |
| 6 | Draft/compare | Directed comparison; gaps not inferred across | |
| 7 | Safety wording | Exact copy; no valid/recommended/safe/cleared/best | |
| 8 | Failure states | Stale generation / capacity errors fail closed | |
| 9 | Limitations walkthrough | Non-operational ranking explained; no authority implied | |

Supporting evidence already retained: machine-executed passes
(`uat-execution-record-{chrome,chromium,webkit}.md`), screenshots, the PG-03
exact-subject records, and the browser compatibility record. The owner run
records observations in this file's rows; screenshots go alongside it.
