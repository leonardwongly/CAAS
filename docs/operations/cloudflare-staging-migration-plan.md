# Cloudflare staging migration plan

Status: staging-only technical migration plan, 2026-08-16. This document supplements the existing Azure POC procedures; it neither authorizes a Cloudflare account change nor alters the Azure deployment path. No Cloudflare resource, DNS record, secret, GitHub Environment, GitHub App connection, deployment, production release, or data-use scope has been created by this plan.

## 1. Scope and decision

Cloudflare is a separate **staging** lane for the Flight Route Explorer. Azure remains untouched and remains the documented private POC path. Production use remains prohibited. A production deployment needs a new explicit approval after the exit criteria in section 8 are met.

The staging design intentionally uses the existing frontend/API boundary:

```text
Browser
  ├─ static SPA assets ──> Worker static-asset binding (edge cached)
  └─ same-origin /api/* ─> Worker ─> Durable Object-backed Container ─> Fastify :8080
                                                          └─ CAAS five-family APIs
```

`wrangler.jsonc` defines the Worker, SPA assets, one `ApiContainer` class, the Durable Object binding/migration, and the distinct `staging` Worker environment. The Worker sends only `/api/*` to the Container; `assets.run_worker_first` is restricted to that path so frontend files retain normal edge delivery. SPA fallback is handled by the static-assets `single-page-application` policy.

The existing Dockerfile is intentionally reused. It still contains the Vite distribution because Azure uses its Fastify static serving path. The Cloudflare Worker serves the same build output directly, so the duplicate bytes are accepted staging-only parity overhead. Removing them would make a new OCI subject and requires its own review/evidence.

## 2. Service and resource mapping

| Current component | Cloudflare staging implementation | Notes |
|---|---|---|
| Vite/React SPA (`apps/web/dist`) | Worker static assets | The build stays `pnpm --filter @flight-route-explorer/web run build`; no browser credential is introduced. |
| Fastify BFF (`apps/api`) | Dockerfile-backed Cloudflare Container on port 8080 | Existing API routes, readiness behavior, CSP, same-origin request checks, response limits, and in-memory generation store remain in effect. |
| `apikey` CAAS credential | Per-environment Cloudflare Worker secret, injected into `ApiContainer.envVars` | It is available only as the Container environment variable `apikey`; never put it in `wrangler.jsonc`, Git, GitHub logs, a Vite `VITE_*` variable, or frontend assets. |
| Current active/previous generations and route variations | Container process memory | No persistence migration is required. Restart intentionally reacquires data and invalidates transient tokens/state. |
| Bundled airport-name data | Container image | No KV, D1, R2, queue, or snapshot store is introduced. Add one only after a separately approved persistence requirement. |
| Azure POC topology and identities | Unchanged | This plan does not modify Bicep, Azure DNS, Key Vault, Entra, or the existing Azure release/rollback controls. |

The staging Container is limited to one active instance, with the same 1 vCPU/2 GiB shape as the current POC contract. This avoids inventing horizontal-state semantics for a process-local generation store. Cold starts and five-family acquisition remain expected behavior; readiness, not merely an open port, is the serving signal.

## 3. Required one-time account setup (owner-operated)

These steps are intentionally manual because they write Cloudflare/GitHub/DNS security state:

1. Create or select the Cloudflare account and enable Workers/Containers for it. Confirm the account can deploy a Dockerfile-backed Worker Container.
2. In GitHub, create Environments `cloudflare-staging` and `cloudflare-production` to scope their credentials. Store only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as environment secrets. Configure `CLOUDFLARE_SMOKE_URL` as a non-secret environment variable for each environment.
3. Create a least-privilege, bounded Cloudflare API token for the repository workflow. Verify it can deploy only the intended Worker/Container resources; do not use a global API key or put credentials in repository variables.
4. Set the runtime secret interactively for each intended Worker environment, for example `pnpm exec wrangler secret put apikey --env staging`. The `secrets.required` declaration makes a deploy fail if it is absent. Configure `REFRESH_SECRET` only if that optional Fastify control is approved and used.
5. Connect the repository to **Cloudflare Workers Builds**. Use a dedicated production branch such as `cloudflare-production`; set the build command to `corepack enable && corepack prepare pnpm@11.5.2 --activate && pnpm install --frozen-lockfile && pnpm --filter @flight-route-explorer/web run build`, and the production deploy command to `pnpm exec wrangler deploy`. Workers Builds must use `wrangler deploy` (not `wrangler versions upload`) because Container image publication/rollout requires a full deployment.
6. Configure Workers Builds watch paths for `apps/edge/**`, `apps/api/**`, `apps/web/**`, `packages/**`, `containers/**`, `wrangler.jsonc`, `package.json`, and `pnpm-lock.yaml`. Require an explicit owner-approved promotion to the dedicated production branch; do not connect `master` directly to Cloudflare production.

The repository workflow is complementary: a push to `master` deploys the isolated staging environment; production requires an explicit manual workflow dispatch using the `cloudflare-production` environment. Cloudflare Workers Builds provides the requested native production-branch path only after the account owner performs the connection above.

