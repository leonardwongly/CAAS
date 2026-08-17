import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { resolve, relative, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

export const root = resolve(import.meta.dirname, "../..");
const allowedOperators = new Set(["equals", "less-than-or-equal", "greater-than-or-equal", "all-less-than-or-equal", "set-equals", "hash-equals", "manual-approval"]);
const forbiddenWorkflow = /(^|[^A-Za-z0-9_])(az\s+(?:login|deployment|provider)|what-if|azure\/(?:login|cli)|workflow_dispatch|secrets\.)/i;
const forbiddenCloudflareDeployment = /(^|[^A-Za-z0-9_])(az\s+(?:login|deployment|provider)|what-if|azure\/(?:login|cli))/i;
const cloudflareWorkflowSecrets = new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
const prohibitedResource = /Microsoft\.Storage\/storageAccounts|Microsoft\.App\/jobs|Microsoft\.ServiceBus\/namespaces|Microsoft\.Network\/privateEndpoints|Microsoft\.Network\/azureFirewalls|Microsoft\.Network\/applicationGateways|Microsoft\.Web\/sites/i;
const allowedResourceTypes = new Set([
  "Microsoft.Resources/resourceGroups",
  "Microsoft.Consumption/budgets",
  "Microsoft.OperationalInsights/workspaces",
  "Microsoft.ContainerRegistry/registries",
  "Microsoft.KeyVault/vaults",
  "Microsoft.ManagedIdentity/userAssignedIdentities",
  "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials",
  "Microsoft.App/managedEnvironments",
  "Microsoft.App/containerApps",
  "Microsoft.App/containerApps/authConfigs",
  "Microsoft.Authorization/roleAssignments",
]);

function issue(message) { return message; }
function isObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function rejectUnknown(object, allowed, label, errors) {
  if (!isObject(object)) return;
  for (const key of Object.keys(object)) if (!allowed.has(key)) errors.push(`${label} contains unknown field ${key}`);
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }

async function readText(relativePath) {
  if (relativePath.includes(".env")) throw new Error("offline validator refuses to read environment files");
  return readFile(resolve(root, relativePath), "utf8");
}

async function filesUnder(relativeDirectory, extensions) {
  const results = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".env")) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (extensions.has(extname(entry.name))) results.push(absolute);
    }
  }
  await visit(resolve(root, relativeDirectory));
  return results;
}

function deriveCheck(check) {
  const expected = check.threshold.expected;
  const value = check.measurement.value;
  switch (check.threshold.operator) {
    case "equals": return equal(value, expected);
    case "less-than-or-equal": return typeof value === "number" && typeof expected === "number" && value <= expected;
    case "greater-than-or-equal": return typeof value === "number" && typeof expected === "number" && value >= expected;
    case "all-less-than-or-equal": return Array.isArray(value) && Array.isArray(expected) && value.length === expected.length && value.every((item, index) => typeof item === "number" && typeof expected[index] === "number" && item <= expected[index]);
    case "set-equals": return Array.isArray(value) && Array.isArray(expected) && equal([...value].sort(), [...expected].sort());
    case "hash-equals": return typeof value === "string" && value === expected;
    case "manual-approval": return equal(value, expected);
    default: return false;
  }
}

