// Measured security evidence. Honest, hermetic, offline: scans the tracked
// repository for credential material, verifies no .env is tracked, verifies the
// .env.example contains only placeholders, verifies response security headers
// on the fixture-backed loopback server, and re-asserts image metadata
// (non-root, no secret env) when the image is built locally. The networked
// package audit is never run here: its committed record
// (docs/security/dependency-audit-local.json) is read and bound by sha256,
// never invented.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CheckCollector, isoNow, reportAndExit, root, sha256Hex, shortSha, writeJsonRecord } from "./lib-evidence.mjs";
import { FIXTURE_API_KEY, FIXTURE_REFRESH_SECRET } from "./fixtures.mjs";

const short = shortSha();
const recordPath = `docs/evidence/security-local-${short}.json`;
const collector = new CheckCollector();
const startedAt = isoNow();

const SELF_ARTIFACT = { path: "scripts/validation/measure-security.mjs", sha256: sha256Hex(await readFile(resolve(root, "scripts/validation/measure-security.mjs"), "utf8")) };
const artifactsFor = (extra = []) => [SELF_ARTIFACT, ...extra];

const trackedFiles = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
const textFiles = trackedFiles.filter((path) => !/(?:\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|eot|lockb|jar|zip))$/i.test(path));

// 1. Credential-material scan across tracked files.
const credentialPatterns = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/, "private key material"],
  [/aws_secret_access_key\s*[:=]\s*\S+/i, "AWS secret access key"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/github_pat_[0-9A-Za-z_]{20,}|ghp_[0-9A-Za-z]{30,}/, "GitHub token"],
  [/xox[baprs]-[0-9A-Za-z-]{10,}/, "Slack token"],
];
const credentialHits = [];
for (const path of textFiles) {
  const contents = await readFile(resolve(root, path), "utf8").catch(() => "");
  for (const [pattern, label] of credentialPatterns) {
    if (pattern.test(contents)) credentialHits.push({ path, label });
  }
}
collector.pass("SEC-CREDENTIAL-SCAN", "no credential material in tracked files", "No private keys, AWS/GitHub/Slack tokens, or similar material appears in any tracked file.", startedAt, isoNow(),
  credentialHits.length === 0, "hits", Math.max(1, credentialHits.length), artifactsFor(credentialHits.slice(0, 5).map((hit) => ({ path: hit.path, sha256: "redacted-location-only", metadata: { label: hit.label } }))));

// 2. No .env is tracked; .env.example holds only placeholders.
const envTracked = trackedFiles.filter((path) => /(?:^|\/)\.env(?:$|\.)/.test(path));
collector.pass("SEC-DOTENV-NOT-TRACKED", "no local .env tracked", "The only tracked .env* file is .env.example.", startedAt, isoNow(),
  envTracked.length === 1 && envTracked[0] === ".env.example", "files", envTracked.length, artifactsFor());
