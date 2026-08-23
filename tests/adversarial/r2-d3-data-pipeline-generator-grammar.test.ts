/**
 * R2-D3 — data pipelines & snapshot integrity.
 *
 * Hostile CSV grammar against scripts/generate-airport-names.mjs: the
 * generator must fail closed deterministically and never emit corrupt
 * bundles.
 *
 * Dedupe note: apps/api/test/airport-names.test.ts already pins the sha256
 * chain, record count 10_444, uniqueness/sort/^[A-Z]{4}$/NFC/≤160 invariants,
 * lookup fallbacks, no-fetch runtime, and generator determinism on one small
 * CSV with one quoted-comma field. This file does not repeat those; it covers
 * hostile grammar the baseline never feeds the parser: CRLF/BOM, quoted
 * fields with embedded newlines, unterminated quotes, empty/header-only
 * input, missing columns, malformed and lookalike ICAO values, duplicate
 * ident conflicts, short/oversize rows, control/bidi characters in names,
 * and argument validation — always asserting fail-closed with no partial
 * output.
 */
import assert from "node:assert/strict";
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
const RETRIEVED_AT = "2026-08-16T10:02:08Z";

type AirportBundle = { schemaVersion: number; records: Array<{ icao: string; name: string }> };
type AirportManifest = { recordCount: number; sourceSha256: string; recordsSha256: string };

async function runGenerator(inputText: string | Buffer, args: string[] = []): Promise<{
  code: number;
  stderr: string;
  outputDirectory: string;
}> {
  const work = await mkdtemp(join(tmpdir(), "r2d3-generator-"));
  const inputPath = join(work, "airports.csv");
  const outputDirectory = join(work, "out");
  await writeFile(inputPath, inputText);
  await mkdir(outputDirectory);
  try {
    await execFileAsync(process.execPath, [
      generatorPath,
      inputPath,
      outputDirectory,
      COMMIT,
      RETRIEVED_AT,
      ...args,
    ]);
    return { code: 0, stderr: "", outputDirectory };
  } catch (error) {
    const failure = error as { code: number; stderr: string };
    // Record the directory so assertions can prove no partial output landed,
    // then report everything through the returned descriptor.
    failure.stderr = failure.stderr ?? "";
    return { code: failure.code ?? 1, stderr: failure.stderr, outputDirectory };
  } finally {
    cleanupQueue.push(work);
  }
}

const cleanupQueue: string[] = [];
test.after(async () => {
  for (const directory of cleanupQueue) await rm(directory, { recursive: true, force: true });
});

async function readOutputs(outputDirectory: string): Promise<{ bundle: AirportBundle; manifest: AirportManifest; bundleText: string }> {
  const bundleText = await readFile(join(outputDirectory, "airport-names.json"), "utf8");
  const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8")) as AirportManifest;
  return { bundle: JSON.parse(bundleText) as AirportBundle, manifest, bundleText };
}

