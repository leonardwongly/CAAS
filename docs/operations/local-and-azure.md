# Operations: local Linux first, Azure late

## Current status

The repository has a pinned `pnpm` workspace, a runnable Fastify service, React/Vite build, five-family live adapter, Linux container, offline validation scripts, a static CI validation workflow, Bicep templates, and a policy file. It does not evidence CI execution, Azure deployment, or operational runbook execution. The commands below separate local implementation checks from future authorized gates.

## Safe local setup

Use Linux for the authoritative build path. The root metadata pins Node `>=22.22.2` and `pnpm@11.5.2`.

```bash
corepack prepare pnpm@11.5.2 --activate
pnpm install --frozen-lockfile
cp .env.example .env
$EDITOR .env
pnpm run validate:config
pnpm run typecheck
pnpm run validate
```

`apikey` belongs only in the untracked local `.env` or an authorized runtime secret injection. Never put it in a URL, command argument, source file, Docker build argument, image layer, browser bundle, log, or retained artifact. The current `.env.example` is a placeholder contract, not a usable credential.

The root scripts currently declare `build`, `clean`, `dev`, `lint`, `test`, `test:offline`, `typecheck`, `validate:config`, `validate:policy`, `container:smoke`, and `validate`. `test:offline` runs the cross-package offline suite (140 tests across 22 files); `validate:policy` enforces `deploy/poc-policy.yaml` and the Bicep topology invariants; `container:smoke` checks the Dockerfile without building unless `RUN_CONTAINER_BUILD=1`. `lint` performs real import-boundary and script-hygiene checks (`scripts/validation/lint-import-boundaries.mjs`); `test` runs the package suites plus the a11y, e2e, and responsive vitest lanes.

## Planned local release sequence

After implementation creates the corresponding scripts, the intended sequence is:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:property
pnpm test:contract
pnpm test:integration
pnpm test:a11y
pnpm test:e2e
pnpm test:security
pnpm test:performance
pnpm test:container
pnpm test:evidence
pnpm verify
```

The live lane is explicit and separately authorized; it is not part of a generic `verify` command:

```bash
pnpm test:live
```

`test:live` must acquire all five families through the server adapter, prove Airways output exclusion, and exercise browse/search/selection/business behavior. The authoritative `PG-03` run must use the one secretless-CI-built OCI digest loaded or addressed loopback-only with the key injected at runtime. A locally rebuilt image is not an acceptable substitute.

No command is reported as passed without its exact subject, exit result, assertion/measurement details, retained artifact path, SHA-256, and gate-manifest entry. The evidence schema is only a structural envelope; later gates require a semantic policy validator.

## Generation and incident behavior

- Startup requires a usable complete five-family generation. If acquisition or validation fails for any mandatory family, fail explicitly with an upstream-unavailable state; do not serve synthetic or partial records.
- Refresh builds off to the side and swaps atomically only after complete validation. On failure, retain only a still-usable prior generation within freshness and memory bounds, and report stale state.
- Retain at most active plus immediately previous generation for the defined 30-minute in-flight window. Restart loses data and requires reacquisition.
- Invalidate generation-bound cursors, point references, candidate IDs, and draft tokens on refresh/revision mismatch. Never mix generations.
- If map tiles fail, preserve route tables, distances, gaps, and other non-map functionality.
- If a safety or secret-boundary check fails, stop serving the affected flow and retain sanitized diagnostics only.

## Azure is a gated late write, not a development environment

Normal development must not run write-capable Azure commands. Read-only checks may confirm account/capability context when separately authorized, for example:

```bash
az account show --only-show-errors
az provider show --namespace Microsoft.App --query registrationState --only-show-errors
```

These are examples of read-only inspection, not evidence of deployment. Do not add `az group create`, provider registration, role assignment, Key Vault secret writes, app registration, Container Apps creation, registry push, ingress enablement, or deletion commands to routine scripts or documentation as if they were currently executable.

Before any cloud write, all of the following are required:

1. The exact authoritative secretless-CI OCI subject passes complete loopback-only real-data `PG-03`.
2. The demonstration is planned within 48 hours.
3. A go/no-go check confirms provider, quota/name, budget/RBAC, identity/federation, ACR push, Key Vault bootstrap, auth configuration, and cleanup capabilities.
4. The user explicitly authorizes cloud bootstrap. Documentation review or a design decision is not authorization.
5. No secret or committed tenant/user identifier enters source or command arguments.

The target is one region, one managed environment, one Container App, ACR Basic, Key Vault Standard, separate runtime/deployment identities, one single-tenant allowed Entra user, and bounded monitoring. The target topology is not evidence that those resources exist.

## Deployment and rollback semantics

There is no staging environment. The unchanged verified digest goes directly to the private POC through narrowly scoped GitHub OIDC. Initial ingress remains disabled while control-plane, revision, probe, five-family acquisition, telemetry, and auth configuration checks run. External checks then run fail-closed: unauthenticated request rejected, deployment identity denied, allowed user full flow.

A first deployment has no rollback target. On failure, keep ingress disabled, deactivate/remove the failed candidate under the authorized cleanup procedure, clear temporary credentials, and repair or abort. Only after a known-good revision exists may a later failure restore the prior revision and the complete app-scoped configuration (ingress/traffic, identity, Key Vault references, environment, scale/probes, and separate auth configuration). The restored application reacquires current CAAS data; external data is not snapshot-rolled back.

Authorized Azure procedures (release path, preflight, deployment, abort/rollback drills, post-demo verification, and the reconciled topology) live under `docs/operations/` and `docs/architecture/`: `azure-release-path.md`, `azure-preflight-and-bootstrap.md`, `azure-deployment-procedure.md`, `azure-abort-and-rollback-drills.md`, `azure-post-demo-verification.md`, `azure-poc-topology.md`. Their paired dry-run/negative-check scripts are in `deploy/`.

## Cost and teardown controls

The accepted governance ceiling is USD 50 with alert thresholds at USD 25, USD 37.50, and USD 45. Alerts are notifications, not billing cutoffs; expiry tags do not delete resources. Provisioning starts no earlier than 48 hours before the demonstration, teardown targets 24 hours afterward, and seven days is an operator-enforced maximum requiring explicit teardown approval or separately authorized retention. Stop new deployment work at a USD 45 forecast/actual alert and request teardown or retention authority.

No Azure resource, provider registration, app registration, secret, deployment, rollback drill, UAT, or teardown is evidenced in this repository today.
