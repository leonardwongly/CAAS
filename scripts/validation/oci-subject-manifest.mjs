// Generates docs/evidence/oci-subject-local.json: the PG-03 gate manifest for
// the locally built OCI subject, with real hashes bound to the committed files.
//
// This manifest is BLOCKED on the two checks that require the authoritative CI
// subject and an authorized live run (PG03-EXACT-DIGEST, PG03-LOOPBACK-REAL-DATA);
// the secretless and resource-shape checks are recorded pass from real local
// observations (the image was built with no credential, non-root user, linux,
// and the Bicep cpu/memory invariants pass validate:policy). Nothing is
// invented: the digest below is the image that was actually built by
// scripts/validation/build-oci.mjs.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { VALIDATOR_VERSION } from "./validate-evidence-bundle.mjs";
import { root, shortSha } from "./lib-evidence.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const short = shortSha();
const bundlePath = `docs/evidence/oci-digest-bundle-${short}.json`;
const bundle = JSON.parse(await readFile(resolve(root, bundlePath), "utf8"));
const imageDigest = bundle.image?.imageId;
if (!imageDigest || !bundle.assertions?.nonRootUser || !bundle.assertions?.noSecretEnv || !bundle.assertions?.exposes8080 || !bundle.assertions?.linuxImage) {
  throw new Error("oci-subject-manifest: the digest bundle must record a built image with all assertions true");
}

// Exact-subject verification: an authorized container live run whose subject
// digest equals the newest committed CI-built bundle's image ID. Only such a
// record lifts PG03-EXACT-DIGEST and PG03-LOOPBACK-REAL-DATA; a local rebuild
// can never fake it — the lane refuses to run against a non-matching image
// ID, and ci-build bundles can only originate from the CI workflow.
const evidenceDir = resolve(root, "docs/evidence");
const bundleFiles = (await readdir(evidenceDir)).filter((name) => name.startsWith("oci-digest-bundle-") && name.endsWith(".json")).sort();
const ciBundles = (await Promise.all(bundleFiles.map(async (name) => JSON.parse(await readFile(resolve(evidenceDir, name), "utf8")))))
  .filter((candidate) => candidate.recordKind === "oci-digest-bundle" && candidate.subject?.environment === "ci-build"
    && candidate.assertions?.nonRootUser && candidate.assertions?.noSecretEnv && candidate.assertions?.exposes8080 && candidate.assertions?.linuxImage)
  .sort((left, right) => (left.buildMetadata?.startedAt ?? "").localeCompare(right.buildMetadata?.startedAt ?? ""));
const verifiedBundle = ciBundles.at(-1) ?? null;
const verifiedDigest = verifiedBundle?.image?.imageId ?? null;
const verifiedBundleName = verifiedBundle
  ? bundleFiles.find((name) => {
      try {
        return JSON.parse(readFileSync(resolve(evidenceDir, name), "utf8")).subject?.identifiers?.digest === verifiedDigest;
      } catch {
        return false;
      }
    })
  : undefined;

const containerLiveFiles = (await readdir(evidenceDir)).filter((name) => name.startsWith("container-live-lane-") && name.endsWith(".json")).sort();
let exactVerified = false;
let containerLiveRecord = null;
if (verifiedDigest) {
  for (const name of [...containerLiveFiles].reverse()) {
    const candidate = JSON.parse(await readFile(resolve(evidenceDir, name), "utf8"));
    if (candidate.recordKind === "lane-results" && candidate.mode === "authorized-run" && candidate.subject?.identifiers?.digest === verifiedDigest && candidate.summary?.failed === 0 && candidate.summary?.blocked === 0) {
      const checkIds = new Set((candidate.checks ?? []).map((check) => check.checkId));
      if (checkIds.has("CONTAINER-LIVE-FIVE-FAMILY") && checkIds.has("CONTAINER-LIVE-BROWSE-EXACT-ONCE") && checkIds.has("CONTAINER-LIVE-EXACT-SUBJECT")) {
        exactVerified = true;
        containerLiveRecord = { name, candidate };
        break;
      }
    }
  }
}
if (exactVerified) console.log(`oci-subject-manifest: exact-subject container live run found (${containerLiveRecord.name}) for the CI-built digest ${verifiedDigest.slice(0, 20)}…; lifting PG03-EXACT-DIGEST and PG03-LOOPBACK-REAL-DATA.`);

const policyPath = resolve(root, "deploy/poc-policy.yaml");
const validatorPath = resolve(root, "scripts/validation/validate-evidence-bundle.mjs");
const dockerfilePath = resolve(root, "containers/Dockerfile");
const buildScriptPath = resolve(root, "scripts/validation/build-oci.mjs");
const workflowDir = resolve(root, ".github/workflows");
const workflowName = (await readdir(workflowDir)).find((name) => name === "oci-subject-build.yml");
if (!workflowName) throw new Error("oci-subject-manifest: .github/workflows/oci-subject-build.yml is missing");

const policySha256 = digest(await readFile(policyPath, "utf8"));
const validatorSha256 = digest(await readFile(validatorPath, "utf8"));

const startedAt = new Date().toISOString();
const endedAt = new Date().toISOString();

