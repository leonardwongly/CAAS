import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const testFiles = (await readdir(resolve(root, "tests")))
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => resolve(root, "tests", file));

try {
  const result = await execFileAsync(process.execPath, ["--test", "--experimental-strip-types", ...testFiles], {
    cwd: root,
    env: { ...process.env, CI: "1" },
    maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.log("Offline repository test smoke passed without live-data access.");
} catch (error) {
  const failure = error;
  if (typeof failure.stdout === "string") process.stdout.write(failure.stdout);
  if (typeof failure.stderr === "string") process.stderr.write(failure.stderr);
  process.exitCode = typeof failure.code === "number" ? failure.code : 1;
}
