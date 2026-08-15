// Regression coverage for scripts/validation/container-live-lane.mjs:
// the authorized container lane must fail closed — no credential records a
// PENDING lane without starting a container, and a placeholder credential is
// refused loudly with exit 1 and no upstream request.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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

// The lane names its record after the current HEAD (lib-evidence shortSha).
// Read THAT record: other committed records (e.g. an authorized run) must
// never shadow the record produced by this invocation.
async function currentHeadContainerLiveRecord() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim().slice(0, 12);
  return JSON.parse(await readFile(resolve(root, "docs/evidence", `container-live-lane-${head}.json`), "utf8"));
}

test("container live lane records PENDING and exits 0 when no credential is configured", async () => {
  const output = runLane("");
  assert.match(output, /PENDING record written/u);
  const record = await currentHeadContainerLiveRecord();
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
