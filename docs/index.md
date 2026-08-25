# Flight Route Explorer documentation

This directory is the documentation entry point for the Flight Route Explorer.
Documents describe the implemented local POC, design constraints, and retained
evidence; they do not prove Azure deployment or production operational controls.

## Master product direction

- [Master product document](product/master-product-document.md) — **source of truth for product direction**, target experience, personas, terminology, requirements, priorities, and intended-versus-evidenced status
- [Detailed customer journey and personas](product/customer-journey-and-personas.md) — supporting journey analysis and service-blueprint detail incorporated into the master

Technical contracts, acceptance criteria, gate definitions, and evidence rules remain independently authoritative in the design, implementation plan, ADR, and testing documents below until explicitly reconciled with an approved product decision.

## Architecture and plans

- [System design](superpowers/specs/2026-08-11-flight-route-explorer-design.md)
- [Implementation plan](superpowers/plans/2026-08-11-flight-route-explorer-implementation-plan.md)
- [Archived historical design sections 3-29](superpowers/historical/2026-08-11-flight-route-explorer-design-legacy-sections-3-29.md) (non-binding historical analysis)
- [POC boundary and reconciliation](architecture/poc-boundary.md)
- [POC interaction exclusions](architecture/poc-interaction-exclusions.md) (what the POC deliberately does not provide)
- [Azure POC topology conformance](architecture/azure-poc-topology.md)
- [Network-enforced egress design (production prerequisite)](operations/egress-design.md)

## Capability and gate status

- [POC capability and gate-status matrix](status/poc-capability-and-gate-matrix.md) — every `AC-POC-*` criterion and `PG-00..PG-04` gate with evidenced/implemented/planned/deferred status

## Operations, release, and Azure procedures

- [Local operations: Linux first, Azure late](operations/local-and-azure.md)
- [Azure release path: authorized, time-boxed POC delivery](operations/azure-release-path.md)
- [Azure go/no-go preflight and least-privilege bootstrap](operations/azure-preflight-and-bootstrap.md)
- [Azure POC deployment procedure](operations/azure-deployment-procedure.md)
- [Azure abort and rollback drills](operations/azure-abort-and-rollback-drills.md)
- [Azure post-demo cost, access, and teardown verification](operations/azure-post-demo-verification.md)
- [Cloudflare staging migration plan](operations/cloudflare-staging-migration-plan.md) — staging-only Worker, Container, DNS, rollback, and parity plan; Azure remains unchanged
- [Product-owner UAT and timed POC walkthrough](operations/uat-and-timed-walkthrough.md)

## Data use and authorization

- [Real CAAS data contract](data-use/caas-contract.md)
- [Airport-name reference governance](data-use/airport-name-reference.md) — pinned source/license/checksums, deterministic update, exact join, fallback, and rollback
- [CAAS data-use authorization gate](data-use/data-use-authorization-gate.md) (`AUTHORIZED` 2026-08-15)
- [CAAS Data Use Record](data-use/data-use-record.md) (filled 2026-08-15 by owner decision)
- [Release data-use gate](data-use/release-data-use-gate.md) (checkpoint shared by Azure and live-demo release paths; record + `AUTHORIZED` status retained)

## Testing, accessibility, and evidence

- [Validation and evidence rules](testing/evidence-and-validation.md)
- [Accessibility and UAT evidence hub](testing/accessibility-evidence.md)
- [Keyboard-only review](testing/keyboard-review.md)
- [Screen-reader and browser compatibility review](testing/screen-reader-review.md)
- [Responsive, zoom/reflow, forced-colors, reduced-motion review](testing/responsive-review.md)
- [UAT walkthrough protocol](testing/uat-walkthrough.md)
- [Security, safety, and privacy boundary](security/safety-and-secrets.md)

## Production boundary (separate gate; production remains prohibited)

- [Production access approval record (template)](operations/production-access-approval.md)
- [Production operations: ownership, SLOs, incident response, DR (design candidates)](operations/production-operations.md)
- [Production-prerequisites register](operations/production-prerequisites-register.md) (closed out of scope by owner decision 2026-08-15; production remains prohibited)
- [ADR: binding POC authority and legacy reconciliation](adr/0001-poc-authority-and-legacy-reconciliation.md)
- [ADR: server-side donor-subpath synthesis](adr/0002-server-side-donor-subpath-synthesis.md) — superseded by ADR-0003
- [ADR: airway labels and direct alternate](adr/0003-airway-labels-and-direct-alternate.md) — recorded airway labels on legs plus a computed direct great-circle alternate; removes the donor-subpath synthesis capability