async function assertFailClosed(result: { code: number; stderr: string; outputDirectory: string }, messagePart: string): Promise<void> {
  assert.notEqual(result.code, 0, "hostile input must exit non-zero");
  assert.match(result.stderr, new RegExp(messagePart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(await readdir(result.outputDirectory), [], "no partial bundle or manifest may be written on failure");
}

test("CRLF input parses identically to LF input for the same logical rows", async () => {
  const lf = "icao_code,name\nKAAA,Alpha Airport\nKBBB,Beta Airport\n";
  const crlf = lf.replaceAll("\n", "\r\n");
  const fromLf = await runGenerator(lf);
  const fromCrlf = await runGenerator(crlf);
  assert.equal(fromLf.code, 0);
  assert.equal(fromCrlf.code, 0);
  const lfOutputs = await readOutputs(fromLf.outputDirectory);
  const crlfOutputs = await readOutputs(fromCrlf.outputDirectory);
  assert.deepEqual(crlfOutputs.bundle.records, lfOutputs.bundle.records);
  assert.deepEqual(crlfOutputs.bundle.records, [
    { icao: "KAAA", name: "Alpha Airport" },
    { icao: "KBBB", name: "Beta Airport" },
  ]);
});

test("a single leading UTF-8 BOM is stripped deterministically and the raw bytes are still hashed", async () => {
  const plain = "icao_code,name\nKAAA,Alpha Airport\n";
  const bommed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(plain, "utf8")]);
  const fromPlain = await runGenerator(plain);
  const fromBom = await runGenerator(bommed);
  assert.equal(fromPlain.code, 0);
  assert.equal(fromBom.code, 0, "BOM-prefixed CSV must not fail closed once stripped");
  const plainOutputs = await readOutputs(fromPlain.outputDirectory);
  const bomOutputs = await readOutputs(fromBom.outputDirectory);
  assert.deepEqual(bomOutputs.bundle, plainOutputs.bundle);
  assert.equal(bomOutputs.manifest.recordCount, plainOutputs.manifest.recordCount);
  assert.notEqual(bomOutputs.manifest.sourceSha256, plainOutputs.manifest.sourceSha256, "provenance must hash the raw input bytes, BOM included");
});

test("quoted fields keep escaped quotes; embedded newlines fail closed as control characters", async () => {
  const csv = 'icao_code,name\nKAAA,"Air ""North"" Field"\n';
  const result = await runGenerator(csv);
  assert.equal(result.code, 0);
  const { bundle } = await readOutputs(result.outputDirectory);
  assert.deepEqual(bundle.records, [{ icao: "KAAA", name: 'Air "North" Field' }]);

  await assertFailClosed(
    await runGenerator('icao_code,name\nKAAA,"Alpha\nAir Field"\n'),
    "control or bidirectional formatting characters",
  );
});

test("input ending inside a quoted field fails closed with no output", async () => {
  await assertFailClosed(
    await runGenerator('icao_code,name\nKAAA,"unterminated\n'),
    "CSV ends inside a quoted field",
  );
});

test("empty input and header-only input fail closed or emit an honest empty bundle", async () => {
  await assertFailClosed(await runGenerator(""), "CSV has no header");
  const headerOnly = await runGenerator("icao_code,name\n");
  assert.equal(headerOnly.code, 0);
  const { bundle, manifest } = await readOutputs(headerOnly.outputDirectory);
  assert.deepEqual(bundle, { schemaVersion: 1, records: [] });
  assert.equal(manifest.recordCount, 0, "record count must reflect zero accepted records, not raw rows");
});

test("missing required columns fail closed", async () => {
  await assertFailClosed(await runGenerator("icao,name\nKAAA,Alpha\n"), "CSV must contain icao_code and name columns");
  await assertFailClosed(await runGenerator("name\nAlpha\n"), "CSV must contain icao_code and name columns");
});

test("malformed, short, oversize, and lookalike ICAO values fail closed", async () => {
  for (const hostile of ["KJ", "KJFKX", "KJF1", "\u041aJFK", "KJF K", "1234"]) {
    await assertFailClosed(await runGenerator(`icao_code,name\n${hostile},Alpha\n`), "Invalid ICAO value");
  }
});

test("lowercase and padded ICAO values are normalized, duplicate idents dedupe, conflicting names fail closed", async () => {
  const dedupe = await runGenerator("icao_code,name\n kaAa ,Alpha Airport\nKAAA,Alpha Airport\n");
  assert.equal(dedupe.code, 0);
  const { bundle, manifest } = await readOutputs(dedupe.outputDirectory);
  assert.deepEqual(bundle.records, [{ icao: "KAAA", name: "Alpha Airport" }]);
  assert.equal(manifest.recordCount, 1, "recordCount must count unique ICAO codes, not raw CSV rows");

  await assertFailClosed(
    await runGenerator("icao_code,name\nKAAA,Alpha Airport\nKAAA,Beta Airport\n"),
    "Conflicting airport names for KAAA",
  );
});