export async function validateManifest(manifest, baseDirectory = root) {
  const errors = [];
  const required = ["schemaVersion", "gateId", "policy", "subject", "checks", "blockingIssues", "gateResult", "failureFallback"];
  rejectUnknown(manifest, new Set(required), "manifest", errors);
  for (const key of required) if (!(key in (manifest ?? {}))) errors.push(issue(`manifest missing ${key}`));
  if (manifest?.schemaVersion !== 1) errors.push(issue("manifest schemaVersion must be 1"));
  if (!/^PG-(00|01|02|03|04|05|PROD|LIFE)$/.test(manifest?.gateId ?? "")) errors.push(issue("manifest gateId is invalid"));
  const policy = manifest?.policy;
  rejectUnknown(policy, new Set(["policyVersion", "policySha256", "validatorVersion", "validatorSha256", "evaluationMode"]), "policy", errors);
  if (!isObject(policy) || typeof policy.policyVersion !== "string" || !/^[a-f0-9]{64}$/.test(policy.policySha256 ?? "") || !["human-reviewed-pg00", "semantic-validator"].includes(policy.evaluationMode)) errors.push(issue("manifest policy metadata is invalid"));
  if (manifest?.gateId !== "PG-00" && (!isObject(policy) || policy.evaluationMode !== "semantic-validator" || typeof policy.validatorVersion !== "string" || !/^[a-f0-9]{64}$/.test(policy.validatorSha256 ?? ""))) errors.push(issue("non-PG-00 manifest requires semantic validator metadata"));
  rejectUnknown(manifest?.subject, new Set(["type", "identifiers", "environment"]), "subject", errors);
  if (!isObject(manifest?.subject) || !["documents", "commit", "oci", "azure-deployment", "lifecycle"].includes(manifest.subject.type) || !isObject(manifest.subject.identifiers) || Object.keys(manifest.subject.identifiers).length === 0 || typeof manifest.subject.environment !== "string" || !manifest.subject.environment) errors.push(issue("manifest subject is invalid"));
  if (!Array.isArray(manifest?.checks) || manifest.checks.length < 1) errors.push(issue("manifest must contain checks"));
  const ids = new Set();
  for (const check of manifest?.checks ?? []) {
    if (!isObject(check)) { errors.push(issue("check must be an object")); continue; }
    rejectUnknown(check, new Set(["checkId", "mandatory", "procedure", "startedAt", "endedAt", "threshold", "measurement", "artifacts", "result", "exception", "failureFallback"]), `check ${check.checkId ?? "unknown"}`, errors);
    if (ids.has(check.checkId)) errors.push(issue(`duplicate check ${check.checkId}`));
    ids.add(check.checkId);
    if (typeof check.checkId !== "string" || !/^[A-Z0-9][A-Z0-9._-]+$/.test(check.checkId)) errors.push(issue("checkId is invalid"));
    if (check.mandatory !== true || typeof check.procedure !== "string" || !check.procedure || typeof check.failureFallback !== "string" || !check.failureFallback) errors.push(issue(`check ${check.checkId} metadata is invalid`));
    const started = Date.parse(check.startedAt);
    const ended = Date.parse(check.endedAt);
    if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) errors.push(issue(`check ${check.checkId} timestamps are invalid or reversed`));
    if (!isObject(check.threshold) || typeof check.threshold.rule !== "string" || !allowedOperators.has(check.threshold.operator) || !("expected" in check.threshold)) errors.push(issue(`check ${check.checkId} threshold is invalid`));
    rejectUnknown(check.threshold, new Set(["rule", "operator", "expected", "units"]), `check ${check.checkId} threshold`, errors);
    if (!isObject(check.measurement) || typeof check.measurement.summary !== "string" || !("value" in check.measurement) || !Number.isInteger(check.measurement.sampleCount) || check.measurement.sampleCount < 1) errors.push(issue(`check ${check.checkId} measurement is invalid`));
    rejectUnknown(check.measurement, new Set(["summary", "value", "units", "sampleCount"]), `check ${check.checkId} measurement`, errors);
    if (!Array.isArray(check.artifacts) || check.artifacts.length < 1) errors.push(issue(`check ${check.checkId} has no artifacts`));
    for (const artifact of check.artifacts ?? []) {
      if (!isObject(artifact) || typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) { errors.push(issue(`check ${check.checkId} artifact is invalid`)); continue; }
      rejectUnknown(artifact, new Set(["path", "sha256"]), `check ${check.checkId} artifact`, errors);
      // Path containment: absolute paths, parent traversal, symlinks, and
      // non-regular files (devices, FIFOs) are rejected WITHOUT opening them —
      // never a host-file hash oracle and never a hang on a special file.
      if (artifact.path.includes("..") || artifact.path.startsWith("/")) { errors.push(issue(`check ${check.checkId} artifact is invalid`)); continue; }
      const absolute = resolve(baseDirectory, artifact.path);
      try {
        const stats = await lstat(absolute);
        if (!stats.isFile()) { errors.push(issue(`check ${check.checkId} artifact is invalid`)); continue; }
        const real = await realpath(absolute);
        if (!real.startsWith(resolve(baseDirectory) + sep)) { errors.push(issue(`check ${check.checkId} artifact is invalid`)); continue; }
        const contents = await readFile(absolute);
        if (digest(contents) !== artifact.sha256) errors.push(issue(`artifact hash mismatch: ${artifact.path}`));
      } catch { errors.push(issue(`artifact is missing: ${artifact.path}`)); }
    }
    if (!["pass", "fail", "blocked"].includes(check.result)) errors.push(issue(`check ${check.checkId} result is invalid`));
    if (check.threshold?.operator && check.measurement && deriveCheck(check) !== (check.result === "pass")) errors.push(issue(`caller result drift: ${check.checkId}`));
    if (check.exception && (!isObject(check.exception) || typeof check.exception.reason !== "string" || !Number.isFinite(Date.parse(check.exception.expiresAt)) || typeof check.exception.gateBlocking !== "boolean")) errors.push(issue(`check ${check.checkId} exception is invalid`));
    if (check.exception && isObject(check.exception) && Date.parse(check.exception.expiresAt) < Date.now()) errors.push(issue(`check ${check.checkId} exception has expired (${check.exception.expiresAt}); policy rule reject-expired-exceptions requires rejection`));
    rejectUnknown(check.exception, new Set(["reason", "expiresAt", "gateBlocking"]), `check ${check.checkId} exception`, errors);
  }
  for (const item of manifest?.blockingIssues ?? []) {
    rejectUnknown(item, new Set(["id", "priority", "status"]), "blocking issue", errors);
    if (!isObject(item) || typeof item.id !== "string" || !["P0", "P1"].includes(item.priority) || !["open", "resolved"].includes(item.status)) errors.push(issue("blocking issue is invalid"));
  }
  const openBlocking = (manifest?.blockingIssues ?? []).some((item) => isObject(item) && ["P0", "P1"].includes(item.priority) && item.status === "open");
  const blockingException = (manifest?.checks ?? []).some((check) => check.exception?.gateBlocking === true);
  const expiredException = (manifest?.checks ?? []).some((check) => isObject(check.exception) && Date.parse(check.exception.expiresAt) < Date.now());
  const derivedGate = openBlocking || blockingException || expiredException ? "blocked" : (manifest?.checks ?? []).some((check) => check.result === "blocked") ? "blocked" : (manifest?.checks ?? []).some((check) => check.result === "fail") ? "fail" : "pass";
  if (manifest?.gateResult !== derivedGate) errors.push(`caller gate result drift: expected ${derivedGate}`);
  if (manifest?.gateResult === "pass" && ((manifest?.checks ?? []).some((check) => check.result !== "pass") || openBlocking || blockingException || expiredException)) errors.push("passing gate contains blocking evidence");
  return errors;
}

