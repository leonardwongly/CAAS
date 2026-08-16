import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./lib-evidence.mjs";

const evidenceDirectory = resolve(root, "docs/evidence");
const archiveDirectory = resolve(evidenceDirectory, "archived");
const apply = process.argv.includes("--apply");
const digest = (value) => createHash("sha256").update(value).digest("hex");

function artifactEntries(record) {
  const entries = [...(record.artifacts ?? [])];
  for (const check of record.checks ?? []) entries.push(...(check?.artifacts ?? []));
  return entries;
}

async function staleArtifacts(record) {
  const stale = [];
  for (const artifact of artifactEntries(record)) {
    if (artifact?.path === "raw" || artifact?.path === "spawn" || artifact?.sha256 === "redacted-location-only" || artifact?.sha256 === "none") continue;
    if (!artifact || typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") || artifact.path.includes("..") || artifact.path.startsWith("/")) {
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

const names = (await readdir(evidenceDirectory)).filter((name) => name.endsWith(".json") && !name.startsWith("."))
  .sort();
const candidates = [];
for (const name of names) {
  const path = resolve(evidenceDirectory, name);
  let record;
  try {
    record = JSON.parse(await readFile(path, "utf8"));
  } catch {
    continue;
  }
  if (record.recordKind !== "lane-results" && record.recordKind !== "measurement-results") continue;
  const stale = await staleArtifacts(record);
  if (stale.length > 0) candidates.push({ name, stale });
}

if (candidates.length === 0) {
  console.log("No stale top-level lane/measurement evidence records found.");
  process.exit(0);
}

console.log(`${apply ? "Applying" : "Dry run:"} ${candidates.length} stale top-level lane/measurement record(s).`);
for (const candidate of candidates) {
  console.log(`- ${candidate.name}`);
  for (const reason of candidate.stale) console.log(`  ${reason}`);
}

if (!apply) {
  console.log("No files moved. Re-run with --apply only after reviewing this list.");
  process.exit(0);
}

await mkdir(archiveDirectory, { recursive: true });
for (const candidate of candidates) {
  const source = resolve(evidenceDirectory, candidate.name);
  const destination = resolve(archiveDirectory, candidate.name);
  try {
    await lstat(destination);
    throw new Error(`archive destination already exists: ${candidate.name}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rename(source, destination);
}
console.log(`Archived ${candidates.length} stale record(s) byte-for-byte under docs/evidence/archived/.`);
