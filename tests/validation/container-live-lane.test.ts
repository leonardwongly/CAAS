// Regression coverage for scripts/validation/container-live-lane.mjs:
// the authorized container lane must fail closed — no credential records a
// PENDING lane without starting a container, and a placeholder credential is
// refused loudly with exit 1 and no upstream request.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

// Test probes run the lane with an isolated --record-dir so they can never
// overwrite committed evidence records in docs/evidence.
function runLane(apikey: string, recordDir: string, recordId: string) {
  return execFileSync(
    "node",
    ["--experimental-strip-types", "scripts/validation/container-live-lane.mjs", `--record-dir=${recordDir}`, `--record-id=${recordId}`],
    { cwd: root, encoding: "utf8", env: { ...process.env, apikey } },
  );
}

async function probeRecord(recordDir: string, recordId: string) {
  return JSON.parse(await readFile(join(recordDir, `container-live-lane-${recordId}.json`), "utf8"));
}

test("container live lane records PENDING and exits 0 when no credential is configured", async () => {
  const recordDir = await mkdtemp(join(tmpdir(), "container-live-pending-"));
  try {
    const output = runLane("", recordDir, "pending-probe");
    assert.match(output, /PENDING record written/u);
    const record = await probeRecord(recordDir, "pending-probe");
    assert.equal(record.mode, "pending-authorized-execution");
    assert.equal(record.summary.failed, 0);
    assert.equal(record.summary.blocked, 5);
    assert.equal(record.summary.passed, 1);
    assert.equal(record.subject.type, "oci");
  } finally {
    await rm(recordDir, { recursive: true, force: true });
  }
});

test("container live lane refuses a placeholder credential with exit 1 and no container start", async () => {
  const recordDir = await mkdtemp(join(tmpdir(), "container-live-refused-"));
  try {
    assert.throws(
      () => runLane("changeme", recordDir, "refused-probe"),
      (error) => {
        const failure = error as { status?: number; stdout?: unknown; stderr?: unknown };
        const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
        return failure.status === 1 && output.includes("refusing placeholder credential");
      },
      "placeholder credentials must fail the lane loudly",
    );
    const record = await probeRecord(recordDir, "refused-probe");
    assert.equal(record.mode, "refused-placeholder-credential");
  } finally {
    await rm(recordDir, { recursive: true, force: true });
  }
});
