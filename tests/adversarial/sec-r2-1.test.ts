// Adversarial regression test (sec-r2-1): evidence/gate artifact paths must be
// contained under the validation root and name regular files.
//
// North-star contract: gate manifests and lane records bind artifact evidence
// as repo-relative paths with SHA-256 hashes (README: "no command should be
// described as passed until ... artifact hash are retained in a gate
// manifest"; docs/testing/evidence-and-validation.md: retained records carry
// "real SHA-256 artifact hashes"). A validator that resolves artifact.path
// against the repo root and readFile()s whatever comes back must not be usable
// as (a) an arbitrary host-file reader whose content-verification answer leaks
// file existence/content, or (b) a hang vector: readFile on a non-regular file
// such as /dev/zero never reaches EOF. Correct behavior: an artifact whose
// path is absolute, escapes the base directory (via .. or a symlink), or names
// a non-regular file must error "artifact is invalid" WITHOUT opening the
// file, and the validator must always complete in bounded time.
//
// Baseline (buggy) behavior observed before this test:
//   - artifact.path = process.execPath (absolute, outside the repo) with the
//     CORRECT sha256 -> validateManifest returns ZERO errors (host file read
//     and accepted as evidence);
//   - same path with a wrong sha256 -> "artifact hash mismatch: <abs path>"
//     (content-verification oracle on an arbitrary host file);
//   - artifact.path = "/dev/zero" -> readFile never EOFs; the child process
//     had to be SIGTERM-killed at 4s with no output.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateManifest } from "../../scripts/validation/validate-offline.mjs";

const root = resolve(import.meta.dirname, "../..");
const testsDir = resolve(import.meta.dirname, "..");

// An absolute path outside the repo that is guaranteed to exist and be
// readable on every platform (plays the role of /etc/hosts in the finding).
const outsideTarget = process.execPath;

async function loadFixture(): Promise<Record<string, unknown>> {
  const fixture = JSON.parse(
    await readFile(resolve(root, "tests/fixtures/evidence-manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  return structuredClone(fixture);
}

function setArtifact(manifest: Record<string, unknown>, path: string, sha256: string): void {
  const checks = manifest.checks as Array<Record<string, unknown>>;
  checks[0]!.artifacts = [{ path, sha256 }];
}

async function digestOf(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

// Runs validateManifest inside a fresh child process with a hard wall-clock
// bound, so a validator that hangs (device files) fails this test instead of
// hanging the suite. Returns the errors the child reported.
function runValidatorInChild(path: string, sha256: string, timeoutMs = 5000): Promise<string[]> {
  const driver = `
import { validateManifest } from "../scripts/validation/validate-offline.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const fixture = JSON.parse(await readFile(resolve(${JSON.stringify(root)}, "tests/fixtures/evidence-manifest.json"), "utf8"));
fixture.checks[0].artifacts = [{ path: ${JSON.stringify(path)}, sha256: ${JSON.stringify(sha256)} }];
const errors = await validateManifest(fixture, ${JSON.stringify(root)});
console.log("DRIVER_DONE", JSON.stringify(errors));
`;
  return new Promise<string[]>((resolvePromise, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", driver],
      { timeout: timeoutMs, cwd: testsDir },
      (error, stdout) => {
        if (error) {
          const killed = error.killed === true;
          reject(new Error(`validator child did not finish within ${timeoutMs}ms${killed ? " (killed: hung read)" : ""}: ${error.message}`));
          return;
        }
        const out = typeof stdout === "string" ? stdout : String(stdout);
        const match = /DRIVER_DONE\s+(.*)/.exec(out);
        if (!match) {
          reject(new Error(`driver produced no DRIVER_DONE marker; stdout: ${out}`));
          return;
        }
        resolvePromise(JSON.parse(match[1]!) as string[]);
      },
    );
  });
}

test("control: an unmodified valid relative artifact still passes", async () => {
  const manifest = await loadFixture();
  const errors = await validateManifest(manifest, root);
  assert.deepEqual(errors, [], "the control fixture must validate clean so the adversarial cases isolate the path-containment defect");
});

test("an absolute artifact path is rejected as artifact-invalid without being opened", async () => {
  const manifest = await loadFixture();
  setArtifact(manifest, outsideTarget, await digestOf(outsideTarget));
  const errors = await validateManifest(manifest, root);
  assert.ok(
    errors.some((error) => error.includes("artifact is invalid")),
    `an absolute artifact.path must error "artifact is invalid" instead of reading the host file; got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((error) => error.includes("hash mismatch")),
    "the file must never be opened: a hash-mismatch result means the absolute path was read",
  );
});

test("a wrong-hash absolute path must not leak a hash-mismatch oracle", async () => {
  const manifest = await loadFixture();
  setArtifact(manifest, outsideTarget, "0".repeat(64));
  const errors = await validateManifest(manifest, root);
  assert.ok(
    errors.some((error) => error.includes("artifact is invalid")),
    `the hash-mismatch oracle naming the absolute path must be replaced by "artifact is invalid"; got: ${JSON.stringify(errors)}`,
  );
  assert.ok(!errors.some((error) => error.includes("hash mismatch")), "no hash-mismatch oracle may be reported for a path outside the repo");
});

test("a symlink escaping the base directory is rejected as artifact-invalid", async () => {
  const base = await mkdtemp(join(tmpdir(), "sec-r2-1-"));
  try {
    await symlink(outsideTarget, join(base, "escaped"));
    const manifest = await loadFixture();
    setArtifact(manifest, "escaped", await digestOf(outsideTarget));
    const errors = await validateManifest(manifest, base);
    assert.ok(
      errors.some((error) => error.includes("artifact is invalid")),
      `a symlink escaping the base directory must error "artifact is invalid"; got: ${JSON.stringify(errors)}`,
    );
    assert.ok(!errors.some((error) => error.includes("hash mismatch")), "the symlink target must never be opened");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a device-file artifact (/dev/zero) must error artifact-invalid in bounded time, never hang", async () => {
  const errors = await runValidatorInChild("/dev/zero", "0".repeat(64));
  assert.ok(
    errors.some((error) => error.includes("artifact is invalid")),
    `a non-regular artifact path must error "artifact is invalid" without opening the device; got: ${JSON.stringify(errors)}`,
  );
});
