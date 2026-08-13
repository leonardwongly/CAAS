// Semantic validator for the evidence bundle (docs/evidence/*). This is the
// validator referenced by gate manifests' policy.validatorSha256 binding.
//
// It reuses validate-offline.mjs's structural validateManifest and adds the
// evidence-policy layer:
//   1. policySha256 must equal the real sha256 of deploy/poc-policy.yaml;
//   2. validatorVersion/validatorSha256 must equal this validator's own
//      version and real file sha256 (self-binding);
//   3. every mandatory check the policy registry defines for a gate must be
//      present, with matching operator and units;
//   4. lane/measurement records (loopback lanes, performance, security, lint,
//      live pending) are classified structurally: envelope fields, checkId
//      pattern, result values, measurement sample counts, artifact hashes
//      verified against the filesystem, timestamps not reversed, summary
//      consistent with the check list;
//   5. PG-00 discovery records are outside the gate regime and skipped.
//
// Deterministic, hermetic, offline. Fails loudly with a non-zero exit when
// invoked directly; importing this module is side-effect free.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateManifest } from "./validate-offline.mjs";
import { root } from "./lib-evidence.mjs";

export const VALIDATOR_VERSION = "release-evidence-validator-v1";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const evidenceDirectory = resolve(root, "docs/evidence");
const policyPath = resolve(root, "deploy/poc-policy.yaml");
const validatorPath = resolve(root, "scripts/validation/validate-evidence-bundle.mjs");

