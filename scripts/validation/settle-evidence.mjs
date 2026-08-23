// Two-phase evidence archive/re-settlement workflow.
//
// Default: print a reviewable plan and change nothing.
// Apply: require the reviewed plan to still match the filesystem, archive each
// selected root record byte-for-byte, regenerate the current loopback record,
// then run semantic validation serially. Historical records are never edited.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { commitSha, root, sha256Hex } from "./lib-evidence.mjs";
import { validateEvidenceBundle } from "./validate-evidence-bundle.mjs";

const execFileAsync = promisify(execFile);
export const SETTLEMENT_VERSION = "evidence-settlement-v1";
const evidenceDirectory = resolve(root, "docs/evidence");
const archiveDirectory = resolve(evidenceDirectory, "archived");
const defaultPlanPath = resolve(root, "tmp", `evidence-settlement-plan-${commitSha().slice(0, 12)}.json`);

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

// Path containment: plan files are human-reviewed, but the evidence root must
// never be reachable with a traversal name. Record names are flat basenames
// produced by readdir; anything else (separators, parent steps, dot-names)
// fails loudly before any file is read, moved, or unlinked.
function assertFlatEvidenceName(name) {
  if (typeof name !== "string" || !name || name !== basename(name) || name.startsWith(".")) {
    throw new Error(`settlement refuses a non-flat evidence record name: ${JSON.stringify(name)}`);
  }
}

function artifactEntries(record) {
  const entries = [...(record.artifacts ?? [])];
  for (const check of record.checks ?? []) entries.push(...(check?.artifacts ?? []));
  return entries;
}

async function staleArtifacts(record) {
  const stale = [];
  for (const artifact of artifactEntries(record)) {
    if (artifact?.path === "raw" || artifact?.path === "spawn" || artifact?.sha256 === "redacted-location-only" || artifact?.sha256 === "none") continue;
    if (!artifact || typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? "") || artifact.path.includes("..") || artifact.path.startsWith("/")) {
      stale.push(`${artifact?.path ?? "<invalid>"}: invalid artifact binding`);
      continue;
    }
    const absolute = resolve(root, artifact.path);
    try {
      const stats = await lstat(absolute);
      if (!stats.isFile()) {
        stale.push(`${artifact.path}: not a regular file`);
        continue;
      }
      const actual = digest(await readFile(absolute));
      if (actual !== artifact.sha256) stale.push(`${artifact.path}: recorded ${artifact.sha256}, current ${actual}`);
    } catch {
      stale.push(`${artifact.path}: missing`);
    }
  }
  return stale;
}

