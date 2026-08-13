# POC capability and gate-status matrix

Status snapshot: 2026-08-13 (documentation-reconciliation workstream).

This matrix records the current status of every `AC-POC-*` acceptance criterion
(binding design Section 0.6 and implementation plan Section 8.3) and of the
`PG-00` through `PG-04` gates. It is a documentation artifact, not evidence: a
status moves to "evidenced" only when a retained gate manifest with exact
subject, procedure, measurements, and artifact hashes exists (see
[Testing and evidence contract](../testing/evidence-and-validation.md)).

Classification terms:

- **Implemented and evidenced:** code exists and a retained artifact records the result.
- **Implemented, not yet gate-evidenced:** code exists; no retained manifest proves the criterion.
- **Partially implemented:** core behavior exists but a mandated part is missing or un-evidenced.
- **Designed/planned only:** documented contract; no implementation.
- **Deferred / blocked on authorization:** deliberately postponed, or requires user authorization (for example any Azure write).

## Acceptance criteria

| Criterion | Binding source | Status | What exists today | Gap / next action |
|---|---|---|---|---|
| `AC-POC-LOCAL-01` — authoritative secretless-CI OCI digest passes the complete loopback-only five-family real-data container gate before any Azure write | Design §0.6; plan §8.3 | Not evidenced (planned) | Non-root multi-stage `containers/Dockerfile` (node:22.14.0-bookworm-slim, `USER app`, `VOLUME /tmp`, entrypoint) and a `container:smoke` regex lane; secretless `poc-pr-static.yml` workflow (no evidenced run) | No CI-built OCI digest, no loopback-only five-family container run, no gate manifest. Requires CI execution evidence and the `PG-03` run |
| `AC-POC-BROWSE-01` — cursor traversal from first page through terminal cursor returns every active-generation flight exactly once; callsign search and duplicate selection directly exercised | Design §0.6; plan §8.3 | Implemented, not yet gate-evidenced | `/api/v1/routes/browse` with generation-bound cursor tokens (`apps/api/src/server.ts` browse, cursor, scoped-token code); callsign search `/api/v1/callsigns/search`; duplicate selection via ambiguity-preserving exact resolution | Exact-once traversal results are not retained in a manifest; offline suites cover contract behavior only |
| `AC-POC-RANK-01` — every tied Rank 1 candidate with provenance and modeled distance under the exact qualified label | Design §0.6; plan §8.3 | Partially implemented | Ranking semantics implemented: ties share rank, `rankDistanceNm` rounded to `0.000001 NM` for competition equality only, all tied Rank-1 candidates presented (`packages/route-engine`, `apps/api/src/server.ts` ranking) | The mandated exact label "Rank 1 by shortest modeled distance among complete candidates" appears only in documentation (README, POC boundary, safety doc), never in API/UI code; the UI and API use different wording. Aligning the label is a code change outside this workstream's scope (see handoffs) |
| `AC-POC-LIVE-01` — local and Azure POC flows acquire and validate real five-family data; cold startup fails on any unusable family; refresh retains only a still-usable complete generation; no synthetic runtime/demo fallback | Design §0.6; plan §8.3 | Implemented locally; Azure leg un-evidenced | Five-family adapter (`packages/upstream-caas`); startup fails on any unusable mandatory family; refresh acquires all five families first, then swaps atomically; no synthetic fallback (prohibited by `deploy/poc-policy.yaml`) | Local flow is evidenced only by the 2026-08-12 discovery manifest (read-only aggregates), not by an application-level gate run; Azure flow requires authorization (handoffs) |
| `AC-POC-DATA-01` — Airways fetch/schema/count validation directly evidenced while its values/types are absent from every output; Airports/NAVAIDs participate only through exact ambiguity-preserving resolution; graphical-airway variance recorded; no inferred topology | Design §0.6; plan §8.3 | Implemented, not yet gate-evidenced | Airways fetched/parsed/count-validated and hidden from API/UI/logs; exact resolution with preserved ambiguity/gaps (`packages/route-engine`); variance documented (README, POC boundary); discovery aggregates retained in `docs/evidence/pg-00-live-api-discovery.json` | No application-level evidence manifest proving output exclusion at every exit point |
| `AC-POC-MAP-01` — attribution, accepted IP/tile disclosure, origin-only Referer, caching, no-prefetch, configurable provider, non-map tile-failure behavior | Design §0.6 | Satisfied by deliberate variance; not gate-evidenced | Dependency-free inline SVG route diagram; the browser makes no external map/tile/provider request at all (same-origin `apps/web/src/api.ts` only; CSP `img-src 'self' data:` in the API server); non-map functionality is inherently independent of tiles | The legacy "configurable provider" option is non-binding archived material; there is no external party for attribution/disclosure/Referer criteria. Automated checks await the planned `test:a11y`/`test:security` lanes |
| `AC-POC-SEC-01` — browser never receives the CAAS key/raw object; strict application allow-list tests and the accepted no-firewall residual are recorded | Design §0.6; plan §8.3 | Implemented; automated gate tests not evidenced | Key and raw objects are server-only; origin/path/method allow-lists; no-firewall residual documented (README, safety, operations); `validate:policy` and the CI workflow enforce Bicep allow-list and secretless patterns | `test:security` lane is planned only; no automated negative tests retained |
| `AC-POC-REL-01` — unchanged-digest direct deployment, first-deploy ingress-disabled abort/cleanup, later prior-revision plus complete app-scoped configuration rollback, smoke, and current-data reacquisition | Design §0.6; plan §8.3 | Designed only; blocked on authorization | Deployment/rollback semantics documented (README, operations); target topology in `infra/bicep` | No Azure deployment, rollback drill, or smoke evidence; all Azure writes are unauthorized today |
| `AC-POC-DOC-01` — architecture, algorithms, tooling, build/deploy, limitations, AI use, lessons, requested feedback, and future roadmaps documented | Design §0.6; plan §8.3 | Implemented and evidenced | README plus the documentation index, POC boundary, data-use, operations, security, testing, and ADR documents cover the listed topics; this matrix and the historical archive complete the set | The 30-minute walkthrough remains to be delivered and is not evidenced |

