// Shared helpers for the release-evidence lanes: commit detection, hashing,
// result recording, and pass/fail reporting with loud exit codes.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function sha256Hex(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export function commitSha(fallback = "local-uncommitted") {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
}

export function shortSha(fallback = "local") {
  return commitSha(fallback).slice(0, 12);
}

export function isoNow() {
  return new Date().toISOString();
}

export async function writeJsonRecord(relativePath, record) {
  // Path containment: the evidence writer must never be a write-what-where
  // primitive. Relative paths must stay inside the repository root — parent
  // traversal is rejected component-wise before any mkdir/write happens, the same
  // discipline the validators apply to artifact reads. Absolute paths are
  // admitted only for explicit caller-owned isolation directories (lane probes
  // pass --record-dir=<tmpdir>); traversal components are rejected in either
  // form.
  if (typeof relativePath !== "string" || !relativePath) {
    throw new Error(`writeJsonRecord refuses an empty record path: ${relativePath}`);
  }
  if (relativePath.split("/").includes("..")) {
    throw new Error(`writeJsonRecord refuses parent traversal in the record path: ${relativePath}`);
  }
  const absolute = resolve(root, relativePath);
  if (!isAbsolute(relativePath) && absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error(`writeJsonRecord refuses a path outside the repository root: ${relativePath}`);
  }
  await mkdir(dirname(absolute), { recursive: true });
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  // Atomic write: a concurrent lane run (or a crash mid-write) must never
  // leave a torn half-written record at the final path. Each writer uses a
  // unique temp file (same-process concurrent writers included) and the
  // rename is atomic on the same filesystem, so readers see either the old
  // record or the complete new one — never a truncation.
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, absolute);
  // Hash the exact serialized bytes in memory: the sha256 must attest what
  // the lane wrote, never whatever the record path yields at re-read time
  // (a symlink planted at the path would otherwise redirect the attestation).
  return sha256Hex(contents);
}

export class CheckCollector {
  constructor() {
    this.checks = [];
    this.failures = 0;
    // Named blockedCount: a this.blocked property shadows the prototype
    // blocked() method and makes it uncallable (TypeError).
    this.blockedCount = 0;
  }

  add({ checkId, name, procedure, startedAt, endedAt, result, measurement, artifacts = [], exception = undefined, failureFallback = "Fail the lane loudly and keep the gate blocked." }) {
    this.checks.push({ checkId, name, procedure, startedAt, endedAt, result, measurement, artifacts, ...(exception ? { exception } : {}), failureFallback });
    if (result === "fail") this.failures += 1;
    if (result === "blocked") this.blockedCount += 1;
  }

  pass(checkId, name, procedure, startedAt, endedAt, value, units, sampleCount = 1, artifacts = []) {
    if (!value) {
      // A false predicate is a FAILURE, never a pass: the evidence regime must
      // be fail-closed. Callers that want an honest non-pass must use fail()
      // or blocked() explicitly.
      this.fail(checkId, name, procedure, startedAt, endedAt, `check predicate evaluated false: ${name}`);
      return;
    }
    this.add({ checkId, name, procedure, startedAt, endedAt, result: "pass", measurement: { summary: name, value, units, sampleCount }, artifacts });
  }

  fail(checkId, name, procedure, startedAt, endedAt, message) {
    this.add({ checkId, name, procedure, startedAt, endedAt, result: "fail", measurement: { summary: message, value: false, units: "boolean", sampleCount: 1 } });
  }

  blocked(checkId, name, procedure, startedAt, endedAt, message) {
    this.add({ checkId, name, procedure, startedAt, endedAt, result: "blocked", measurement: { summary: message, value: null, units: "boolean", sampleCount: 1 } });
  }

  summary() {
    return { checks: this.checks.length, passed: this.checks.length - this.failures - this.blockedCount, blocked: this.blockedCount, failed: this.failures };
  }

  exitCode() {
    return this.failures > 0 ? 1 : 0;
  }
}

export function reportAndExit(collector, label) {
  const summary = collector.summary();
  if (summary.failed === 0) {
    const suffix = summary.blocked > 0 ? `, ${summary.blocked} blocked` : "";
    console.log(`${label}: ${summary.passed}/${summary.checks} checks passed${suffix}.`);
    process.exitCode = 0;
  } else {
    console.error(`${label}: ${summary.failed}/${summary.checks} checks FAILED.`);
    for (const check of collector.checks) {
      if (check.result === "fail") {
        console.error(`  FAILED ${check.checkId}: ${check.measurement?.summary ?? check.name}`);
      }
    }
    process.exitCode = 1;
  }
}
