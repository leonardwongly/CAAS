# Release data-use gate (checkpoint shared by Azure and live-demo release paths)

> Status: **checkpoint embedded; record filled and `AUTHORIZED` (2026-08-15).**
> This document is the single checkpoint that the Azure release path (issue
> #20) and any live-demo release procedure must embed so that no deployment or
> demonstration accidentally broadens access to live CAAS-derived data. The
> Data Use Record is filled from the owner decision of 2026-08-15 and the gate
> status artifact is `AUTHORIZED`; checks 3–8 below remain per-window
> release-time verifications. It is intentionally independent of the Azure
> workstream's `docs/operations/local-and-azure.md` and does not modify it.

## 1. Purpose

The data-use authorization (#26/#27) must be complete **before** the release
path of any externally accessible deployment or live-data demo proceeds. This
checklist is the embedded gate both workstreams reference:

- **Azure workstream (issue #20 release path):** the release procedure must
  not promote, expose, or keep ingress enabled on any deployment that serves
  live CAAS-derived data unless this gate passes.
- **Live-demo procedures (issue #29):** the UAT and timed walkthrough must not
  run against an external audience unless this gate passes.

## 2. Gate logic

```text
For any release path that serves live CAAS-derived data to anyone other than
the key holder on loopback/local infrastructure:

  Data Use Record present and completed?  --> NO  --> BLOCK (operator-local-only fallback)
  Gate status artifact = AUTHORIZED?      --> NO  --> BLOCK (operator-local-only fallback)
  Audience in record == intended audience --> NO  --> BLOCK
  Exposed fields in record cover the demo --> NO  --> BLOCK
  Retention/teardown decided in record?   --> NO  --> BLOCK
  Release checkpoint signed by the user?  --> NO  --> BLOCK
  ------------------------------------------------ PASS (recorded with evidence hashes)
```

A `BLOCK` is final for that release attempt; there is no unblocking shortcut,
and no downstream gate may treat a blocked release as passed.

## 3. Operator-local-only fallback (authority absent)

When the Data Use Record or the authorization decision is absent:

- Live CAAS-derived data remains confined to the key holder's local loopback
  environment; the operator may validate the full five-family flow locally.
- There is **no** externally accessible deployment, demo, or review flow, and
  no synthetic runtime/demo fallback exists ([design §0.1](../../docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#01-delivery-profile-and-authority)).
- Release checklists and demo invitations must state the fallback condition
  explicitly so an absent decision cannot be mistaken for approval.

## 4. Release checklist (to be embedded in both release paths)

| # | Checkpoint | Evidence required | Verdict (recorded) |
|---|---|---|---|
| 1 | Data Use Record exists and is complete | Filled `docs/data-use/data-use-record.md` at a commit, SHA-256 recorded | ☑ pass — filled 2026-08-15, SHA-256 `d941b11d…` (full hash in the status artifact) |
| 2 | Gate status artifact is `AUTHORIZED` by the user | `docs/data-use/data-use-authorization-gate-status.yaml` | ☑ pass — `AUTHORIZED`, 2026-08-15 |
| 3 | Intended demo audience matches the record's audience decision | Walkthrough plan + record comparison | `________` |
| 4 | Every field exposed to the audience is in the record's normalized-field list | DTO review against record | `________` |
| 5 | Retention and teardown decisions are recorded (24-hour teardown target; seven-day maximum requires explicit approval) | Record Section 6 | `________` |
| 6 | Release path (Azure #20) has embedded this checkpoint and will not bypass it | Release procedure change reference | `________` |
| 7 | Walkthrough/UAT evidence retained per the [evidence kit](../operations/uat-and-timed-walkthrough.md) | Results record link + hashes | `________` |
| 8 | The user signs the release checkpoint | Explicit user statement in the gate status artifact | **REQUIRES USER AUTHORIZATION** |

Every `________` verdict must be filled at release time and retained. A
checklist with blank verdicts is a blocked release, not a pending one.

## 5. Failure handling

- Any check failing or unrecorded: abort the release path; keep ingress
  disabled; notify the user with the exact check and evidence gap.
- The gate status artifact may not be retroactively changed to bypass a
  failed check; changes are new decisions recorded at a new commit.
- An unresolved severity-1 accessibility or acceptance defect also blocks
  release per the UAT gate ([evidence kit](../operations/uat-and-timed-walkthrough.md)).

## 6. Relationship to other gates

- This gate is **not** the production gate. Passing it authorizes the bounded
  external demo defined in the record only; production remains prohibited until
  [production access approval](../operations/production-access-approval.md).
- The Azure workstream references this checkpoint in its release path;
  `docs/operations/local-and-azure.md` is owned by that workstream and is not
  edited here.

Resolved per GitHub issue #28.
