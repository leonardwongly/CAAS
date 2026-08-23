// Owner: D5 — contracts & evidence/policy pipeline (adversarial sweep 2026-08-23).
//
// Attacks the evidence/policy pipeline in scripts/validation:
//   1. Evidence-writer path containment and races: writeJsonRecord must never
//      write outside the repository root (regression for the traversal/absolute
//      write-what-where fixed in lib-evidence.mjs) and must stay atomic across
//      PROCESSES (sec-r4-1 pins same-process writers).
//   2. Settlement traversal: archiveRecordByteForByte and the --recover path
//      must refuse non-flat record names (regression for the containment guard
//      added to settle-evidence.mjs).
//   3. Lane-record state corruption: malformed manifests (duplicate checkIds,
//      invalid subjects, inconsistent summaries, reversed check timestamps,
//      zero samples, non-object checks, torn JSON) must all fail loudly.
//   4. Schema drift between the three sources of truth: poc-policy.yaml,
//      validate-offline.mjs enforcement, and evidence-manifest.schema.json.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CheckCollector, root, sha256Hex, writeJsonRecord } from "../../scripts/validation/lib-evidence.mjs";
import { archiveRecordByteForByte } from "../../scripts/validation/settle-evidence.mjs";
import { validateEvidenceBundle } from "../../scripts/validation/validate-evidence-bundle.mjs";
import { validateManifest } from "../../scripts/validation/validate-offline.mjs";

const execFileAsync = promisify(execFile);
const evidenceDir = resolve(root, "docs/evidence");

// ---------------------------------------------------------------------------
// 1. Evidence writer: path containment + cross-process atomicity
// ---------------------------------------------------------------------------

