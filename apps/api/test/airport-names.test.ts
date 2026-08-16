import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  AIRPORT_NAME_RECORD_COUNT,
  airportDisplayLabel,
  airportNameForIcao,
} from "../src/airport-names.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const dataDirectory = resolve(import.meta.dirname, "../src/data");
const bundlePath = join(dataDirectory, "airport-names.json");
const manifestPath = join(dataDirectory, "manifest.json");
const generatorPath = join(repositoryRoot, "scripts/generate-airport-names.mjs");

type AirportRecord = { icao: string; name: string };
type AirportBundle = { schemaVersion: number; records: AirportRecord[] };
type AirportManifest = {
  schemaVersion: number;
  source: {
    name: string;
    url: string;
    repository: string;
    commit: string;
    retrievedAt: string;
    license: string;
    licenseUrl: string;
    authority: string;
    disclaimer: string;
  };
  selection: string;
  generator: string;
  sourceSha256: string;
  recordsSha256: string;
  recordCount: number;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

test("airport-name manifest pins the governed source, license, version, checksum, and count", async () => {
  const bundleBytes = await readFile(bundlePath);
  const bundle = JSON.parse(bundleBytes.toString("utf8")) as AirportBundle;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as AirportManifest;

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.source.name, "OurAirports airports.csv");
  assert.equal(manifest.source.repository, "https://github.com/davidmegginson/ourairports-data");
  assert.equal(manifest.source.commit, "be07e33e6cc10087f57064f2bb3fccfcd39f5801");
  assert.equal(
    manifest.source.url,
    `https://raw.githubusercontent.com/davidmegginson/ourairports-data/${manifest.source.commit}/airports.csv`,
  );
  assert.equal(manifest.source.license, "Public Domain / Unlicense");
  assert.match(manifest.source.licenseUrl, /\/LICENSE$/);
  assert.equal(manifest.source.authority, "community-maintained reference; not an official ICAO publication");
  assert.equal(manifest.sourceSha256, "f23f8924e70a585ceebc03ec4e49beb3aa7743588caf5490c045f1fe53320a71");
  assert.equal(manifest.recordsSha256, "6bfc0f4d050a0e058e2dda87b2837f0ea9a18d84a7c1a164ccff80619bc98608");
  assert.equal(sha256(bundleBytes), manifest.recordsSha256);
  assert.equal(manifest.recordCount, 10_444);
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.records.length, manifest.recordCount);
  assert.equal(AIRPORT_NAME_RECORD_COUNT, manifest.recordCount);
});

test("airport-name records are unique, sorted, normalized exact ICAO entries", async () => {
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as AirportBundle;
  const codes = bundle.records.map(({ icao }) => icao);

  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(codes, [...codes].sort((left, right) => left.localeCompare(right)));
  for (const record of bundle.records) {
    assert.match(record.icao, /^[A-Z]{4}$/);
    assert.equal(record.name, record.name.trim().normalize("NFC"));
    assert.ok(record.name.length > 0 && record.name.length <= 160);
  }
});

test("airport enrichment uses exact ICAO only and has an explicit fallback without runtime lookup", async () => {
  assert.equal(airportNameForIcao("KJFK"), "John F. Kennedy International Airport");
  assert.equal(airportNameForIcao("kjfk"), "John F. Kennedy International Airport");
  assert.equal(airportNameForIcao("JFK"), undefined);
  assert.equal(airportNameForIcao("KJFK-nearby"), undefined);
  assert.equal(airportNameForIcao("ZZZZ"), undefined);
  assert.equal(airportDisplayLabel("KJFK"), "John F. Kennedy International Airport (KJFK)");
  assert.equal(airportDisplayLabel("ZZZZ"), "Name unavailable (ZZZZ)");

  const runtimeSource = await readFile(resolve(import.meta.dirname, "../src/airport-names.ts"), "utf8");
  assert.doesNotMatch(runtimeSource, /\bfetch\s*\(|https?:\/\//i);
});

test("the pinned generator is deterministic and excludes non-ICAO code columns", async () => {
  const work = await mkdtemp(join(tmpdir(), "airport-names-test-"));
  try {
    const input = join(work, "airports.csv");
    const outputOne = join(work, "one");
    const outputTwo = join(work, "two");
    const source = [
      "ident,name,icao_code,gps_code,local_code",
      'JFK,"John F. Kennedy, International Airport",KJFK,KJFK,JFK',
      "LOCAL,Local Only Airport,,ZZZZ,LOCAL",
      "HEATHROW,London Heathrow Airport,egll,EGLL,LHR",
      "",
    ].join("\n");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await writeFile(input, source);
    await mkdir(outputOne);
    await mkdir(outputTwo);
    const args = [input, outputOne, "be07e33e6cc10087f57064f2bb3fccfcd39f5801", "2026-08-16T10:02:08Z"];
    await execFileAsync(process.execPath, [generatorPath, ...args]);
    args[1] = outputTwo;
    await execFileAsync(process.execPath, [generatorPath, ...args]);

    const firstBundle = await readFile(join(outputOne, "airport-names.json"), "utf8");
    const secondBundle = await readFile(join(outputTwo, "airport-names.json"), "utf8");
    const firstManifest = await readFile(join(outputOne, "manifest.json"), "utf8");
    const secondManifest = await readFile(join(outputTwo, "manifest.json"), "utf8");
    assert.equal(firstBundle, secondBundle);
    assert.equal(firstManifest, secondManifest);
    assert.deepEqual((JSON.parse(firstBundle) as AirportBundle).records, [
      { icao: "EGLL", name: "London Heathrow Airport" },
      { icao: "KJFK", name: "John F. Kennedy, International Airport" },
    ]);
    const generatedManifest = JSON.parse(firstManifest) as AirportManifest;
    assert.equal(generatedManifest.sourceSha256, sha256(source));
    assert.equal(generatedManifest.recordsSha256, sha256(firstBundle));
    assert.match(generatedManifest.selection, /no ident, gps_code, local_code, fuzzy, proximity, or runtime lookup joins/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