## 4. Staging hostname, routing, and DNS

Start with the staging Worker `workers.dev` hostname captured in `CLOUDFLARE_SMOKE_URL`; this needs no custom DNS cutover. If a custom staging hostname is later approved:

- use a dedicated staging-only hostname (for example, `staging.<approved-domain>`), never the production hostname;
- add the DNS record only in the approved Cloudflare zone and keep it proxied when using a Worker custom domain/route;
- lower the existing record TTL before a planned change, record the prior record/value/proxy state, and wait for propagation before validation;
- bind the route/custom domain to the **staging** Worker only; do not attach a wildcard that can capture production traffic;
- keep frontend and API same-origin. The Worker sends `/api/*` internally to the Container, avoiding browser CORS configuration or exposing the container directly.

There is no production DNS cutover in this plan. Removing the staging route or reverting the dedicated DNS record restores the pre-staging routing state without touching Azure.

## 5. Deployment and rollback

### Staging deployment sequence

1. Existing secretless CI and OCI subject checks run unchanged on `master`.
2. The additive `cloudflare-deploy` workflow builds the Vite assets, runs `wrangler deploy --env staging`, and waits for both frontend and `/api/v1/health/ready` smoke checks.
3. Review Worker deployment status, Container rollout status, error logs, cold-start observations, and the readiness result before inviting any staging user.

A Container rollout is not fully transactional: Worker code may be reachable before image publication and container replacement complete. Treat the ready-route smoke test as mandatory, retain its result, and abort/revert if it fails. Container-backed Workers do not use the normal Workers Builds preview-URL model; a real staging environment is the review target.

### Rollback order

1. Stop traffic to the candidate staging version by rolling the staging Worker back to the last known-good Worker version in Cloudflare.
2. Verify the old Worker version still routes `/api/*` to its corresponding ready container and that the frontend route responds.
3. If a dedicated staging hostname was attached, remove/revert that route or DNS record as required; keep Azure untouched.
4. Preserve non-secret deployment/version identifiers, timestamps, rollout status, readiness output, and the reason for rollback. Do not retain raw CAAS records, headers, URLs containing tokens, or credentials.

Cloudflare rollback does not roll back CAAS data: the app intentionally reacquires a fresh generation after restart. First staging deployment has no known-good Cloudflare version, so the recovery is disable/remove the staging route and clean up the candidate only with explicit authority.

## 6. Parity and smoke validation

Before calling staging usable, record the exact source revision, Worker version, Container image/deployment identifier, and these checks:

| Area | Required validation |
|---|---|
| Static frontend | `GET /` returns the SPA root; an SPA deep link returns the shell; asset requests remain edge-served. |
| API/container | `GET /api/v1/health/ready` becomes `200` with `status: ready` after cold start; wrong/unknown API paths retain bounded Fastify errors. |
| Core browser route | Open the SPA and complete the overview → select → inspect path using same-origin `/api/*`; verify no browser CORS failure. |
| Safety/security headers | Confirm CSP, HSTS, nosniff, frame protection, referrer policy, and permissions policy on API responses; verify no `apikey` in assets, HTML, responses, Worker logs, or workflow output. |
| Data behavior | A staging restart reacquires a complete five-family generation; no partial generation, persistence, or synthetic fallback appears. |
| Access/rate controls | Recheck Fastify’s origin guard, refresh-rate behavior, request/response limits, and bounded errors. Configure Cloudflare rate limiting/cache rules only after an approved threat model; never cache authenticated or mutable API responses merely for performance. |
| Observability | Verify Worker logs/error visibility and Container logs/rollout monitoring. Use sanitized reason codes/counts/durations only. |

The existing 92-flight live-UAT remains authorization-bound. Run it locally only with the supported explicit `--env-file .env` process and required data-use authority. Cloudflare staging needs its own owner-configured `apikey` secret; it is not a substitute for or permission to run live UAT.

## 7. Operational caveats and monitoring

- The first API request after container sleep can include container start and Fastify five-family acquisition latency. Frontend assets should remain available; API readiness must remain false until the full generation is usable.
- Container process storage is ephemeral. `/tmp`, generation data, tokens, and route variations must not be treated as durable.
- Track Worker deployment errors, container start/stop/rollout events, readiness failures, API error rates, upstream acquisition failures, and memory/CPU pressure. Alerting destinations, retention, and incident ownership need explicit approval before configuration.
- Preserve the existing CSP and same-origin design. Adding cross-origin APIs, permissive CORS, public container endpoints, or Vite-injected secrets is prohibited without a new security review.

## 8. Production decision gate

A Cloudflare production cutover is not implied by a successful staging run. It requires explicit owner approval and evidence that: staging smoke and end-to-end parity checks passed on the candidate; container rollout/cold-start behavior is acceptable; a least-privilege token and manual authorization record are verified; a custom-domain/DNS rollback record is rehearsed; secret rotation/revocation, log retention, monitoring ownership, rate limiting, cache policy, incident response, data-use authority, and production access controls are approved; Azure coexistence/rollback is documented; and the product’s separate production gate is opened. Until then, production deployment remains unconfigured and Azure remains unchanged.
