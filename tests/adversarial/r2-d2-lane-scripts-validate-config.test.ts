// Adversarial sweep owner/domain: R2-D2 — root lane scripts & collector.
//
// scripts/validate-config.mjs probed through its alternate-root hook (the
// optional positional argument). The real repository config is never mutated:
// every hostile variant lives in a temp root. Coverage:
// - missing root files fail closed and are named;
// - the pnpm@11.5.2 pin rejects drift, whitespace, and foreign managers;
// - the workspace-glob list is exact: reorderings, omissions, additions,
//   traversal-shaped patterns, and non-array shapes all fail;
// - malformed JSON/YAML fails closed;
// - .env.example must carry ONLY the documented placeholder: a lone
//   placeholder line may not launder a second secret-bearing apikey line,
//   and casing/spacing variants of the assignment are rejected (regression
//   for the single-line-regex hole in the original check).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);

const VALID_PACKAGE_JSON = JSON.stringify({ name: "fixture", packageManager: "pnpm@11.5.2" });
const VALID_WORKSPACE_YAML = 'packages:\n  - "apps/*"\n  - "packages/*"\n  - "tests"\n';
const VALID_TSCONFIG = "{}";
const VALID_ENV_EXAMPLE = "# docs\napikey=replace-with-a-local-secret\nHOST=127.0.0.1\n";

interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runValidate(args: string[]): Promise<ScriptResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/validate-config.mjs", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

interface RootOverrides {
  "package.json"?: string;
  "pnpm-workspace.yaml"?: string;
  "tsconfig.base.json"?: string;
  ".env.example"?: string;
  ".dockerignore"?: string;
  omit?: keyof RootOverrides;
}

async function makeRoot(t: TestContext, overrides: RootOverrides = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "r2d2-validate-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const files = {
    "package.json": VALID_PACKAGE_JSON,
    "pnpm-workspace.yaml": VALID_WORKSPACE_YAML,
    "tsconfig.base.json": VALID_TSCONFIG,
    ".env.example": VALID_ENV_EXAMPLE,
    ".dockerignore": "node_modules\n",
  };
  for (const [name, content] of Object.entries(files)) {
    if (overrides.omit === name) continue;
    const override = overrides[name as keyof RootOverrides];
    await writeFile(join(root, name), typeof override === "string" ? override : content, "utf8");
  }
  return root;
}

test("validate-config accepts a fully valid root and the real repository root", async (t) => {
  const root = await makeRoot(t);
  const fixture = await runValidate([root]);
  assert.equal(fixture.code, 0, `valid fixture root must pass, got: ${fixture.stderr}`);
  assert.match(fixture.stdout, /valid/u);
  const real = await runValidate([]);
  assert.equal(real.code, 0, `the committed repository config must pass, got: ${real.stderr}`);
});

test("validate-config names every missing required root file", async (t) => {
  for (const name of ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json", ".env.example", ".dockerignore"] as const) {
    const root = await makeRoot(t, { omit: name });
    const result = await runValidate([root]);
    assert.notEqual(result.code, 0, `missing ${name} must fail`);
    assert.match(result.stderr, new RegExp(`Missing required root file: ${name.replace(/[.*]/gu, "\\$&")}`, "u"));
  }
});

test("validate-config rejects every form of pnpm pin drift", async (t) => {
  for (const packageJson of [
    JSON.stringify({ packageManager: "pnpm@11.5.3" }),
    JSON.stringify({ packageManager: "pnpm@11.5.2 " }),
    JSON.stringify({ packageManager: "pnpm@11.5.20" }),
    JSON.stringify({ packageManager: "npm@11.5.2" }),
    JSON.stringify({ packageManager: "pnpm@12.0.0" }),
    JSON.stringify({ name: "no-pin-at-all" }),
  ]) {
    const root = await makeRoot(t, { "package.json": packageJson });
    const result = await runValidate([root]);
    assert.notEqual(result.code, 0, `${packageJson} must fail the pin check`);
    assert.match(result.stderr, /must pin pnpm@11\.5\.2/u);
  }
});

