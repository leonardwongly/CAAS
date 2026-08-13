# Product-owner UAT and timed POC walkthrough (procedure and evidence kit)

> Status: **procedure and evidence kit delivered; execution pending.** The UAT
> and the timed walkthrough have not been run. Execution is pending the product
> owner (the user, as challenge decision authority) and requires, where noted,
> the data-use authorization gate and the Azure release checkpoint. This kit
> defines exactly what to run, in what time, and what evidence to retain.

## 1. Purpose and authority

Automated tests and accessibility checks do not substitute for product-owner
acceptance or for proof that the end-to-end POC can be explained within the
required demonstration time (plan §16). This kit turns plan §16 (`PLAN-5.1`
UAT, `PLAN-5.3` walkthrough) and design §21.7's UAT gate ("an unresolved
severity-1 accessibility or acceptance defect blocks release") into a retained
evidence record.

The walkthrough must describe modeled-distance ranking as non-operational and
must not imply deployment or data-sharing authority (issue #29 scope note).

## 2. Timing requirements (binding)

- **Walkthrough: exactly 20 minutes**, split into the eight fixed segments
  (plan §16 `PLAN-5.3`):
  1. Problem, safety boundary, architecture, code structure — 2 minutes.
  2. Real API evidence, sanitization, live refresh, limits — 2 minutes.
  3. Callsign search, duplicate selection, real route map/table — 3 minutes.
  4. Gaps, hidden/unproven airway data, distance, Rank 1 ties, user choice — 3 minutes.
  5. Edit copy and directed comparison — 3 minutes.
  6. Tests, accessibility/failure states, build/test/deploy code — 3 minutes.
  7. Exact digest, direct Azure POC deployment, auth, rollback — 2 minutes.
  8. Limitations, AI use, lessons learned, requested feedback, separate
     two-week/production roadmaps — 2 minutes.
- **Questions and transitions: exactly 10 minutes reserved.**
- A rehearsal that exceeds the fixed 20 minutes is a defect; the walkthrough
  must be re-rehearsed until the timed format holds before any demonstration.

## 3. UAT procedure — what is exercised

Run the complete representative flow with the product owner, against the exact
deployed digest (or, before deployment authorization, the exact local subject):

| # | UAT item | Pass criteria | Evidence to record |
|---|---|---|---|
| 1 | Browse-all exact-once | Traverse the bounded flight-list cursor from first page to terminal cursor; every record in the active generation appears exactly once, no duplicate, omission, silent truncation, or cursor reuse across a generation change (`AC-POC-BROWSE-01`) | Page count, total records, terminal-cursor behavior |
| 2 | Callsign search | Query matches by normalized callsign; bounded results; empty and non-matching queries behave; query length limits enforced | Search terms used, result counts |
| 3 | Duplicate selection | Ambiguous reference resolves to an explicit duplicate list (e.g. navaid `DUPX` in fixtures / real duplicates); user selects from the list; ambiguity is never silently resolved | Duplicate term, match count, selection outcome |
| 4 | Route map and Route Data | SVG diagram renders only exact resolved segments; visible gaps preserved without connecting them; Route Data usable when geometry is absent (`AC-POC-MAP-01`) | Screenshots, notes |
| 5 | Ranked and unranked candidates | All Rank 1 candidates sharing minimum `rankDistanceNm` listed under the exact label; provenance and modeled distance shown; user can choose (`AC-POC-RANK-01`) | Candidate list, label text |
| 6 | Draft/compare behavior | Local draft accepted; directed comparison shows added/removed waypoints; gap status when incomplete; no distance/geometry inferred across gaps | Draft content, comparison output |
| 7 | Safety wording | The safety copy is exactly: "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated."; no candidate called valid/recommended/safe/cleared/best | Exact strings recorded |
| 8 | Errors and failure states | Cold-start/refresh failure, stale generation, cursor expiry, capacity errors surface as bounded fail-closed errors; no silent truncation | Error codes observed |
| 9 | Limitations walkthrough | The presenter explains modeled-distance ranking as non-operational and states the evidence boundary and that no deployment/data-sharing authority is implied | Notes |

## 4. Timed walkthrough record (template)

Each rehearsal and the final run records:

| Field | Value |
|---|---|
| Date/time | `________` |
| Subject (commit / OCI digest) | `________` |
| Environment (local loopback / Azure ingress) | `________` |
| Presenter / note taker | `________` |
| Audience (must match the Data Use Record if external) | `________` |
| Total elapsed time | `________` (target 20:00; +10:00 questions) |
| Per-segment times | `________` (8 entries) |
| Defects found (severity, description, disposition) | `________` |
| Severity-1 open at close? | `________` (any "yes" blocks release) |
| Timing met? | `________` |
| Evidence artifact hashes (SHA-256) | `________` |

## 5. Retained evidence kit

Retain, at a recorded commit with hashes:

1. The UAT results record (Section 4 template, filled) — one per run.
2. The walkthrough timed record with segment times.
3. Raw evidence: screenshots, console output, inject/API transcripts that are
   secret-free and identifier-restricted per the evidence rules
   ([docs/testing/evidence-and-validation.md](../testing/evidence-and-validation.md)).
4. Defect log with severity and disposition (fixed / accepted with reason /
   deferred to issue).
5. Confirmation that no raw upstream record, credential, or restricted
   identifier appears in any retained artifact.

## 6. Results-record template (acceptance)

```yaml
# docs/operations/uat-walkthrough-results.yaml (template)
run: 1                        # run number
date: ""
subject: ""                   # commit / OCI digest
environment: ""               # local loopback | Azure
audience: ""                  # must match the Data Use Record if external
segments:
  problem_safety_arch: ""     # seconds, target 120
  live_evidence: ""           # seconds, target 120
  search_selection_map: ""    # seconds, target 180
  gaps_airway_distance: ""    # seconds, target 180
  edit_compare: ""            # seconds, target 180
  tests_a11y_failure: ""      # seconds, target 180
  digest_deploy_rollback: ""  # seconds, target 120
  limitations_roadmap: ""     # seconds, target 120
questions_minutes: ""         # target 10
total_minutes: ""             # target 30
browse_all_exactly_once: ""   # pass | fail | not-run
callsign_search: ""           # pass | fail | not-run
duplicate_selection: ""       # pass | fail | not-run
comparison: ""                # pass | fail | not-run
safety_copy: ""               # exact strings pass | fail
failure_states: ""            # pass | fail | not-run
defects: []                   # [{severity, description, disposition}]
severity1_open: false
timing_met: true
decision: ""                  # user acceptance: accept | accept-with-defects | reject
decidedBy: ""                 # the user
decisionRetainedAt: ""        # commit + hashes
```

`decision`, `decidedBy`, and `decisionRetainedAt` are **REQUIRES USER
AUTHORIZATION** fields filled by the product owner. Until filled, the results
record is an executed test record, not an acceptance.

## 7. Execution prerequisites

- Data-use gate: an external audience run additionally requires the
  [data-use authorization gate](../data-use/data-use-authorization-gate.md)
  and the [release data-use gate](../data-use/release-data-use-gate.md).
- Azure deployment evidence: if the walkthrough segment 7 (digest, deployment,
  auth, rollback) is presented as executed, it requires the Azure workstream
  gates; until then it is presented as planned/unauthorized.
- Severity-1 open defect: blocks release per the UAT gate.

Resolved per GitHub issue #29.
