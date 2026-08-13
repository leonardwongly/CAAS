# Testing and evidence contract

## Status rule

This repository contains an offline test suite, container smoke lane, and policy validator. It does not evidence CI execution or a semantic production gate. The checked-in `deploy/evidence-manifest.schema.json` validates a structural envelope only; it is not a threshold engine. Do not write “tests passed” unless the exact subject was run, assertions/measurements were inspected, artifacts were hashed, and the semantic gate policy derived `pass`.

## Evidence classes

Use these terms precisely:

- **Observed:** retained PG-00 read-only discovery facts, such as response status/media, bytes, counts, parser aggregates, and non-observations.
- **Designed:** a binding implementation rule or future validation requirement.
- **Planned:** a command or gate that cannot yet run because the relevant implementation/artifact does not exist.
- **Proved:** a later check with exact subject, environment, measurement/sample count, retained artifact hash, and policy-derived result.
- **Not evidenced:** no retained result exists. Do not infer it from source text, package metadata, or a successful no-op.

PG-00 is human-reviewed against the exact design/plan hashes using `evaluationMode: human-reviewed-pg00`. Before PG-01, implementation must add a versioned check policy and semantic validator. Later manifests must bind the gate, commit/OCI subject, environment, procedure, typed threshold, measured value/units/sample count, artifact SHA-256, derived result, exception/expiry, and fallback.

## Required behavior coverage

### Unit and property behavior

Cover coordinate parsing/range checks, exact reference resolution, ambiguity, explicit gaps, Haversine legs/totals, antimeridian display, canonical signatures, tie-key rounding, all-Rank-1 presentation, bounded local-draft integrity and server-computed delta when both computations are complete, and hard bounds. Include negative cases for malformed records, duplicate references, unknown fields, missing endpoints, generation mismatch, and forbidden airway output.

### Contract behavior

Use minimized, irreversibly sanitized captured-real responses. They must contain no key, raw personal fields, raw identifier list, or invented runtime flight record. Verify all five families, including `text/plain` bodies carrying JSON arrays, alias normalization, unknown-field discard, bounded parsing, and Airways fetch/schema/count validation with downstream output exclusion.

### Integration and E2E behavior

Verify server-only CAAS access, startup failure for any unusable mandatory family, atomic refresh, prior-generation freshness limits, cursor exact-once traversal from first to terminal cursor, callsign search, duplicate selection, route/table/SVG parity, visible gaps, all tied Rank 1 recorded candidates, the bounded local draft controls, keyboard/focus states, and URL privacy. The browser must make no external map-provider request. No synthetic fixture may appear as a runtime or demo fallback.

### Security and operational behavior

Verify key/raw-field absence from browser, image, logs, traces, and artifacts; origin/path/method/redirect/proxy controls; output encoding; request limits; same-origin URL privacy; telemetry redaction; non-root/read-only image properties; restart reacquisition; stale refresh behavior; and explicit failure fallback. Network firewall enforcement is not a POC claim and remains a production blocker.

## Current local commands

The repository currently declares these root commands:

```bash
pnpm run validate:config
pnpm run validate:policy
pnpm run typecheck
pnpm run test:offline
pnpm run container:smoke
pnpm run validate
pnpm run build
pnpm run lint
pnpm run test
```

`validate` is the aggregate offline lane: configuration and policy validation, TypeScript checks, package tests, offline tests, and the Linux container smoke check. `test:offline` runs the cross-package offline suite (currently 43 tests across 8 files). `validate:policy` enforces `deploy/poc-policy.yaml` and the Bicep topology invariants. `container:smoke` checks the Dockerfile without building unless `RUN_CONTAINER_BUILD=1`. `build` produces the Vite UI and TypeScript outputs. The live lane remains separately authorized and is not part of generic offline validation.

`lint` and `test` are currently recursive `--if-present` wrappers. Until package-level scripts exist, either command may complete without application work; a successful no-op is not lint or test evidence. Record the exact substantive suites and assertions that ran instead.

The future implementation command matrix is:

| Command | Intended scope | Evidence gate |
|---|---|---|
| `pnpm format:check` | Markdown/code formatting | PG-01 |
| `pnpm lint` | Lint/import boundaries | PG-01 |
| `pnpm typecheck` | All TypeScript projects | PG-01 |
| `pnpm test:unit` | Pure packages/components | PG-02 |
| `pnpm test:property` | Route/parser invariants | PG-02 |
| `pnpm test:contract` | Sanitized real-response contracts | PG-02 |
| `pnpm test:integration` | BFF, adapters, generation/token boundaries | PG-02/PG-03 |
| `pnpm test:e2e` | Deterministic captured-real flow | PG-02/PG-03 |
| `pnpm test:a11y` | Automated accessibility | PG-02/PG-03/PG-05 |
| `pnpm test:live` | Authorized five-family CAAS flow | PG-02/PG-03/PG-04 |
| `pnpm test:performance` | Startup/API/memory measurements | PG-03 |
| `pnpm test:security` | Secret, output, limit, privacy boundaries | PG-03/PG-04 |
| `pnpm test:container` | Exact digest, non-root/read-only, smoke | PG-02/PG-03/PG-04 |
| `pnpm test:evidence` | Schema and semantic-validator checks | PG-01 and every later gate |
| `pnpm verify` | Secretless local/CI checks; never live CAAS/Azure | Evolves by phase |

## Live and Azure distinctions

`test:live` is separately authorized and uses real CAAS data through the server adapter. Deterministic sanitized fixtures are not a live fallback. The authoritative PG-03 result must use the exact secretless-CI OCI subject, loopback-only, with the key injected at runtime. Azure writes are blocked until that evidence exists and the user separately authorizes bootstrap.

PG-04 is the first place where the unchanged digest, private auth, Azure deployment, first-deploy abort path, later revision plus app-config rollback, and current-data reacquisition can be evidenced. PG-05 adds manual accessibility/UAT and demonstration readiness. None of these results currently exist.

## Failure reporting

Record failed or blocked gates, not just successful checks. A failed mandatory check blocks the gate and points to a concrete fallback: no synthetic substitution, no partial generation, ingress disabled on Azure, or teardown/repair under authorization. A command exit status cannot override missing measurements, missing artifact hashes, policy mismatch, expired exceptions, or manual authorization/UAT.
