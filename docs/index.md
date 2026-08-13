# Flight Route Explorer documentation

This directory is the documentation entry point for the Flight Route Explorer.
Documents describe the implemented local POC, design constraints, and retained
evidence; they do not prove Azure deployment or production operational controls.

## Architecture and plans

- [System design](superpowers/specs/2026-08-11-flight-route-explorer-design.md)
- [Implementation plan](superpowers/plans/2026-08-11-flight-route-explorer-implementation-plan.md)
- [Archived historical design sections 3-29](superpowers/historical/2026-08-11-flight-route-explorer-design-legacy-sections-3-29.md) (non-binding historical analysis)

## Evidence

- [Secret-free PG-00 live API discovery manifest](evidence/pg-00-live-api-discovery.json)
- [Gate evidence manifest schema](../deploy/evidence-manifest.schema.json)

## Status

The system design and implementation plan remain the governing design and delivery references; the local POC implementation now exists beneath them.
Bounded real-API discovery and authenticated read-only Azure capability checks
were confirmed on 2026-08-12. The accepted path is local-first: secretless Linux
CI builds the authoritative OCI subject once, and that exact digest must pass the
complete loopback-only real-data `PG-03` gate before any Azure write.

The [POC capability and gate-status matrix](status/poc-capability-and-gate-matrix.md)
records the status of every acceptance criterion and gate: what is implemented
and evidenced, what is implemented but not yet gate-evidenced, and what remains
planned, deferred, or blocked on authorization.

Independent exact-hash reviews of plan version `1.4-rc4` and design version
`1.2-rc4` report no unresolved P0/P1. `PG-00` remains blocked only by:

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
repository, but no later gate (CI execution, authoritative OCI digest evidence,
Azure, or UAT) is claimed as evidenced.
