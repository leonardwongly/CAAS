# Production operations: ownership, SLOs, incident response, DR

> Status: **design candidates; no named owners, no measured SLOs, no incident
> or DR evidence.** This document defines what production operations must
> contain (issue #33). Every named-owner field is blank until the user assigns
> them; every SLO/DR value is a candidate for the production ADR, not a
> commitment. None of this is true of the POC today, and nothing here
> authorizes production.

## 1. Ownership model

Design §30 item 2 requires named service, product, technical, security/data,
release, cost, and on-call owners with escalation and independent production
approval. Ownership is a user assignment:

| Role | Responsibility | Named owner (blank until user assigns) |
|---|---|---|
| Service owner | Overall service, scope, acceptance | **REQUIRES USER AUTHORIZATION** — `________` |
| Product owner | Requirements, UAT, demo decisions, data-use decisions | **REQUIRES USER AUTHORIZATION** — `________` |
| Technical owner | Code, releases, rollback, technical debt | **REQUIRES USER AUTHORIZATION** — `________` |
| Security/data owner | Data governance, privacy, retention, telemetry redaction | **REQUIRES USER AUTHORIZATION** — `________` |
| Release owner | Change records, sign-offs, release authority | **REQUIRES USER AUTHORIZATION** — `________` |
| Cost/spend owner | Budgets, forecast, cost alerts, telemetry caps | **REQUIRES USER AUTHORIZATION** — `________` |
| On-call owner(s) | Paging, incident command, support hours | **REQUIRES USER AUTHORIZATION** — `________` |

Escalation path: on-call → technical owner → service owner → user (challenge
decision authority). Independent production approval must come from outside
the team that implements the change.

## 2. SLI/SLO candidates and measurement approach

These are candidates for the production ADR (design §30 item 3). Nothing is
measured today; POC thresholds (plan §6.2) are the starting point, not the
production contract.

| SLI | Candidate SLO | Measurement approach (production) |
|---|---|---|
| Availability of the API (ready and serving) | `________` | Probe `/api/v1/health/live` + `/readyz` from the monitoring region; success = 2xx from a serving instance within timeout; windowed error budget |
| Warm request latency (p95) | <= 2 s candidate; 5 s hard server deadline (plan §6.2) | >= 100 requests after 10 warmups per gate; nearest-rank p95 at `ceil(0.95 * n)`; every request <= 5 s |
| Acquisition success (five-family generation) | `________` | Generation refresh outcomes from server logs/telemetry; failures classified `UPSTREAM_UNAVAILABLE` / `REFERENCE_RECORD_LIMIT` / `RECORD_LIMIT` / timeouts |
| Error rate on API surfaces | `________` | 5xx + retryable error codes as a fraction of requests |
| Freshness delivery | `________` | Fraction of served generations within the tiered freshness windows (issue #35 runtime pending) |
| Data loss events (generation drops) | 0 | Restart/reacquisition audit |

Error budget policy: `________` (window, burn rate, and the incident/paging
trigger that results — blank until the user approves).

## 3. Incident response runbook skeleton

Severity definitions (candidates): Sev-1 = service unusable or data-accuracy
risk for the served audience; Sev-2 = degraded with workaround; Sev-3 = minor.
Support hours and paging thresholds: `________`.

| Step | Action |
|---|---|
| Detect | Alert from SLO monitor (see Section 2); log check; user report |
| Triage | On-call classifies severity; Sev-1 starts the incident log and declares incident command |
| Communicate | Incident commander, comms owner, status to the user/audience per the incident communication plan |
| Contain | For upstream outage: keep serving the last fresh generation within the freshness window; stop refreshes that fail; do not present stale data as fresh (`GENERATION_STALE` behavior) |
| Diagnose | Check adapter evidence (retries, timeouts, record limits), generation state, network-control logs (egress design), telemetry |
| Repair | Under change control: deploy the known-good prior revision plus app-scoped configuration, then reacquire current data (never roll back data as a snapshot) |
| Postmortem | Within `________` hours: timeline, root cause, action items with owners, evidence retained with hashes |

## 4. DR requirements and evidence

Design §30 item 4 requires approved RTO/RPO and successful restore/DR tests
for: Key Vault configuration, ACR/evidence, snapshots/pointers, IaC,
monitoring evidence, and the chosen regional/platform-loss scenario.

| Item | Requirement (blank until approved) | Evidence needed |
|---|---|---|
| RTO | `________` | Timed restore drill result with hashes |
| RPO | `________` (note: there is no snapshot data store; current data is reacquired from CAAS — data RPO is effectively the reacquisition time) | Reacquisition timing measurement |
| Key Vault configuration restore | `________` | Restore test result |
| ACR/evidence restore | `________` | Restore test result |
| IaC re-apply | `________` | Re-apply test result |
| Monitoring evidence availability | `________` | Post-restore metric/log availability check |
| Regional/platform-loss scenario | `________` | The chosen scenario executed successfully |
| Evidence retention | Per the approved retention schedule | Logs, manifests, hashes |

## 5. Runbook and change control

Design §30 items 8 and 9 require current runbooks for alerts, outages, drift,
secrets, rollback, restore, and decommission; and an auditable change record
with release authority, sign-offs, risk acceptance, change window/
communications, known-good targets, and emergency rollback authority. All are
**Open — REQUIRES USER AUTHORIZATION**; the runbook skeleton above and the
decommission steps of design §31 are the starting material.

## 6. Relationship to the POC

None of the above is evidenced or in force. The POC remains a private,
single-user, non-operational demonstration; production access remains
prohibited until the [production access approval](production-access-approval.md)
is signed and every open row of the [production-prerequisites register](production-prerequisites-register.md)
is closed with retained evidence.

Resolved per GitHub issue #33.
