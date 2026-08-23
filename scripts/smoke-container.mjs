import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
// An optional positional argument points the smoke at an alternate Dockerfile
// (adversarial fixtures); the committed container definition remains default.
const dockerfilePath = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "containers/Dockerfile");
const dockerfile = await readFile(dockerfilePath, "utf8");

// Shell/Dockerfile line continuations join physical lines, so forbidden-token
// scans also run over the continuation-normalized text ("a\" + newline + "z"
// is "az" at execution time).
const normalized = dockerfile.replace(/\\\r?\n/g, "");

// The digest, not the tag, is the pin: a floating tag such as
// node:22-bookworm-slim only counts as pinned when a sha256 digest is present.
const pinnedBase = "node:22(?:\\.\\d+){0,2}-bookworm-slim@sha256:[0-9a-f]{64}";
const requiredPatterns = [
  [new RegExp(`^FROM ${pinnedBase} AS dependencies$`, "m"), "a digest-pinned Linux dependencies stage"],
  [/^FROM .* AS build$/m, "a separate build stage"],
  [new RegExp(`^FROM ${pinnedBase} AS runtime$`, "m"), "a digest-pinned Linux runtime stage"],
  [/^USER app$/m, "a non-root runtime user"],
  [/TMPDIR=\/tmp\/?(?=\s|$)/m, "a temporary directory under /tmp"],
  [/^VOLUME \["\/tmp"\]$/m, "a writable /tmp volume"],
  [/^COPY --from=build \/workspace\/apps\/web\/dist\b/m, "the built web assets"],
  [/^EXPOSE 8080(?:\/(?:tcp|udp))?$/m, "the documented port 8080"],
];
for (const [pattern, description] of requiredPatterns) {
  if (!pattern.test(dockerfile)) throw new Error(`Container smoke failed: missing ${description}`);
}
// A later USER directive silently overrides an earlier one: every USER line in
// the file must be exactly `USER app`, or the non-root invariant is void.
for (const text of [dockerfile, normalized]) {
  if (/^USER\s+(?!app$)\S+/m.test(text)) throw new Error("Container smoke failed: a non-root runtime user");
  if (/\b(?:az|azure)\b/i.test(text)) throw new Error("Container smoke failed: Azure invocation is not allowed");
  if (/fixture|fake-runtime|NODE_ENV\s*=\s*["']?test/i.test(text)) throw new Error("Container smoke failed: runtime fixture mode is not allowed");
}

if (process.env.RUN_CONTAINER_BUILD === "1") {
  await new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["build", "--pull=false", "-f", dockerfilePath, "-t", "flight-route-explorer:smoke", root], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`docker build exited with ${code}`)));
  });
  console.log("Offline container build smoke passed.");
} else {
  console.log("Container definition smoke passed; set RUN_CONTAINER_BUILD=1 to run an optional daemon-backed build.");
}