export async function validateEvidenceBundle() {
  const [policyText, validatorText] = await Promise.all([readFile(policyPath, "utf8"), readFile(validatorPath, "utf8")]);
  const policySha256 = digest(policyText);
  const validatorSha256 = digest(validatorText);

  const policy = parseYaml(policyText);
  const policyRegistry = new Map();
  for (const [gateId, gate] of Object.entries(policy?.checks ?? {})) {
    for (const check of gate.mandatory ?? []) {
      if (!policyRegistry.has(gateId)) policyRegistry.set(gateId, []);
      policyRegistry.get(gateId).push({ id: check.id, operator: check.operator, units: check.units });
    }
  }

  const errors = [];

  async function classifyLaneRecord(file, record) {
    const required = ["recordKind", "lane", "subject", "startedAt", "endedAt", "checks", "summary", "artifacts"];
    for (const key of required) if (!(key in record)) errors.push(`${file}: lane record missing ${key}`);
    if (record.recordKind === "lane-results") {
      for (const key of ["mode", "credentialHandling"]) if (!(key in record)) errors.push(`${file}: lane record missing ${key}`);
    }
    if (record.recordKind !== "lane-results" && record.recordKind !== "measurement-results") errors.push(`${file}: unexpected recordKind ${record.recordKind}`);
    if (typeof record.lane !== "string" || !record.lane) errors.push(`${file}: lane missing`);
    const subject = record.subject ?? {};
    if (!["commit", "oci", "documents"].includes(subject.type)) errors.push(`${file}: lane subject type invalid`);
    if (subject.type === "commit" && typeof subject.identifiers?.commit !== "string") errors.push(`${file}: lane subject commit missing`);
    if (typeof subject.environment !== "string" || !subject.environment) errors.push(`${file}: lane subject environment missing`);
    const started = Date.parse(record.startedAt ?? "");
    const ended = Date.parse(record.endedAt ?? "");
    if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) errors.push(`${file}: lane timestamps invalid or reversed`);
    if (!Array.isArray(record.checks) || record.checks.length < 1) { errors.push(`${file}: lane has no checks`); return; }
    const ids = new Set();
    for (const check of record.checks) {
      if (!check || typeof check !== "object") { errors.push(`${file}: check must be an object`); continue; }
      if (typeof check.checkId !== "string" || !/^[A-Z0-9][A-Z0-9._-]+$/.test(check.checkId)) errors.push(`${file}: checkId invalid`);
      if (ids.has(check.checkId)) errors.push(`${file}: duplicate checkId ${check.checkId}`);
      ids.add(check.checkId);
      if (!["pass", "fail", "blocked"].includes(check.result)) errors.push(`${file}: check ${check.checkId} result invalid`);
      const measurement = check.measurement ?? {};
      if (typeof measurement.summary !== "string" || !("value" in measurement) || !Number.isInteger(measurement.sampleCount) || measurement.sampleCount < 1) {
        errors.push(`${file}: check ${check.checkId} measurement invalid`);
      }
      if (check.result === "pass" && (!Number.isInteger(measurement.sampleCount) || measurement.sampleCount < 1)) errors.push(`${file}: passing check ${check.checkId} lacks a real measurement`);
      const checkStarted = Date.parse(check.startedAt ?? "");
      const checkEnded = Date.parse(check.endedAt ?? "");
      if (!Number.isFinite(checkStarted) || !Number.isFinite(checkEnded) || checkEnded < checkStarted) errors.push(`${file}: check ${check.checkId} timestamps invalid or reversed`);
      if (!Array.isArray(check.artifacts) || check.artifacts.length < 1) { errors.push(`${file}: check ${check.checkId} has no artifacts`); continue; }
      for (const artifact of check.artifacts) {
        if (artifact?.path === "raw" || artifact?.path === "spawn" || artifact?.sha256 === "redacted-location-only" || artifact?.sha256 === "none") continue;
        if (!artifact || typeof artifact.path !== "string" || artifact.path.includes("..") || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
          errors.push(`${file}: check ${check.checkId} artifact invalid`);
          continue;
        }
        try {
          const contents = await readFile(resolve(root, artifact.path));
          if (digest(contents) !== artifact.sha256) errors.push(`${file}: artifact hash mismatch ${artifact.path}`);
        } catch {
          errors.push(`${file}: artifact missing ${artifact.path}`);
        }
      }
    }
    const summary = record.summary ?? {};
    const blocked = summary.blocked ?? 0;
    if (!Number.isInteger(summary.checks) || !Number.isInteger(summary.passed) || !Number.isInteger(summary.failed) || !Number.isInteger(blocked) || summary.passed + summary.failed + blocked !== summary.checks || summary.checks !== record.checks.length) {
      errors.push(`${file}: summary inconsistent with checks`);
    }
  }

  const files = (await readdir(evidenceDirectory)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
  let gateCount = 0;
  let laneCount = 0;
  let skipped = 0;

  for (const name of files) {
    const filePath = resolve(evidenceDirectory, name);
    const file = `docs/evidence/${name}`;
    const record = JSON.parse(await readFile(filePath, "utf8"));
    if (record.recordKind === "discovery" || (record.gateId === undefined && record.checks === undefined)) {
      skipped += 1;
      continue;
    }
    if (typeof record.gateId === "string") {
      gateCount += 1;
      const structuralErrors = await validateManifest(record, root);
      errors.push(...structuralErrors.map((error) => `${file}: ${error}`));
      if (structuralErrors.length > 0) continue;
      if (record.policy?.policySha256 !== policySha256) errors.push(`${file}: policySha256 does not match deploy/poc-policy.yaml`);
      if (record.policy?.validatorVersion !== VALIDATOR_VERSION || record.policy?.validatorSha256 !== validatorSha256) {
        errors.push(`${file}: validator binding mismatch (expected ${VALIDATOR_VERSION} / ${validatorSha256})`);
      }
      const mandatory = policyRegistry.get(record.gateId) ?? [];
      const present = new Map(record.checks.map((check) => [check.checkId, check]));
      for (const required of mandatory) {
        const check = present.get(required.id);
        if (!check) { errors.push(`${file}: missing mandatory check ${required.id} for ${record.gateId}`); continue; }
        const threshold = check.threshold ?? {};
        if (threshold.operator !== required.operator || (required.units !== null && required.units !== undefined && threshold.units !== required.units)) {
          errors.push(`${file}: check ${required.id} operator/units drift (expected ${required.operator}/${required.units})`);
        }
      }
    } else if (record.recordKind === "lane-results" || record.recordKind === "measurement-results") {
      laneCount += 1;
      await classifyLaneRecord(file, record);
    } else {
      errors.push(`${file}: unclassified evidence record (recordKind ${record.recordKind})`);
    }
  }

  if (gateCount === 0) errors.push("no gate manifest found in docs/evidence");
  return { errors, gateCount, laneCount, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { errors, gateCount, laneCount, skipped } = await validateEvidenceBundle();
  console.log(`Evidence bundle validator: ${gateCount} gate manifest(s), ${laneCount} lane/measurement record(s), ${skipped} discovery/skipped record(s) examined.`);
  if (errors.length > 0) {
    for (const error of errors) console.error(`evidence-bundle failed: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("Evidence bundle validation passed: gate manifests match the policy registry, validator binding is exact, and lane records are structurally sound.");
  }
}