export async function validateRepository() {
  const errors = [];
  const policy = parseYaml(await readText("deploy/poc-policy.yaml"));
  if (typeof policy?.policyVersion !== "string" || !policy.policyVersion) errors.push("policyVersion is missing");
  if (policy?.schema?.evidenceManifest !== "deploy/evidence-manifest.schema.json") errors.push("policy must reference the evidence schema");
  if (policy?.execution?.cloudWrites?.default !== "disabled") errors.push("cloud writes must default to disabled");
  if (policy?.execution?.bootstrap?.externalIngress !== "disabled") errors.push("bootstrap ingress must be disabled");
  if (policy?.execution?.exactSubject?.required !== true) errors.push("exact subject must be required");
  const workflows = await filesUnder(".github/workflows", new Set([".yml", ".yaml"]));
  for (const file of workflows) {
    if (file.endsWith("poc-pr-static.yml")) continue;
    const text = await readFile(file, "utf8");
    if (file.endsWith("cloudflare-deploy.yml")) {
      if (forbiddenCloudflareDeployment.test(text)) errors.push(`forbidden Azure operation in ${relative(root, file)}`);
      const undeclaredSecret = [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].find((match) => !cloudflareWorkflowSecrets.has(match[1] ?? ""));
      if (undeclaredSecret) errors.push(`undeclared workflow secret in ${relative(root, file)}`);
      continue;
    }
    if (forbiddenWorkflow.test(text)) errors.push(`forbidden workflow operation in ${relative(root, file)}`);
  }
  const bicepFiles = await filesUnder("infra/bicep", new Set([".bicep"]));
  const declared = new Set();
  for (const file of bicepFiles) {
    const text = await readFile(file, "utf8");
    if (prohibitedResource.test(text)) errors.push(`prohibited legacy resource marker in ${relative(root, file)}`);
    for (const match of text.matchAll(/resource\s+\w+\s+'([^@']+)@/g)) declared.add(match[1]);
  }
  for (const type of declared) if (!allowedResourceTypes.has(type)) errors.push(`resource type is outside policy allow-list: ${type}`);
  const main = await readText("infra/bicep/main.bicep");
  for (const requiredText of ["param deployResources bool = false", "param bootstrap bool = true", "param enableExternalIngress bool = false", "imageRepository}@${imageDigest}", "minReplicas: minReplicas", "maxReplicas: maxReplicas"]) if (!main.includes(requiredText)) errors.push(`Bicep invariant missing: ${requiredText}`);
  const resourceGroup = await readText("infra/bicep/resource-group.bicep");
  for (const requiredText of ["external: bootstrap ? false : enableExternalIngress", "targetPort: 8080", "cpu: 1", "memory: '2Gi'"]) if (!resourceGroup.includes(requiredText)) errors.push(`Bicep invariant missing: ${requiredText}`);
  const manifest = JSON.parse(await readText("tests/fixtures/evidence-manifest.json"));
  errors.push(...await validateManifest(manifest));
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const errors = await validateRepository();
  if (errors.length) {
    console.error(errors.map((error) => `offline validation failed: ${error}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Offline policy, evidence, security-boundary, and legacy-resource validation passed.");
  }
}
