/**
 * R2-D3 — data pipelines & snapshot integrity.
 *
 * Manifest governance-field semantics and drift between manifest and bundle:
 * the manifest must be an honest, self-consistent provenance record for
 * whatever bundle sits next to it.
 *
 * Dedupe note: apps/api/test/airport-names.test.ts already pins the committed
 * manifest's exact digest values, license/authority fields, and
 * sha256(bundle) === recordsSha256 for the committed artifact. This file
 * instead exercises the generator's manifest semantics under hostile corpora:
 * recordCount vs raw rows, hash drift detection, governance fields
 * (generator, disclaimer, retrievedAt), and manifest/bundle agreement after
 * regeneration.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const generatorPath = join(repositoryRoot, "scripts/generate-airport-names.mjs");
const COMMIT = "be07e33e6cc10087f57064f2bb3fccfcd39f5801";

type GeneratedBundle = { schemaVersion: number; records: Array<{ icao: string; name: string }> };
type GeneratedManifest = {
  schemaVersion: number;
  source: { url: string; commit: string; retrievedAt: string; disclaimer: string };
  selection: string;
  generator: string;
  sourceSha256: string;
  recordsSha256: string;
  recordCount: number;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function generate(csv: string, retrievedAt = "2026-08-16T10:02:08Z"): Promise<{
  bundle: GeneratedBundle;
  bundleText: string;
  manifest: GeneratedManifest;
  csvBytes: Buffer;
}> {
  const work = await mkdtemp(join(tmpdir(), "r2d3-manifest-"));
  const inputPath = join(work, "airports.csv");
  const outputDirectory = join(work, "out");
  await writeFile(inputPath, csv);
  await mkdir(outputDirectory);
  try {
    await execFileAsync(process.execPath, [generatorPath, inputPath, outputDirectory, COMMIT, retrievedAt]);
    const bundleText = await readFile(join(outputDirectory, "airport-names.json"), "utf8");
    const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8")) as GeneratedManifest;
    return { bundle: JSON.parse(bundleText) as GeneratedBundle, bundleText, manifest, csvBytes: Buffer.from(csv, "utf8") };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test("generated manifest digests, counts, and governance fields are self-consistent", async () => {
  const csv = "icao_code,name\nKBBB,Beta Airport\nKAAA,Alpha Airport\n kaAa ,Alpha Airport\n";
  const { bundle, bundleText, manifest, csvBytes } = await generate(csv);

  assert.equal(manifest.recordCount, bundle.records.length, "recordCount must equal the bundle's record count");
  assert.equal(manifest.recordCount, 2, "duplicate idents must not inflate recordCount");
  assert.equal(manifest.recordsSha256, sha256(bundleText), "recordsSha256 must hash the exact emitted bundle bytes");
  assert.equal(manifest.sourceSha256, sha256(csvBytes), "sourceSha256 must hash the exact input bytes");
  assert.equal(manifest.generator, "generate-airport-names.mjs", "generator field must name the producing script");
  assert.equal(manifest.source.commit, COMMIT);
  assert.ok(manifest.source.url.includes(`/${COMMIT}/`), "source url must embed the pinned commit");
  assert.ok(manifest.source.disclaimer.length > 0, "the disclaimer governance field must not be dropped");
  assert.ok(!Number.isNaN(Date.parse(manifest.source.retrievedAt)), "retrievedAt must be a parseable timestamp");
  assert.equal(manifest.source.retrievedAt, "2026-08-16T10:02:08Z", "retrievedAt must be recorded exactly as supplied for provenance fidelity");
});

test("recordCount reflects unique accepted ICAO codes under a hostile corpus, never raw row counts", async () => {
  const csv = [
    "icao_code,name",
    "KAAA,Alpha Airport",
    "KAAA,Alpha Airport",
    "KAAA,Alpha Airport",
    "KBBB,Beta Airport",
    ",Skipped Row",
    "KCCC,  Gamma Airport  ",
  ].join("\n");
  const { bundle, manifest } = await generate(csv);
  assert.equal(manifest.recordCount, 3);
  assert.deepEqual(bundle.records.map((record) => record.icao), ["KAAA", "KBBB", "KCCC"]);
  assert.equal(bundle.records[2]!.name, "Gamma Airport", "names must be trimmed before recording");
});

test("a one-byte drift in either artifact is detectable via the pinned digests", async () => {
  const { bundleText, manifest, csvBytes } = await generate("icao_code,name\nKAAA,Alpha Airport\n");
  assert.notEqual(sha256(`${bundleText} `), manifest.recordsSha256, "trailing whitespace drift must change the bundle digest");
  const drifted = bundleText.replace("Alpha Airport", "Alpha Airporx");
  assert.notEqual(sha256(drifted), manifest.recordsSha256, "content drift must change the bundle digest");
  assert.notEqual(sha256(Buffer.concat([csvBytes, Buffer.from("x")])), manifest.sourceSha256, "source drift must change the source digest");
});

test("the committed manifest and bundle agree on every cross-checked governance field", async () => {
  const dataDirectory = resolve(import.meta.dirname, "../../apps/api/src/data");
  const bundleBytes = await readFile(join(dataDirectory, "airport-names.json"));
  const bundle = JSON.parse(bundleBytes.toString("utf8")) as GeneratedBundle;
  const manifest = JSON.parse(await readFile(join(dataDirectory, "manifest.json"), "utf8")) as GeneratedManifest;

  assert.equal(manifest.generator, "generate-airport-names.mjs");
  assert.equal(manifest.recordCount, bundle.records.length, "committed recordCount must not drift from the committed bundle");
  assert.equal(manifest.recordsSha256, sha256(bundleBytes));
  assert.ok(!Number.isNaN(Date.parse(manifest.source.retrievedAt)), "committed retrievedAt must remain a parseable timestamp");
  assert.ok(manifest.source.url.startsWith("https://raw.githubusercontent.com/"), "committed source url must remain a raw content pin");
  assert.match(manifest.selection, /no ident, gps_code, local_code, fuzzy, proximity, or runtime lookup joins/);
});

test("non-ISO retrieved-at values are rejected before any manifest is emitted", async () => {
  for (const retrievedAt of ["yesterday", "2026-13-45T99:99:99Z", "16/08/2026"]) {
    const work = await mkdtemp(join(tmpdir(), "r2d3-manifest-badts-"));
    const inputPath = join(work, "airports.csv");
    const outputDirectory = join(work, "out");
    await writeFile(inputPath, "icao_code,name\nKAAA,Alpha\n");
    await mkdir(outputDirectory);
    try {
      await assert.rejects(
        execFileAsync(process.execPath, [generatorPath, inputPath, outputDirectory, COMMIT, retrievedAt]),
        /retrieved-at must be an ISO timestamp/,
      );
      assert.deepEqual(await readdir(outputDirectory), []);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
});
