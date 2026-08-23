// Owner: R2-D4 — declarative config correctness (round-2 adversarial sweep 2026-08-23).
//
// .github/workflows/* previously had only scattered textual self-checks
// (poc-pr-static demands >= 2 sha40 pins in itself; validate-offline greps
// for forbidden operators). This lane parses every workflow as YAML and pins
// the REAL declarative properties across all of them:
//   1. Trigger correctness: every push trigger targets the repo's VERIFIED
//      default branch. The verified default is `master` (git symbolic-ref
//      refs/remotes/origin/HEAD); the "main convention" elsewhere does not
//      apply here and triggers must never be rewritten to `main`. The test
//      re-derives the default branch from git when possible so a future
//      default-branch rename forces a deliberate trigger update.
//   2. Action pin completeness: EVERY remote `uses:` in EVERY workflow must
//      be a full 40-char commit sha (repo policy: no named-version pins, no
//      mutable tags; there are no local composite actions to exempt).
//      Container images used by jobs must be digest-pinned likewise.
//   3. Permissions minimality: top-level `permissions` is exactly
//      contents:read everywhere; no job-level escalation; no write scope.
//   4. fetch-depth: 0 invariant on the ci-secretless-validation validate job
//      (the evidence lane asserts recorded evidence commits exist in git
//      history; a depth-1 checkout silently breaks it).
//   5. Job dependency ordering: every `needs` resolves to an existing job in
//      the same file with no cycles, and the deploy workflow's in-job step
//      order is checkout -> install -> build -> deploy -> verify.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const workflowsDirectory = resolve(root, ".github/workflows");

type Workflow = Record<string, unknown>;
interface WorkflowEntry {
  text: string;
  doc: Workflow;
}

const EXPECTED_WORKFLOWS = ["ci-secretless-validation.yml", "cloudflare-deploy.yml", "oci-subject-build.yml", "poc-pr-static.yml"] as const;

async function loadWorkflows(): Promise<Map<string, WorkflowEntry>> {
  const workflows = new Map<string, WorkflowEntry>();
  for (const entry of await readdir(workflowsDirectory)) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    const text = await readFile(resolve(workflowsDirectory, entry), "utf8");
    workflows.set(entry, { text, doc: parseYaml(text) as Workflow });
  }
  for (const name of EXPECTED_WORKFLOWS) assert.ok(workflows.has(name), `expected workflow ${name} to be committed`);
  return workflows;
}

function workflowOf(workflows: Map<string, WorkflowEntry>, name: (typeof EXPECTED_WORKFLOWS)[number]): WorkflowEntry {
  const entry = workflows.get(name);
  assert.ok(entry, `${name} must be present`);
  return entry;
}

/** YAML 1.1 parsers turn the `on:` key into boolean true; cover both shapes. */
function triggerOf(doc: Workflow): Record<string, unknown> {
  const trigger = (doc["on"] ?? (doc as Record<string, unknown>)[true as unknown as string]) as Record<string, unknown> | undefined;
  assert.ok(trigger && typeof trigger === "object", "workflow must declare an object-shaped trigger block");
  return trigger;
}

function jobsOf(doc: Workflow): Record<string, Record<string, unknown>> {
  const jobs = doc["jobs"] as Record<string, Record<string, unknown>> | undefined;
  assert.ok(jobs && typeof jobs === "object", "workflow must declare jobs");
  return jobs;
}

function discoverDefaultBranch(): string {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const branch = ref.split("/").slice(1).join("/");
    if (branch) return branch;
  } catch {
    // Shallow or origin-less checkouts: fall through to the pinned fact.
  }
  return "master"; // verified default branch of this repository
}

test("every workflow parses as YAML with unique, non-empty job identifiers", async () => {
  const workflows = await loadWorkflows();
  for (const [name, { doc }] of workflows) {
    assert.ok(typeof doc["name"] === "string" && doc["name"].length > 0, `${name} must declare a workflow name`);
    const jobs = jobsOf(doc);
    assert.ok(Object.keys(jobs).length > 0, `${name} must declare at least one job`);
  }
});

