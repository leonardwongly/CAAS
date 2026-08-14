# Upstream-bounds evidence suite (issue #30)

Deterministic tests proving the **currently implemented** bounded behavior of
the upstream adapter (`packages/upstream-caas`) and the API generation
lifecycle (`apps/api`) — the technical proof that "crossing a hard limit fails
closed with a bounded error and never silently truncates required results"
(plan §6). No runtime code is changed by this suite; where the plan/design
require behavior the code does not implement, the test **documents the actual
behavior as a gap** and marks it for issue #35 (runtime policy workstream).

## Run

From the repository root (pnpm workspace):

```sh
pnpm --filter tests test:upstream-bounds
```

or directly:

```sh
pnpm --filter tests exec node --test --experimental-strip-types upstream-bounds/*.test.ts
```

All tests use sanitized fixtures (`tests/fixtures/sanitized-caas.ts`), stubbed
transports, and mocked clocks — no network, no credentials, no live CAAS data.

## Proved behavior (executed evidence)

| File | Proves |
|---|---|
| `retry-backoff.test.ts` | One retry for 429/retryable 5xx, honoring `Retry-After` (seconds and HTTP-date) capped at `MAX_RETRY_AFTER_MS` (5 s); invalid `Retry-After` = 0 backoff; no retry for other 4xx; `RETRY_EXHAUSTED` after exactly 2 attempts and 1 backoff; cancellation during backoff (`CANCELLED`, 1 request) and before any attempt (0 requests); success on retry surfaces `evidence.retried: true`; `CaasAdapterError`s pass through unmodified |
| `failure-surfacing.test.ts` | Policy constants match plan §6.1 (per-family `maxBytes`/`maxRecords`, aggregate 700,000); fixed GET/redirect-forbidden/apikey header/lowercased response headers; `RESPONSE_TOO_LARGE` from content-length and from streamed bytes; invalid UTF-8 -> `POLICY_REJECTED`; `TIMEOUT` at 5 s connect and 30 s total deadlines; no retroactive abort of completed requests; media-type mismatch in both directions; `RECORD_LIMIT` at per-family and aggregate bounds; rejected records counted in `evidence` (`rejectedRecords`), never silently dropped |
| `generation-lifecycle.test.ts` | 30-minute TTL -> `GENERATION_STALE` 503 when expired; failed refresh keeps the prior generation serving (503 `REFRESH_FAILED`, retryable, readiness stays `ready`); refresh success swaps the generation atomically; generations never persist across store instances; draft tokens bind their generation (410 `DRAFT_EXPIRED` after refresh or across instances); draft capacity 512 -> 513th is 429 `DRAFT_CAPACITY_REACHED`; acquisition fails closed beyond 700,000 aggregate points (store status `failed`, readiness `UPSTREAM_UNAVAILABLE`); cold-start failure -> 503 `UPSTREAM_UNAVAILABLE`, never partial data; cursor tokens bind `{g, t, e, n, o, q, l}` |
| `pagination.test.ts` | Browse/search walks return every record exactly once at every limit tested (1, 2, 3, 4, 5, 7, 11, 12, 100 over 12 records); non-terminal pages exactly `limit` items; terminal page **omits** `nextCursor` (absent, never null); cursors bind limit and query (reuse with a different limit/query -> 409 `CURSOR_EXPIRED`); cursors from a dropped generation fail closed with 409 after refresh — never drifting into new data; generation id stable within a walk, different after refresh |

## ACTUAL behavior vs plan/design — documented gaps (not fixed here)

These were issue-#30 observations of the code as of the pre-integration tree.
The runtime-policies workstream (issue #35) has since implemented most of them
on the merged tree; each item below records its current status.

1. **Active + previous generation retention — IMPLEMENTED (issue #35).** The
   store now retains the active plus immediately previous generation
   (`GenerationStore.previousSnapshot`, pruned once unusable); tokens remain
   generation-scoped, so prior-generation cursors/drafts still fail closed on
   refresh. Proved in `generation-lifecycle.test.ts` ("a successful refresh
   invalidates prior-generation cursors while retaining the previous snapshot").
2. **Tiered freshness windows — IMPLEMENTED (issue #35).** Plan §6.2 tiers are
   pinned in `packages/upstream-caas/src/freshness.ts` (live fresh ≤ 5 min,
   unusable after 30 min; reference 24 h/7 d) with fail-closed unusable states.
   Proved in `generation-lifecycle.test.ts` (live unusable-boundary test) and
   `tests/runtime-policies/`.
3. **No application-revision field in tokens — REMAINS.** Design §0.2 says
   tokens bind to "application revision and generation"; the token body is
   `{g, t, e, n, ...}` with no revision identifier. Binding to a fresh
   per-process generation UUID means a restart/redeploy invalidates tokens de
   facto — acceptable for the POC, not the documented mechanism. Proved in
   `generation-lifecycle.test.ts` ("cursors bind the generation id and carry
   no separate application-revision field").
4. **5-second hard server deadline — IMPLEMENTED (issue #35).** Warm requests
   now run under a 5-second server-side deadline (`withWarmDeadline`) and fail
   closed `503 REQUEST_DEADLINE_EXCEEDED`. Proved in
   `tests/runtime-policies/runtime-policies.test.ts`.
5. **Refresh-failure response detail — IMPLEMENTED (issue #35).** The 503
   `REFRESH_FAILED` body now carries `retained.generation` with the prior
   generation's retrieval time and stale state. Proved by the loopback lane
   `LANE-REFRESH-RETAINS` check.
6. **Acquisition causes collapse to `UPSTREAM_UNAVAILABLE` — REMAINS.**
   `acquireSnapshot` computes and throws the precise cause
   (`REFERENCE_RECORD_LIMIT` for the aggregate bound, per-family
   `RECORD_LIMIT`, timeouts), but the store's `catch` re-throws a default
   `GenerationAcquisitionError` whose causeCode is always
   `UPSTREAM_UNAVAILABLE`. The public surface cannot distinguish acquisition
   causes today, so the failure-classification measurements in
   `docs/operations/production-operations.md` §2 (UPSTREAM_UNAVAILABLE vs
   REFERENCE_RECORD_LIMIT vs RECORD_LIMIT vs timeouts) are not yet reachable.
   Proved in `generation-lifecycle.test.ts` ("acquisition fails closed beyond
   700,000 aggregate records; the store collapses the cause").

Each gap is asserted through the *actual* behavior the test proves, so the
suite remains green while the README records the divergence.

## Relationship to other suites

- `tests/upstream-adapter-contract.test.ts` / `tests/api-contract.test.ts`
  (existing) cover the adapter/API contracts; this suite adds the bound- and
  failure-proof layer.
- `scripts/test-offline.mjs` recurses into this directory automatically; no
  script change was needed beyond the `tests/package.json` glob (see the
  `test:upstream-bounds` script there).

Resolved per GitHub issue #30.
