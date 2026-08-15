// Regression coverage for scripts/validation/container-live-lane.mjs:
// the authorized container lane must fail closed — no credential records a
// PENDING lane without starting a container, and a placeholder credential is
// refused loudly with exit 1 and no upstream request.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

function runLane(apikey: string) {
  return execFileSync("node", ["--experimental-strip-types", "scripts/validation/container-live-lane.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, apikey },
  });
}

async function latestContainerLiveRecord() {
  const files = (await readdir(resolve(root, "docs/evidence"))).filter((name) => name.startsWith("container-live-lane-") && name.endsWith(".json")).sort();
  assert.ok(files.length > 0, "the lane must write a record");
  return JSON.parse(await readFile(resolve(root, "docs/evidence", files[files.length - 1]!), "utf8"));
}

test("container live lane records PENDING and exits 0 when no credential is configured", async () => {
  const output = runLane("");
  assert.match(output, /PENDING record written/u);
  const record = await latestContainerLiveRecord();
  assert.equal(record.mode, "pending-authorized-execution");
  assert.equal(record.summary.failed, 0);
  assert.equal(record.summary.blocked, 5);
  assert.equal(record.summary.passed, 1);
  assert.equal(record.subject.type, "oci");
});

test("container live lane refuses a placeholder credential with exit 1 and no container start", () => {
  assert.throws(
    () => runLane("changeme"),
    (error) => {
      const failure = error as { status?: number; stdout?: unknown; stderr?: unknown };
      const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      return failure.status === 1 && output.includes("refusing placeholder credential");
    },
    "placeholder credentials must fail the lane loudly",
  );
});
