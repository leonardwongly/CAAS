// Real lint for the workspace (replaces the silent recursive no-op): import
// boundary enforcement and workspace hygiene, with loud failures.
//
//   LINT-WEB-BOUNDARY   apps/web must not import upstream-caas or node: builtins,
//                       and must not reference process.env (browser bundle only).
//   LINT-SCRIPTS        every workspace package declares a real `typecheck`
//                       script; every package with runtime code declares a real
//                       `test` script (apps/web is the documented exception: it
//                       is a static bundle covered by the tests/ lanes); no
//                       script is a no-op stub (`true`, `echo`, empty).
//   LINT-ROOT-VALIDATION  every `validate*` and `lint` script in the root
//                       package.json is a real command, not a stub.
//
// No network, no secrets, deterministic on the committed tree.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { CheckCollector, isoNow, reportAndExit, root, sha256Hex, shortSha, writeJsonRecord } from "./lib-evidence.mjs";

const short = shortSha();
const recordPath = `docs/evidence/lint-local-${short}.json`;
const collector = new CheckCollector();
const startedAt = isoNow();

const SELF_ARTIFACT = { path: "scripts/validation/lint-import-boundaries.mjs", sha256: sha256Hex(await readFile(resolve(root, "scripts/validation/lint-import-boundaries.mjs"), "utf8")) };
const artifactsFor = (extra = []) => [SELF_ARTIFACT, ...extra];

const NOOP_PATTERN = /^(true|exit\s+0|echo(?:[\s\S]*)$|:)\s*$/;

// 1. apps/web import boundary.
const webFiles = execFileSync("git", ["ls-files", "apps/web"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter((path) => /\.(?:ts|tsx|js|mjs|cjs|html)$/.test(path));
const webViolations = [];
for (const path of webFiles) {
  const contents = await readFile(resolve(root, path), "utf8").catch(() => "");
  const lines = contents.split("\n");
  lines.forEach((line, index) => {
    const importMatch = line.match(/^\s*(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/);
    const source = importMatch?.[1] ?? "";
    if (source.includes("upstream-caas") || source === "node" || source.startsWith("node:")) webViolations.push({ path, line: index + 1, source });
    if (line.includes("process.env")) webViolations.push({ path, line: index + 1, source: "process.env" });
  });
}
collector.pass("LINT-WEB-BOUNDARY", "web does not import server packages or node builtins", "apps/web only depends on browser-safe packages; no upstream-caas, node: builtins, or process.env.", startedAt, isoNow(),
  webViolations.length === 0, "violations", Math.max(1, webViolations.length),
  artifactsFor(webViolations.slice(0, 5).map((violation) => ({ path: violation.path, sha256: "redacted-location-only", metadata: { line: violation.line, source: violation.source } }))));

// 2. Workspace package script hygiene.
const packagePaths = [
  ...execFileSync("git", ["ls-files", "apps/*/package.json", "packages/*/package.json", "tests/package.json"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean),
];
const scriptViolations = [];
for (const path of packagePaths) {
  const packageJson = JSON.parse(await readFile(resolve(root, path), "utf8"));
  const scripts = packageJson.scripts ?? {};
  const name = packageJson.name ?? path;
  const isWeb = name.includes("/web");
  for (const scriptName of ["typecheck"]) {
    const value = scripts[scriptName] ?? "";
    if (typeof value !== "string" || value.trim() === "" || NOOP_PATTERN.test(value.trim())) scriptViolations.push({ path, script: scriptName, issue: "missing or no-op" });
  }
  if (!isWeb) {
    const value = scripts.test ?? "";
    if (typeof value !== "string" || value.trim() === "" || NOOP_PATTERN.test(value.trim())) scriptViolations.push({ path, script: "test", issue: "missing or no-op" });
  }
}
collector.pass("LINT-SCRIPTS", "workspace packages declare real typecheck and test scripts", "Every package declares typecheck; every package except the web static bundle declares a real test script.", startedAt, isoNow(),
  scriptViolations.length === 0, "violations", Math.max(1, scriptViolations.length),
  artifactsFor(scriptViolations.slice(0, 5).map((violation) => ({ path: violation.path, sha256: "redacted-location-only", metadata: { script: violation.script, issue: violation.issue } }))));

// 3. Root validation/lint scripts are real.
const rootPackageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const rootScripts = rootPackageJson.scripts ?? {};
const rootViolations = [];
for (const [name, value] of Object.entries(rootScripts)) {
  if (!/^(?:validate|lint|verify|test|typecheck)/.test(name)) continue;
  if (typeof value !== "string" || value.trim() === "" || NOOP_PATTERN.test(value.trim())) rootViolations.push({ script: name, issue: "no-op stub" });
  if (name === "lint" && /recursive.*run lint/.test(value)) rootViolations.push({ script: name, issue: "recursive no-op when no package declares lint" });
}
collector.pass("LINT-ROOT-VALIDATION", "root validate/lint/test scripts are real commands", "No root validation-related script is a silent stub.", startedAt, isoNow(),
  rootViolations.length === 0, "violations", Math.max(1, rootViolations.length),
  artifactsFor(rootViolations.slice(0, 5).map((violation) => ({ path: "package.json", sha256: "redacted-location-only", metadata: { script: violation.script, issue: violation.issue } }))));

const record = {
  recordKind: "measurement-results",
  lane: "lint",
  subject: { type: "commit", identifiers: { commit: short }, environment: "local-hermetic" },
  startedAt,
  endedAt: isoNow(),
  checks: collector.checks,
  summary: collector.summary(),
  artifacts: artifactsFor(),
};
const fileSha = await writeJsonRecord(recordPath, record);
console.log(`Lint record written to ${recordPath} (sha256 ${fileSha})`);
reportAndExit(collector, "WORKSPACE LINT (import boundaries + script hygiene)");