## Evidence

- [Secret-free PG-00 live API discovery manifest](evidence/pg-00-live-api-discovery.json)
- [Authorized live five-family lane run (`116a84d608f3`, 5 checks)](evidence/live-lane-116a84d608f3.json)
- [Current neutral-contract loopback lane (`e965c728fe45`, 23/23)](evidence/loopback-lane-local-e965c728fe45.json)
- [Older Rank-era loopback lane (`116a84d608f3`, historical subject)](evidence/loopback-lane-local-116a84d608f3.json)
- [Loopback container lane, current tree (`116a84d608f3`, 7 checks)](evidence/loopback-container-local-116a84d608f3.json)
- [Security measurement lane, current tree (`116a84d608f3`, 8/8; package audit passed, 0 advisories)](evidence/security-local-116a84d608f3.json)
- [Performance measurement lane, current tree (`116a84d608f3`)](evidence/performance-local-116a84d608f3.json)
- [Workspace lint lane, current tree (`116a84d608f3`)](evidence/lint-local-116a84d608f3.json)
- [Local OCI subject manifest (`PG-03` candidate, unverified)](evidence/oci-subject-local.json)
- [Authoritative CI-built OCI subject bundle (PR #38 merge ref `e456dd0c`, CI digest `sha256:8d978f18…`)](evidence/oci-digest-bundle-e456dd0cd791.json)
- [CI Trivy scan report for the authoritative subject (0 HIGH/CRITICAL)](security/trivy-scan-ci-e456dd0c.json)
- [Older lane records (archived)](evidence/archived/)
- [Gate evidence manifest schema](../deploy/evidence-manifest.schema.json)

## Status

The system design and implementation plan remain the governing design and delivery references. Neutral comparison, the exact-once uncapped overview, shared selection, tolerant gap projection, and airport-name enrichment are implemented and focused-tested locally; historical evidence remains subject-bound.
Bounded real-API discovery and authenticated read-only Azure capability checks
were confirmed on 2026-08-12. The accepted path is local-first: secretless Linux
CI builds the authoritative OCI subject once, and that exact digest must pass the
complete loopback-only real-data `PG-03` gate before any Azure write.

The [POC capability and gate-status matrix](status/poc-capability-and-gate-matrix.md)
records the status of every acceptance criterion and gate: what is implemented
and evidenced, what is implemented but not yet gate-evidenced, and what remains
planned, deferred, or blocked on authorization.

Independent exact-hash reviews of plan version `1.4-rc4` and design version
`1.2-rc4` report no unresolved P0/P1. Plan `1.4-rc5` (command-matrix tree
status, supply-chain scope, `PLAN-R-18` eligibility API) and design `1.2-rc5`
(no-tile SVG map boundary, since superseded by the owner-authorized OSM tile
layer of 2026-08-15, design §0.5) await independent exact-hash re-review.
`PG-00` remains blocked only by:

- an explicitly authorized exact-hash Git commit; and
- a later explicit implementation request.

`Microsoft.App` registration, Entra app/secret, budget alerts, RBAC, and Azure
resources are deferred `PG-04` work after local `PG-03`, a demonstration planned
within 48 hours, and explicit cloud-write authorization. The selected region is
`southeastasia`; the conservative seven-day forecast is USD 34.66 including
contingency, below the USD 50 governance ceiling. Budgets/alerts do not enforce a
billing cutoff and expiry tags do not delete resources. Azure teardown targets
24 hours after the demonstration; seven days is an operator-enforced maximum
requiring explicit teardown approval or separately authorized retention. No
cloud resource, provider registration, app registration, secret, or deployment
is evidenced by these documents. The local implementation is committed in the
repository. Secretless CI executes on pull requests (evidence validation,
Semgrep, gitleaks secret scan, dependency audit, image build with Trivy scan);
the CI-built subject digest is retained at
[`docs/evidence/oci-digest-bundle-0962c7fedb67.json`](evidence/oci-digest-bundle-0962c7fedb67.json)
(`sha256:ae5dc6d1…`). **`PG-03` passed on 2026-08-15** for that subject: the
exact CI subject ran the loopback-only real-data container lane 5/5, a run now
archived byte-for-byte at
[`docs/evidence/archived/container-live-lane-afe29166ac21.json`](evidence/archived/container-live-lane-afe29166ac21.json).
The donor-subpath synthesis capability and its synthesis-aggregation lane check
were removed on 2026-08-23 (ADR-0003); a fresh authorized run on a CI-built
subject is required before the gate can be re-evidenced. Azure, production, and
UAT execution remain un-evidenced.
