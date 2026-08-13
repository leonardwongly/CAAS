// Cross-checks the workspace lint contract (scripts/validation/
// lint-import-boundaries.mjs): apps/web stays browser-safe, the root lint
// script is a real command, and no workspace test/typecheck script is a
// silent no-op stub.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const NOOP_PATTERN = /^(true|exit\s+0|echo(?:[\s\S]*)$|:)\s*$/;

test("apps/web does not import upstream-caas, node builtins, or process.env", async () => {
  const webFiles: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:ts|tsx|js|mjs|cjs|html)$/.test(entry.name)) webFiles.push(path);
    }
  };
  await walk(resolve(root, "apps/web/src"));
  assert.ok(webFiles.length > 0, "apps/web/src contains source files");
  const violations: Array<{ path: string; line: number; source: string }> = [];
  for (const path of webFiles) {
    const contents = await readFile(path, "utf8");
    contents.split("\n").forEach((line, index) => {
      const match = line.match(/^\s*(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/);
      const source = match?.[1] ?? "";
      if (source.includes("upstream-caas") || source === "node" || source.startsWith("node:")) violations.push({ path, line: index + 1, source });
      if (line.includes("process.env")) violations.push({ path, line: index + 1, source: "process.env" });
    });
  }
  assert.deepEqual(violations, [], "web must not import server packages or node builtins");
});

test("root lint script is a real command, not a recursive no-op", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const lint = packageJson.scripts.lint;
  assert.equal(typeof lint, "string");
  assert.ok(lint.includes("lint-import-boundaries.mjs"), "root lint must run the real lint script");
  assert.ok(!/recursive.*run lint/.test(lint), "root lint must not be the silent recursive no-op");
});

test("every workspace package declares a real typecheck script and a real test script (web is the documented exception)", async () => {
  const workspaceYaml = await readFile(resolve(root, "pnpm-workspace.yaml"), "utf8");
  assert.ok(workspaceYaml.includes("apps/*") && workspaceYaml.includes("packages/*") && workspaceYaml.includes("tests"));
  const packages = ["apps/api", "apps/web", "packages/contracts", "packages/route-engine", "packages/upstream-caas", "tests"];
  for (const relative of packages) {
    const manifest = JSON.parse(await readFile(resolve(root, relative, "package.json"), "utf8"));
    const typecheck = manifest.scripts?.typecheck ?? "";
    assert.ok(typeof typecheck === "string" && typecheck.trim() !== "" && !NOOP_PATTERN.test(typecheck.trim()), `${relative} typecheck must be real`);
    if (!manifest.name?.includes("/web")) {
      const testScript = manifest.scripts?.test ?? "";
      assert.ok(typeof testScript === "string" && testScript.trim() !== "" && !NOOP_PATTERN.test(testScript.trim()), `${relative} test must be real`);
    }
  }
});