test("push triggers target the verified default branch (master), never main", async () => {
  const defaultBranch = discoverDefaultBranch();
  assert.equal(defaultBranch, "master", "this repository's verified default branch is master; triggers must follow it, not a 'main' convention");
  const workflows = await loadWorkflows();
  const pushWorkflows: string[] = [];
  for (const [name, { doc }] of workflows) {
    const trigger = triggerOf(doc);
    if (!("push" in trigger)) continue;
    pushWorkflows.push(name);
    const push = trigger["push"] as { branches?: string[] } | null;
    assert.ok(push && typeof push === "object", `${name}: a bare push trigger without branch filters is forbidden`);
    assert.deepEqual(push.branches, [defaultBranch], `${name} push trigger must target exactly [${defaultBranch}]`);
    assert.ok(!JSON.stringify(push.branches).includes("main"), `${name} must not trigger on main`);
  }
  assert.deepEqual(pushWorkflows.sort(), ["ci-secretless-validation.yml", "cloudflare-deploy.yml", "oci-subject-build.yml"].sort(), "exactly the three delivery workflows carry push triggers");
});

test("manual dispatch exists only on cloudflare-deploy; PR gates cover validation and OCI", async () => {
  const workflows = await loadWorkflows();
  for (const [name, { doc }] of workflows) {
    const trigger = triggerOf(doc);
    const hasDispatch = Object.prototype.hasOwnProperty.call(trigger, "workflow_dispatch");
    assert.equal(hasDispatch, name === "cloudflare-deploy.yml", `${name}: workflow_dispatch is authorized only for the deployment workflow`);
  }
  // A bare `pull_request:` key parses as null, so assert key presence, not truthiness.
  assert.ok("pull_request" in triggerOf(workflowOf(workflows, "ci-secretless-validation.yml").doc), "ci-secretless-validation must run on pull requests");
  assert.ok("pull_request" in triggerOf(workflowOf(workflows, "oci-subject-build.yml").doc), "oci-subject-build must run on pull requests");
  assert.ok("pull_request" in triggerOf(workflowOf(workflows, "poc-pr-static.yml").doc), "poc-pr-static must run on pull requests");
  assert.ok(!("push" in triggerOf(workflowOf(workflows, "poc-pr-static.yml").doc)), "poc-pr-static must not run on push");
});

