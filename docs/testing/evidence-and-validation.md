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

Cover coordinate parsing/range checks, exact reference resolution, ambiguity, explicit gaps, Haversine legs/totals, antimeridian display, canonical signatures, selected-first immutable source ordering, absence of public preference fields, bounded local-variation integrity and server-computed delta when both computations are complete, and hard bounds. Include negative cases for malformed records, duplicate references, unknown fields, missing endpoints, generation mismatch, and forbidden airway output.

### Contract behavior

Use minimized, irreversibly sanitized captured-real responses. They must contain no key, raw personal fields, raw identifier list, or invented runtime flight record. Verify all five families, including `text/plain` bodies carrying JSON arrays, alias normalization, unknown-field discard, bounded parsing, and Airways fetch/schema/count validation with downstream output exclusion.

### Integration and E2E behavior

Verify server-only CAAS access, startup failure for any unusable mandatory family, atomic refresh, prior-generation freshness limits, client/server cursor exact-once traversal, rejection of duplicate identities/generation drift/non-progressing pages, >10-route map/list rendering, shared map/list/filter/HUD selection, exact-overlap choice, callsign filtering, visible gaps without bridging, neutral complete/incomplete groups, absence of public preference fields, bounded local-variation controls, keyboard/focus states, and URL privacy. OSM requests must obey the binding tile-only/no-referrer/CSP/attribution/cap contract and route data must survive tile failure. No synthetic fixture may appear as a runtime or demo fallback.

### Airport-name bundle behavior

Verify manifest schema, pinned source commit and license, source and normalized SHA-256 values, 10,444-record count, unique sorted exact ICAO entries, deterministic regeneration, exact lookup, explicit missing-name fallback, and absence of fuzzy/proximity/generated-code/runtime lookup. Bundle and manifest updates and rollbacks are atomic. The reference is community-maintained and not an official ICAO publication.

### Security and operational behavior

Verify key/raw-field absence from browser, image, logs, traces, and artifacts; origin/path/method/redirect/proxy controls; output encoding; request limits; same-origin URL privacy; telemetry redaction; non-root/read-only image properties; restart reacquisition; stale refresh behavior; and explicit failure fallback. Network firewall enforcement is not a POC claim and remains a production blocker.

## Current local commands

The repository currently declares these root commands:

```bash
pnpm run validate:config
pnpm run validate:policy
pnpm run typecheck
pnpm run container:smoke
pnpm run validate
pnpm run lint
pnpm run test
pnpm run test:offline
pnpm run test:evidence
pnpm run test:integration
pnpm run test:security
pnpm run test:container
pnpm run test:performance
pnpm run test:live
pnpm run validate:evidence
pnpm run evidence:archive             # dry run; moves nothing
pnpm run evidence:archive -- --apply  # archive reviewed stale records only
pnpm run oci:build
pnpm run oci:verify
pnpm run build
pnpm run verify
```

`validate` is the aggregate offline lane: configuration and policy validation,
TypeScript checks, package tests, offline deterministic tests, evidence tests
and bundle validation, the real workspace lint, and the Linux container
definition smoke check. It is hermetic: no credential, no live CAAS call, no
cloud write, no registry push. A failing step fails the command with a non-zero
exit; there are no no-op stubs left in the `validate*`/`lint` entry points.
`validate:policy` enforces `deploy/poc-policy.yaml` and the Bicep topology
invariants. `container:smoke` checks the Dockerfile without building unless
`RUN_CONTAINER_BUILD=1`. `build` produces the Vite UI and TypeScript outputs.

`verify` is the full secretless evidence run: everything in `validate`, plus
the loopback five-family lane (`test:integration`), the hermetic security
measurement, the container lane and container smoke, the fixture-backed
performance measurement, and the live-data lane in pending mode. Run
`pnpm oci:build` before `pnpm verify` so the container lane can inspect the
built image; `oci:build` builds the digest-pinned image and emits both the
digest bundle and the PG-03 gate manifest.

The live lane remains separately authorized and is not part of generic offline
validation: `test:live` records a pending manifest with the exact authorized-run
procedure whenever no credential is configured, and refuses placeholder keys.

### Implemented evidence lanes and records

