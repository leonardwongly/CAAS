// Template records (explicit `template: true` or a `.template.json` filename)
// declare the shape of a future evidence artifact and must be classified as
// pending templates, never structurally scored. Real records stay strict.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { validateEvidenceBundle } from "../../scripts/validation/validate-evidence-bundle.mjs";

const root = resolve(import.meta.dirname, "../..");
const TEMPLATE_FILE = "azure-poc-teardown-evidence.template.json";

test("the WS5 teardown template is marked template: true", async () => {
  const record = JSON.parse(await readFile(resolve(root, "docs/evidence", TEMPLATE_FILE), "utf8"));
  assert.equal(record.template, true, "template records must carry the explicit template: true marker");
  assert.equal(record.gateResult, "blocked", "a template claims no event and stays blocked by design");
});

test("the evidence bundle validator classifies template records as skipped, not failed", async () => {
  const { errors, templateCount } = await validateEvidenceBundle();
  const templateErrors = errors.filter((error) => error.includes(TEMPLATE_FILE));
  assert.equal(templateErrors.length, 0, `template record must not produce structural errors: ${templateErrors.join("; ")}`);
  assert.ok(templateCount >= 1, "the teardown template must be counted as a template record");
});

test("a completed record must not carry the template marker", async () => {
  const { errors } = await validateEvidenceBundle();
  // Real lane/measurement records are never templates; the validator scores them
  // strictly and must not have skipped them as templates.
  for (const error of errors) {
    assert.ok(!/template: true|\.template\.json/.test(error), `unexpected template classification: ${error}`);
  }
});