test("every remote action reference in every workflow is pinned to a full 40-char commit sha", async () => {
  const workflows = await loadWorkflows();
  let pinnedTotal = 0;
  for (const [name, { text }] of workflows) {
    const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*['"]?([^\s'"#]+)/gm)].map((match) => match[1]);
    assert.ok(uses.length > 0, `${name} must reference at least one action`);
    for (const candidate of uses) {
      assert.ok(candidate !== undefined, `${name}: uses regex must capture the reference`);
      const reference = candidate;
      assert.ok(!reference.startsWith("./"), `${name}: no local composite actions exist, so none may appear`);
      const separator = reference.lastIndexOf("@");
      assert.ok(separator > 0, `${name}: unpinned action reference ${reference}`);
      const spec = reference.slice(0, separator);
      const ref = reference.slice(separator + 1);
      assert.match(ref, /^[0-9a-f]{40}$/, `${name}: action ${spec} must be pinned to a full commit sha, got '${ref}' (named-version/tag pins are repo-policy violations)`);
      pinnedTotal += 1;
    }
  }
  // Strictly stronger than poc-pr-static's self-check, which only demands >= 2
  // sha40 pins inside itself; the whole-workflow audit leaves no unpinned gap.
  assert.ok(pinnedTotal >= 2, "pin audit must have observed pinned actions");
});

test("job container images are digest-pinned", async () => {
  const workflows = await loadWorkflows();
  let images = 0;
  for (const [name, { doc }] of workflows) {
    for (const [jobId, job] of Object.entries(jobsOf(doc))) {
      const container = job["container"] as { image?: string } | undefined;
      if (!container) continue;
      images += 1;
      assert.match(container.image ?? "", /@sha256:[0-9a-f]{64}$/, `${name}/${jobId}: container image must be digest-pinned`);
    }
  }
  assert.ok(images >= 2, "expected the semgrep and gitleaks container jobs to be present");
});

test("permissions are minimal everywhere: exactly contents:read, no job escalation, no writes", async () => {
  const workflows = await loadWorkflows();
  for (const [name, { doc, text }] of workflows) {
    assert.deepEqual(doc["permissions"], { contents: "read" }, `${name}: top-level permissions must be exactly contents:read`);
    for (const [jobId, job] of Object.entries(jobsOf(doc))) {
      assert.equal(job["permissions"], undefined, `${name}/${jobId}: job-level permissions would escalate the token`);
    }
    assert.ok(!/permissions:\s*\n\s*contents:\s*write/.test(text), `${name}: contents:write would grant mutation rights`);
  }
});

test("ci-secretless-validation validate job keeps fetch-depth: 0 for the evidence-history lane", async () => {
  const workflows = await loadWorkflows();
  const doc = workflowOf(workflows, "ci-secretless-validation.yml").doc;
  const validate = jobsOf(doc)["validate"];
  assert.ok(validate, "the validate job must exist");
  const steps = validate["steps"] as { name?: string; uses?: string; with?: Record<string, unknown> }[];
  const checkout = steps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"));
  assert.ok(checkout, "the validate job must check out the repository");
  assert.equal(checkout.with?.["fetch-depth"], 0, "fetch-depth: 0 is load-bearing: the offline suite asserts recorded evidence commits exist in git history, and a depth-1 checkout would fail that check");
});

test("cloudflare-deploy step ordering: checkout -> install -> build -> deploy -> verify", async () => {
  const workflows = await loadWorkflows();
  const doc = workflowOf(workflows, "cloudflare-deploy.yml").doc;
  const deploy = jobsOf(doc)["deploy"];
  assert.ok(deploy, "the deploy job must exist");
  const steps = (deploy["steps"] as { name?: string }[]).map((step) => step.name ?? "");
  const positionOf = (needle: string) => {
    const index = steps.findIndex((name) => name.includes(needle));
    assert.ok(index >= 0, `deploy workflow must contain a step matching '${needle}'`);
    return index;
  };
  assert.ok(positionOf("Checkout") < positionOf("pnpm"), "install must follow checkout");
  assert.ok(positionOf("Install") < positionOf("Build"), "build must follow install");
  assert.ok(positionOf("Build") < positionOf("Deploy"), "deploy must follow the asset build");
  assert.ok(positionOf("Deploy") < positionOf("Verify"), "smoke verification must follow the deploy");
  // Staging deploys the env-scoped config; production uses the root config.
  const deployStep = (deploy["steps"] as { name?: string; run?: string }[]).find((step) => (step.name ?? "").includes("Deploy"));
  assert.ok(deployStep, "the deploy job must contain a deploy step");
  assert.match(deployStep.run ?? "", /wrangler deploy --env staging/, "staging must deploy the env.staging configuration");
  assert.match(deployStep.run ?? "", /else\n\s*pnpm exec wrangler deploy\n/, "production must deploy the root configuration");
  assert.equal(deploy["environment"]?.toString().includes("cloudflare-"), true, "deployment must stay scoped to a GitHub Environment");
});

test("needs references resolve within each workflow and form no cycle", async () => {
  const workflows = await loadWorkflows();
  for (const [name, { doc }] of workflows) {
    const jobs = jobsOf(doc);
    const graph = new Map<string, string[]>();
    for (const [jobId, job] of Object.entries(jobs)) {
      const needs = job["needs"] === undefined ? [] : Array.isArray(job["needs"]) ? (job["needs"] as string[]) : [job["needs"] as string];
      for (const dependency of needs) {
        assert.ok(Object.prototype.hasOwnProperty.call(jobs, dependency), `${name}/${jobId}: needs '${dependency}' does not exist in this workflow`);
        assert.notEqual(dependency, jobId, `${name}/${jobId}: a job cannot depend on itself`);
      }
      graph.set(jobId, needs);
    }
    // Depth-first cycle detection over the declared ordering.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (jobId: string): void => {
      if (visited.has(jobId)) return;
      assert.ok(!visiting.has(jobId), `${name}: dependency cycle through '${jobId}'`);
      visiting.add(jobId);
      for (const dependency of graph.get(jobId) ?? []) visit(dependency);
      visiting.delete(jobId);
      visited.add(jobId);
    };
    for (const jobId of graph.keys()) visit(jobId);
  }
});

test("workflow secrets stay confined to the two declared Cloudflare secrets in the deploy workflow", async () => {
  const workflows = await loadWorkflows();
  const allowed = new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
  for (const [name, { text }] of workflows) {
    const references = [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    if (name !== "cloudflare-deploy.yml") {
      assert.deepEqual(references, [], `${name}: secretless workflow must reference no secrets`);
      continue;
    }
    for (const secret of references) {
      assert.ok(secret !== undefined, "secrets regex must capture the secret name");
      assert.ok(allowed.has(secret), `${name}: undeclared secret '${secret}'`);
    }
    assert.deepEqual([...new Set(references)].sort(), [...allowed].sort(), "the deploy workflow must use both and only its declared Cloudflare secrets");
  }
});