## Gate status

| Gate | Status | Evidence present | Blocker / next action |
|---|---|---|---|
| `PG-00` | Partially closed; blocked per design §0.7 | Retained secret-free discovery manifest (`docs/evidence/pg-00-live-api-discovery.json`); independent exact-hash reviews of design `1.2-rc4` and plan `1.4-rc4` report no unresolved P0/P1; documents committed (`96bd1a9`, `341acd9`, `1d109f6`, plus the `docs/reconcile-poc-documentation` branch) | The two design §0.7 blockers remain: (1) an explicitly authorized exact-hash Git commit — commits exist, but whether they satisfy the authorization requirement is the user's determination, not a documentation claim; (2) a later explicit implementation request — open |
| `PG-01` | Partially implemented | `.github/workflows/poc-pr-static.yml` (secretless, pinned commit-SHA actions, offline Bicep compile); local `typecheck` passes (5 projects, exit 0) | CI execution is un-evidenced (no retained run artifacts); `format:check` and `lint` are no-op wrappers (no package-level scripts); `test:evidence` and `verify` are planned only |
| `PG-02` | Partially implemented | Offline suite runs via `test:offline`: 43 tests across 8 files (unit, contract, and integration-style behavior) | No gate manifest; a11y/E2E lanes absent (no Playwright/axe in the workspace) |
| `PG-03` | Not evidenced | Local `container:smoke` regex check only; Bicep compiles offline in the CI workflow | No authoritative secretless-CI OCI digest and no loopback-only five-family real-data container run; this gate is the precondition for every Azure write |
| `PG-04` | Deferred; blocked on authorization | None; all inputs (Microsoft.App registration, Entra app/secret, budgets/alerts, RBAC, resources) are deliberately deferred per design §0.7 and the README Azure write boundary | Requires user authorization and the completed `PG-03` evidence before any cloud write |

## Handoffs to other workstreams

Items in this matrix that require code or evidence work outside the
documentation file domain:

- `AC-POC-RANK-01` exact label: align the API/UI candidate label with the binding wording (runtime and ranking workstream).
- `PG-01`/`PG-03`: CI execution evidence, `format:check`/`lint` real lanes, and the authoritative OCI digest container gate (release-evidence and Azure workstreams).
- `PG-04` and `AC-POC-REL-01`: Azure deployment, auth configuration, and rollback drill evidence after authorization (Azure workstream).
- `AC-POC-LOCAL-01` automated accessibility and `AC-POC-SEC-01` negative tests: accessibility/UAT workstream lanes.

## Updating this matrix

Reclassify a row only with retained evidence (a gate manifest, an executed
command's retained output with artifact hashes, or a user-authorized decision).
Documentation wording does not change a status; evidence does. When a status
changes, update this file, the documentation index, and the affected gate's
section in the implementation plan together.