const envExample = await readFile(resolve(root, ".env.example"), "utf8").catch(() => "");
// HOST/PORT are documented non-secret defaults, not credentials; the check
// guards credential-shaped values only (the CAAS key must stay a placeholder).
const credentialShapedValues = [...envExample.matchAll(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]?([^'"\n]*)['"]?\s*$/gm)]
  .map((match) => ({ key: match[1] ?? "", value: (match[2] ?? "").trim() }))
  .filter(({ key }) => !/^(HOST|PORT)$/i.test(key));
const allPlaceholders = credentialShapedValues.every(({ value }) => value === "" || /^(?:your-|changeme|replace-with|<[^>]+>|\[[^\]]+\]|example|xxxxx|n\/a|none)/i.test(value));
collector.pass("SEC-ENV-EXAMPLE-PLACEHOLDER", ".env.example contains only placeholders", "Every credential-shaped value in .env.example is a documented placeholder, not a real credential.", startedAt, isoNow(),
  allPlaceholders, "values", credentialShapedValues.length, artifactsFor());

// 3. Fixture credentials appear only where fixtures are documented.
const fixtureOnlyIn = new Set(["scripts/validation", "tests"]);
const fixtureLeaks = [];
for (const path of textFiles) {
  if (fixtureOnlyIn.has(path.split("/")[0]) || [...fixtureOnlyIn].some((prefix) => path.startsWith(`${prefix}/`))) continue;
  const contents = await readFile(resolve(root, path), "utf8").catch(() => "");
  if (contents.includes(FIXTURE_API_KEY) || contents.includes(FIXTURE_REFRESH_SECRET)) fixtureLeaks.push(path);
}
collector.pass("SEC-FIXTURE-SCOPE", "fixture credentials scoped to fixtures", "The loopback fixture apikey/refresh secret appear only in scripts/validation and tests.", startedAt, isoNow(),
  fixtureLeaks.length === 0, "files", Math.max(1, fixtureLeaks.length), artifactsFor(fixtureLeaks.slice(0, 5).map((path) => ({ path, sha256: "redacted-location-only", metadata: { note: "fixture value leak" } }))));

// 4. Response security headers on the fixture-backed server.
const { createApiServer } = await import("../../apps/api/src/index.ts");
const { createCaasAdapter } = await import("../../packages/upstream-caas/src/index.ts");
const { createMockTransport } = await import("./fixtures.mjs");
process.env.apikey = FIXTURE_API_KEY;
const server = await createApiServer({ adapter: createCaasAdapter({ transport: createMockTransport() }) });
await server.app.listen({ port: 0, host: "127.0.0.1" });
const address = server.app.server.address();
const base = `http://127.0.0.1:${address.port}`;
const response = await fetch(`${base}/api/v1/health/live`);
const headers = Object.fromEntries(response.headers.entries());
const expected = ["content-security-policy", "referrer-policy", "strict-transport-security", "x-content-type-options", "x-frame-options", "permissions-policy"];
const missing = expected.filter((name) => headers[name] === undefined);
collector.pass("SEC-RESPONSE-HEADERS", "documented response security headers", "All documented security headers present on API responses.", startedAt, isoNow(),
  missing.length === 0, "headers", expected.length, artifactsFor(missing.map((name) => ({ path: "header", sha256: "none", metadata: { name } }))));
await server.app.close();

// 5. Image metadata (non-root, no secret env) when built locally; pending otherwise.
let imageId = "";
try {
  imageId = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", "flight-route-explorer:release-evidence"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  imageId = "";
}
if (imageId) {
  const config = JSON.parse(execFileSync("docker", ["image", "inspect", "--format", "{{json .Config}}", imageId], { cwd: root, encoding: "utf8" }));
  const user = config.User ?? "";
  const envKeys = (config.Env ?? []).map((entry) => entry.split("=", 1)[0]);
  const secretKeys = envKeys.filter((key) => /api|key|secret|token|credential|password/i.test(key));
  collector.pass("SEC-IMAGE-NON-ROOT", "image runs as non-root", "The built image's runtime user is not root.", startedAt, isoNow(), user === "app", "user", 1, artifactsFor());
  collector.pass("SEC-IMAGE-NO-SECRET-ENV", "image has no credential environment", "No apikey/secret/token environment is baked into the image.", startedAt, isoNow(), secretKeys.length === 0, "keys", Math.max(1, secretKeys.length), artifactsFor());
} else {
  collector.add({
    checkId: "SEC-IMAGE-METADATA", name: "image metadata checks", procedure: "Build the image first with `pnpm oci:build`, then re-run this lane; non-root user and no credential environment are then asserted from the real image config.",
    startedAt, endedAt: isoNow(), result: "blocked",
    measurement: { summary: "image not built locally; metadata pending", value: null, units: "boolean", sampleCount: 1 },
    artifacts: artifactsFor(), failureFallback: "Keep the security gate blocked until the built image is inspected.",
  });
}

// 6. Networked package audit: the authorized local run's record is committed
// at docs/security/dependency-audit-local.json (the raw `pnpm audit --prod
// --json` output, pnpm 11.5.2, frozen pnpm-lock.yaml). The lane stays
// hermetic — it reads the committed record, never the network. The CI
// dependency-audit job re-runs the same invocation on every push and PR.
const AUDIT_RECORD = "docs/security/dependency-audit-local.json";
let auditCheck;
try {
  const auditText = await readFile(resolve(root, AUDIT_RECORD), "utf8");
  const audit = JSON.parse(auditText);
  const advisories = Object.keys(audit.advisories ?? {}).length;
  const vulnerabilities = audit.metadata?.vulnerabilities ?? {};
  auditCheck = advisories === 0 ? {
    checkId: "SEC-PACKAGE-AUDIT", name: "dependency audit against registry",
    procedure: `Authorized networked run (pnpm 11.5.2): \`pnpm audit --prod --json\` against the frozen pnpm-lock.yaml, with the committed record bound by sha256. The CI dependency-audit job re-runs the identical invocation on every push and PR.`,
    startedAt, endedAt: isoNow(), result: "pass",
    measurement: { summary: `${advisories} advisories in production dependencies at audit time`, value: 0, units: "vulnerabilities", sampleCount: 1 },
    artifacts: artifactsFor([{ path: AUDIT_RECORD, sha256: sha256Hex(auditText) }]),
    failureFallback: "Keep the security gate failed until a clean audit result is recorded.",
  } : {
    checkId: "SEC-PACKAGE-AUDIT", name: "dependency audit against registry",
    procedure: `Authorized networked run (pnpm 11.5.2): \`pnpm audit --prod --json\` against the frozen pnpm-lock.yaml. The committed record reports ${advisories} advisories (${JSON.stringify(vulnerabilities)}) and must not pass until they are remediated.`,
    startedAt, endedAt: isoNow(), result: "fail",
    measurement: { summary: `${advisories} advisories in production dependencies at audit time`, value: advisories, units: "vulnerabilities", sampleCount: 1 },
    artifacts: artifactsFor([{ path: AUDIT_RECORD, sha256: sha256Hex(auditText) }]),
    failureFallback: "Remediate or document every advisory before the security gate can pass.",
  };
} catch {
  auditCheck = {
    checkId: "SEC-PACKAGE-AUDIT", name: "dependency audit against registry", procedure: `Pending an authorized networked run: \`pnpm audit --prod\` against the frozen pnpm-lock.yaml (pnpm 11.5.2), commit the resulting record at ${AUDIT_RECORD}. Not run here because the validation lanes are hermetic/offline.`,
    startedAt, endedAt: isoNow(), result: "blocked",
    measurement: { summary: "pending authorized networked audit", value: null, units: "vulnerabilities", sampleCount: 1 },
    artifacts: artifactsFor(), failureFallback: "Keep the security gate blocked until a real audit records a result.",
  };
}
collector.add(auditCheck);

const record = {
  recordKind: "measurement-results",
  lane: "security",
  subject: { type: "commit", identifiers: { commit: short }, environment: "local-hermetic" },
  startedAt,
  endedAt: isoNow(),
  scope: "tracked-file secret scan, .env tracking, fixture scope, response headers on fixture-backed server, image metadata when built",
  checks: collector.checks,
  summary: collector.summary(),
  artifacts: artifactsFor(),
};
const fileSha = await writeJsonRecord(recordPath, record);
console.log(`Security record written to ${recordPath} (sha256 ${fileSha})`);
reportAndExit(collector, "SECURITY MEASUREMENT (hermetic, offline)");
