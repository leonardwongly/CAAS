import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
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
  const result = await execFileAsync(process.execPath, ["--test", "--experimental-strip-types", ...testFiles], {
    cwd: root,
    env: { ...process.env, CI: "1" },
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
