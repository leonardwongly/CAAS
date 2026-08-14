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
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
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
      policyRegistry.get(gateId).push({ id: check.id, operator: check.operator, units: check.units, expected: check.expected });
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
      // Failed checks record no artifact hash (nothing was produced); only
      // passing/blocked checks must carry artifact evidence.
      if (check.result !== "fail" && (!Array.isArray(check.artifacts) || check.artifacts.length < 1)) { errors.push(`${file}: check ${check.checkId} has no artifacts`); continue; }
      if (check.result === "fail") continue;
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
    // Record-level artifacts are evidence too: same path/hash rules as
    // per-check artifacts (placeholder shorthands allowed, traversal never).
    if (!Array.isArray(record.artifacts)) {
      errors.push(`${file}: record artifacts missing`);
    } else {
      for (const artifact of record.artifacts) await validateArtifact(file, "record", artifact);
    }
  }

  async function validateArtifact(file, owner, artifact) {
    if (artifact?.path === "raw" || artifact?.path === "spawn" || artifact?.sha256 === "redacted-location-only" || artifact?.sha256 === "none") return;
    if (!artifact || typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
      errors.push(`${file}: ${owner} artifact invalid`);
      return;
    }
    // Path containment: absolute paths, parent traversal, symlinks, and
    // non-regular files are rejected WITHOUT opening them — never a host-file
    // hash oracle and never a hang on a special file.
    if (artifact.path.includes("..") || artifact.path.startsWith("/")) { errors.push(`${file}: ${owner} artifact invalid`); return; }
    const absolute = resolve(root, artifact.path);
    try {
      const stats = await lstat(absolute);
      if (!stats.isFile()) { errors.push(`${file}: ${owner} artifact invalid`); return; }
      const real = await realpath(absolute);
      if (!real.startsWith(resolve(root) + sep)) { errors.push(`${file}: ${owner} artifact invalid`); return; }
      const contents = await readFile(absolute);
      if (digest(contents) !== artifact.sha256) errors.push(`${file}: artifact hash mismatch ${artifact.path}`);
    } catch {
      errors.push(`${file}: artifact missing ${artifact.path}`);
    }
  }

  const files = (await readdir(evidenceDirectory)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
  let gateCount = 0;
  let laneCount = 0;
  let skipped = 0;
  let templateCount = 0;

  for (const name of files) {
    const filePath = resolve(evidenceDirectory, name);
    const file = `docs/evidence/${name}`;
    // A concurrent writer (e.g. parallel adversarial tests exercising the
    // lanes) can expose a half-written file; report it under the file's own
    // name and continue rather than aborting the whole scan.
    let record;
    try {
      record = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      errors.push(`${file}: evidence record is not readable JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    // Template records (explicit `template: true` marker or a .template.json
    // filename) declare the shape of a future evidence artifact. They record no
    // event, claim no result, and carry placeholder paths/timestamps by design;
    // they are classified as pending templates and never structurally scored.
    // A completed gate/lane/measurement record must NOT keep the marker: it
    // would otherwise escape all scoring.
    const isTemplateMarked = record.template === true || name.endsWith(".template.json");
    // A legitimate template declares itself fully: template: true AND
    // templateStatus: "pending" AND the .template.json filename suffix. A
    // completed record keeping only part of the marker (e.g. template: true on
    // a .json gate manifest, or a .template.json name without the marker) is
    // an authoring defect and must error, never be silently skipped.
    const isLegitTemplate = record.template === true && record.templateStatus === "pending" && name.endsWith(".template.json");
    if (isLegitTemplate) {
      skipped += 1;
      templateCount += 1;
      continue;
    }
    if (isTemplateMarked) {
      errors.push(`${file}: completed evidence record must not carry the template marker (template: true / .template.json); legitimate templates must set templateStatus: "pending" and use the .template.json suffix`);
    }
    if (record.recordKind === "discovery") {
      skipped += 1;
      continue;
    }
    if (record.recordKind === "oci-digest-bundle") {
      // Digest bundles are scored: digest format, source hashes, and the
      // bound code-under-test commit must be present and well-formed.
      const imageDigest = record.image?.digest ?? record.image?.imageId;
      if (typeof imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) errors.push(`${file}: oci-digest-bundle image digest invalid`);
      if (typeof record.subject?.identifiers?.commit !== "string" || !/^[a-f0-9]{7,40}$/.test(record.subject.identifiers.commit)) errors.push(`${file}: oci-digest-bundle subject commit invalid`);
      const sourceHashes = record.sourceHashes ?? {};
      if (typeof sourceHashes !== "object" || Array.isArray(sourceHashes) || !Object.values(sourceHashes).every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) {
        errors.push(`${file}: oci-digest-bundle sourceHashes must map source paths to sha256 digests`);
      }
      continue;
    }
    if (record.gateId === undefined && record.checks === undefined) {
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
      const knownIds = new Set(mandatory.map((required) => required.id));
      for (const check of record.checks) {
        if (!knownIds.has(check.checkId)) errors.push(`${file}: unknown check ${check.checkId} for ${record.gateId} (policy rule reject-unknown-checks)`);
      }
      for (const required of mandatory) {
        const check = present.get(required.id);
        if (!check) { errors.push(`${file}: missing mandatory check ${required.id} for ${record.gateId}`); continue; }
        const threshold = check.threshold ?? {};
        if (threshold.operator !== required.operator || (required.units !== null && required.units !== undefined && threshold.units !== required.units)) {
          errors.push(`${file}: check ${required.id} operator/units drift (expected ${required.operator}/${required.units})`);
        }
        if (required.expected !== undefined && JSON.stringify(threshold.expected) !== JSON.stringify(required.expected)) {
          errors.push(`${file}: check ${required.id} expected drift (policy pins ${JSON.stringify(required.expected)}, manifest claims ${JSON.stringify(threshold.expected)})`);
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
  return { errors, gateCount, laneCount, skipped, templateCount };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { errors, gateCount, laneCount, skipped, templateCount } = await validateEvidenceBundle();
  console.log(`Evidence bundle validator: ${gateCount} gate manifest(s), ${laneCount} lane/measurement record(s), ${templateCount} template record(s), ${skipped - templateCount} discovery/skipped record(s) examined.`);
  if (errors.length > 0) {
    for (const error of errors) console.error(`evidence-bundle failed: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("Evidence bundle validation passed: gate manifests match the policy registry, validator binding is exact, and lane records are structurally sound.");
  }
}