test("validate-config requires the workspace glob list exactly, defeating escapes and rewrites", async (t) => {
  const variants = [
    'packages:\n  - "packages/*"\n  - "apps/*"\n  - "tests"\n', // reordered
    'packages:\n  - "apps/*"\n  - "packages/*"\n', // missing tests
    'packages:\n  - "apps/*"\n  - "packages/*"\n  - "tests"\n  - "evil/*"\n', // extra glob
    'packages:\n  - "apps/*"\n  - "packages/*"\n  - "apps/../secrets"\n', // traversal-shaped swap
    'packages:\n  - "apps/* "\n  - "packages/*"\n  - "tests"\n', // trailing whitespace glob
    'packages: "apps/*"\n', // scalar, not a list
    "# empty workspace file\n", // no packages key at all
  ];
  for (const yaml of variants) {
    const root = await makeRoot(t, { "pnpm-workspace.yaml": yaml });
    const result = await runValidate([root]);
    assert.notEqual(result.code, 0, `workspace variant must fail: ${JSON.stringify(yaml)}`);
    assert.match(result.stderr, /must declare apps\/\*, packages\/\*, tests/u);
  }
});

test("validate-config fails closed on malformed JSON and YAML", async (t) => {
  const hostilePackage = await makeRoot(t, { "package.json": '{"packageManager": "pnpm@11.5.2",' });
  const packageResult = await runValidate([hostilePackage]);
  assert.notEqual(packageResult.code, 0, "truncated package.json must fail");

  const hostileYaml = await makeRoot(t, { "pnpm-workspace.yaml": "packages: [\n" });
  const yamlResult = await runValidate([hostileYaml]);
  assert.notEqual(yamlResult.code, 0, "unterminated YAML flow sequence must fail");

  const hostileTsconfig = await makeRoot(t, { "tsconfig.base.json": '{ "compilerOptions": // comment\n }' });
  const tsconfigResult = await runValidate([hostileTsconfig]);
  assert.notEqual(tsconfigResult.code, 0, "JSONC-style tsconfig must fail strict JSON parsing");
});

test("validate-config rejects any apikey line that is not exactly the documented placeholder", async (t) => {
  const variants = [
    "# no credential line at all\nHOST=127.0.0.1\n",
    "apikey=hunter2\n",
    // The original single-regex check passed all of these: a placeholder line
    // laundering a second secret-bearing assignment.
    "apikey=replace-with-a-local-secret\napikey=hunter2\n",
    "apikey=replace-with-a-local-secret\nAPIKEY=leaked-secret\n",
    "apikey=replace-with-a-local-secret\napikey = replace-with-a-local-secret\n",
    "apikey=replace-with-a-local-secret\napikey=replace-with-a-local-secret-extra\n",
  ];
  for (const envExample of variants) {
    const root = await makeRoot(t, { ".env.example": envExample });
    const result = await runValidate([root]);
    assert.notEqual(result.code, 0, `env variant must fail: ${JSON.stringify(envExample)}`);
    assert.match(result.stderr, /documented placeholder for apikey/u);
  }
});

test("validate-config accepts placeholder-only apikey shapes including comments and CRLF", async (t) => {
  for (const envExample of [
    "apikey=replace-with-a-local-secret\n",
    "# apikey=real-secret-in-a-comment\napikey=replace-with-a-local-secret\n",
    "apikey=replace-with-a-local-secret\r\nHOST=127.0.0.1\r\n",
  ]) {
    const root = await makeRoot(t, { ".env.example": envExample });
    const result = await runValidate([root]);
    assert.equal(result.code, 0, `env variant must pass: ${JSON.stringify(envExample)} got: ${result.stderr}`);
  }
});
