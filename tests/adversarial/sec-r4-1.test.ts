import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { writeJsonRecord } from "../../scripts/validation/lib-evidence.mjs";
import { validateEvidenceBundle } from "../../scripts/validation/validate-evidence-bundle.mjs";

// Security sweep round-4 regressions (evidence pipeline):
// - writeJsonRecord is atomic under concurrent same-process writers: the final
//   record is one complete serialization, never a torn mix, and no temp files
//   remain.
// - Per-check artifact paths get the same containment discipline as
//   record-level artifacts: absolute paths and traversal are rejected WITHOUT
//   opening the host file.
// - A completed record cannot escape scoring by reclassifying its recordKind:
//   unclassified records fail loudly instead of being silently skipped.

const root = resolve(import.meta.dirname, "../..");

test("concurrent writeJsonRecord writers never tear the final record", async () => {
  const dir = resolve(root, "tmp", "r4-atomic");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    const base = { recordKind: "lane-results", lane: "r4-atomic-probe", checks: Array.from({ length: 200 }, (_, i) => ({ i })) };
    await Promise.all(Array.from({ length: 8 }, (_, i) => writeJsonRecord("tmp/r4-atomic/record.json", { ...base, writer: i })));
    const parsed = JSON.parse(await readFile(resolve(dir, "record.json"), "utf8")) as { lane: string; checks: unknown[] };
    assert.equal(parsed.lane, "r4-atomic-probe");
    assert.equal(parsed.checks.length, 200, "the final record must be one complete serialization, never a torn mix");
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no temp files may remain after the writes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function probeLaneRecord(artifacts: unknown[]): Record<string, unknown> {
  return {
    recordKind: "lane-results",
    lane: "r4-containment-probe",
    mode: "probe",
    credentialHandling: "probe",
    subject: { type: "commit", identifiers: { commit: "0".repeat(40) }, environment: "probe" },
    startedAt: "2026-08-14T00:00:00.000Z",
    endedAt: "2026-08-14T00:00:01.000Z",
    checks: [{
      checkId: "R4-CONTAINMENT",
      name: "probe",
      procedure: "probe",
      startedAt: "2026-08-14T00:00:00.000Z",
      endedAt: "2026-08-14T00:00:01.000Z",
      result: "pass",
      measurement: { summary: "probe", value: true, units: "boolean", sampleCount: 1 },
      artifacts,
      failureFallback: "probe",
    }],
    summary: { checks: 1, passed: 1, failed: 0, blocked: 0 },
    artifacts: [],
  };
}

test("per-check artifact paths get record-level containment: host files are never opened", async () => {
  const file = resolve(root, "docs/evidence", "r4-check-artifact-probe.json");
  await writeFile(file, `${JSON.stringify(probeLaneRecord([
    { path: "/etc/hosts", sha256: "a".repeat(64) },
    { path: "../../etc/passwd", sha256: "b".repeat(64) },
  ]), null, 2)}\n`, "utf8");
  try {
    const { errors } = await validateEvidenceBundle();
    const mine = errors.filter((error) => error.includes("r4-check-artifact-probe"));
    assert.ok(mine.length >= 2, `absolute and traversal per-check artifact paths must both fail: ${mine.join("; ") || "none"}`);
    assert.ok(!mine.some((error) => error.includes("hash mismatch")), "an invalid path must never reach the host-file hash read");
  } finally {
    await unlink(file);
  }
});

test("a completed record cannot escape scoring by reclassifying its recordKind", async () => {
  const file = resolve(root, "docs/evidence", "r4-reclassified-probe.json");
  await writeFile(file, `${JSON.stringify({ recordKind: "lane-results-evidence", lane: "r4-probe", subject: { type: "commit", identifiers: { commit: "0".repeat(40) }, environment: "probe" } }, null, 2)}\n`, "utf8");
  try {
    const { errors } = await validateEvidenceBundle();
    const mine = errors.filter((error) => error.includes("r4-reclassified-probe"));
    assert.ok(mine.length > 0, "an unclassified record must fail loudly, never be silently skipped");
    assert.ok(mine.some((error) => error.includes("unclassified evidence record")), `expected the unclassified-record error: ${mine.join("; ")}`);
  } finally {
    await unlink(file);
  }
});
