// Finding (deferred-8): the semantic validator never enforces two rules the
// policy registry declares in deploy/poc-policy.yaml `validator.requiredRules`
// — `reject-unknown-checks` and `derive-check-result` (expected binding):
//
//  1. Unknown check ids pass: validate-evidence-bundle.mjs lines 143-152 bind
//     only the *policy→manifest* direction (every mandatory policy check must
//     be present with matching operator/units). The reverse direction — every
//     manifest check id must exist in the policy registry — is never checked,
//     so a gate manifest can carry a fabricated check id (e.g.
//     PG01-FABRICATED-CHECK) and the validator emits zero errors. Plan §6:
//     "The validator rejects missing, unknown, or duplicate checks."
//
//  2. threshold.expected is never bound: the mandatory-enforcement loop
//     compares only operator and units (line 149), never `expected`. A check
//     like PG03-LOOPBACK-REAL-DATA can declare threshold.expected: false with
//     measurement.value: false and result "pass"; validate-offline.mjs
//     deriveCheck (equals false === false) sees no caller-result drift and the
//     bundle binding sees matching operator/units, so the manifest passes
//     though the policy pins expected: true. Plan §6: the validator "rejects
//     incompatible expected/measured types or units" and "derives each check
//     ... result from policy plus measurements".
//
// Correct behavior: both manifests must be rejected with an error. Currently
// both produce zero errors.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { VALIDATOR_VERSION, validateEvidenceBundle } from "../../scripts/validation/validate-evidence-bundle.mjs";

const root = resolve(import.meta.dirname, "../..");
const evidenceDir = resolve(root, "docs/evidence");
const policyPath = resolve(root, "deploy/poc-policy.yaml");
const validatorPath = resolve(root, "scripts/validation/validate-evidence-bundle.mjs");

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Real hash of the policy file, used as the artifact every check carries, so
// validateManifest's artifact-hash verification passes.
const policyArtifactHash = sha256(await readFile(policyPath, "utf8"));

interface PolicyCheck {
  id: string;
  operator: string;
  expected: unknown;
  units: string | null;
}

interface ManifestCheck {
  checkId: string;
  mandatory: boolean;
  procedure: string;
  startedAt: string;
  endedAt: string;
  threshold: { rule: string; operator: string; expected: unknown; units?: string | undefined };
  measurement: { summary: string; value: unknown; units?: string | undefined; sampleCount: number };
  artifacts: Array<{ path: string; sha256: string }>;
  result: "pass" | "fail" | "blocked";
  failureFallback: string;
}

async function loadPolicyChecks(gateId: string): Promise<PolicyCheck[]> {
  const policy = parseYaml(await readFile(policyPath, "utf8")) as { checks: Record<string, { mandatory: PolicyCheck[] }> };
  return (policy.checks[gateId]?.mandatory ?? []).map((c) => ({
    id: c.id,
    operator: c.operator,
    expected: c.expected,
    units: c.units ?? null,
  }));
}

// Each check carries one real artifact (the policy file itself, hashed live)
// so the manifest passes validateManifest's artifact-hash verification and any
// failure observed is attributable to the injected drift, not the harness.
function makeCheck(required: PolicyCheck, overrides: Partial<ManifestCheck> = {}): ManifestCheck {
  const base: ManifestCheck = {
    checkId: required.id,
    mandatory: true,
    procedure: `procedure for ${required.id}`,
    startedAt: "2026-08-12T00:00:00.000Z",
    endedAt: "2026-08-12T00:01:00.000Z",
    threshold: {
      rule: `rule for ${required.id}`,
      operator: required.operator,
      expected: required.expected,
      units: required.units ?? undefined,
    },
    measurement: {
      summary: `measurement for ${required.id}`,
      value: required.expected,
      units: required.units ?? undefined,
      sampleCount: 1,
    },
    artifacts: [{ path: "deploy/poc-policy.yaml", sha256: policyArtifactHash }],
    result: "pass",
    failureFallback: `fallback for ${required.id}`,
  };
  return { ...base, ...overrides };
}

async function runWithManifest(gateId: string, filename: string, checks: ManifestCheck[]): Promise<string[]> {
  const [policyText, validatorText] = await Promise.all([readFile(policyPath, "utf8"), readFile(validatorPath, "utf8")]);
  const manifest = {
    schemaVersion: 1,
    gateId,
    policy: {
      policyVersion: "1.0.0-poc",
      policySha256: sha256(policyText),
      validatorVersion: VALIDATOR_VERSION,
      validatorSha256: sha256(validatorText),
      evaluationMode: "semantic-validator",
    },
    subject: {
      type: "documents",
      identifiers: { fixture: "deferred-8-adversarial" },
      environment: "offline-test",
    },
    checks,
    blockingIssues: [],
    gateResult: "pass",
    failureFallback: "block later gates",
  };
  const filePath = resolve(evidenceDir, filename);
  try {
    await writeFile(filePath, JSON.stringify(manifest, null, 2));
    const { errors } = await validateEvidenceBundle();
    return errors.filter((error) => error.includes(filename));
  } finally {
    await rm(filePath, { force: true });
  }
}

const TEMP_FILES = ["deferred-8-unknown-check.json", "deferred-8-expected-drift.json", "deferred-8-control.json"];
test.after(async () => {
  for (const name of TEMP_FILES) await rm(resolve(evidenceDir, name), { force: true });
});

test("control: a gate manifest with exactly the registry checks passes with zero errors", async () => {
  const pg01 = await loadPolicyChecks("PG-01");
  const checks = pg01.map((required) => makeCheck(required));
  const errors = await runWithManifest("PG-01", "deferred-8-control.json", checks);
  assert.deepEqual(errors, [], `clean manifest must not error: ${errors.join("; ")}`);
});

test("an unknown check id absent from the policy registry is rejected (reject-unknown-checks)", async () => {
  const pg01 = await loadPolicyChecks("PG-01");
  const checks = pg01.map((required) => makeCheck(required));
  checks.push(makeCheck(
    { id: "PG01-FABRICATED-CHECK", operator: "equals", expected: true, units: "boolean" },
  ));
  const errors = await runWithManifest("PG-01", "deferred-8-unknown-check.json", checks);
  assert.ok(
    errors.some((error) => error.includes("PG01-FABRICATED-CHECK")),
    `fabricated check id must be rejected as unknown; got errors: ${errors.join("; ")}`,
  );
});

test("a mandatory check whose threshold.expected drifts from the policy's expected is rejected", async () => {
  const pg03 = await loadPolicyChecks("PG-03");
  const checks = pg03.map((required) =>
    required.id === "PG03-LOOPBACK-REAL-DATA"
      ? makeCheck(required, {
          threshold: { rule: "loopback real-data", operator: "equals", expected: false, units: "boolean" },
          measurement: { summary: "loopback real-data", value: false, units: "boolean", sampleCount: 1 },
          result: "pass",
        })
      : makeCheck(required),
  );
  const errors = await runWithManifest("PG-03", "deferred-8-expected-drift.json", checks);
  assert.ok(
    errors.some((error) => error.includes("PG03-LOOPBACK-REAL-DATA")),
    `expected drift (policy pins expected: true; manifest declares false) must be rejected; got errors: ${errors.join("; ")}`,
  );
});
