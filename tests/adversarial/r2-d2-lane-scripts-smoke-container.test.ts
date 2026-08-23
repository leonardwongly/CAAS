// Adversarial sweep owner/domain: R2-D2 — root lane scripts & collector.
//
// scripts/smoke-container.mjs probed through its alternate-Dockerfile hook
// (the optional positional argument); the committed containers/Dockerfile is
// never mutated. Every hostile variant is a Dockerfile that a naive grep
// would bless but that breaks the invariant's INTENT:
// - digest pin evasion: floating tags in the dependencies or runtime stage;
// - USER override: `USER app` followed by a later `USER root`;
// - forbidden-token evasion: quoted NODE_ENV="test", shell line
//   continuations splitting "az", hostile COPY sources, prefixed ports,
//   prefixed TMPDIR values, widened VOLUME declarations.
// Positive pins guard against over-tightening: the committed Dockerfile and
// digest-pinned coarse tags must still pass.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);

const DIGEST = "d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436";
const PINNED_BASE = `node:22.23.2-bookworm-slim@sha256:${DIGEST}`;

// Minimal Dockerfile satisfying every hardened invariant.
const VALID_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM ${PINNED_BASE} AS dependencies
RUN pnpm install --frozen-lockfile
FROM dependencies AS build
RUN pnpm run build
FROM ${PINNED_BASE} AS runtime
ENV NODE_ENV=production \\
    TMPDIR=/tmp
