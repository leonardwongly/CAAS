import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { validateManifest } from "../scripts/validation/validate-offline.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);

async function jsonFixture() {
  return JSON.parse(await readFile(new URL("fixtures/evidence-manifest.json", new URL("./", import.meta.url)), "utf8"));
}

test("validates policy safety defaults, evidence structure, typed measurements, and artifact binding", async () => {
  const policy = parseYaml(await readFile(new URL("deploy/poc-policy.yaml", root), "utf8"));
  assert.equal(policy.execution.cloudWrites.default, "disabled");
  assert.deepEqual(policy.execution.cloudWrites.prohibitedByDefault, ["azure-login", "provider-registration", "resource-creation", "deployment", "workflow-dispatch"]);
  assert.equal(policy.execution.bootstrap.externalIngress, "disabled");
  assert.equal(policy.execution.exactSubject.required, true);
  assert.equal(policy.schema.evidenceManifest, "deploy/evidence-manifest.schema.json");
  assert.equal(policy.checks["PG-01"].mandatory[1].id, "PG01-OFFLINE-STATIC");

  const manifest = await jsonFixture();
  assert.deepEqual(await validateManifest(manifest), []);
  const unknown = structuredClone(manifest);
  unknown.untrustedField = true;
  assert.ok((await validateManifest(unknown)).some((error) => error.includes("unknown field")));
  const tampered = structuredClone(manifest);
  tampered.checks[0].endedAt = "2026-08-11T23:59:59.000Z";
  assert.ok((await validateManifest(tampered)).some((error) => error.includes("reversed")));
  const drifted = structuredClone(manifest);
  drifted.checks[0].measurement.value = false;
  assert.ok((await validateManifest(drifted)).some((error) => error.includes("caller result drift")));
  const openIssue = structuredClone(manifest);
  openIssue.blockingIssues = [{ id: "fixture-p1", priority: "P1", status: "open" }];
  assert.ok((await validateManifest(openIssue)).some((error) => error.includes("gate result drift")));
});

test("offline validator rejects legacy resources and succeeds without network access", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/validation/validate-offline.mjs"], { cwd: new URL("../", import.meta.url).pathname });
  assert.match(result.stdout, /Offline policy/);
  assert.equal(result.stderr, "");
});
