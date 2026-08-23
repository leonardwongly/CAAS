// Adversarial sweep owner/domain: R2-D2 — root lane scripts & collector.
//
// scripts/test-offline.mjs is the gate for the whole offline lane, so these
// probes attack it through its own interface: a temp repo tree fed via the
// --root= fixture hook. Every probe pins a collection semantic that, if it
// silently changed, would either drop tests from the lane or let the lane
// pass while a test fails:
// - naming assumptions: .test.tsx/.test.mjs/.spec.ts are never collected
//   (they belong to Vitest-owned lanes), files named exactly ".test.ts" ARE
//   collected by the endsWith rule, and a DIRECTORY named "*.test.ts" is
//   recursed, not treated as a file;
// - excluded dirs (a11y/e2e/responsive) are skipped at any nesting depth;
// - empty or missing suites fail closed;
// - child exit codes propagate; symlinks are never followed; the 10 MB
//   maxBuffer boundary fails closed instead of truncating silently.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);

const PASS_FIXTURE = `import test from "node:test";\ntest("ok", () => {});\n`;
const FAIL_FIXTURE = `import test from "node:test";\ntest("must never run", () => {\n  throw new Error("fixture was collected");\n});\n`;

const SUITE_DIRS = ["tests", "apps/api/test", "packages/contracts/test", "packages/route-engine/test", "packages/upstream-caas/test"] as const;

interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCollector(args: string[], env: Record<string, string> = {}): Promise<ScriptResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/test-offline.mjs", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

// A temp repo tree with one passing test file in every required suite dir.
async function makeTempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "r2d2-collector-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  for (const suite of SUITE_DIRS) {
    await mkdir(join(root, suite), { recursive: true });
    await writeFile(join(root, suite, "ok.test.ts"), PASS_FIXTURE, "utf8");
  }
  return root;
}

test("collector passes a clean temp tree and reports the exact collected file count", async (t) => {
  const root = await makeTempRoot(t);
  const result = await runCollector([`--root=${root}`]);
  assert.equal(result.code, 0, `collector must pass a clean tree, got: ${result.stderr}`);
  assert.match(result.stdout, /across 5 deterministic test files/u, "exactly the five ok.test.ts files must be collected");
});

test("collector recurses nested dirs, collects a hidden '.test.ts', and treats '*.test.ts' directories as directories", async (t) => {
  const root = await makeTempRoot(t);
  // Replace the flat tests/ok.test.ts with nested + odd-named entries.
  await rm(join(root, "tests/ok.test.ts"));
  await mkdir(join(root, "tests/deep/nested"), { recursive: true });
  await writeFile(join(root, "tests/deep/nested/a.test.ts"), PASS_FIXTURE, "utf8");
  // endsWith(".test.ts") collects a file whose WHOLE name is ".test.ts".
  await writeFile(join(root, "tests/.test.ts"), PASS_FIXTURE, "utf8");
  // A directory named like a test file must be recursed, not opened as a file.
  await mkdir(join(root, "tests/dir.test.ts"), { recursive: true });
  await writeFile(join(root, "tests/dir.test.ts/inner.test.ts"), PASS_FIXTURE, "utf8");
  const result = await runCollector([`--root=${root}`]);
  assert.equal(result.code, 0, `collector must pass nested/odd-named entries, got: ${result.stderr}`);
  assert.match(result.stdout, /across 7 deterministic test files/u, "3 nested tests-dir files + 4 package suites");
});