All lane/measurement scripts live in `scripts/validation/` and write records
into `docs/evidence/` with real SHA-256 artifact hashes:

- `loopback-lane.mjs` — the loopback five-family lane: the real server and real
  adapter over loopback HTTP against a deterministic sanitized mock upstream.
  Twenty-three checks cover startup/readiness, five-family acquisition, single-retry
  on 429, bounded egress, browse exact-once cursor traversal, callsign search
  (positive/negative), selected-first neutral source order, descriptive distance, preference-field exclusion, exact-signature dedup, explicit
  gap preservation, duplicate-identifier ambiguity, draft compare, refresh
  authorization/atomicity/retention, airway exclusion, security headers,
  fail-closed startup, and restart reacquisition. Fixture values mirror
  `packages/upstream-caas/src/config.ts` exactly (cross-checked by
  `tests/validation/fixtures-contract.test.ts`).
- `live-lane.mjs` — the authorized live-data lane. Pending mode writes a
  blocked record with the exact authorized-run procedure and exits 0; a
  configured real credential runs the live five-family flow and records real
  measurements (never printing the key); placeholder/fixture keys are refused
  loudly.
- `build-oci.mjs` + `oci-subject-manifest.mjs` — reproducible secretless local
  OCI build from the digest-pinned `containers/Dockerfile`, with image
  assertions (non-root user, port 8080, no secret environment, linux/amd64),
  artifact tar hash, and the PG-03 gate manifest bound to the real policy and
  validator hashes. The manifest stays `blocked` until the authoritative CI
  subject and the authorized loopback real-data run are recorded.
- `loopback-container-lane.mjs` — container-half of the loopback gate:
  fail-closed boot without a credential plus image metadata assertions.
- `measure-performance.mjs` (+ `perf-child.mjs`) — real measured values on this
  machine against the fixture-backed loopback server: cold start to readiness
  (worst of 3 fresh processes), warm p95 over 100 sampled requests per
  endpoint, and peak RSS sampled at 1 Hz, evaluated against the design section 6
  bounds (120 s/180 s cold start, 2 s/5 s warm p95, 1.5 GiB/2 GiB memory).
  Live-data and CI measurements are recorded as pending with procedure.
- `measure-security.mjs` — hermetic secret scan of tracked files, .env
  tracking, .env.example placeholder check, fixture-credential scope, response
  security headers, and image metadata. The networked dependency audit is
  recorded pending with procedure (hermetic constraint).
- `lint-import-boundaries.mjs` — the real workspace lint (replaces the silent
  recursive no-op): apps/web import boundary, package script hygiene
  (typecheck everywhere, real test scripts), and root validation script
  honesty.
- `validate-evidence-bundle.mjs` — the semantic validator bound by gate
  manifests (`policy.validatorSha256`): runs the structural
  `validateManifest`, verifies `policySha256` against the real policy file,
  verifies the self-binding validator hash, checks every mandatory policy
  check is present with matching operator/units, classifies lane/measurement
  records structurally (envelope, check ids, sample counts, artifact hashes,
  timestamps, summary consistency), and skips PG-00 discovery records.

### CI workflows (local artifacts; not triggered)

- `.github/workflows/ci-secretless-validation.yml` — hermetic validation lane
  on push/PR: frozen install, `validate:config`, `validate:policy`, typecheck,
  lint, unit tests, offline suite, evidence tests and bundle validation, the
  loopback lane, security measurement, and container smoke. No secrets, no
  Azure operations, no manual trigger.
- `.github/workflows/oci-subject-build.yml` — authoritative secretless OCI
  subject build using the same `scripts/validation/build-oci.mjs` path as
  locally, uploading the digest bundle. No registry push, no secrets.

The future implementation command matrix is:

