# CAAS Data Use Record (template)

> Status: **template only — no authority is granted by this file.** This is the
> repository's template for a Challenge Data Use Record as referenced by the
> [README, "Known limitations and evidence boundary"](../../README.md#known-limitations-and-evidence-boundary):
> *"No Challenge Data Use Record is present, so HTTP `200` and possession of a
> key do not authorize reviewer redistribution of live CAAS-derived data."*
>
> Every decision field below is blank. Filling it is the user's decision
> (challenge decision authority). A filled record must be retained at a
> specific commit with a SHA-256 of its content, and the
> [data-use authorization gate](data-use-authorization-gate.md) must be passed
> before any externally accessible live-data demonstration.

## 1. Purpose

This record is the written authority that permits exposing live CAAS-derived
data to a specific audience under specific conditions, for a bounded window.
Without it, live CAAS-derived data stays confined to the key holder's local
operator environment. Technical API access, HTTP `200`, and key possession are
not substitutes ([`docs/data-use/caas-contract.md`](caas-contract.md)).

## 2. Provider / challenge authority

| Field | Value (blank until user decision) |
|---|---|
| Data provider | CAAS (Singapore Civil Aviation Authority) Flight Object Manager and Aeronautical Data Service, via `https://api.swimapisg.info` |
| Challenge decision authority | The user |
| Authority cited for redistribution | **REQUIRES USER AUTHORIZATION** — exact wording of the written authority (license, permission notice, or challenge terms) |
| Authority date and holder | `________` |

## 3. Data in scope

| Field | Decision (blank until user decision) |
|---|---|
| Datasets | Flight Plan (`displayAll`); Airways (fetch/schema/count only — values/types are never exposed); Fixes; Airports; NAVAIDs |
| Data form | Normalized public DTOs only (`id`, `flightId`, `callsign`, `origin`, `destination`, `pointCount`, route geometry, gaps, provenance, freshness, safety; distance/rank only when complete). **Never** raw upstream records, credentials, restricted identifiers beyond the active request, or airway values/types |
| Normalized-field list approved for the audience | **REQUIRES USER AUTHORIZATION** — `________` |
| Sanitization proof | Reference to the sanitizer and to tests proving raw fields never cross the BFF boundary |
| Snapshot reference | Exact commit / OCI digest the record applies to: `________` |

## 4. Provenance

| Field | Decision |
|---|---|
| Acquisition path | Server-side bounded, allow-listed HTTPS GETs to all five families; browser never contacts CAAS |
| Evidence of acquisition | Loopback-only `PG-03` evidence for the exact subject (Azure workstream), or recorded local live validation |
| Data completeness claim | Discovery record confirms successful responses only; no quota/retry/failure claim ([README](../../README.md#known-limitations-and-evidence-boundary)) |
| Upstream behavior unobserved | Rate limits, quota headers, pagination metadata, natural failures — **unknown**, not claimed (plan §1.2) |

## 5. Permitted audience

| Field | Decision (blank until user decision) |
|---|---|
| Audience definition | **REQUIRES USER AUTHORIZATION** — `________` (e.g. "the user only", "named reviewer: __", "no external audience") |
| Audience size | **REQUIRES USER AUTHORIZATION** — `________` |
| Access mechanism | **REQUIRES USER AUTHORIZATION** — `________` (loopback-only, private Azure ingress with `allowedPrincipals`, recorded screen share, etc.) |
| Demo environment | **REQUIRES USER AUTHORIZATION** — `________` |
| Expiry of audience permission | **REQUIRES USER AUTHORIZATION** — `________` |

The POC is single-user by design ([design §0.1](../../docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#01-delivery-profile-and-authority));
any audience beyond the user is a deliberate, separately decided expansion.

## 6. Retention

| Field | Decision (blank until user decision) |
|---|---|
| Live-data retention during demo | **REQUIRES USER AUTHORIZATION** — `________` |
| Teardown target | 24 hours after the demonstration (plan §6.3) — confirm: `________` |
| Seven-day governance maximum | Operator-enforced; requires explicit teardown approval or separately authorized retention — decision: `________` |
| Evidence retention | Records named in the UAT/walkthrough kit retained per `docs/testing/evidence-and-validation.md` — confirm: `________` |
| Logs/telemetry retention | **REQUIRES USER AUTHORIZATION** — `________` |

## 7. Attribution and redistribution rules

| Field | Decision (blank until user decision) |
|---|---|
| Attribution required | **REQUIRES USER AUTHORIZATION** — `________` |
| Redistribution allowed | **REQUIRES USER AUTHORIZATION** — `________` (default: none) |
| Derivative reuse allowed | **REQUIRES USER AUTHORIZATION** — `________` (default: none) |
| Prohibited uses | Operational decision-making, filing, dispatch, clearance; presenting any candidate as safe/recommended/valid; broader accessibility without the production gate |

## 8. Evidence handling and restricted identifiers

- Credentials (`apikey`), raw upstream records, and restricted identifiers
  beyond the active request never enter source control, evidence, fixtures,
  logs, traces, or screenshots.
- Retained evidence is sanitized and secret-free; the data-use gate status
  artifact records hashes of everything retained.

## 9. Approval location and lifecycle

| Field | Decision |
|---|---|
| Record location | `docs/data-use/data-use-record.md` (this file, filled) |
| Approval recorded at | Commit: `________`, SHA-256 of filled record: `________` |
| Gate status artifact | `docs/data-use/data-use-authorization-gate-status.yaml` |
| Review cadence | Re-review before every external demonstration window; record changes at a new commit |
| Revocation | Any user decision to revoke is recorded at a new commit and the gate status artifact moves to `REVOKED` |

## 10. Acceptance check

This record is complete only when every `________` field above is filled by the
user, the record is committed, and the data-use authorization gate passes.
Absent that, Section 4 of the [gate document](data-use-authorization-gate.md)
applies: **no external exposure**.

Resolved per GitHub issue #27.