test("collector silently never runs .test.tsx, .test.mjs, .spec.ts, or anything inside excluded dirs (even nested)", async (t) => {
  const root = await makeTempRoot(t);
  // Every "bad" fixture throws if executed; the lane only passes if none are collected.
  await writeFile(join(root, "tests/bad.test.tsx"), FAIL_FIXTURE, "utf8");
  await writeFile(join(root, "tests/bad.test.mjs"), FAIL_FIXTURE, "utf8");
  await writeFile(join(root, "tests/bad.spec.ts"), FAIL_FIXTURE, "utf8");
  await mkdir(join(root, "tests/e2e"), { recursive: true });
  await writeFile(join(root, "tests/e2e/bad.test.ts"), FAIL_FIXTURE, "utf8");
  await mkdir(join(root, "tests/nested/a11y"), { recursive: true });
  await writeFile(join(root, "tests/nested/a11y/bad.test.ts"), FAIL_FIXTURE, "utf8");
  await mkdir(join(root, "tests/responsive"), { recursive: true });
  await writeFile(join(root, "tests/responsive/bad.test.ts"), FAIL_FIXTURE, "utf8");
  await mkdir(join(root, "packages/route-engine/test/e2e"), { recursive: true });
  await writeFile(join(root, "packages/route-engine/test/e2e/bad.test.ts"), FAIL_FIXTURE, "utf8");
  const result = await runCollector([`--root=${root}`]);
  assert.equal(result.code, 0, `non-.test.ts and excluded-dir fixtures must never run, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /across 5 deterministic test files/u, "only the five ok.test.ts files may be collected");
});

test("collector fails closed when a required suite is empty and names the suite", async (t) => {
  const root = await makeTempRoot(t);
  await rm(join(root, "packages/route-engine/test/ok.test.ts"));
  const result = await runCollector([`--root=${root}`]);
  assert.notEqual(result.code, 0, "an empty required suite must fail the lane");
  assert.match(result.stderr, /Required deterministic test suite is empty: packages\/route-engine\/test/u);
});

test("collector fails closed when a required suite directory is missing entirely", async (t) => {
  const root = await makeTempRoot(t);
  await rm(join(root, "apps/api/test"), { recursive: true, force: true });
  const result = await runCollector([`--root=${root}`]);
  assert.notEqual(result.code, 0, "a missing suite directory must fail the lane");
});

test("collector propagates the child test runner's failure exit code", async (t) => {
  const root = await makeTempRoot(t);
  await writeFile(join(root, "tests/fail.test.ts"), FAIL_FIXTURE, "utf8");
  const result = await runCollector([`--root=${root}`]);
  assert.equal(result.code, 1, "a failing collected test must surface exit code 1");
  assert.match(result.stdout, /fail/u, "the child runner's TAP failure output must be relayed");
});

test("collector never fails open under a leaked NODE_TEST_CONTEXT from an outer runner", async (t) => {
  // Regression: NODE_TEST_CONTEXT=child (set by any enclosing `node --test`)
  // used to leak through process.env into the child runner, which then
  // reported success while tests failed.
  const root = await makeTempRoot(t);
  await writeFile(join(root, "tests/fail.test.ts"), FAIL_FIXTURE, "utf8");
  const result = await runCollector([`--root=${root}`], { NODE_TEST_CONTEXT: "child" });
  assert.equal(result.code, 1, "runner-internal NODE_TEST_* state must be stripped before spawning the child runner");
});

test("collector never follows symlinked test files or directories", async (t) => {
  const root = await makeTempRoot(t);
  const outside = await mkdtemp(join(tmpdir(), "r2d2-collector-outside-"));
  t.after(async () => {
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(join(outside, "bad.test.ts"), FAIL_FIXTURE, "utf8");
  await symlink(join(outside, "bad.test.ts"), join(root, "tests/link.test.ts"));
  await symlink(outside, join(root, "tests/symdir"));
  const result = await runCollector([`--root=${root}`]);
  assert.equal(result.code, 0, `symlinks must be skipped, not collected, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /across 5 deterministic test files/u);
});

test("collector fails closed at the 10 MB maxBuffer boundary instead of truncating silently", async (t) => {
  const root = await makeTempRoot(t);
  const flood = [
    `import test from "node:test";`,
    `test("flood", () => {`,
    `  const chunk = "x".repeat(1024 * 1024);`,
    `  for (let index = 0; index < 12; index += 1) console.log(chunk);`,
    `});`,
    ``,
  ].join("\n");
  await writeFile(join(root, "tests/big.test.ts"), flood, "utf8");
  const result = await runCollector([`--root=${root}`]);
  assert.notEqual(result.code, 0, "output beyond maxBuffer must fail the lane, not be swallowed");
});