| Command | Intended scope | Evidence gate |
|---|---|---|
| `pnpm format:check` | Markdown/code formatting | PG-01 (not yet implemented) |
| `pnpm lint` | Lint/import boundaries (implemented) | PG-01 |
| `pnpm typecheck` | All TypeScript projects | PG-01 |
| `pnpm test:unit` | Pure packages/components | PG-02 |
| `pnpm test:property` | Route/parser invariants | PG-02 |
| `pnpm test:contract` | Sanitized real-response contracts | PG-02 |
| `pnpm test:integration` | Loopback five-family lane (implemented) | PG-02/PG-03 |
| `pnpm test:e2e` | Deterministic browser interaction lane (implemented; vitest + jsdom) | PG-02/PG-03 |
| `pnpm test:browser` | Built SPA against fixture-only same-origin API routes in Chromium and WebKit, including critical-path interaction and axe audit (implemented) | PG-02/PG-03 |
| `pnpm test:a11y` | Automated accessibility (axe + ARIA structure; implemented) | PG-02/PG-03/PG-05 |
| `pnpm test:live` | Authorized five-family CAAS flow; pending mode implemented | PG-02/PG-03/PG-04 |
| `pnpm test:performance` | Fixture-backed measurements implemented; live pending | PG-03 |
| `pnpm test:security` | Hermetic secret/output/limit boundaries (implemented) | PG-03/PG-04 |
| `pnpm test:container` | Fail-closed boot, metadata, smoke (implemented) | PG-02/PG-03/PG-04 |
| `pnpm test:evidence` | Schema and semantic-validator checks (implemented) | PG-01 and every later gate |
| `pnpm verify` | Secretless local/CI checks; never live CAAS/Azure | Evolves by phase |

## Live and Azure distinctions

`test:live` is separately authorized and uses real CAAS data through the server adapter. Deterministic sanitized fixtures are not a live fallback. The authoritative PG-03 result must use the exact secretless-CI OCI subject, loopback-only, with the key injected at runtime. Azure writes are blocked until that evidence exists and the user separately authorizes bootstrap.

PG-04 is the first place where the unchanged digest, private auth, Azure deployment, first-deploy abort path, later revision plus app-config rollback, and current-data reacquisition can be evidenced. PG-05 adds manual accessibility/UAT and demonstration readiness. None of these results currently exist.

## Historical and generated evidence

Retained evidence is immutable audit history. A record containing superseded Rank-era checks proves only the named older subject and contract. Do not edit it to imply proof of neutral comparison, the all-route overview, synchronized selection, or airport-name governance. New claims require current tests or a new subject-bound record with current artifact hashes, such as `loopback-lane-local-e965c728fe45.json`.

## Failure reporting

Record failed or blocked gates, not just successful checks. A failed mandatory check blocks the gate and points to a concrete fallback: no synthetic substitution, no partial generation, ingress disabled on Azure, or teardown/repair under authorization. A command exit status cannot override missing measurements, missing artifact hashes, policy mismatch, expired exceptions, or manual authorization/UAT.

### Evidence archive and re-settlement workflow

Historical evidence is immutable audit history. The dedicated `evidence:settle`
workflow is intentionally two-phase:

1. Run `pnpm run evidence:settle` (or `--write-plan <path>`) to produce a
   read-only plan. The plan lists only top-level lane/measurement records whose
   referenced artifacts are missing or hash-mismatched, including each root
   record's byte length and SHA-256. It never edits or moves a record.
2. Review the plan against the current product/runtime contract. Set
   `review.status` to `approved` only after confirming that each candidate is a
   superseded root record and that no retained UAT artifact is being relabeled.
3. Run `node scripts/validation/settle-evidence.mjs --apply --plan-file
   <path> --approve`. The command re-scans and rejects a stale plan, copies
   each selected root record to `docs/evidence/archived/`, verifies the copied
   bytes and hash before removing the root, regenerates the current
   subject-bound loopback record, then invokes the semantic validator once,
   serially, after all writes complete. It writes a settlement audit record in
   the archive directory.

The archive operation is byte-preserving, never rewrites JSON, and refuses an
existing archive copy whose bytes differ. Current records are regenerated from
current code and current artifact hashes; they are not obtained by editing an
older record. Revised live UAT is a separate subject-bound run under
`docs/testing/artifacts/` and must not rename, rewrite, or upgrade older UAT
records. The workflow performs no Azure operation, cloud write, deployment,
rollback, teardown, or production action.

The older `evidence:archive` command remains available for compatibility and is
read-only by default; do not use its legacy `--apply` path for new lifecycle
work. Use `evidence:settle` for any archive or re-settlement operation.
