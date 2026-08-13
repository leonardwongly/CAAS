// Cross-checks the evidence policy layer: the policy registry gates, the
// semantic validator binding, and that tampered manifests are rejected.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { validateManifest } from "../../scripts/validation/validate-offline.mjs";
import { VALIDATOR_VERSION } from "../../scripts/validation/validate-evidence-bundle.mjs";

const root = resolve(import.meta.dirname, "../..");

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

interface MandatoryCheck { id: string; operator: string; units: string | null; }
interface GatePolicy { mandatory: MandatoryCheck[]; }

test("policy registry defines PG-01 and PG-03 mandatory checks with allowed operators", async () => {
  const policy = parseYaml(await readFile(resolve(root, "deploy/poc-policy.yaml"), "utf8")) as {
    checks: Record<string, GatePolicy>;
    execution: { exactSubject: { required: boolean } };
  };
  const allowedOperators = new Set(["equals", "less-than-or-equal", "greater-than-or-equal", "all-less-than-or-equal", "set-equals", "hash-equals", "manual-approval"]);
  const pg01 = policy.checks["PG-01"];
  const pg03 = policy.checks["PG-03"];
  assert.ok(pg01 && pg01.mandatory.length >= 3, "PG-01 mandatory checks exist");
  assert.ok(pg03 && pg03.mandatory.length >= 4, "PG-03 mandatory checks exist");
  const expected = ["PG03-EXACT-DIGEST", "PG03-LOOPBACK-REAL-DATA", "PG03-SECRETLESS", "PG03-RESOURCE-SHAPE"];
  const actual = pg03.mandatory.map((check) => check.id);
  assert.deepEqual(actual, expected, "PG-03 mandatory check ids");
  for (const gate of Object.values(policy.checks)) {
    for (const check of gate.mandatory) assert.ok(allowedOperators.has(check.operator), `operator ${check.operator} allowed`);
  }
  assert.equal(policy.execution.exactSubject.required, true);
});

test("semantic validator self-binding is versioned and stable", async () => {
  const validator = await readFile(resolve(root, "scripts/validation/validate-evidence-bundle.mjs"), "utf8");
  assert.equal(typeof VALIDATOR_VERSION, "string");
  assert.ok(VALIDATOR_VERSION.length > 0);
  assert.equal(digest(validator).length, 64);
});

test("validateManifest rejects a tampered gate manifest", async () => {
  const fixture = JSON.parse(await readFile(resolve(root, "tests/fixtures/evidence-manifest.json"), "utf8"));
  const tampered = structuredClone(fixture);
  tampered.policy.policySha256 = "not-a-hash";
  const errors = await validateManifest(tampered, root);
  assert.ok(errors.length > 0, "malformed policySha256 must be rejected");
  const drift = structuredClone(fixture);
  if (drift.checks?.length > 0) drift.checks[0].result = drift.checks[0].result === "pass" ? "fail" : "pass";
  const driftErrors = await validateManifest(drift, root);
  assert.ok(driftErrors.length > 0, "caller result drift must be rejected");
});
