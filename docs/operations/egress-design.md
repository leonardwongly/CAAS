# Network-enforced egress design for production access

> Status: **design documented; no execution.** This is a production
> prerequisite (issue #32), not a required implementation step for the current
> local-first POC. Nothing here authorizes Azure writes or production traffic.
> No Azure resource has been created, and no network control has been
> executed or tested.

## 1. Problem statement

The POC intentionally omits network-enforced outbound filtering
([design §0.5](../../docs/superpowers/specs/2026-08-11-flight-route-explorer-design.md#05-poc-azure-identity-map-and-egress-boundaries)):
*"Network-enforced outbound filtering is omitted to preserve the least-complex
POC. Strict application origin/path/method/redirect/proxy controls are
mandatory. This residual is accepted only for the POC and blocks broader
production access until enforced egress is designed and tested."*

The residual means that today a compromised or misconfigured server process
could, in principle, reach destinations other than the CAAS API at the network
layer. Production access requires that an enforceable network control limits
application traffic to approved destinations while preserving the Azure
control-plane behavior the application needs.

## 2. Current state: strict application-layer controls (mandatory, retained)

These controls are implemented in `packages/upstream-caas` and remain
mandatory under the network control (defense in depth):

| Control | Implementation | Evidence |
|---|---|---|
| Exact HTTPS origin/path allow-list | `assertFixedRequest` in `packages/upstream-caas/src/transport.ts` rejects any request outside `https://api.swimapisg.info` + fixed family paths, non-GET methods, search/hash, wrong `maxBytes` | Offline tests in `tests/upstream-bounds/failure-surfacing.test.ts` |
| No redirects | `fetch(..., { redirect: "error" })` — a redirect is a hard error, not followed | Offline test proves `redirect: "error"` is passed |
| No proxy-controlled destinations | The transport uses the platform `fetch` directly with fixed URLs and no proxy configuration; proxy environment variables are not consulted | Code inspection (documented, not network-tested) |
| Bounded timeouts and response sizes | 5 s connect / 30 s total timeouts; per-family `maxBytes`; streaming size enforcement | Offline tests |
| Credential handling | `apikey` header injected server-side only; never in browser, image, or logs | Security workstream evidence |

These controls are necessary but not sufficient: they protect the application
logic, not the network path.

## 3. Target network-enforced design

### 3.1 Requirements

1. Application egress limited to: the CAAS API (`api.swimapisg.info`, HTTPS
   port 443) — and nothing else for business traffic.
2. Azure control-plane egress preserved: the managed environment still needs
   its platform-required outbound traffic (image pulls from ACR, Key Vault,
   Azure Monitor/Log Analytics ingestion, Container Apps management plane,
   diagnostic settings). These are Azure-platform FQDNs/IPs, not business
   destinations.
3. No business egress can bypass the control (no NAT/proxy holes, no DNS
   rebinding window, no plaintext fallback).
4. Blocking must fail closed: if the network control is misconfigured or
   degraded, business traffic must not silently bypass it.

### 3.2 Candidate architecture (to be selected by a new production ADR)

Per the plan's production option analysis and Azure Container Apps networking:

**Option A — User-defined route (UDR) to Azure Firewall (recommended for
evaluation):**

- Container Apps managed environment outbound traffic routes through a
  user-defined route to an Azure Firewall in a hub virtual network.
- Azure Firewall application rules allow HTTPS to `api.swimapisg.info` only
  for the app's business egress; platform-required control-plane FQDNs are
  allowed on a tightly curated allow-list (ACR, Key Vault, Log Analytics /
  Monitor ingestion, Container Apps service tags, AKS/control-plane service
  tags per the managed-environment requirements at the time of the ADR).
- Network rules deny everything else; default route (0.0.0.0/0) through the
  firewall with no fallback NAT path.
- TLS inspection is optional; without it the firewall filters by FQDN/SNI
  (DNS-based), so the design must also enforce that the app cannot bypass DNS
  (no raw-IP connections to non-approved destinations — network rules deny
  non-approved IPs).

**Option B — NAT gateway + strict service-tag network rules (simpler, weaker):**

- NAT gateway provides outbound; network security groups (NSG) allow only
  destinations in the approved set. Weaker than Option A for FQDN-level
  control because NSG rules are IP-based and CAAS may not publish stable
  public IP ranges; rejected as insufficient unless combined with an
  application-layer FQDN check that the POC already has.

**Option C — Egress via a dedicated proxy/gateway the app must use:**

- The app's `CaasTransport` is replaced by a transport that dials only through
  a locked-down forward proxy with an allow-list. The proxy itself is the
  network enforcement point. Requires transport code change; evaluated as a
  fallback if Azure Firewall routing is not feasible in the chosen region.

The design does not bind a choice: production mechanisms are selected by a new
ADR (plan §17) after validating the managed-environment routing constraints in
the target region. The POC architecture is not automatically production
architecture.

### 3.3 Strict application controls inside the network boundary

- The existing allow-listed transport remains the only business egress path.
- The app runs with no ambient credentials for other clouds; no egress is
  needed for any feature other than CAAS acquisition.
- Startup fails if the network control cannot be verified (see validation
  plan) — the app must not serve stale generations indefinitely with egress
  unproven.
- Telemetry/export paths (Azure Monitor/Log Analytics) are included in the
  control-plane allow-list and stay separate from business egress.

## 4. Validation plan (no Azure execution — this is the plan)

All of the following are planned test procedures to run only after the
production ADR is approved and Azure execution is authorized. None has been
run.

| Test | Procedure | Expected result |
|---|---|---|
| Egress allow-list positive | Deploy the app in the target topology; trigger a full five-family refresh | Acquisition succeeds; firewall logs show only approved destinations |
| Egress deny negative | From a probe container in the same subnet, attempt HTTPS to a non-approved public FQDN and a raw-IP connection | Both blocked at the network layer; firewall/NSG logs record the deny |
| Redirect handling at network layer | Serve a synthetic upstream response with a 3xx; observe app behavior | App fails closed (`redirect: "error"`); no second connection leaves the subnet |
| DNS bypass check | Attempt connection via resolved IP of a non-approved host | Network rule denies non-approved IPs |
| Control-plane preservation | Run image pull, Key Vault secret retrieval, and telemetry export while business egress is active | All control-plane flows succeed; allow-list covers them |
| Fail-closed check | Misconfigure the firewall (remove CAAS allow rule) and trigger refresh | Acquisition fails with the bounded upstream error; app reports `UPSTREAM_UNAVAILABLE`; no silent fallback |
| Evidence retention | Record firewall rules, logs, test matrix, and results with hashes in the PG-PROD manifest | Complete, retained, secret-free |

## 5. What remains open

- Region-specific routing constraints for the managed environment must be
  re-validated when the production ADR is written.
- TLS-inspection decision (with or without) changes the FQDN vs IP enforcement
  posture; the ADR records the choice.
- CAAS quota-exhaustion and failure behavior remains unobserved (issue #30
  evidence boundary) and does not change with egress enforcement.

Resolved per GitHub issue #32.
