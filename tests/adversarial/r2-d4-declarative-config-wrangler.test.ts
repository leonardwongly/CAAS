// Owner: R2-D4 — declarative config correctness (round-2 adversarial sweep 2026-08-23).
//
// wrangler.jsonc was previously UNTESTED: validate-offline.mjs (d5-owned)
// scans workflows and Bicep but never reads it. This lane parses the file as
// JSONC and cross-references every declaration against the actual repo state:
//   1. JSONC parse validity (the comment-stripper is self-tested first so the
//      parse pin is not vacuous), main entrypoint / container image paths
//      must resolve to real files in the tree, and assets.directory must
//      match the web build output declaration without depending on build
//      output existing (it is produced at build time, never committed).
//   2. assets.run_worker_first must describe exactly the prefix the edge
//      router classifies (apps/edge/src/routing.ts isApiRequest -> "/api/").
//   3. The container class_name ApiContainer must agree across the containers
//      block, the durable-object bindings, the migrations tag, and the class
//      actually exported by apps/edge/src/index.ts; the container `name` and
//      the binding names must match the edge wiring.
//   4. secrets.required must be exactly ["apikey"] and match the container
//      env-var contract (nothing else may cross into the container).
//   5. Root-vs-env.staging drift: every block duplicated under env.staging
//      must be deep-equal to its root counterpart, so the two cannot silently
//      diverge.
// Everything reads committed files; nothing is mocked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

/**
 * Minimal JSONC comment stripper (line + block comments, string-aware).
 * Deliberately local so the lane stays hermetic; self-tested below so a
 * broken stripper can never silently pass the config parse.
 */
export function stripJsoncComments(text: string): string {
  let output = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] ?? "";
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n") {
        output += char; // preserve line structure for diagnostics
      }
      continue;
    }
    if (inString) {
      output += char;
      if (char === "\\") {
        output += next;
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

interface WranglerContainer {
  name: string;
  class_name: string;
  image: string;
  image_build_context: string;
  instance_type: { vcpu: number; memory_mib: number; disk_mb: number };
  max_instances: number;
  ssh: { enabled: boolean };
}

interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  assets: { directory: string; binding: string; run_worker_first: string[]; not_found_handling: string };
  containers: WranglerContainer[];
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { tag: string; new_sqlite_classes: string[] }[];
  secrets: { required: string[] };
  observability: { enabled?: boolean; logs: { enabled: boolean; invocation_logs: boolean } };
  env: { staging: { containers: WranglerContainer[]; durable_objects: { bindings: { name: string; class_name: string }[] }; secrets: { required: string[] } } };
}

function onlyContainer(config: WranglerConfig): WranglerContainer {
  assert.equal(config.containers.length, 1, "exactly one container is declared");
  const container = config.containers[0];
  assert.ok(container, "the single container declaration must be present");
  return container;
}

async function loadConfig(): Promise<{ raw: string; config: WranglerConfig }> {
  const raw = await readFile(resolve(root, "wrangler.jsonc"), "utf8");
  const config = JSON.parse(stripJsoncComments(raw)) as WranglerConfig;
  return { raw, config };
}

async function loadEdgeSources(): Promise<{ indexSource: string; routingSource: string }> {
  const indexSource = await readFile(resolve(root, "apps/edge/src/index.ts"), "utf8");
  const routingSource = await readFile(resolve(root, "apps/edge/src/routing.ts"), "utf8");
  return { indexSource, routingSource };
}

test("the JSONC comment stripper is string-aware (self-check guards the parse pin)", () => {
  // Comments inside strings must survive; real comments must die. A broken
  // stripper would either corrupt strings or let comments reach JSON.parse.
  const sample = '{\n  "url": "https://x.test/a//b/*c*/", // trailing line comment\n  /* block */ "n": 1\n}';
  assert.deepEqual(JSON.parse(stripJsoncComments(sample)), { url: "https://x.test/a//b/*c*/", n: 1 });
  const escaped = '{"s": "a \\" // not a comment"}';
  assert.deepEqual(JSON.parse(stripJsoncComments(escaped)), { s: 'a " // not a comment' });
});

test("wrangler.jsonc parses as JSONC and declares the worker identity", async () => {
  const { config } = await loadConfig();
  assert.equal(config.name, "flight-route-explorer", "worker name must stay the project identity");
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/, "compatibility_date must be a wrangler date");
});

