# CAAS Data Use Record — filled (owner decision 2026-08-15)

> Status: **filled and retained.** This is the repository's Challenge Data Use
> Record, completed by the user's recorded decision of 2026-08-15 (GitHub
> issue #26/#27): *"Yes. All the fields can be shown if need to."* The
> [data-use authorization gate](data-use-authorization-gate.md) status artifact
> records `AUTHORIZED` with the decision wording, the record hash, and the
> retaining commit. Every exposure decision remains subject to the gate's
> re-review before each demonstration window.

## 1. Purpose

This record is the written authority that permits exposing live CAAS-derived
data to a specific audience under specific conditions, for a bounded window.
Without it, live CAAS-derived data stays confined to the key holder's local
operator environment. Technical API access, HTTP `200`, and key possession are
not substitutes ([`docs/data-use/caas-contract.md`](caas-contract.md)).

## 2. Provider / challenge authority

| Field | Value |
|---|---|
| Data provider | CAAS (Singapore Civil Aviation Authority) Flight Object Manager and Aeronautical Data Service, via `https://api.swimapisg.info` |
| Challenge decision authority | The user |
| Authority cited for redistribution | The user's recorded decision of 2026-08-15 (GitHub issue #26/#27): **"Yes. All the fields can be shown if need to."** No external provider/challenge license document is cited by this record; if the provider or challenge organizer publishes terms that differ, those supersede this record and the gate status must be re-decided. |
| Authority date and holder | 2026-08-15; the user (CAAS access holder) |

## 3. Data in scope

| Field | Decision |
|---|---|
| Datasets | Flight Plan (`displayAll`); Airways (fetch/schema/count only — values/types are never exposed); Fixes; Airports; NAVAIDs |
| Data form | Normalized public DTOs only (`id`, `flightId`, `callsign`, `origin`, `destination`, `pointCount`, route geometry, gaps, provenance, freshness, safety; distance/rank only when complete). **Never** raw upstream records, credentials, restricted identifiers beyond the active request, or airway values/types |
| Normalized-field list approved for the audience | **All normalized public DTO fields the application serves** — per the owner decision "All the fields can be shown if need to." The standing exclusions are unchanged and are not overridden by this approval: raw upstream records, credentials, restricted identifiers beyond the active request, and airway values/types are never exposed. |
| Sanitization proof | Reference to the sanitizer and to tests proving raw fields never cross the BFF boundary |
| Snapshot reference | The commit retaining this filled record (SHA-256 of this file recorded in `docs/data-use/data-use-authorization-gate-status.yaml`) |

## 4. Provenance

| Field | Decision |
|---|---|
| Acquisition path | Server-side bounded, allow-listed HTTPS GETs to all five families; browser never contacts CAAS |
| Evidence of acquisition | Loopback-only `PG-03` evidence for the exact subject (Azure workstream), or recorded local live validation |
| Data completeness claim | Discovery record confirms successful responses only; no quota/retry/failure claim ([README](../../README.md#known-limitations-and-evidence-boundary)) |
| Upstream behavior unobserved | Rate limits, quota headers, pagination metadata, natural failures — **unknown**, not claimed (plan §1.2) |

## 5. Permitted audience

| Field | Decision |
|---|---|
| Audience definition | Any audience the user (challenge decision authority) presents the demonstration to, at their discretion — owner decision 2026-08-15. The audience present at each demonstration window is recorded in the walkthrough record at that time. |
| Audience size | As the user directs at demo time; no unattended or public exposure is authorized by this record |
| Access mechanism | User-operated demo: local loopback, user-controlled screen share of the running app, or the private single-user Azure POC with ingress and `allowedPrincipals` restricted to the single allowed user |
| Demo environment | User-operated local rehearsal server (loopback) or the private single-user Azure POC |
| Expiry of audience permission | Each demonstration window; re-confirmed per the gate's review cadence (re-review before every external demonstration window) |

The POC is single-user by design ([design §0.1](../../docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#01-delivery-profile-and-authority));
any audience beyond the user is a deliberate, separately decided expansion —
recorded here by the owner decision of 2026-08-15.

## 6. Retention

| Field | Decision |
|---|---|
| Live-data retention during demo | In-memory generation for the session; no persisted copy beyond the app's in-memory store |
| Teardown target | 24 hours after each demonstration (plan §6.3) — confirmed for each window |
| Seven-day governance maximum | Operator-enforced; requires explicit teardown approval or separately authorized retention — no current exception is authorized |
| Evidence retention | Records named in the UAT/walkthrough kit retained per `docs/testing/evidence-and-validation.md` (sanitized, secret-free, at recorded commits) |
| Logs/telemetry retention | The POC has no external log/telemetry sink; local server logs are session-scoped and not retained beyond the session |

## 7. Attribution and redistribution rules

| Field | Decision |
|---|---|
| Attribution required | CAAS provider attribution retained in the UI and evidence |
| Redistribution allowed | None beyond the permitted demonstration windows (default: none) |
| Derivative reuse allowed | None (default: none) |
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
| Approval recorded at | Commit retaining this record; SHA-256 of the filled record recorded in `docs/data-use/data-use-authorization-gate-status.yaml` |
| Gate status artifact | `docs/data-use/data-use-authorization-gate-status.yaml` — `AUTHORIZED` (2026-08-15) |
| Review cadence | Re-review before every external demonstration window; record changes at a new commit |
| Revocation | Any user decision to revoke is recorded at a new commit and the gate status artifact moves to `REVOKED` |

## 10. Acceptance check

This record is complete: every decision field above is filled from the owner
decision of 2026-08-15, the record is committed, and the data-use
authorization gate status is `AUTHORIZED`. Per-window prerequisites (audience
naming, retention confirmation, release checkpoint signing) remain re-checked
before each demonstration per the [gate document](data-use-authorization-gate.md).

Resolved per GitHub issue #27 (owner decision 2026-08-15).

## 11. Addendum — bulk data browse (owner request 2026-08-15)

The owner directed a separate "API data" page showing the API data, with both
an endpoint explorer and a bulk data browser (owner choice recorded
2026-08-15). The browse endpoints (`/api/v1/data/flights|fixes|airports|
navaids` and `/api/v1/data/summary`) serve only the normalized public DTO
fields already defined by this record's normalized-field list: flight
summaries (callsign, departure, destination, recorded point count) and
fix/airport/navaid identifiers with coordinates through the public location
DTO. Airway values/types are never exposed — counts only. Raw upstream
records, credentials, and restricted identifiers beyond the active request
remain excluded, and the standing 24-hour teardown / 7-day governance-max
retention decisions are unchanged by this addendum.
