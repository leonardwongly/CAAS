// Reproducible local OCI build and digest-bound evidence bundle.
//
// Builds the POC image from containers/Dockerfile (digest-pinned base), records
// the image ID, a deterministic artifact hash of the OCI layout tar, the
// Dockerfile/script/workflow hashes, and image-config assertions (non-root
// runtime user, no credential environment, exposed port 8080). It never pushes
// to a registry and never touches a credential: the runtime CAAS key is absent
// from the image by design and is injected only at runtime by the live lane.
//
// Usage:
//   node scripts/validation/build-oci.mjs              # build and write bundle
//   node scripts/validation/build-oci.mjs --verify     # verify a previous build
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfilePath = resolve(root, "containers/Dockerfile");
const iidFile = resolve(root, "tmp/oci-build-iid.txt");
const layoutTar = resolve(root, "tmp/flight-route-explorer-oci.tar");
const tag = "flight-route-explorer:release-evidence";

function sha256Hex(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Contained tar extraction for the OCI build context: reject absolute member
 * names, parent traversal, and symlink members whose targets escape the
 * context directory. A docker build context must never materialize files
 * outside contextDir. Exported so the adversarial regression suite can feed
 * crafted archives through the exact path the build lane uses.
 */
export async function extractBuildContext(contextTar, contextDir) {
  const listing = (await execFileAsync("tar", ["-tvf", contextTar], { cwd: root, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const listingLines = listing.split("\n").filter(Boolean);
  for (const line of listingLines) {
    // bsdtar: mode links user group size mon day time NAME (9 cols)
    // GNU tar: mode user/group size date time NAME (6 cols)
    const words = line.split(/\s+/);
    const name = words.length >= 9 ? words.slice(8).join(" ") : words.slice(5).join(" ");
    if (!name) throw new Error(`OCI build context listing line unparseable: ${line.slice(0, 80)}`);
    if (name.startsWith("/") || name.split("/").some((segment) => segment === "..")) {
      throw new Error(`OCI build context contains an escaping member name: ${name}`);
    }
    // Symlink members start with 'l' in the mode column: their target is
    // appended after " -> " and must stay inside the context directory.
    if (line.startsWith("l")) {
      // A symlink NAME containing " -> " would defeat the split-based target
      // parse (an escaping target could hide behind a name fragment and pass
      // the containment check). More than one occurrence on a symlink line is
      // unparseable and must fail loudly, never be guessed at. Regular files
      // with " -> " in the name are benign and unaffected.
      const arrowCount = line.split(" -> ").length - 1;
      if (arrowCount > 1) {
        throw new Error(`OCI build context listing line contains an unparseable " -> " sequence: ${line.slice(0, 80)}`);
      }
      const target = arrowCount === 0 ? undefined : line.split(" -> ")[1];
      if (target === undefined || target.startsWith("/") || target.split("/").some((segment) => segment === "..")) {
        throw new Error(`OCI build context contains an escaping symlink member: ${name}`);
      }
    }
  }
  await execFileAsync("tar", ["-xf", contextTar, "-C", contextDir], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  await assertContainedContext(contextDir);
}

/**
 * Platform-independent backstop for extracted build contexts: some tar
 * flavors garble listings whose member names contain " -> " (e.g. macOS
 * bsdtar reports "Damaged tar archive" while exiting 0). Whatever the
 * extraction produced, walk the result WITHOUT following symlinks and reject
 * any symlink whose target resolves outside the context directory — an
 * escaping symlink must never reach the docker build context on any
 * platform. Exported so the adversarial suite can exercise the backstop
 * directly, deterministically, on every platform.
 */
export async function assertContainedContext(contextDir) {
  const stack = [""];
  while (stack.length > 0) {
    const relative = stack.pop();
    const absolute = resolve(contextDir, relative);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolved = resolve(dirname(absolute), target);
      const inside = resolved === contextDir || resolved.startsWith(contextDir + sep);
      if (!inside) {
        throw new Error(`OCI build context extraction materialized an escaping symlink: ${relative} -> ${target}`);
      }
    } else if (stats.isDirectory()) {
      for (const entry of await readdir(absolute)) stack.push(join(relative, entry));
    }
  }
}

async function sha256OfFile(path) {
  return sha256Hex(await readFile(path));
}

async function currentCommit() {
  try {
    return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  } catch {
    return "local-uncommitted";
  }
}

async function docker(args, options = {}) {
  try {
    return await execFileAsync("docker", args, { cwd: root, maxBuffer: 32 * 1024 * 1024, ...options });
  } catch (error) {
    const detail = typeof error.stderr === "string" && error.stderr.trim() ? `: ${error.stderr.trim().split("\n").slice(-3).join(" ")}` : "";
    throw new Error(`docker ${args.join(" ")} failed with exit ${error.code ?? "unknown"}${detail}`);
  }
}

function parseArgs(argv) {
  return { verify: argv.includes("--verify") };
}

// The image subject must bind the committed tree, not a dirty working tree.
// When OCI_BUILD_CONTEXT_TAR is set, the build context is a tar of the
// committed HEAD tree (`git archive`), so uncommitted edits from other
// workstreams never leak into the evidence-bound image.
async function buildImage() {
  if (process.env.OCI_BUILD_CONTEXT_TAR) {
    const contextTar = resolve(root, "tmp/oci-build-context.tar");
    const contextDir = resolve(root, "tmp/oci-build-context");
    await rm(contextDir, { recursive: true, force: true });
    await mkdir(contextDir, { recursive: true });
    await execFileAsync("git", ["archive", "--format=tar", "-o", contextTar, "HEAD"], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    await extractBuildContext(contextTar, contextDir);
    return docker(["build", "--pull=false", "-f", dockerfilePath, "-t", tag, "--iidfile", iidFile, contextDir]);
  }
  return docker(["build", "--pull=false", "-f", dockerfilePath, "-t", tag, "--iidfile", iidFile, root]);
}

// Main entry: the build + evidence writes run ONLY when this script is the
// direct entry point. Importing the module (e.g. tests exercising
// extractBuildContext) must be side-effect free — never a docker build, never
// an evidence write. This is the same main-guard the evidence validator uses.
const isMain = import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href;
if (isMain) {
  const { verify } = parseArgs(process.argv.slice(2));

  const dockerfile = await readFile(dockerfilePath, "utf8");
  const pinnedBasePattern = /^FROM node:22\.23\.2-bookworm-slim@sha256:[0-9a-f]{64} AS (dependencies|runtime)$/m;
  const pinnedBases = dockerfile.match(/@sha256:[0-9a-f]{64}/g) ?? [];
  if (verify) {
    if (pinnedBases.length < 2) throw new Error("oci verify failed: containers/Dockerfile must pin both stages by digest");
  } else if (!pinnedBasePattern.test(dockerfile)) {
    throw new Error("oci build failed: containers/Dockerfile must pin node:22.23.2-bookworm-slim by digest for every stage");
  }

  if (!verify) {
    await mkdir(resolve(root, "tmp"), { recursive: true });
    await buildImage();
  }

  const imageId = (await readFile(iidFile, "utf8")).trim();
  const configJson = (await docker(["image", "inspect", "--format", "{{json .Config}}", imageId])).stdout;
  const config = JSON.parse(configJson);
  const osInfo = { os: JSON.parse((await docker(["image", "inspect", "--format", "{{json .Os}}", imageId])).stdout), architecture: JSON.parse((await docker(["image", "inspect", "--format", "{{json .Architecture}}", imageId])).stdout) };

  const env = Object.fromEntries((config.Env ?? []).map((entry) => {
    const index = entry.indexOf("=");
    return index === -1 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
  }));
  const secretEnvKeys = Object.keys(env).filter((key) => /api|key|secret|token|credential|password/i.test(key));
  const secretLikeValues = Object.values(env).filter((value) => /^[A-Za-z0-9._-]{16,}$/.test(value) && !/^(production|8080|0\.0\.0\.0|1|true|false|localhost|127\.0\.0\.1|workspace|\/app|\/tmp)$/i.test(value));

  await docker(["save", "-o", layoutTar, imageId]);
  const tarBytes = (await stat(layoutTar)).size;
  const tarSha256 = await sha256OfFile(layoutTar);

  const commit = await currentCommit();
  const short = commit.slice(0, 12);
  const nowIso = new Date().toISOString();

  const bundle = {
    recordKind: "oci-digest-bundle",
    subject: {
      type: "oci",
      identifiers: { digest: imageId, commit, tarSha256 },
      environment: process.env.CI === "true" ? "ci-build" : verify ? "local-verify" : "local-build",
    },
    image: {
      tag,
      imageId,
      osArchitecture: osInfo,
      config: {
        user: config.User ?? "",
        workingDir: config.WorkingDir ?? "",
        exposedPorts: Object.keys(config.ExposedPorts ?? {}).sort(),
        envKeys: Object.keys(env).sort(),
      },
      artifactTar: { path: "tmp/flight-route-explorer-oci.tar", sha256: tarSha256, bytes: tarBytes },
    },
    sourceHashes: {
      dockerfile: await sha256OfFile(dockerfilePath),
      buildScript: await sha256OfFile(resolve(root, "scripts/validation/build-oci.mjs")),
    },
    reproducibility: {
      baseImagePinnedByDigest: true,
      installFrozenLockfile: dockerfile.includes("pnpm install --frozen-lockfile"),
      networkAtBuildTime: "pnpm registry fetch inside the build; no live CAAS call and no cloud write",
      registryPush: "never performed by this script",
    },
    buildMetadata: { builder: await (async () => { try { return (await docker(["version", "--format", "{{.Client.Version}}"])).stdout.trim(); } catch { return "unknown"; } })(), contextSource: process.env.OCI_BUILD_CONTEXT_TAR ? "git-archive@HEAD" : "working-tree", startedAt: nowIso, verifiedAt: verify ? nowIso : undefined },
  };

  // Honest image assertions: fail loudly instead of recording an unverified claim.
  const assertions = {
    nonRootUser: config.User !== "" && !/^0(?:[^0-9]|$)|^root$/.test(config.User),
    noSecretEnv: secretEnvKeys.length === 0 && secretLikeValues.length === 0,
    exposes8080: Object.keys(config.ExposedPorts ?? {}).includes("8080/tcp"),
    linuxImage: osInfo.os === "linux",
  };
  bundle.assertions = assertions;
  for (const [name, ok] of Object.entries(assertions)) {
    if (!ok) {
      console.error(`oci assertions failed: ${name}`);
      process.exitCode = 1;
    }
  }

  const bundleRelative = `docs/evidence/oci-digest-bundle-${short}.json`;
  const bundleAbsolute = resolve(root, bundleRelative);
  await mkdir(dirname(bundleAbsolute), { recursive: true });
  await writeFile(bundleAbsolute, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  const bundleSha = await sha256OfFile(bundleAbsolute);
  console.log(`OCI image ${imageId}`);
  console.log(`OCI layout tar: ${tarSha256} (${tarBytes} bytes) at tmp/flight-route-explorer-oci.tar`);
  console.log(`Digest bundle written to ${bundleRelative} (sha256 ${bundleSha})`);
  console.log(`Image assertions: ${JSON.stringify(assertions)}`);
  if (verify) await rm(layoutTar, { force: true });
  process.exitCode = process.exitCode ?? 0;
}