USER app
VOLUME ["/tmp"]
COPY --from=build /workspace/apps/web/dist ./apps/web/dist
EXPOSE 8080
ENTRYPOINT ["node", "apps/api/src/cli.ts"]
`;

interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runSmoke(args: string[]): Promise<ScriptResult> {
  const env = { ...process.env };
  delete env.RUN_CONTAINER_BUILD; // probes must never touch a docker daemon
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/smoke-container.mjs", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function smokeDockerfile(t: TestContext, content: string): Promise<ScriptResult> {
  const dir = await mkdtemp(join(tmpdir(), "r2d2-smoke-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const dockerfilePath = join(dir, "Dockerfile");
  await writeFile(dockerfilePath, content, "utf8");
  return runSmoke([dockerfilePath]);
}

test("smoke-container accepts the minimal valid fixture and the committed Dockerfile", async (t) => {
  const fixture = await smokeDockerfile(t, VALID_DOCKERFILE);
  assert.equal(fixture.code, 0, `valid fixture Dockerfile must pass, got: ${fixture.stderr}`);
  assert.match(fixture.stdout, /Container definition smoke passed/u);
  const real = await runSmoke([]);
  assert.equal(real.code, 0, `the committed containers/Dockerfile must pass, got: ${real.stderr}`);
});

test("smoke-container pins the digest, not the tag: floating base images fail in both stages", async (t) => {
  // Regression: the original pattern made the sha256 digest OPTIONAL, so a
  // floating tag sailed through a check advertised as "pinned".
  const noDigest = await smokeDockerfile(t, VALID_DOCKERFILE.replace(`@sha256:${DIGEST} AS dependencies`, " AS dependencies"));
  assert.notEqual(noDigest.code, 0, "dependencies stage without a digest must fail");
  assert.match(noDigest.stderr, /digest-pinned Linux dependencies stage/u);

  const floatingRuntime = await smokeDockerfile(t, VALID_DOCKERFILE.replace(`FROM ${PINNED_BASE} AS runtime`, "FROM ubuntu:latest AS runtime"));
  assert.notEqual(floatingRuntime.code, 0, "an unpinned runtime base must fail");
  assert.match(floatingRuntime.stderr, /digest-pinned Linux runtime stage/u);

  const tagOnlyRuntime = await smokeDockerfile(t, VALID_DOCKERFILE.replace(`FROM ${PINNED_BASE} AS runtime`, "FROM node:22.23.2-bookworm-slim AS runtime"));
  assert.notEqual(tagOnlyRuntime.code, 0, "a runtime base pinned only by tag must fail");
});

test("smoke-container accepts a coarse tag when a digest carries the pin", async (t) => {
  const coarse = await smokeDockerfile(t, VALID_DOCKERFILE.replaceAll("node:22.23.2-bookworm-slim@", "node:22-bookworm-slim@"));
  assert.equal(coarse.code, 0, `digest-pinned coarse tags must pass, got: ${coarse.stderr}`);
});

test("smoke-container rejects a later USER directive overriding USER app", async (t) => {
  // Regression: `^USER app$` existence-checking passed Dockerfiles that
  // switched back to root on a later line.
  const override = await smokeDockerfile(t, `${VALID_DOCKERFILE}USER root\n`);
  assert.notEqual(override.code, 0, "USER root after USER app must fail");
  assert.match(override.stderr, /non-root runtime user/u);

  const numericUser = await smokeDockerfile(t, VALID_DOCKERFILE.replace("USER app", "USER 1000"));
  assert.notEqual(numericUser.code, 0, "a non-app USER must fail");

  const impersonator = await smokeDockerfile(t, `${VALID_DOCKERFILE}USER appx\n`);
  assert.notEqual(impersonator.code, 0, "USER appx must not masquerade as USER app");
});

test("smoke-container rejects fixture-mode evasion via quoted or spaced NODE_ENV=test", async (t) => {
  // Regression: the literal NODE_ENV=test pattern missed quoted variants.
  for (const variant of ['ENV NODE_ENV="test"', "ENV NODE_ENV='test'", "ENV NODE_ENV = test", "ENV NODE_ENV=test"]) {
    const result = await smokeDockerfile(t, VALID_DOCKERFILE.replace("ENV NODE_ENV=production \\", `${variant} \\`));
    assert.notEqual(result.code, 0, `${variant} must fail the fixture-mode scan`);
    assert.match(result.stderr, /runtime fixture mode is not allowed/u);
  }
});

test("smoke-container catches forbidden tokens split across shell line continuations", async (t) => {
  // Regression: "a\" + newline + "z" joins to "az" at execution time, but a
  // raw-text scan never matched it.
  const splitAz = await smokeDockerfile(t, `${VALID_DOCKERFILE}RUN a\\\nz deploy --evil\n`);
  assert.notEqual(splitAz.code, 0, "line-continuation-split az must fail");
  assert.match(splitAz.stderr, /Azure invocation is not allowed/u);

  const splitFixture = await smokeDockerfile(t, `${VALID_DOCKERFILE}ENV MODE=fixt\\\nure\n`);
  assert.notEqual(splitFixture.code, 0, "line-continuation-split fixture token must fail");

  for (const variant of ["RUN az deploy\n", "RUN azure-cli login\n", "RUN AZ account show\n", "# fixture harness\n"]) {
    const result = await smokeDockerfile(t, VALID_DOCKERFILE + variant);
    assert.notEqual(result.code, 0, `${JSON.stringify(variant)} must fail the forbidden-token scan`);
  }
});

test("smoke-container rejects TMPDIR prefix evasion and unprefixed /tmp lookalikes", async (t) => {
  // Regression: /TMPDIR=\/tmp/ matched TMPDIR=/tmpX by prefix.
  const prefix = await smokeDockerfile(t, VALID_DOCKERFILE.replace("TMPDIR=/tmp", "TMPDIR=/tmpX"));
  assert.notEqual(prefix.code, 0, "TMPDIR=/tmpX must fail");
  assert.match(prefix.stderr, /temporary directory under \/tmp/u);

  const trailingSlash = await smokeDockerfile(t, VALID_DOCKERFILE.replace("TMPDIR=/tmp", "TMPDIR=/tmp/"));
  assert.equal(trailingSlash.code, 0, `a trailing-slash /tmp is the same directory, got: ${trailingSlash.stderr}`);
});

test("smoke-container anchors EXPOSE, VOLUME, and the web-asset COPY source", async (t) => {
  // Regression: unanchored patterns matched prefixes and wrong sources.
  const exposePrefix = await smokeDockerfile(t, VALID_DOCKERFILE.replace("EXPOSE 8080", "EXPOSE 808080"));
  assert.notEqual(exposePrefix.code, 0, "EXPOSE 808080 must not satisfy EXPOSE 8080");
  assert.match(exposePrefix.stderr, /documented port 8080/u);

  const exposeTcp = await smokeDockerfile(t, VALID_DOCKERFILE.replace("EXPOSE 8080", "EXPOSE 8080/tcp"));
  assert.equal(exposeTcp.code, 0, `EXPOSE 8080/tcp is the documented port, got: ${exposeTcp.stderr}`);

  const widenedVolume = await smokeDockerfile(t, VALID_DOCKERFILE.replace('VOLUME ["/tmp"]', 'VOLUME ["/tmp", "/etc"]'));
  assert.notEqual(widenedVolume.code, 0, "a widened VOLUME declaration must fail");

  const singleQuotedVolume = await smokeDockerfile(t, VALID_DOCKERFILE.replace('VOLUME ["/tmp"]', "VOLUME ['/tmp']"));
  assert.notEqual(singleQuotedVolume.code, 0, "single-quoted VOLUME must fail the exact shape check");

  const wrongSource = await smokeDockerfile(t, VALID_DOCKERFILE.replace("COPY --from=build /workspace/apps/web/dist", "COPY --from=build /dev/null"));
  assert.notEqual(wrongSource.code, 0, "web assets must be copied from the build stage's /workspace/apps/web/dist");
  assert.match(wrongSource.stderr, /built web assets/u);
});

test("smoke-container fails closed when a required stage is absent", async (t) => {
  const missingRuntime = await smokeDockerfile(t, VALID_DOCKERFILE.replace(`FROM ${PINNED_BASE} AS runtime\n`, ""));
  assert.notEqual(missingRuntime.code, 0, "a Dockerfile without a runtime stage must fail");

  const empty = await smokeDockerfile(t, "# nothing to see here\n");
  assert.notEqual(empty.code, 0, "an empty Dockerfile must fail");
});
