# CAAS data-use authorization gate

> Status: **gate defined; decision pending.** This document defines the
> authorization gate that must pass before any externally accessible live-data
> demonstration of CAAS-derived data. It does not itself authorize any exposure.
> No Data Use Record is currently present in this repository, so live
> CAAS-derived data must remain confined to the authorized operator's local
> environment until a completed record exists ([README, "Known limitations and
> evidence boundary"](../../README.md#known-limitations-and-evidence-boundary)).

## 1. Why this gate exists

The project has authenticated CAAS access and local live-validation evidence,
but HTTP `200` responses and possession of an API key are **not** redistribution
authority ([`docs/data-use/caas-contract.md`](caas-contract.md);
[design §0.3](../../docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#03-confirmed-live-contract)
records successful discovery only). Any externally accessible demo that serves
live CAAS-derived data to a reviewer or other audience must first satisfy this
gate; absent a completed record the required behavior is to **fail closed**: no
external exposure, no assumed audience, no inferred permission.

This gate is the operational realization of the repository's evidence rule
("No Challenge Data Use Record is present, so HTTP `200` and possession of a
key do not authorize reviewer redistribution of live CAAS-derived data" —
[README, "Known limitations and evidence boundary"](../../README.md#known-limitations-and-evidence-boundary)).

## 2. Who decides

The **user is the challenge decision authority**. No other person, role,
document, or tool output may grant the authorization this gate protects. In
particular:

- a green test suite, a passing container smoke, a successful local live
  acquisition, or a deployed POC are **not** decisions;
- an AI assistant, reviewer, or workstream owner cannot make the decision;
- the decision is expressed exclusively by a completed and retained
  [Data Use Record](data-use-record.md) plus, where the gate status demands it,
  an explicit approval entry in the gate status artifact (Section 5).

## 3. What must precede any externally accessible live-data demo

All of the following are prerequisites. Each is independently checkable; a
demo is blocked until every row is satisfied.

| # | Prerequisite | Authority source | Status |
|---|---|---|---|
| 1 | A completed [Data Use Record](data-use-record.md) naming the permitted audience, exposed normalized fields, retention, attribution, and teardown obligations | User decision | **PENDING — REQUIRES USER AUTHORIZATION** |
| 2 | The demo audience matches the record's permitted-audience decision exactly (no "reviewer audience by default"; the POC is single-user by design — [design §0.1](../../docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#01-delivery-profile-and-authority)) | User decision | **PENDING — REQUIRES USER AUTHORIZATION** |
| 3 | The fields served to the audience are a subset of the record's exposed-fields decision and of the normalized public DTOs (no raw upstream records, credentials, or restricted identifiers) | Record + code review | **PENDING** |
| 4 | The Azure/bootstrap release path embeds this gate as a blocking checkpoint ([release data-use gate](release-data-use-gate.md)) | Checkpoint present; execution pending | **PENDING** |
| 5 | Loopback-only `PG-03` real-data evidence exists for the exact OCI subject being demonstrated (per the Azure write boundary in [README](../../README.md#azure-write-boundary)) | Azure workstream gate | **PENDING** |
| 6 | Retention and teardown are fixed: teardown target within 24 hours after the demonstration; seven-day maximum requires explicit teardown approval or separately authorized retention (plan §6.3) | User decision at demo time | **PENDING — REQUIRES USER AUTHORIZATION** |
| 7 | The walkthrough retains the timed 20+10 minute demonstration format and records the decision record below (plan §16 `PLAN-5.3`) | Product owner | **PENDING** |

## 4. What the gate forbids when it is not passed

- No externally accessible endpoint, URL, screen share, published build, or
  review flow may serve live CAAS-derived data to any audience other than the
  key holder in the operator's local environment.
- No synthetic runtime/demo fallback exists as an alternative ([design §0.1](../../docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#01-delivery-profile-and-authority));
  absence of the record means **no external demo at all**, not "a demo with
  different data".
- No one may infer the decision from a later demonstration, a merged PR, or a
  green gate. Only the recorded decision counts.
- Production access remains prohibited regardless of this gate
  ([production access approval](../operations/production-access-approval.md)).

## 5. Gate status artifact (decision record)

This record is a template. Every decision field is intentionally blank and
must be filled by the user; filling these fields is the only act that passes
the gate.

```yaml
# docs/data-use/data-use-authorization-gate-status.yaml
status: PENDING-DECISION          # PENDING-DECISION | AUTHORIZED | DENIED | REVOKED
updatedAt: ""                     # ISO-8601, filled by the user on decision
decidedBy: ""                     # The user (challenge decision authority)
dataUseRecord: ""                 # Link + SHA-256 of the completed data-use-record.md
demoPlannedFor: ""                # Planned demonstration date/time
audienceDecision: ""              # Exact audience allowed by the record
exposedFieldsDecision: ""         # Exact normalized fields allowed by the record
retentionDecision: ""             # Teardown target and any separately authorized retention
azureReleaseCheckpoint: ""        # Release data-use gate result (pending / passed / blocked)
walkthroughEvidence: ""           # Link to the retained UAT + walkthrough results record
authorizationStatement: ""        # The user's explicit statement; e.g. "I authorize ..."
decisionRetainedAt: ""            # Commit/artifact hash retaining the decision
```

Rules for this artifact:

- Until `status: AUTHORIZED` and the user-filled fields above are present,
  the gate is not passed and Section 4 applies.
- `AUTHORIZED` may only appear in this artifact when the user has made the
  decision; it must never be pre-written.
- A `DENIED` or `REVOKED` status is permanent for the stated scope unless a
  later user decision changes it and is retained.
- Every change to this artifact must be committed with the evidence it
  references (record hash, walkthrough evidence hash).

## 6. Escalation when authority is missing

If any consumer (release engineer, demo host, reviewer, or tooling) needs
externally accessible live data and the record or decision is absent, they must
escalate to the user and **stop** the exposure path. The escalation states the
exact data, audience, environment, and window requested and asks for the
decision — it does not proceed on silence. Silence or a missing record is a
block, not an approval.

## 7. Related artifacts

- [Data Use Record template](data-use-record.md) (issue #27) — the record this gate requires.
- [Release data-use gate](release-data-use-gate.md) (issue #28) — the checkpoint embedded in release and demo procedures.
- [UAT and timed walkthrough evidence kit](../operations/uat-and-timed-walkthrough.md) (issue #29) — the demonstration procedure the gate guards.
- [Production access approval](../operations/production-access-approval.md) (issue #34) — the separate, stricter production gate; passing this data-use gate does not pass that one.

Resolved per GitHub issue #26.
