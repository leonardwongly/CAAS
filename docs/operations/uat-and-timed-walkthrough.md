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

The walkthrough must describe modeled distance as descriptive only, show neutral route comparison without a winner, and must not imply deployment or data-sharing authority (issue #29 scope note).

## 2. Timing requirements (binding)

- **Walkthrough: exactly 20 minutes**, split into the eight fixed segments
  (plan §16 `PLAN-5.3`):
  1. Problem, safety boundary, architecture, code structure — 2 minutes.
  2. Real API evidence, sanitization, live refresh, limits — 2 minutes.
  3. All-flight overview, shared map/list/callsign selection, real route map/table — 3 minutes.
  4. Gaps, airport-name provenance/fallback, hidden Airways, descriptive distance, neutral comparison — 3 minutes.
  5. Explore a route variation and directed variation comparison — 3 minutes.
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
| 1 | Overview exact-once | Traverse every generation-bound cursor; every safe flight appears exactly once, every available resolved component is shown, and duplicate/generation/non-progressing pages fail explicitly (`AC-POC-BROWSE-01`) | Page count, total records, terminal behavior, rendered list/path count |
| 2 | Callsign filter | Filter the populated overview by normalized callsign; map/list subset and shown/total HUD count agree | Search terms used, result counts, map/list counts |
| 3 | Shared and overlap selection | Select from full list, map, and callsign filter; exact overlaps use an explicit chooser; every surface shares one `flightId` | Selected identities, overlap count, `aria-current`, HUD |
| 4 | Route map and Route Data | OSM/schematic map renders only exact resolved segments; visible gaps are not connected; resolvable interior components survive endpoint gaps; Route Data remains usable | Screenshots, notes |
| 5 | Neutral route comparison | Selected route first, remaining immutable source order, neutral complete/incomplete groups, descriptive distance, no preference fields or winner language (`AC-POC-COMPARE-01`) | Candidate order, groups, copy, payload fields |
| 6 | Explore variation | Local unsaved variation accepted; exact point controls and directed delta work when complete; incomplete state keeps explicit gaps and unavailable values | Variation content, comparison output |
| 7 | Safety wording | The safety copy is exactly: "Demonstration only. Operational weather, NOTAM, ATC, fuel, aircraft suitability, and regulatory constraints are not evaluated."; no candidate called valid/recommended/safe/cleared/best | Exact strings recorded |
| 8 | Errors and failure states | Cold-start/refresh failure, stale generation, cursor expiry, capacity errors surface as bounded fail-closed errors; no silent truncation | Error codes observed |
| 9 | Limitations walkthrough | The presenter explains descriptive modeled distance, neutral ordering, non-official airport metadata, historical evidence limits, and the absence of deployment/data-sharing authority | Notes |

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
  overview_gaps_names_compare: "" # seconds, target 180
  explore_variation: ""       # seconds, target 180
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
