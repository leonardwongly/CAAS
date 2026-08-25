// Owner: R2-D6 — fixture integrity (round-2 adversarial sweep 2026-08-23).
//
// Two integrity guarantees the fixture set must never lose:
//   1. Sanitization completeness — the five checked-in fixtures are consumed
//      by offline lanes and must contain no residual live identifiers: the
//      production CAAS origin, URLs, hostnames, emails, tenant/resource
//      GUIDs, credential assignments, secret-length tokens, live callsign
//      shapes, or bare ICAO airport-shaped identifiers. The scan binds the
//      "live origin" notion to the real CAAS_ORIGIN in
//      packages/upstream-caas/src/config.ts rather than a hardcoded guess.
//   2. Evidence manifest consistency — tests/fixtures/evidence-manifest.json
//      stays structurally consistent with deploy/evidence-manifest.schema.json
//      (constraints derived from the schema file itself, not re-typed) and its
//      artifact sha256 binds the real bytes of the sanitized evidence file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { CAAS_ORIGIN } from "../../packages/upstream-caas/src/config.ts";

const root = resolve(import.meta.dirname, "../..");

const FIXTURE_FILES = [
  "tests/fixtures/web-app.ts",
  "tests/fixtures/caas-fixtures.ts",
  "tests/fixtures/sanitized-caas.ts",
  "tests/fixtures/sanitized-evidence.txt",
  "tests/fixtures/evidence-manifest.json",
] as const;

async function fixtureSources(): Promise<Array<{ path: string; source: string }>> {
  return Promise.all(FIXTURE_FILES.map(async (path) => ({ path, source: await readFile(resolve(root, path), "utf8") })));
}

test("no fixture mentions the live CAAS origin", async () => {
  const liveHost = new URL(CAAS_ORIGIN).hostname.toLowerCase();
  assert.ok(liveHost.includes("."), "the live origin is a real hostname this scan can pin");
  for (const { path, source } of await fixtureSources()) {
    assert.ok(!source.toLowerCase().includes(liveHost), `${path} must never mention the live origin ${liveHost}`);
    assert.ok(!source.toLowerCase().includes("swimapisg"), `${path} must never mention the live upstream tenant fragment`);
  }
});

