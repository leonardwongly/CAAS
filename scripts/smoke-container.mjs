import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const dockerfilePath = resolve(root, "containers/Dockerfile");
const dockerfile = await readFile(dockerfilePath, "utf8");

const requiredPatterns = [
  [/^FROM node:22(?:\.\d+){0,2}-bookworm-slim(?:@sha256:[0-9a-f]{64})? AS dependencies$/m, "a pinned Linux dependencies stage"],
  [/^FROM .* AS build$/m, "a separate build stage"],
  [/^FROM .* AS runtime$/m, "a separate runtime stage"],
  [/^USER app$/m, "a non-root runtime user"],
  [/TMPDIR=\/tmp/, "a temporary directory under /tmp"],
  [/VOLUME \[\"\/tmp\"\]/, "a writable /tmp volume"],
  [/COPY --from=build .*apps\/web\/dist/, "the built web assets"],
  [/EXPOSE 8080/, "the documented port 8080"],
];
for (const [pattern, description] of requiredPatterns) {
  if (!pattern.test(dockerfile)) throw new Error(`Container smoke failed: missing ${description}`);
}
if (/\b(?:az|azure)\b/i.test(dockerfile)) throw new Error("Container smoke failed: Azure invocation is not allowed");
if (/fixture|fake-runtime|NODE_ENV=test/i.test(dockerfile)) throw new Error("Container smoke failed: runtime fixture mode is not allowed");

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