test("main entrypoint and container image resolve to real paths", async () => {
  const { config } = await loadConfig();
  assert.equal(config.main, "apps/edge/src/index.ts");
  assert.ok(existsSync(resolve(root, config.main)), `main entrypoint ${config.main} must exist`);
  const container = onlyContainer(config);
  const image = container.image.replace(/^\.\//, "");
  assert.ok(existsSync(resolve(root, image)), `container image Dockerfile ${container.image} must exist`);
  const context = container.image_build_context.replace(/^\.\//, "");
  assert.ok(existsSync(resolve(root, context)), `image_build_context ${container.image_build_context} must exist`);
});

test("assets.directory names the web build output: declared, produced at build time, never committed", async () => {
  // CI runs this lane on a fresh checkout BEFORE any web build, so
  // apps/web/dist legitimately does not exist there; asserting its existence
  // would make the test pass or fail depending on local build leftovers —
  // an environment-dependent false assertion of repo truth. The real
  // invariant is declarative: assets.directory must be exactly the directory
  // the web build writes to (derived from the web package's build config, not
  // the filesystem), and that directory must be gitignored so committed state
  // can never contain build output.
  const { config } = await loadConfig();
  assert.equal(config.assets.directory, "./apps/web/dist", "assets.directory must stay pinned to the web build output path");
  // Derive the build output directory from committed sources: the web build
  // script is `vite build` and apps/web/vite.config.ts sets no build.outDir,
  // so Vite's default `dist/` (relative to apps/web) is the output directory
  // — exactly the apps/web/dist path wrangler declares.
  const webPackage = JSON.parse(await readFile(resolve(root, "apps/web/package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(webPackage.scripts.build ?? "", /vite build/, "the web build must be produced by vite build");
  const viteConfig = await readFile(resolve(root, "apps/web/vite.config.ts"), "utf8");
  assert.ok(!/outDir/.test(viteConfig), "vite config must not redirect build output via outDir; the default dist/ is the contract");
  // Graceful local-only sanity: when a build has already produced the output
  // directory (never the case on a fresh CI checkout, which runs this lane
  // before any web build), it must contain the SPA entrypoint — a dist/ with
  // no index.html is a stale or interrupted build, not deployable assets.
  const declaredAssetsDirectory = resolve(root, config.assets.directory.replace(/^\.\//, ""));
  if (existsSync(declaredAssetsDirectory)) {
    assert.ok(
      existsSync(join(declaredAssetsDirectory, "index.html")),
      `local build output ${config.assets.directory} exists but contains no index.html — stale or partial build`,
    );
  }
  // git check-ignore exits 0 only when the path matches an ignore pattern.
  let ignored = false;
  try {
    execFileSync("git", ["check-ignore", "--", "apps/web/dist"], { cwd: root, stdio: "pipe" });
    ignored = true;
  } catch {
    ignored = false;
  }
  assert.ok(ignored, "apps/web/dist must be gitignored: build output is produced at build time, never committed");
});

test("run_worker_first covers exactly the /api/ prefix the edge router classifies", async () => {
  const { config } = await loadConfig();
  const { routingSource } = await loadEdgeSources();
  // The routing contract is literal: only pathname.startsWith("/api/") hits
  // the container. The assets declaration must hand that same prefix to the
  // Worker first, and nothing else (an extra pattern would route SPA paths
  // through the Worker and mask asset regressions).
  assert.deepEqual(config.assets.run_worker_first, ["/api/*"], "run_worker_first must be exactly the API prefix");
  assert.match(routingSource, /pathname\.startsWith\("\/api\/"\)/, "edge router must keep classifying the literal /api/ prefix");
  assert.equal(config.assets.binding, "ASSETS");
  assert.equal(config.assets.not_found_handling, "single-page-application");
});

test("class_name ApiContainer is consistent across containers, DO bindings, migrations, and the edge export", async () => {
  const { config } = await loadConfig();
  const { indexSource } = await loadEdgeSources();
  const classNames = new Set<string>();
  for (const container of config.containers) classNames.add(container.class_name);
  for (const binding of config.durable_objects.bindings) classNames.add(binding.class_name);
  for (const migration of config.migrations) for (const klass of migration.new_sqlite_classes) classNames.add(klass);
  assert.deepEqual([...classNames], ["ApiContainer"], "every declarative class_name reference must name the same container class");
  assert.match(indexSource, /export class ApiContainer extends Container/, "the Worker must export the class the declarations name");
  assert.equal(config.migrations.length, 1, "exactly one migrations tag is expected");
  const migration = config.migrations[0];
  assert.ok(migration, "the migrations declaration must be present");
  assert.equal(migration.tag, "v1");
});

test("container name and binding names match the edge wiring in routing.ts", async () => {
  const { config } = await loadConfig();
  const { routingSource } = await loadEdgeSources();
  const nameMatch = routingSource.match(/export const API_CONTAINER_NAME = "([^"]+)"/);
  assert.ok(nameMatch && nameMatch[1] !== undefined, "routing.ts must keep exporting the container name constant");
  const container = onlyContainer(config);
  assert.equal(container.name, nameMatch[1], "wrangler container name must equal API_CONTAINER_NAME");
  assert.deepEqual(config.durable_objects.bindings.map((binding) => binding.name), ["API_CONTAINER"]);
  assert.match(routingSource, /API_CONTAINER: \{ getByName\(name: string\)/, "routing.ts must keep consuming the API_CONTAINER binding");
  assert.match(routingSource, /ASSETS: \{ fetch\(request: Request\)/, "routing.ts must keep consuming the ASSETS binding");
});

test("secrets.required is exactly [\"apikey\"] and matches the container env-var contract", async () => {
  const { config } = await loadConfig();
  const { routingSource, indexSource } = await loadEdgeSources();
  assert.deepEqual(config.secrets.required, ["apikey"], "root secrets.required must stay exactly the apikey contract");
  assert.deepEqual(config.env.staging.secrets.required, ["apikey"], "staging secrets.required must stay exactly the apikey contract");
  // containerEnvVars is the only authorized bridge from Worker env into the
  // container; it accepts and returns exactly { apikey }.
  assert.match(routingSource, /containerEnvVars\(env: \{ readonly apikey: string \}\): \{ readonly apikey: string \}/);
  assert.match(indexSource, /readonly apikey: string/);
});

test("root and env.staging duplicated blocks are identical (no silent drift)", async () => {
  const { config } = await loadConfig();
  const staging = config.env.staging;
  assert.deepEqual(staging.containers, config.containers, "env.staging containers drifted from the root containers block");
  assert.deepEqual(staging.durable_objects, config.durable_objects, "env.staging durable_objects drifted from the root block");
  assert.deepEqual(staging.secrets, config.secrets, "env.staging secrets drifted from the root block");
});

test("observability logging stays enabled with no contradicting legacy switch", async () => {
  const { config } = await loadConfig();
  assert.equal(config.observability.logs.enabled, true, "worker logs must stay enabled");
  assert.equal(config.observability.logs.invocation_logs, true, "invocation logs must stay enabled");
  // The legacy top-level observability.enabled is a master switch: if it is
  // present it must not be false while logs.enabled is true (silent conflict).
  if (config.observability.enabled !== undefined) {
    assert.equal(config.observability.enabled, true, "a legacy observability.enabled=false would silently contradict logs.enabled=true");
  }
});

test("container sizing and lifecycle stay pinned to the POC shape", async () => {
  const { config } = await loadConfig();
  const container = onlyContainer(config);
  assert.equal(container.max_instances, 1, "POC runs at most one container instance");
  assert.equal(container.ssh.enabled, false, "container ssh must remain disabled");
  assert.deepEqual(container.instance_type, { vcpu: 1, memory_mib: 3072, disk_mb: 2000 });
});
