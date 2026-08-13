// Loopback container lane. Runs the built OCI image WITHOUT any credential and
// asserts the container fails closed (the runtime must not start without the
// CAAS key), plus image metadata checks: non-root user, port 8080, no secret
// environment, digest-pinned base. This is the container-half of the loopback
// gate; the five-family mechanics run host-side in loopback-lane.mjs because
// the image has no fixture mode by design (smoke-container.mjs forbids it).
//
// Authorized live run procedure (pending): build with
// `pnpm oci:build`, then run the image with the authorized credential
// (e.g. `docker run --rm -p 8080:8080 -e apikey=<authorized-key> <image>`)
// and verify `GET /api/v1/health/ready` reaches status "ready" with all five
// families; that run must be executed by an authorized person and its record
// committed. This lane never invents that run.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { CheckCollector, isoNow, reportAndExit, root, sha256Hex, shortSha, writeJsonRecord } from "./lib-evidence.mjs";

const short = shortSha();
const recordPath = `docs/evidence/loopback-container-local-${short}.json`;
const collector = new CheckCollector();
const startedAt = isoNow();

const SELF_ARTIFACT = { path: "scripts/validation/loopback-container-lane.mjs", sha256: sha256Hex(await readFile(resolve(root, "scripts/validation/loopback-container-lane.mjs"), "utf8")) };
const artifactsFor = (extra = []) => [SELF_ARTIFACT, ...extra];

function dockerInspect(template, imageId) {
  return execFileSync("docker", ["image", "inspect", "--format", template, imageId], { encoding: "utf8", cwd: root }).trim();
}

const dockerfile = await readFile(resolve(root, "containers/Dockerfile"), "utf8");
const digestPinCount = (dockerfile.match(/@sha256:[0-9a-f]{64}/g) ?? []).length;
collector.pass("CONTAINER-BASE-DIGEST-PINNED", "base image digest-pinned", "Every base-image stage pins node:22.14.0-bookworm-slim by digest for reproducibility.", startedAt, isoNow(), digestPinCount >= 2, "stages", digestPinCount, artifactsFor());

const imageTag = "flight-route-explorer:release-evidence";
let imageId;
try {
  imageId = dockerInspect("{{.Id}}", imageTag);
} catch {
  imageId = "";
}
const imageBuilt = imageId !== "";
collector.pass("CONTAINER-IMAGE-PRESENT", "OCI image built", "The release-evidence image exists locally (built by scripts/validation/build-oci.mjs).", startedAt, isoNow(), imageBuilt, "boolean", 1, artifactsFor());
if (!imageBuilt) {
  collector.add({
    checkId: "CONTAINER-FAIL-CLOSED-WITHOUT-CREDENTIAL",
    name: "container fails closed without a credential",
    procedure: "Cannot run: the OCI image is not built. Run `pnpm oci:build` first.",
    startedAt, endedAt: isoNow(), result: "blocked",
    measurement: { summary: "image missing locally", value: null, units: "boolean", sampleCount: 1 },
    artifacts: artifactsFor(), failureFallback: "Keep PG-03 blocked until the built image is present and inspected.",
  });
} else {
  const config = JSON.parse(dockerInspect("{{json .Config}}", imageId));
  const osArch = dockerInspect("{{.Os}}/{{.Architecture}}", imageId);
  const user = config.User ?? "";
  const env = Object.fromEntries((config.Env ?? []).map((entry) => {
    const index = entry.indexOf("=");
    return index === -1 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
  }));
  const secretEnvKeys = Object.keys(env).filter((key) => /api|key|secret|token|credential|password/i.test(key));
  const exposed = Object.keys(config.ExposedPorts ?? {}).sort();

  collector.pass("CONTAINER-NON-ROOT", "non-root runtime user", "The runtime user is the unprivileged `app` user.", startedAt, isoNow(), user === "app", "user", 1, artifactsFor());
  collector.pass("CONTAINER-PORT-8080", "documented port exposed", "The image exposes TCP port 8080.", startedAt, isoNow(), exposed.includes("8080/tcp"), "ports", exposed.length, artifactsFor());
  collector.pass("CONTAINER-NO-SECRET-ENV", "no credential in image environment", "No apikey/secret/token environment variable is baked into the image.", startedAt, isoNow(), secretEnvKeys.length === 0, "keys", Math.max(1, secretEnvKeys.length), artifactsFor());
  collector.pass("CONTAINER-LINUX", "linux image", "The image is a Linux image per its metadata (CI builds the amd64 authoritative subject).", startedAt, isoNow(), osArch.startsWith("linux/"), "os/arch", 1, artifactsFor());

  // Fail-closed boot without a credential: run with no environment, expect a
  // non-zero exit from the missing-key error within a bounded window.
  const bootStartedAt = Date.now();
  const { spawn } = await import("node:child_process");
  const spawned = await new Promise((resolvePromise) => {
    const child = spawn("docker", ["run", "--rm", "--network", "none", imageId], { stdio: "ignore", cwd: root });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolvePromise({ exit: "timeout", durationMs: 120000 }); }, 120000);
    child.once("exit", (code) => { clearTimeout(timer); resolvePromise({ exit: code, durationMs: Date.now() - bootStartedAt }); });
    child.once("error", (error) => { clearTimeout(timer); resolvePromise({ exit: `error:${error.message}`, durationMs: 0 }); });
  });
  collector.pass("CONTAINER-FAIL-CLOSED-WITHOUT-CREDENTIAL", "container fails closed without a credential", "Without a credential the container must exit non-zero (never start serving); a live call must not be attempted.", startedAt, isoNow(),
    spawned.exit !== 0 && spawned.exit !== "timeout", "boolean", 1, artifactsFor([{ path: "spawn", sha256: "none", metadata: { exit: String(spawned.exit), durationMs: spawned.durationMs } }]));
}

const record = {
  recordKind: "lane-results",
  lane: "loopback-container-lane",
  subject: { type: "oci", identifiers: { digest: imageId || "not-built", commit: short }, environment: "local-container-metadata" },
  startedAt,
  endedAt: isoNow(),
  mode: "fail-closed-metadata",
  credentialHandling: "no credential supplied to the container; no live origin call attempted",
  procedure: "Authorized live container run: build with `pnpm oci:build`, then `docker run --rm -p 8080:8080 -e apikey=<authorized-key> flight-route-explorer:release-evidence` and verify `GET /api/v1/health/ready` reports status ready with all five families; commit the resulting record.",
  checks: collector.checks,
  summary: collector.summary(),
  artifacts: artifactsFor(),
};
const fileSha = await writeJsonRecord(recordPath, record);
console.log(`Container lane record written to ${recordPath} (sha256 ${fileSha})`);
reportAndExit(collector, "LOOPBACK CONTAINER LANE (fail-closed + metadata)");