test("no fixture carries URLs, hostnames, emails, GUIDs, or credential assignments", async () => {
  const patterns: Array<{ name: string; pattern: RegExp }> = [
    { name: "absolute URL", pattern: /https?:\/\//i },
    { name: "cloud/hostname shape", pattern: /\b[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.(com|net|org|info|io|dev|gov|edu|sg|cloud|app|aero)\b/i },
    { name: "email address", pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
    { name: "resource GUID", pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
    { name: "credential assignment", pattern: /(authorization|bearer|apikey|api_key|api-key|password|secret|token)(["']?\s*[:=]\s*["'])[A-Za-z0-9+/_.-]{16,}/i },
  ];
  for (const { path, source } of await fixtureSources()) {
    for (const { name, pattern } of patterns) {
      assert.ok(!pattern.test(source), `${path} must contain no ${name}`);
    }
  }
});

test("no fixture carries secret-length tokens outside the pinned manifest hashes", async () => {
  // The manifest legitimately binds one real artifact hash and all-zero
  // placeholder hashes; any OTHER long token-shaped string is a leak suspect.
  const evidenceBytes = await readFile(resolve(root, "tests/fixtures/sanitized-evidence.txt"));
  const evidenceSha = createHash("sha256").update(evidenceBytes).digest("hex");
  const allowed = new Set([evidenceSha, "0".repeat(64)]);
  const tokenPattern = /[A-Za-z0-9+/]{48,}={0,2}/g;
  for (const { path, source } of await fixtureSources()) {
    for (const match of source.matchAll(tokenPattern)) {
      const token = match[0];
      const isLowerHex64 = /^[0-9a-f]{64}$/.test(token);
      assert.ok(isLowerHex64 && allowed.has(token), `${path} carries an unpinned long token: ${token.slice(0, 12)}…`);
    }
  }
});

test("no fixture carries live callsign or ICAO airport shapes", async () => {
  // Live airline callsigns are an ICAO designator plus a 2-4 digit flight
  // number; fixture callsigns are intentionally long/short of that shape.
  const callsignPattern = /\b[A-Z]{3}\d{2,4}[A-Z]?\b/;
  // Bare four-uppercase-letter identifiers are exactly the live airport-code
  // shape. DUPX is the one documented synthetic exception: the duplicate
  // navaid identifier shared with reference-only consumer suites that own
  // their own copies (it cannot be renamed from this domain). The scan
  // targets identifier-position values only, so vocabulary strings like
  // error codes or geometry types never count as airport codes.
  const allowedBareCodes = new Set(["DUPX"]);
  const identifierValues = (source: string): string[] => [
    ...[...source.matchAll(/(?:callsign|departure|destination|origin|from|to|identifier|name)\s*:\s*"([^"]*)"/g)].map((match) => match[1]!),
    ...[...source.matchAll(/\[\s*"([^"]+)"\s*,\s*-?\d/g)].map((match) => match[1]!),
    ...[...source.matchAll(/flight\("[^"]*",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/g)].flatMap((match) => [match[1]!, match[2]!, match[3]!]),
  ];
  for (const { path, source } of await fixtureSources()) {
    assert.ok(!callsignPattern.test(source), `${path} carries a live callsign shape: ${source.match(callsignPattern)?.[0]}`);
    const values = path.endsWith(".ts") ? identifierValues(source) : [...source.matchAll(/\b[A-Z]{4}\b/g)].map((match) => match[0]);
    if (path.endsWith(".ts")) assert.ok(values.length > 0, `${path} contributes identifier values the scan actually covers`);
    const bareCodes = values.filter((value) => /^[A-Z]{4}$/.test(value));
    for (const code of bareCodes) {
      assert.ok(allowedBareCodes.has(code), `${path} carries an ICAO-shaped identifier ${code} that is not the documented synthetic exception`);
    }
  }
});

interface EvidenceSchema {
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

test("evidence-manifest.json is structurally consistent with the deploy schema", async () => {
  const schema = JSON.parse(await readFile(resolve(root, "deploy/evidence-manifest.schema.json"), "utf8")) as EvidenceSchema;
  const manifest = JSON.parse(await readFile(resolve(root, "tests/fixtures/evidence-manifest.json"), "utf8")) as Record<string, unknown>;
  const pattern = (value: unknown): RegExp => new RegExp(String(value));

  // Top level: exactly the schema's property set, nothing invented.
  assert.deepEqual(Object.keys(manifest).sort(), [...schema.required].sort(), "top-level keys match the schema's required set");
  for (const key of Object.keys(manifest)) assert.ok(key in schema.properties, `top-level key ${key} exists in the schema`);

  assert.equal(manifest.schemaVersion, 1, "schemaVersion is the schema const");
  const gateIdPattern = (schema.properties.gateId as { pattern: string }).pattern;
  assert.ok(pattern(gateIdPattern).test(String(manifest.gateId)), "gateId matches the schema pattern");

  const policy = manifest.policy as Record<string, unknown>;
  const policySchema = schema.properties.policy as { required: string[]; properties: Record<string, Record<string, unknown>> };
  for (const key of policySchema.required) assert.ok(key in policy, `policy carries required ${key}`);
  for (const key of Object.keys(policy)) assert.ok(key in policySchema.properties, `policy key ${key} exists in the schema`);
  const shaPattern = pattern((policySchema.properties.policySha256 as { pattern: string }).pattern);
  assert.ok(shaPattern.test(String(policy.policySha256)), "policySha256 matches the schema hash grammar");
  assert.ok(shaPattern.test(String(policy.validatorSha256)), "validatorSha256 matches the schema hash grammar");
  const evaluationModes = (policySchema.properties.evaluationMode as { enum: string[] }).enum;
  assert.ok(evaluationModes.includes(String(policy.evaluationMode)), "evaluationMode is enumerated by the schema");

  // Non-PG-00 gates must be validator-signed (schema allOf branch).
  if (manifest.gateId !== "PG-00") {
    assert.ok(typeof policy.validatorVersion === "string" && policy.validatorVersion.length > 0, "non-PG-00 manifest names its validator");
    assert.ok(typeof policy.validatorSha256 === "string" && shaPattern.test(policy.validatorSha256), "non-PG-00 manifest binds a validator hash");
    assert.equal(policy.evaluationMode, "semantic-validator", "non-PG-00 manifests are validator-evaluated");
  }

  const subject = manifest.subject as Record<string, unknown>;
  const subjectSchema = schema.properties.subject as { properties: Record<string, Record<string, unknown>> };
  const subjectTypes = (subjectSchema.properties.type as { enum: string[] }).enum;
  assert.ok(subjectTypes.includes(String(subject.type)), "subject type is enumerated by the schema");
  const identifiers = subject.identifiers as Record<string, unknown>;
  assert.ok(Object.keys(identifiers).length > 0, "subject identifiers are non-empty");
  for (const value of Object.values(identifiers)) assert.ok(typeof value === "string" && value.length > 0, "identifier values are non-empty strings");
  assert.ok(typeof subject.environment === "string" && subject.environment.length > 0, "subject environment is a non-empty string");

  const checks = manifest.checks as Array<Record<string, unknown>>;
  const checkSchema = schema.properties.checks as { items: { required: string[]; properties: Record<string, Record<string, unknown>> } };
  assert.ok(Array.isArray(checks) && checks.length >= 1, "the manifest carries at least one check");
  const resultVocabulary = (checkSchema.items.properties.result as { enum: string[] }).enum;
  const operators = ((checkSchema.items.properties.threshold as { properties: Record<string, Record<string, unknown>> }).properties.operator as { enum: string[] }).enum;
  const checkIdPattern = pattern((checkSchema.items.properties.checkId as { pattern: string }).pattern);
  const artifactShaPattern = pattern((((checkSchema.items.properties.artifacts as { items: { properties: Record<string, Record<string, unknown>> } }).items.properties.sha256) as { pattern: string }).pattern);
  for (const check of checks) {
    for (const key of checkSchema.items.required) assert.ok(key in check, `check ${String(check.checkId)} carries required ${key}`);
    for (const key of Object.keys(check)) assert.ok(key in checkSchema.items.properties, `check key ${key} exists in the schema`);
    assert.ok(checkIdPattern.test(String(check.checkId)), "checkId matches the schema pattern");
    assert.equal(check.mandatory, true, "gate checks are mandatory");
    const startedAt = Date.parse(String(check.startedAt));
    const endedAt = Date.parse(String(check.endedAt));
    assert.ok(Number.isFinite(startedAt) && Number.isFinite(endedAt), "check timestamps are date-times");
    assert.ok(startedAt <= endedAt, "check timestamps are ordered");
    const threshold = check.threshold as Record<string, unknown>;
    assert.ok(operators.includes(String(threshold.operator)), "threshold operator is enumerated by the schema");
    assert.ok(typeof threshold.rule === "string" && threshold.rule.length > 0, "threshold rule is non-empty");
    const measurement = check.measurement as Record<string, unknown>;
    assert.ok(Number.isInteger(measurement.sampleCount) && Number(measurement.sampleCount) >= 1, "measurement sampleCount is a positive integer");
    const artifacts = check.artifacts as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(artifacts) && artifacts.length >= 1, "check binds at least one artifact");
    for (const artifact of artifacts) {
      assert.ok(typeof artifact.path === "string" && artifact.path.length > 0, "artifact path is non-empty");
      assert.ok(artifactShaPattern.test(String(artifact.sha256)), "artifact sha256 matches the schema hash grammar");
    }
    assert.ok(resultVocabulary.includes(String(check.result)), "check result is enumerated by the schema");
  }

  // gateResult pass branch (schema allOf): every check passed, no open issues.
  const gateResults = (schema.properties.gateResult as { enum: string[] }).enum;
  assert.ok(gateResults.includes(String(manifest.gateResult)), "gateResult is enumerated by the schema");
  if (manifest.gateResult === "pass") {
    for (const check of checks) assert.equal(check.result, "pass", "a passing gate carries only passing checks");
    const blockingIssues = manifest.blockingIssues as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(blockingIssues), "blockingIssues is an array");
    assert.ok(!blockingIssues.some((issue) => issue.status === "open"), "a passing gate has no open blocking issues");
  }
});

test("manifest artifact hashes bind the real fixture bytes", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "tests/fixtures/evidence-manifest.json"), "utf8")) as {
    checks: Array<{ artifacts: Array<{ path: string; sha256: string }> }>;
  };
  let artifactCount = 0;
  for (const check of manifest.checks) {
    for (const artifact of check.artifacts) {
      artifactCount += 1;
      const bytes = await readFile(resolve(root, artifact.path));
      const actual = createHash("sha256").update(bytes).digest("hex");
      assert.equal(actual, artifact.sha256, `artifact ${artifact.path} hash binds the real file bytes`);
    }
  }
  assert.ok(artifactCount >= 1, "the manifest binds at least one artifact");
});
