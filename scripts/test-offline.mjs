import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);
// Optional --root=<dir> override so adversarial fixtures can exercise the
// collector against a temp directory tree without touching the real repo.
// Default behavior (repository root) is unchanged.
const rootArgument = process.argv.find((argument) => argument.startsWith("--root="));
const root = rootArgument ? resolve(rootArgument.slice("--root=".length)) : resolve(import.meta.dirname, "..");
const testDirectories = [
  "tests",
  "apps/api/test",
  "packages/contracts/test",
  "packages/route-engine/test",
  "packages/upstream-caas/test",
];

// Vitest-owned browser/DOM lanes (a11y, e2e, responsive) need jsdom + React
// transforms and run through `pnpm run test:a11y|test:e2e|test:responsive`,
// not the node --test collector.
const excludedDirectories = new Set(["a11y", "e2e", "responsive"]);

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return entry.isFile() && entry.name.endsWith(".test.ts") ? [join(directory, entry.name)] : [];
    if (excludedDirectories.has(entry.name)) return [];
    return collectTestFiles(join(directory, entry.name));
  }));
  return nested.flat();
}

const testFiles = (await Promise.all(testDirectories.map(async (relativeDirectory) => {
  const directory = resolve(root, relativeDirectory);
  const files = await collectTestFiles(directory);
  if (files.length === 0) throw new Error(`Required deterministic test suite is empty: ${relativeDirectory}`);
  return files;
}))).flat();

try {
  // Runner-internal state (NODE_TEST_CONTEXT et al.) must never leak into the
  // child runner: when this lane is invoked under an outer `node --test`
  // process, NODE_TEST_CONTEXT=child makes the child runner fail open and
  // report success even while tests fail.
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST_")));
  const result = await execFileAsync(process.execPath, ["--test", "--experimental-strip-types", ...testFiles], {
    cwd: root,
    env: { ...childEnv, CI: "1" },
    maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.log(`Offline repository test smoke passed across ${testFiles.length} deterministic test files without live-data access.`);
} catch (error) {
  const failure = error;
  if (typeof failure.stdout === "string") process.stdout.write(failure.stdout);
  if (typeof failure.stderr === "string") process.stderr.write(failure.stderr);
  process.exitCode = typeof failure.code === "number" ? failure.code : 1;
}
