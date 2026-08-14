// Candidate finding: validate-evidence-bundle.mjs (lines 125-129) skips any
// record with `record.template === true` or a `.template.json` filename BEFORE
// recordKind/gate classification, with no check that the record is actually a
// template. A completed gate manifest or lane record that wrongly keeps the
// marker escapes all scoring — no policy binding, mandatory-check, artifact
// hash, or summary verification — with no error. The only backstop
// (gateCount === 0, line 161) self-defeats as soon as any other gate manifest
// exists, so a wrongly-marked record next to a healthy one is silently dropped
// from the evidence set while the validator reports success.
//
// North-star contract: docs/testing/evidence-and-validation.md — a completed
// manifest must bind the gate, policy hash, threshold, measured values,
// artifact SHA-256, and derived result, and validate-evidence-bundle.mjs is
// the semantic enforcement point bound by gate manifests
// (policy.validatorSha256), designed to "fail loudly" (module header). A
// completed record carrying the template marker is an authoring defect that
// must be surfaced as an error, not silently excluded from scoring: the marker
// is self-asserted, and a record with `template: true` that is otherwise a
// real gate manifest claims no event only by accident of the flag.
//
// Correct behavior: feeding the bundle validator a completed gate record that
// wrongly keeps the template marker must produce an error naming that record.
// Today it is skipped with no error.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { validateEvidenceBundle } from "../../scripts/validation/validate-evidence-bundle.mjs";

const root = resolve(import.meta.dirname, "../..");
const EVIDENCE_DIR = resolve(root, "docs/evidence");
const FLAG_NAME = "zzz-deferred-10-adversarial.json";
const SUFFIX_NAME = "zzz-deferred-10-adversarial.template.json";

async function withTempRecord(name: string, mutate: (record: Record<string, unknown>) => void) {
  // The real completed PG-03 gate manifest is the source for a completed record.
  const source = JSON.parse(await readFile(resolve(EVIDENCE_DIR, "oci-subject-local.json"), "utf8"));
  const copy = structuredClone(source);
  mutate(copy);
  const path = resolve(EVIDENCE_DIR, name);
  try {
    await writeFile(path, JSON.stringify(copy));
    return await validateEvidenceBundle();
  } finally {
    await rm(path, { force: true });
  }
}

test("a completed gate record wrongly keeping template:true must error, not be silently skipped", async () => {
  const { errors, gateCount } = await withTempRecord(FLAG_NAME, (record) => {
    record.template = true;
  });
  const relevant = errors.filter((error) => error.includes(FLAG_NAME));
  assert.ok(
    relevant.length > 0,
    `completed gate record with template:true must be flagged; gateCount=${gateCount}, errors=${JSON.stringify(errors)}`
  );
});

test("a completed gate record wrongly using a .template.json filename must error, not be silently skipped", async () => {
  const { errors } = await withTempRecord(SUFFIX_NAME, () => {});
  const relevant = errors.filter((error) => error.includes(SUFFIX_NAME));
  assert.ok(
    relevant.length > 0,
    `completed gate record with a .template.json filename must be flagged; errors=${JSON.stringify(errors)}`
  );
});