test("short rows and whitespace-only names fail closed instead of emitting blank records", async () => {
  await assertFailClosed(await runGenerator("icao_code,name\nKAAA\n"), "Invalid airport name for KAAA");
  await assertFailClosed(await runGenerator("icao_code,name\nKAAA,   \n"), "Invalid airport name for KAAA");
});

test("oversize names fail closed at 161 while exactly 160 is accepted", async () => {
  const atLimit = "A".repeat(160);
  const accepted = await runGenerator(`icao_code,name\nKAAA,${atLimit}\n`);
  assert.equal(accepted.code, 0);
  const { bundle } = await readOutputs(accepted.outputDirectory);
  assert.equal(bundle.records[0]!.name.length, 160);
  await assertFailClosed(await runGenerator(`icao_code,name\nKAAA,${atLimit}B\n`), "Invalid airport name for KAAA");
});

test("names with control or bidirectional formatting characters fail closed", async () => {
  const hostile = ["Alpha\u0000Airport", "Alpha\u001bAirport", "Alpha\u0085Airport", "Alpha\u202eAirport", "Alpha\u202e\u2066Airport", "\u200fAlpha\u200f"];
  for (const name of hostile) {
    await assertFailClosed(await runGenerator(`icao_code,name\nKAAA,${name}\n`), "control or bidirectional formatting characters");
  }
});

test("NFC normalization makes composed and decomposed duplicates agree while true lookalikes conflict", async () => {
  const composed = "Caf\u00e9 Airport";
  const decomposed = "Cafe\u0301 Airport";
  const nfc = await runGenerator(`icao_code,name\nKAAA,${composed}\nKAAA,${decomposed}\n`);
  assert.equal(nfc.code, 0, "NFC-equivalent duplicate names must not conflict");
  const { bundle } = await readOutputs(nfc.outputDirectory);
  assert.equal(bundle.records[0]!.name, composed);

  await assertFailClosed(
    await runGenerator(`icao_code,name\nKAAA,Cafe Airport\nKAAA,Caf\u00e9 Airport\n`),
    "Conflicting airport names for KAAA",
  );
});

test("extra columns and ragged trailing fields are tolerated without shifting governance columns", async () => {
  const result = await runGenerator("icao_code,name,extra\nKAAA,Alpha Airport,bonus,more\n");
  assert.equal(result.code, 0);
  const { bundle } = await readOutputs(result.outputDirectory);
  assert.deepEqual(bundle.records, [{ icao: "KAAA", name: "Alpha Airport" }]);
});

test("invalid commit and retrieved-at arguments fail closed before reading data", async () => {
  const work = await mkdtemp(join(tmpdir(), "r2d3-generator-args-"));
  cleanupQueue.push(work);
  const inputPath = join(work, "airports.csv");
  const outputDirectory = join(work, "out");
  await writeFile(inputPath, "icao_code,name\nKAAA,Alpha\n");
  await mkdir(outputDirectory);
  for (const badCommit of ["main", "be07e33", "BE07E33E6CC10087F57064F2BB3FCCFCD39F5801", "zz07e33e6cc10087f57064f2bb3fccfcd39f5801"]) {
    await assert.rejects(
      execFileAsync(process.execPath, [generatorPath, inputPath, outputDirectory, badCommit, RETRIEVED_AT]),
      /Usage/,
      `commit ${badCommit} must be rejected by the argument guard`,
    );
  }
  await assert.rejects(
    execFileAsync(process.execPath, [generatorPath, inputPath, outputDirectory, COMMIT, "not-a-timestamp"]),
    /retrieved-at must be an ISO timestamp/,
  );
  assert.deepEqual(await readdir(outputDirectory), [], "invalid arguments must not write any output");
});
