# Production-prerequisites register

> Status: **register established; every item open.** The project is a private,
> single-user, non-operational POC. This register tracks, separately from the
> Azure POC gates, every prerequisite that production access requires per
> [design §30](../../docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#30-public-production-gate)
> and the accepted POC residuals of
> [design §0.5](../../docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#05-poc-azure-identity-map-and-egress-boundaries).
> A successful POC deployment does not satisfy any row of this register and
> must not be presented as production readiness.

## 1. What this register is

- A distinct, deferred production-readiness backlog with explicit blockers and
  evidence requirements (issue #31).
- The evidence set `PG-PROD` requires, per plan §8.1/§17: written data
  redistribution/privacy authority, broader access decisions, network-enforced
  egress, edge/origin protection, SLO/error budget, capacity/cost, on-call,
  retention/legal hold, vulnerability SLAs, expanded accessibility/UAT,
  RTO/RPO, restore/DR, incident response, and release authority.
- It is intentionally separate from `docs/operations/local-and-azure.md`
  (Azure POC workstream) and from the data-use gate
  ([docs/data-use/data-use-authorization-gate.md](../data-use/data-use-authorization-gate.md)).

## 2. Status conventions

- **Open**: not started or deliberately out of POC scope.
- **In design**: an artifact exists (linked) but no execution/evidence exists.
- **Blocked on POC**: cannot start until an Azure POC or local gate completes.
- **Evidenced**: retained proof exists (none today).

## 3. Register

### 3.1 Data, privacy, and access authority (design §30 items 1, 7, 8)

| Prerequisite | Status | Owning gate / workstream | Artifact |
|---|---|---|---|
| Written CAAS redistribution/licensing authority | Open — **REQUIRES USER AUTHORIZATION** | Data use (#26/#27) then production approval (#34) | [Data Use Record](../data-use/data-use-record.md) |
| Data classification, privacy, residency decisions | Open — **REQUIRES USER AUTHORIZATION** | #34 | [Production access approval](production-access-approval.md) |
| Retention schedules, access-review cadence, audit export / legal-hold decision | Open — **REQUIRES USER AUTHORIZATION** | #34 | [Production access approval](production-access-approval.md) |
| End-user access and broader-audience decision | Open — **REQUIRES USER AUTHORIZATION** | #34 | [Production access approval](production-access-approval.md) |
| Provider/tile privacy approval (any external map decision) | POC: owner-authorized OSM tiles 2026-08-15 (design §0.5; review recorded in `safety-and-secrets.md`); **production approval remains open** | #34 + production provider terms/privacy/quota review | [Production access approval](production-access-approval.md) |
| Manual accessibility matrix and product UAT for the production scope | Open | #29 (UAT kit) + accessibility workstream | [UAT and timed walkthrough](uat-and-timed-walkthrough.md) |

### 3.2 Network and edge (design §30 item 5; §0.5 egress residual)

| Prerequisite | Status | Owning gate / workstream | Artifact |
|---|---|---|---|
| Network-enforced outbound filtering (replaces the accepted POC residual) | In design | #32 | [Egress design](egress-design.md) |
| Aggregate edge/WAF/quota protection, origin lockdown, forwarded-header policy | Open | Azure/edge workstream (production) | — |
| Bot/rate-limit/origin-bypass tests; CAAS quota-exhaustion behavior | Open (quota behavior also #30 evidence) | #32/#30 | [Egress design](egress-design.md); upstream-bounds tests |

### 3.3 Operations (design §30 items 2, 3, 4, 6, 9)

| Prerequisite | Status | Owning gate / workstream | Artifact |
|---|---|---|---|
| Named service, product, technical, security/data, release, cost, on-call owners | Open — **REQUIRES USER AUTHORIZATION** (ownership is a user assignment) | #33 | [Production operations](production-operations.md) |
| SLIs/SLOs, error budget, support hours, paging thresholds, incident severities, incident command/communications, postmortem | Open (candidates defined) | #33 | [Production operations](production-operations.md) |
| RTO/RPO and successful restore/DR tests (Key Vault config, ACR/evidence, IaC, monitoring evidence, regional/platform-loss) | Open — no DR test can run in the POC | #33 | [Production operations](production-operations.md) |
| Production-sized capacity/load evidence, quota/headroom, autoscaling, budgets, tags, cost alerts, telemetry caps, spend owner | Open | #33 | [Production operations](production-operations.md) |
| Vulnerability remediation SLAs, emergency patch/change path, current runbooks | Open | #33 | [Production operations](production-operations.md) |
| Auditable change record: naming release authority, sign-offs, risk acceptance, change windows, known-good targets, emergency rollback authority | Open — **REQUIRES USER AUTHORIZATION** | #33 | [Production operations](production-operations.md) |

### 3.4 Evidence boundary items that POC success must not imply

| Item | Status | Note |
|---|---|---|
| Authoritative CI OCI digest, CI execution | Blocked on POC gates | Azure workstream (`PG-03`) |
| Azure deployment, auth, rollback, teardown | Blocked on POC gates | Azure workstream (`PG-04`) |
| Live failure/quota/retry observation | Open (only simulated evidence exists) | #30 — unobserved upstream behavior stays labeled unknown |
| Data redistribution rights | Open — **REQUIRES USER AUTHORIZATION** | #26/#27/#34 |
| Production-approval record | Open — **REQUIRES USER AUTHORIZATION** | #34 |

## 4. Gate logic

Production access is PROHIBITED until every row of this register that is
marked Open or In design is resolved with retained evidence and the
[production access approval](production-access-approval.md) record is signed.
Per design §28.5, the service may be described as production-operational only
when Section 30 of the design is complete. No POC gate (local or Azure) passes
any row here; plan §17 states the POC architecture is not automatically
production architecture.

## 5. Relationship to issue #35 and the runtime

Some POC runtime behavior relevant to production evidence (tiered freshness,
prior-generation retention window, hard server deadline) is documented as
behavior gaps by the #30 deterministic test suite
([tests/upstream-bounds/](../../tests/upstream-bounds/README.md)); issue #35
owns the runtime changes. This register tracks the production evidence, not
the runtime fixes.

Resolved per GitHub issue #31.