test("writeJsonRecord refuses parent traversal before any write (containment regression)", async () => {
  // The writer takes caller-controlled path strings; the traversal class must
  // never resolve a record outside the directory the caller named. Absolute
  // paths remain admitted by design (lane probes pass --record-dir=<tmpdir>).
  for (const path of ["../tmp/sweep-d5-escape.json", "../../escape.json", "tmp/../../escape.json", "..", ""]) {
    await assert.rejects(() => writeJsonRecord(path, { evil: true }), /refuses/, `path ${JSON.stringify(path)} must be refused`);
  }
  // Nothing may have been materialized at the escape targets.
  await assert.rejects(() => readFile(resolve(root, "../tmp/sweep-d5-escape.json")), /ENOENT/);
  await assert.rejects(() => readFile(resolve(root, "../escape.json")), /ENOENT/);
  // Control: a plain relative path still writes, and the returned hash attests
  // exactly the serialized bytes now present at the path.
  const record = { probe: "sweep-d5", value: 1 };
  const hash = await writeJsonRecord("tmp/sweep-d5-writer/record.json", record);
  const bytes = await readFile(resolve(root, "tmp/sweep-d5-writer/record.json"), "utf8");
  assert.equal(hash, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(hash, sha256Hex(`${JSON.stringify(record, null, 2)}\n`));
  await rm(resolve(root, "tmp/sweep-d5-writer"), { recursive: true, force: true });
  // Control: an absolute caller-owned isolation directory (the --record-dir
  // lane pattern) remains writable — only traversal components are refused.
  const isolationDir = await mkdtemp(join(tmpdir(), "sweep-d5-isolated-"));
  try {
    const isolationHash = await writeJsonRecord(join(isolationDir, "record.json"), { probe: "isolated" });
    assert.equal(isolationHash, sha256Hex(`${JSON.stringify({ probe: "isolated" }, null, 2)}\n`));
  } finally {
    await rm(isolationDir, { recursive: true, force: true });
  }
});

test("concurrent cross-process writers never tear the final record and leave no temp files", async () => {
  const dir = resolve(root, "tmp/sweep-d5-race");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    const writers = Array.from({ length: 8 }, (_, writer) => {
      const code = `
        const { writeJsonRecord } = await import(${JSON.stringify(resolve(root, "scripts/validation/lib-evidence.mjs"))});
        await writeJsonRecord("tmp/sweep-d5-race/record.json", { writer: ${writer}, payload: Array.from({ length: 300 }, (_, i) => i) });
      `;
      return execFileAsync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, timeout: 30_000 });
    });
    await Promise.all(writers);
    const parsed = JSON.parse(await readFile(resolve(dir, "record.json"), "utf8")) as { writer: number; payload: number[] };
    assert.ok(Number.isInteger(parsed.writer) && parsed.writer >= 0 && parsed.writer < 8, "the surviving record must be one complete writer's record");
    assert.equal(parsed.payload.length, 300, "the final record must be one complete serialization, never a torn mix");
    assert.deepEqual(parsed.payload.slice(0, 3), [0, 1, 2]);
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no temp files may remain after the race");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Settlement traversal containment
// ---------------------------------------------------------------------------

test("archiveRecordByteForByte refuses traversal, absolute, and hidden names (containment regression)", async () => {
  const hash = "0".repeat(64);
  for (const name of ["../README.md", "../../README.md", "../poc-policy.yaml", "/etc/passwd", "archived/../x.json", ".hidden.json", ""]) {
    await assert.rejects(() => archiveRecordByteForByte(name, hash), /non-flat|outside the evidence/, `name ${JSON.stringify(name)} must be refused`);
  }
  // Control: a flat-but-missing name reaches ordinary processing (ENOENT), not
  // the containment guard — flat names are still accepted.
  await assert.rejects(() => archiveRecordByteForByte("sweep-d5-does-not-exist.json", hash), /ENOENT/);
});

test("the settlement --recover CLI refuses a plan carrying traversal candidate names", async () => {
  const planPath = resolve(root, "tmp/sweep-d5-settle-plan.json");
  await writeFile(planPath, `${JSON.stringify({
    schemaVersion: 1,
    planKind: "evidence-settlement-v1",
    subject: "deadbeef0000",
    review: { status: "approved", reviewedBy: "sweep-d5" },
    rules: { preserveHistoricalBytes: true },
    candidates: [{ name: "../../deploy/poc-policy.yaml", sourceSha256: "0".repeat(64), byteLength: 1, reasons: ["probe"] }],
  }, null, 2)}\n`, "utf8");
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, ["scripts/validation/settle-evidence.mjs", "--apply", "--recover", "--plan-file", "tmp/sweep-d5-settle-plan.json", "--approve"], { cwd: root, timeout: 30_000 }),
      (error: { stderr?: string }) => /non-flat evidence record name/.test(error.stderr ?? ""),
      "recovery must refuse traversal candidate names before reading any file",
    );
  } finally {
    await rm(planPath, { force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Lane-record state corruption
// ---------------------------------------------------------------------------

function probeLaneRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    recordKind: "lane-results",
    lane: "sweep-d5-corruption-probe",
    mode: "probe",
    credentialHandling: "probe",
    subject: { type: "commit", identifiers: { commit: "0".repeat(40) }, environment: "probe" },
    startedAt: "2026-08-23T00:00:00.000Z",
    endedAt: "2026-08-23T00:00:01.000Z",
    checks: [{
      checkId: "SWEEP-D5-PROBE",
      name: "probe",
      procedure: "probe",
      startedAt: "2026-08-23T00:00:00.000Z",
      endedAt: "2026-08-23T00:00:00.500Z",
      result: "pass",
      measurement: { summary: "probe", value: true, units: "boolean", sampleCount: 1 },
      artifacts: [{ path: "deploy/poc-policy.yaml", sha256: "raw-hash-placeholder" }],
      failureFallback: "probe",
    }],
    summary: { checks: 1, passed: 1, failed: 0, blocked: 0 },
    artifacts: [],
  };
  return { ...base, ...overrides };
}

// Writes a probe record under a unique name, runs the bundle validator, and
// returns only the errors naming that file (parallel agents write their own
// temp records into docs/evidence; filtering keeps the assertions isolated).
async function errorsForProbe(name: string, record: unknown): Promise<string[]> {
  const path = resolve(evidenceDir, name);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  try {
    const { errors } = await validateEvidenceBundle();
    return errors.filter((error) => error.includes(name));
  } finally {
    await unlink(path);
  }
}

// A real artifact binding (the policy file itself, hashed live) for probes
// where the check under attack is not the artifact.
const policyArtifact = async () => ({
  path: "deploy/poc-policy.yaml",
  sha256: createHash("sha256").update(await readFile(resolve(root, "deploy/poc-policy.yaml"))).digest("hex"),
});

test("a lane record with a duplicate checkId fails loudly", async () => {
  const record = probeLaneRecord();
  const check = { ...(record.checks as Array<Record<string, unknown>>)[0]!, artifacts: [await policyArtifact()] };
  record.checks = [check, check];
  record.summary = { checks: 2, passed: 2, failed: 0, blocked: 0 };
  const errors = await errorsForProbe("zzz-sweep-d5-dup-check.json", record);
  assert.ok(errors.some((error) => error.includes("duplicate checkId")), `duplicate lane checkIds must be rejected: ${errors.join("; ")}`);
});

test("lane records with invalid subjects fail loudly", async () => {
  const badType = probeLaneRecord({ subject: { type: "satellite", identifiers: { commit: "0".repeat(40) }, environment: "probe" } });
  assert.ok((await errorsForProbe("zzz-sweep-d5-bad-subject.json", badType)).some((e) => e.includes("subject type invalid")));
  const noEnv = probeLaneRecord({ subject: { type: "commit", identifiers: { commit: "0".repeat(40) } } });
  assert.ok((await errorsForProbe("zzz-sweep-d5-no-env.json", noEnv)).some((e) => e.includes("environment missing")));
  const noCommit = probeLaneRecord({ subject: { type: "commit", identifiers: {}, environment: "probe" } });
  assert.ok((await errorsForProbe("zzz-sweep-d5-no-commit.json", noCommit)).some((e) => e.includes("commit missing")));
});

test("a lane record whose summary contradicts its check list fails loudly", async () => {
  const record = probeLaneRecord({ summary: { checks: 5, passed: 1, failed: 0, blocked: 0 } });
  const errors = await errorsForProbe("zzz-sweep-d5-bad-summary.json", record);
  assert.ok(errors.some((error) => error.includes("summary inconsistent")), `inconsistent summaries must be rejected: ${errors.join("; ")}`);
});

test("lane checks with reversed timestamps or zero samples fail loudly", async () => {
  const artifact = await policyArtifact();
  const reversed = probeLaneRecord();
  (reversed.checks as Array<Record<string, unknown>>)[0] = {
    ...(reversed.checks as Array<Record<string, unknown>>)[0]!,
    artifacts: [artifact],
    startedAt: "2026-08-23T00:00:05.000Z",
    endedAt: "2026-08-23T00:00:00.000Z",
  };
  assert.ok((await errorsForProbe("zzz-sweep-d5-reversed.json", reversed)).some((e) => e.includes("timestamps invalid or reversed")));
  const zeroSamples = probeLaneRecord();
  const check: Record<string, unknown> = { ...(zeroSamples.checks as Array<Record<string, unknown>>)[0]!, artifacts: [artifact] };
  check.measurement = { summary: "probe", value: true, units: "boolean", sampleCount: 0 };
  zeroSamples.checks = [check];
  assert.ok((await errorsForProbe("zzz-sweep-d5-zero-samples.json", zeroSamples)).some((e) => e.includes("measurement invalid")));
});

test("a lane record with a non-object check fails loudly without aborting the scan", async () => {
  const record = probeLaneRecord({ checks: ["not-an-object"], summary: { checks: 1, passed: 1, failed: 0, blocked: 0 } });
  const errors = await errorsForProbe("zzz-sweep-d5-non-object-check.json", record);
  assert.ok(errors.some((error) => error.includes("check must be an object")), `non-object checks must be rejected: ${errors.join("; ")}`);
});

test("a torn half-written evidence record is reported under its own name while the scan completes", async () => {
  const name = "zzz-sweep-d5-torn.json";
  const path = resolve(evidenceDir, name);
  await writeFile(path, '{"recordKind": "lane-results", "lane": "torn', "utf8");
  try {
    const { errors, gateCount } = await validateEvidenceBundle();
    assert.ok(errors.some((error) => error.includes(name) && error.includes("not readable JSON")), `torn records must be reported: ${errors.filter((e) => e.includes(name)).join("; ")}`);
    assert.ok(gateCount >= 1, "the scan must still score the remaining records");
  } finally {
    await unlink(path);
  }
});

test("oci-digest-bundle records with malformed digests, commits, or source hashes fail loudly", async () => {
  const bundle = (overrides: Record<string, unknown>) => ({
    recordKind: "oci-digest-bundle",
    image: { digest: "sha256:" + "a".repeat(64) },
    subject: { type: "oci", identifiers: { commit: "0".repeat(40) }, environment: "ci-build" },
    sourceHashes: { "containers/Dockerfile": "b".repeat(64) },
    ...overrides,
  });
  assert.ok((await errorsForProbe("zzz-sweep-d5-bundle-digest.json", bundle({ image: { digest: "sha256:zzz" } }))).some((e) => e.includes("image digest invalid")));
  assert.ok((await errorsForProbe("zzz-sweep-d5-bundle-commit.json", bundle({ subject: { type: "oci", identifiers: { commit: "NOT-A-SHA" }, environment: "ci-build" } }))).some((e) => e.includes("subject commit invalid")));
  assert.ok((await errorsForProbe("zzz-sweep-d5-bundle-hashes.json", bundle({ sourceHashes: ["not", "a", "map"] }))).some((e) => e.includes("sourceHashes")));
});

// ---------------------------------------------------------------------------
// 4. Three-source-of-truth drift: policy yaml x validator x JSON schema
// ---------------------------------------------------------------------------

test("every operator the evidence schema allows is accepted by the offline validator, and foreign operators are not", async () => {
  const schema = JSON.parse(await readFile(resolve(root, "deploy/evidence-manifest.schema.json"), "utf8")) as {
    properties: { checks: { items: { properties: { threshold: { properties: { operator: { enum: string[] } } } } } } };
  };
  const fixture = JSON.parse(await readFile(resolve(root, "tests/fixtures/evidence-manifest.json"), "utf8")) as { checks: Array<Record<string, unknown>> };
  const allowed = schema.properties.checks.items.properties.threshold.properties.operator.enum;
  assert.ok(allowed.length >= 7, "the schema must enumerate the operator vocabulary");
  for (const operator of allowed) {
    const manifest = structuredClone(fixture);
    manifest.checks[0]!.threshold = { ...(manifest.checks[0]!.threshold as Record<string, unknown>), operator };
    const errors = await validateManifest(manifest, root);
    assert.ok(!errors.some((error) => error.includes("threshold is invalid")), `schema-allowed operator ${operator} must be accepted by the validator: ${errors.join("; ")}`);
  }
  const manifest = structuredClone(fixture);
  manifest.checks[0]!.threshold = { ...(manifest.checks[0]!.threshold as Record<string, unknown>), operator: "regex-match" };
  assert.ok((await validateManifest(manifest, root)).some((error) => error.includes("threshold is invalid")), "operators outside the schema enum must be rejected");
});

test("every gateId the evidence schema pattern allows is accepted by the offline validator, and foreign gate ids are not", async () => {
  const schema = JSON.parse(await readFile(resolve(root, "deploy/evidence-manifest.schema.json"), "utf8")) as { properties: { gateId: { pattern: string } } };
  const ids = ["PG-00", "PG-01", "PG-02", "PG-03", "PG-04", "PG-05", "PG-PROD", "PG-LIFE"];
  for (const gateId of ids) {
    assert.ok(new RegExp(`^${schema.properties.gateId.pattern.slice(1, -1)}$`).test(gateId), `schema pattern must admit ${gateId}`);
    const manifest = JSON.parse(await readFile(resolve(root, "tests/fixtures/evidence-manifest.json"), "utf8")) as Record<string, unknown>;
    manifest.gateId = gateId;
    const errors = await validateManifest(manifest, root);
    assert.ok(!errors.some((error) => error.includes("gateId is invalid")), `schema-admitted gateId ${gateId} must be accepted: ${errors.join("; ")}`);
  }
  for (const gateId of ["PG-99", "pg-01", "PG-001", "PG-"]) {
    const manifest = JSON.parse(await readFile(resolve(root, "tests/fixtures/evidence-manifest.json"), "utf8")) as Record<string, unknown>;
    manifest.gateId = gateId;
    assert.ok((await validateManifest(manifest, root)).some((error) => error.includes("gateId is invalid")), `gateId ${gateId} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// 5. CheckCollector fail-closed contract
// ---------------------------------------------------------------------------

test("CheckCollector.pass with a falsy predicate is a failure, never a silent pass", () => {
  // The documented fail-closed contract (lib-evidence.mjs): a false predicate
  // must record a fail, keeping exitCode() non-zero for the lane.
  for (const falsy of [0, "", false, null, undefined]) {
    const collector = new CheckCollector();
    collector.pass("X1", "falsy predicate", "procedure", "start", "end", falsy, "boolean");
    assert.equal(collector.summary().failed, 1, `pass(${String(falsy)}) must record a failure`);
    assert.equal(collector.summary().passed, 0);
    assert.equal(collector.exitCode(), 1, "a falsy predicate must keep the lane exit code non-zero");
  }
  const clean = new CheckCollector();
  clean.pass("X2", "truthy predicate", "procedure", "start", "end", true, "boolean");
  assert.equal(clean.summary().passed, 1);
  assert.equal(clean.exitCode(), 0);
});
