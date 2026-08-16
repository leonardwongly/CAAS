# Airport-name reference governance

## Purpose and authority

Airport display names are product metadata, not CAAS route geometry and not an official ICAO publication. Runtime labels use only the bundled exact-code reference:

- display: `Full Airport Name (ICAO)`;
- fallback: `Name unavailable (ICAO)`;
- join key: exact uppercase four-letter `icao_code` only;
- prohibited joins: `ident`, `gps_code`, `local_code`, IATA code, generated code, fuzzy text, proximity, or runtime third-party lookup.

The source is the community-maintained OurAirports `airports.csv` repository under Public Domain/Unlicense terms. It is useful reference data, not an authority for operational airport identity or suitability.

## Current pinned bundle

| Field | Value |
|---|---|
| Repository | `https://github.com/davidmegginson/ourairports-data` |
| Commit | `be07e33e6cc10087f57064f2bb3fccfcd39f5801` |
| Source URL | `https://raw.githubusercontent.com/davidmegginson/ourairports-data/be07e33e6cc10087f57064f2bb3fccfcd39f5801/airports.csv` |
| License | Public Domain / Unlicense |
| Source SHA-256 | `f23f8924e70a585ceebc03ec4e49beb3aa7743588caf5490c045f1fe53320a71` |
| Normalized bundle SHA-256 | `6bfc0f4d050a0e058e2dda87b2837f0ea9a18d84a7c1a164ccff80619bc98608` |
| Records | 10,444 |
| Generator | `scripts/generate-airport-names.mjs` |
| Runtime files | `apps/api/src/data/airport-names.json`, `apps/api/src/data/manifest.json` |

The manifest records source identity, commit, retrieval time, license, non-official authority statement, selection rule, generator, source checksum, normalized checksum, and count. Runtime imports the normalized JSON only; it performs no network lookup.

## Update procedure

An update is an explicit source change, never an unpinned “latest” refresh.

1. Select and review a full 40-character OurAirports commit. Review the repository license and relevant upstream change history; do not proceed if licensing or redistribution terms are unclear.
2. Download `airports.csv` from the commit-pinned raw URL outside the runtime path. Verify the downloaded bytes are the intended commit artifact and calculate SHA-256.
3. Generate into a temporary directory with an explicit retrieval timestamp:

   ```bash
   node scripts/generate-airport-names.mjs \
     /absolute/path/to/airports.csv \
     /absolute/path/to/output \
     <40-character-commit> \
     <ISO-8601-retrieved-at>
   ```

4. Run the same command again into a second empty directory with the same inputs and timestamp. Both `airport-names.json` and `manifest.json` must be byte-identical.
5. Review the manifest diff: source repository/URL, commit, retrieval time, license, authority disclaimer, source checksum, normalized checksum, and record count. Investigate material count changes rather than accepting them automatically.
6. Review representative additions, removals, and renamed airports. Confirm records remain unique, sorted uppercase four-letter ICAO entries with non-empty NFC names of at most 160 characters.
7. Replace both runtime files together. Never update data without its manifest or hand-edit generated records.
8. Run:

   ```bash
   ./node_modules/.bin/tsc --noEmit -p apps/api/tsconfig.json
   node --test --experimental-strip-types apps/api/test/airport-names.test.ts
   node --test --experimental-strip-types apps/api/test/*.test.ts
   ```

9. Run the relevant API-contract, UI, accessibility, and build validation before accepting the change. Retain a new subject-bound record if making a new evidence claim; do not rewrite older evidence.

## Acceptance and stop conditions

Reject the update if any of these occur:

- source or normalized checksum cannot be reproduced;
- two deterministic runs differ;
- schema version is unsupported;
- duplicate/invalid ICAO entries or invalid names appear;
- source, commit, license, authority disclaimer, or selection rule is missing;
- a non-ICAO column affects selection;
- runtime code gains a third-party lookup, fuzzy/proximity join, or generated-code fallback;
- required tests, typechecks, or build checks fail.

A missing exact name is not repaired heuristically. The safe result is `Name unavailable (ICAO)`.

## Rollback procedure

The bundle and manifest are one atomic versioned unit. To roll back:

1. Identify the last known-good subject and restore both `airport-names.json` and `manifest.json` from that same revision. Do not mix data from one version with another manifest.
2. Recalculate the restored bundle SHA-256 and confirm it equals the restored manifest's `recordsSha256`; confirm the record count and runtime schema validation.
3. Re-run the airport governance test, API typecheck, API tests, relevant UI tests, and build.
4. Record why the update was rejected or reverted. Preserve the rejected subject's evidence and review history; do not edit historical records to look as if they tested the restored bundle.
5. If no known-good pair is available, keep the release blocked. Do not fetch names at runtime or fall back to fuzzy/generated joins.

Rollback affects only bundled display metadata. CAAS generations are reacquired normally and are not rolled back as snapshots.
