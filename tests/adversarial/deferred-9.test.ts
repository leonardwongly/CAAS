import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Candidate finding: scripts/validation/loopback-lane.mjs:248 awaits
// runChecks() at top level with no try/catch. Any rejection during the run —
// a fetch failure, `throw new Error("browse page failed with ...")` (line 88),
// or `json: () => JSON.parse(body)` on a non-JSON 200 body (lines 39/49/64/89)
// — becomes an unhandled rejection: the process exits 1 and the lane-results
// record write (lines 251-279) never executes, so a failed run leaves NO
// evidence. live-lane.mjs (lines 193-197) wraps its authorized run, records a
// LIVE-LANE-ERROR fail check, and writes the record before exiting.
//
// North-star contract: docs/testing/evidence-and-validation.md, "Failure
// reporting" — "Record failed or blocked gates, not just successful checks" —
// and the evidence-class definition "Not evidenced: no retained result
// exists." A lane that crashes mid-run must still exit loudly (non-zero) AND
// write a lane-results record containing the failed check, exactly as
// live-lane.mjs does. This test simulates a mid-lane crash (the ready-check
// fetch throws) and asserts both halves of that contract.

const repoRoot = new URL("../..", import.meta.url).pathname;
const evidenceDir = `${repoRoot}docs/evidence`;

async function snapshotLaneRecords() {
  const snapshot = new Map();
  for (const name of await readdir(evidenceDir)) {
    if (!name.startsWith("loopback-lane-local-")) continue;
    snapshot.set(name, await readFile(`${evidenceDir}/${name}`, "utf8"));
  }
  return snapshot;
}

test("loopback lane records a failed gate when a mid-run exception aborts the checks", async () => {
  // Content snapshot of every pre-existing loopback-lane record so a fresh
  // write (or an overwrite of the same-commit record) is detectable.
  const before = await snapshotLaneRecords();

  // Reproduce the lane exactly as test:integration runs it, but force a
  // mid-lane exception: the ready-check fetch throws, which today propagates
  // out of runChecks()'s top-level await with no catch, so the lane exits
  // non-zero and never writes its lane-results record.
  const childCode = `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/v1/health/ready")) {
        throw new Error("simulated mid-lane fetch failure");
      }
      return originalFetch(input, init);
    };
    await import("./scripts/validation/loopback-lane.mjs");
  `;

  let exitCode;
  let childError: { code?: number | string; signal?: string; stderr?: Buffer | string } | null = null;
  try {
    await execFileAsync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childCode], {
      cwd: repoRoot,
      timeout: 60_000,
    });
    exitCode = 0;
  } catch (error) {
    childError = error as { code?: number | string; signal?: string; stderr?: Buffer | string };
    if (typeof childError.code === "number") exitCode = childError.code;
  }

  assert.notEqual(
    exitCode,
    undefined,
    `lane child failed to RUN (harness issue, not the finding): ${JSON.stringify({
      code: childError?.code,
      signal: childError?.signal,
      stderr: childError?.stderr?.toString().slice(0, 400),
    })}`,
  );
  assert.equal(
    exitCode,
    1,
    `a mid-run exception must fail the lane loudly with exit 1 (got ${exitCode}); lane stderr: ${childError?.stderr?.toString().slice(0, 400)}`,
  );

  // A crash must still leave evidence: a lane-results record containing the
  // failed check. Today the record write never executes.
  const after = await snapshotLaneRecords();
  const written = [...after.entries()].filter(([name, content]) => !before.has(name) || before.get(name) !== content);
  assert.ok(
    written.length > 0,
    `the failed lane must write a fresh loopback-lane record; none appeared (before: ${[...before.keys()].join(", ") || "none"}; after: ${[...after.keys()].join(", ") || "none"})`,
  );

  const [recordName, recordText] = written[0]!;
  const record = JSON.parse(recordText) as {
    recordKind?: string;
    lane?: string;
    checks?: Array<{ result?: string }>;
  };
  assert.equal(record.recordKind, "lane-results", `${recordName} must be a lane-results record`);
  assert.equal(record.lane, "loopback-five-family-lane", `${recordName} must name the loopback lane`);
  const failedChecks = (record.checks ?? []).filter((check) => check.result === "fail");
  assert.ok(
    failedChecks.length >= 1,
    `${recordName} must contain a fail check recording the aborted run; checks: ${JSON.stringify(record.checks)}`,
  );
});