export async function buildSettlementPlan({ subject = commitSha() } = {}) {
  const names = (await readdir(evidenceDirectory)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
  const candidates = [];
  for (const name of names) {
    const source = resolve(evidenceDirectory, name);
    let record;
    let bytes;
    try {
      bytes = await readFile(source);
      record = JSON.parse(bytes.toString("utf8"));
    } catch {
      continue;
    }
    if (record.recordKind !== "lane-results" && record.recordKind !== "measurement-results") continue;
    const stale = await staleArtifacts(record);
    if (stale.length > 0) {
      candidates.push({
        name,
        subject: record.subject ?? null,
        sourceSha256: sha256Hex(bytes),
        byteLength: bytes.byteLength,
        reasons: stale,
      });
    }
  }
  return {
    schemaVersion: 1,
    planKind: SETTLEMENT_VERSION,
    createdAt: new Date().toISOString(),
    subject,
    review: { status: "pending", reviewedBy: null },
    rules: {
      preserveHistoricalBytes: true,
      archiveSupersededRootRecords: true,
      regenerateCurrentSubject: "loopback-five-family-lane",
      validateSemanticGate: "serial-after-regeneration",
      azureWrites: false,
      production: "prohibited",
    },
    candidates,
  };
}

async function assertPlanUnchanged(plan) {
  const current = await buildSettlementPlan({ subject: plan.subject });
  const expected = JSON.stringify(plan.candidates);
  const actual = JSON.stringify(current.candidates);
  if (expected !== actual) throw new Error("settlement plan is stale: candidate names, bytes, hashes, or reasons changed; generate and review a new plan");
}

export async function archiveRecordByteForByte(name, expectedSha256) {
  assertFlatEvidenceName(name);
  const source = resolve(evidenceDirectory, name);
  const destination = resolve(archiveDirectory, name);
  if (!source.startsWith(evidenceDirectory + sep) || !destination.startsWith(archiveDirectory + sep)) {
    throw new Error(`settlement refuses a path outside the evidence directories: ${name}`);
  }
  const sourceBytes = await readFile(source);
  if (sha256Hex(sourceBytes) !== expectedSha256) throw new Error(`source hash changed before archive: ${name}`);
  await mkdir(archiveDirectory, { recursive: true });
  try {
    const existing = await readFile(destination);
    if (sha256Hex(existing) !== expectedSha256 || existing.length !== sourceBytes.length) throw new Error(`archive destination differs for ${name}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const temporary = `${destination}.${process.pid}.tmp`;
    await copyFile(source, temporary);
    const archivedBytes = await readFile(temporary);
    if (sha256Hex(archivedBytes) !== expectedSha256 || archivedBytes.length !== sourceBytes.length || !archivedBytes.equals(sourceBytes)) {
      await unlink(temporary).catch(() => {});
      throw new Error(`byte-for-byte archive verification failed for ${name}`);
    }
    await rename(temporary, destination);
  }
  const verified = await readFile(destination);
  if (!verified.equals(sourceBytes)) throw new Error(`archive postcondition failed for ${name}`);
  await unlink(source);
  return { name, sha256: expectedSha256, byteLength: sourceBytes.length };
}

async function regenerateCurrentSubject() {
  // Deliberately await this before validation; no parallel lane writers or
  // validator scans are permitted during settlement.
  await execFileAsync(process.execPath, ["--experimental-strip-types", "scripts/validation/loopback-lane.mjs"], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
}

export async function validateSerially() {
  // Keep this as an explicit sequential call after all writes. The validator
  // itself scans records in sorted order and reports every mismatch.
  const result = await validateEvidenceBundle();
  if (result.errors.length > 0) throw new Error(`semantic validation failed:\n${result.errors.join("\n")}`);
  return result;
}

// Recovery after a failed apply: when every planned root record is already
// archived but the audit record is missing (e.g. serial validation failed
// after the archives moved), write the audit from the on-disk reality.
async function writeRecoveryAudit(plan) {
  if (plan.review?.status !== "approved") throw new Error("recovery requires plan.review.status=approved after human review");
  const archived = [];
  for (const candidate of plan.candidates) {
    assertFlatEvidenceName(candidate.name);
    const archivedBytes = await readFile(resolve(archiveDirectory, candidate.name));
    if (sha256Hex(archivedBytes) !== candidate.sourceSha256) throw new Error(`archived bytes differ from the reviewed plan: ${candidate.name}`);
    if (await lstat(resolve(evidenceDirectory, candidate.name)).then(() => true, () => false)) throw new Error(`root record still present: ${candidate.name}`);
    archived.push({ name: candidate.name, sha256: candidate.sourceSha256, byteLength: archivedBytes.byteLength });
  }
  const validation = await validateSerially();
  const audit = {
    schemaVersion: 1,
    recordKind: "settlement-results",
    planKind: SETTLEMENT_VERSION,
    subject: { type: "commit", identifiers: { commit: plan.subject }, environment: "local-settlement" },
    completedAt: new Date().toISOString(),
    archived,
    regenerated: ["docs/evidence/loopback-lane-local-" + plan.subject.slice(0, 12) + ".json"],
    validation: { mode: "serial-after-regeneration", gateCount: validation.gateCount, laneCount: validation.laneCount },
    recovery: "audit written after a mid-apply validation failure; archives were verified byte-for-byte against the reviewed plan",
    azure: "untouched",
    production: "prohibited",
  };
  const auditPath = resolve(archiveDirectory, `settlement-${plan.subject.slice(0, 12)}.json`);
  await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  return { archived, validation, auditPath };
}

async function applySettlement(plan) {
  if (plan.review?.status !== "approved") throw new Error("apply requires plan.review.status=approved after human review");
  const auditPath = resolve(archiveDirectory, `settlement-${plan.subject.slice(0, 12)}.json`);
  try {
    await readFile(auditPath);
    throw new Error("settlement audit already exists; this plan was already applied");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await assertPlanUnchanged(plan);
  const archived = [];
  for (const candidate of plan.candidates) archived.push(await archiveRecordByteForByte(candidate.name, candidate.sourceSha256));
  await regenerateCurrentSubject();
  const validation = await validateSerially();
  const audit = {
    schemaVersion: 1,
    recordKind: "settlement-results",
    planKind: SETTLEMENT_VERSION,
    subject: { type: "commit", identifiers: { commit: plan.subject }, environment: "local-settlement" },
    completedAt: new Date().toISOString(),
    archived,
    regenerated: ["docs/evidence/loopback-lane-local-" + plan.subject.slice(0, 12) + ".json"],
    validation: { mode: "serial-after-regeneration", gateCount: validation.gateCount, laneCount: validation.laneCount },
    azure: "untouched",
    production: "prohibited",
  };
  await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  return { archived, validation, auditPath };
}

function usage() {
  console.log(`Usage:\n  node scripts/validation/settle-evidence.mjs [--write-plan <path>]\n  node scripts/validation/settle-evidence.mjs --apply --plan-file <path> --approve\n  node scripts/validation/settle-evidence.mjs --apply --recover --plan-file <path> --approve\n\nDefault is a read-only plan. Apply requires a reviewed plan with review.status=approved; it archives byte-for-byte, regenerates loopback evidence, then validates serially. --recover writes only the missing audit after a mid-apply failure, verifying each archived record byte-for-byte against the reviewed plan.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--help")) {
    usage();
    process.exit(0);
  }
  const writeIndex = process.argv.indexOf("--write-plan");
  const planPath = writeIndex >= 0 ? resolve(root, process.argv[writeIndex + 1]) : defaultPlanPath;
  if (process.argv.includes("--apply")) {
    const planIndex = process.argv.indexOf("--plan-file");
    if (planIndex < 0 || !process.argv[planIndex + 1] || !process.argv.includes("--approve")) throw new Error("apply requires --plan-file <path> --approve");
    const plan = JSON.parse(await readFile(resolve(root, process.argv[planIndex + 1]), "utf8"));
    if (process.argv.includes("--recover")) {
      const result = await writeRecoveryAudit(plan);
      console.log(`Settlement recovery: ${result.archived.length} archived record(s) verified byte-for-byte against the reviewed plan; semantic validation passed serially.`);
      console.log(`Audit: ${result.auditPath.replace(`${root}/`, "")}`);
    } else {
      const result = await applySettlement(plan);
      console.log(`Settlement applied: ${result.archived.length} root record(s) archived byte-for-byte; current loopback subject regenerated; semantic validation passed serially.`);
      console.log(`Audit: ${result.auditPath.replace(`${root}/`, "")}`);
    }
  } else {
    const plan = await buildSettlementPlan();
    if (writeIndex >= 0) {
      await mkdir(resolve(planPath, ".."), { recursive: true });
      await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      console.log(`Reviewable settlement plan written to ${planPath.replace(`${root}/`, "")}`);
    }
    console.log(JSON.stringify(plan, null, 2));
    console.log("No files moved. Review the plan, set review.status to approved, then apply with --apply --plan-file <path> --approve.");
  }
}