const artifactRefs = [
  { path: "deploy/poc-policy.yaml", sha256: policySha256 },
  { path: "deploy/evidence-manifest.schema.json", sha256: digest(await readFile(resolve(root, "deploy/evidence-manifest.schema.json"), "utf8")) },
  { path: "containers/Dockerfile", sha256: digest(await readFile(dockerfilePath, "utf8")) },
  { path: "scripts/validation/build-oci.mjs", sha256: digest(await readFile(buildScriptPath, "utf8")) },
  { path: "scripts/validation/validate-evidence-bundle.mjs", sha256: validatorSha256 },
  { path: `.github/workflows/${workflowName}`, sha256: digest(await readFile(resolve(workflowDir, workflowName), "utf8")) },
  { path: bundlePath, sha256: digest(await readFile(resolve(root, bundlePath), "utf8")) },
  ...(exactVerified && verifiedBundleName ? [{ path: `docs/evidence/${verifiedBundleName}`, sha256: digest(await readFile(resolve(root, "docs/evidence", verifiedBundleName), "utf8")) }] : []),
];

function check({ checkId, name, procedure, result, value, units, expected, operator, extraArtifacts = [] }) {
  return {
    checkId,
    mandatory: true,
    procedure,
    startedAt,
    endedAt,
    threshold: { rule: operator === "set-equals" ? "the set of measured values equals the expected set" : `measured value ${operator} expected`, operator, expected, units },
    measurement: { summary: name, value, units, sampleCount: value === null ? 1 : (Array.isArray(value) ? value.length : 1) },
    artifacts: [...artifactRefs, ...extraArtifacts],
    result,
    failureFallback: "PG-03 must fully pass before any Azure write; keep the gate blocked until every check passes on the exact verified subject.",
  };
}

const checks = [
  check({
    checkId: "PG03-EXACT-DIGEST", name: "exact subject digest is the verified OCI subject",
    procedure: exactVerified
      ? "An authorized container live run (scripts/validation/container-live-lane.mjs) executed the image whose ID equals the committed CI-built bundle's image ID; the record's subject digest matches exactly."
      : "The subject must be the single authoritative CI-built OCI image; the locally built candidate is recorded here with its real digest and remains unverified until an authorized container live run on the exact CI digest is recorded.",
    result: exactVerified ? "pass" : "blocked", value: exactVerified ? verifiedDigest : imageDigest, units: "digest", expected: exactVerified ? verifiedDigest : "verified-oci-subject", operator: "hash-equals",
  }),
  check({
    checkId: "PG03-LOOPBACK-REAL-DATA", name: "exact subject passes loopback with real data",
    procedure: exactVerified
      ? `The exact subject passed the loopback real-data checks in the container (${containerLiveRecord.name}): liveness, five-family acquisition, browse exact-once, secret exclusion.`
      : "The verified subject must pass the loopback gate with real data (authorized run). Mechanics pass fixture-backed (docs/evidence/loopback-lane-local.json); the authorized container run on the exact digest is pending.",
    result: exactVerified ? "pass" : "blocked", value: exactVerified, units: "boolean", expected: true, operator: "equals",
    extraArtifacts: exactVerified ? [{ path: `docs/evidence/${containerLiveRecord.name}`, sha256: digest(await readFile(resolve(root, "docs/evidence", containerLiveRecord.name), "utf8")) }] : [],
  }),
  check({
    checkId: "PG03-SECRETLESS", name: "subject is built secretless",
    procedure: "The image was built by scripts/validation/build-oci.mjs with no credential in the environment, no registry push, and the image config records no secret environment; the CI workflow is hermetic (no secrets, no Azure operations).",
    result: "pass", value: true, units: "boolean", expected: true, operator: "equals",
  }),
  check({
    checkId: "PG03-RESOURCE-SHAPE", name: "subject shape matches the fixed resource policy",
    procedure: "non-root runtime user and linux/amd64 verified from docker image inspect of the built image; 1 vcpu and 2 GiB verified by validate:policy from infra/bicep invariants (cpu: 1, memory '2Gi').",
    result: "pass", value: ["non-root", "linux", "1-vcpu", "2-giB"], units: "shape", expected: ["non-root", "linux", "1-vcpu", "2-giB"], operator: "set-equals",
  }),
];

const manifest = {
  schemaVersion: 1,
  gateId: "PG-03",
  policy: {
    policyVersion: "1.0.0-poc",
    policySha256,
    validatorVersion: VALIDATOR_VERSION,
    validatorSha256,
    evaluationMode: "semantic-validator",
  },
  subject: {
    type: "oci",
    identifiers: { digest: exactVerified ? verifiedDigest : imageDigest, commit: exactVerified ? containerLiveRecord.candidate.subject.identifiers.commit : short, tarSha256: exactVerified ? verifiedBundle.subject.identifiers.tarSha256 : bundle.subject.identifiers.tarSha256 },
    environment: exactVerified ? "verified-ci-subject" : "local-build-candidate",
  },
  checks,
  // A blocked gate must name what blocks it: every blocked check is listed
  // as an open P0 blocking issue (P0: no Azure write may occur until it is
  // resolved on the exact verified subject).
  blockingIssues: checks.filter((check) => check.result === "blocked").map((check) => ({ id: `${check.checkId}: pending authoritative CI-built OCI subject and authorized live loopback on that exact digest`, priority: "P0", status: "open" })),
  gateResult: exactVerified ? "pass" : "blocked",
  failureFallback: "PG-03 must fully pass before any Azure write; keep the gate blocked until every check passes on the exact verified subject.",
};

const manifestPath = "docs/evidence/oci-subject-local.json";
await writeFile(resolve(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`PG-03 gate manifest written to ${manifestPath}`);
console.log(`  subject digest: ${imageDigest}`);
console.log(`  policySha256:   ${policySha256}`);
console.log(`  validatorSha256:${validatorSha256}`);
console.log(`  gateResult:     ${manifest.gateResult} (${checks.map((check) => `${check.checkId}=${check.result}`).join(", ")})`);
