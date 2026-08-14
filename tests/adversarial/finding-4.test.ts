// Adversarial regression test: expired exceptions must be rejected.
// North-star contract:
//   - deploy/poc-policy.yaml lists "reject-expired-exceptions" among the
//     semantic validator rejection rules.
//   - docs/testing/evidence-and-validation.md: "A command exit status cannot
//     override missing measurements, missing artifact hashes, policy mismatch,
//     expired exceptions, or manual authorization/UAT."
// validateManifest only validates exception *shape* (Date.parse(expiresAt)
// must be finite) and never compares expiresAt to the current time, so a pass
// gate carrying an expired exception (gateBlocking: false) is currently
// accepted with zero errors.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { validateManifest } from "../../scripts/validation/validate-offline.mjs";

const root = resolve(import.meta.dirname, "../..");

type Manifest = { checks: Array<Record<string, unknown>>; gateResult: string };

async function passFixture(): Promise<Manifest> {
  const fixture = JSON.parse(
    await readFile(resolve(root, "tests/fixtures/evidence-manifest.json"), "utf8"),
  ) as Manifest;
  return structuredClone(fixture);
}

test("an exception with a past expiresAt must be rejected even when gateBlocking is false", async () => {
  const manifest = await passFixture();
  const check = manifest.checks[0]!;
  check.exception = {
    reason: "temporary deviation",
    expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    gateBlocking: false,
  };
  const errors = await validateManifest(manifest, root);
  assert.ok(
    errors.length > 0,
    "policy rule reject-expired-exceptions: an expired exception must produce an error; " +
      `got zero errors and gateResult '${manifest.gateResult}' was accepted`,
  );
  assert.ok(
    errors.some((error) => error.includes("expir")),
    `the rejection must name the expired exception; got: ${JSON.stringify(errors)}`,
  );
});

test("a non-expired exception is accepted (control: shape validation alone is not the defect)", async () => {
  const manifest = await passFixture();
  const check = manifest.checks[0]!;
  check.exception = {
    reason: "temporary deviation",
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    gateBlocking: false,
  };
  const errors = await validateManifest(manifest, root);
  assert.deepEqual(errors, [], "a valid, unexpired exception must not be rejected");
});
