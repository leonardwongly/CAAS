import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const [inputArg, outputArg, commitArg, retrievedAtArg] = process.argv.slice(2);
if (!inputArg || !outputArg || !commitArg || !/^[0-9a-f]{40}$/.test(commitArg)) {
  throw new Error("Usage: node scripts/generate-airport-names.mjs <airports.csv> <output-dir> <40-char-source-commit> [retrieved-at]");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const inputPath = resolve(inputArg);
const outputDir = resolve(outputArg);
const source = await readFile(inputPath);
const rows = parseCsv(source.toString("utf8"));
const header = rows.shift();
if (!header) throw new Error("CSV has no header");
const icaoIndex = header.indexOf("icao_code");
const nameIndex = header.indexOf("name");
if (icaoIndex < 0 || nameIndex < 0) throw new Error("CSV must contain icao_code and name columns");

const byIcao = new Map();
for (const row of rows) {
  const icao = (row[icaoIndex] ?? "").trim().toUpperCase();
  if (!icao) continue;
  if (!/^[A-Z]{4}$/.test(icao)) throw new Error(`Invalid ICAO value: ${icao}`);
  const name = (row[nameIndex] ?? "").trim().normalize("NFC");
  if (!name || name.length > 160) throw new Error(`Invalid airport name for ${icao}`);
  const prior = byIcao.get(icao);
  if (prior && prior !== name) throw new Error(`Conflicting airport names for ${icao}: ${prior} / ${name}`);
  byIcao.set(icao, name);
}

const records = [...byIcao].sort(([left], [right]) => left.localeCompare(right)).map(([icao, name]) => ({ icao, name }));
const bundle = `${JSON.stringify({ schemaVersion: 1, records }, null, 2)}\n`;
const retrievedAt = retrievedAtArg ?? new Date().toISOString();
if (Number.isNaN(Date.parse(retrievedAt))) throw new Error("retrieved-at must be an ISO timestamp");
const sourceUrl = `https://raw.githubusercontent.com/davidmegginson/ourairports-data/${commitArg}/airports.csv`;
const manifest = `${JSON.stringify({
  schemaVersion: 1,
  source: {
    name: "OurAirports airports.csv",
    url: sourceUrl,
    repository: "https://github.com/davidmegginson/ourairports-data",
    commit: commitArg,
    retrievedAt,
    license: "Public Domain / Unlicense",
    licenseUrl: "https://github.com/davidmegginson/ourairports-data/blob/main/LICENSE",
    authority: "community-maintained reference; not an official ICAO publication",
    disclaimer: "No guarantee of accuracy or fitness for use.",
  },
  selection: "Exact uppercase four-letter values from the icao_code column only; no ident, gps_code, local_code, fuzzy, proximity, or runtime lookup joins.",
  generator: basename(import.meta.filename),
  sourceSha256: sha256(source),
  recordsSha256: sha256(bundle),
  recordCount: records.length,
}, null, 2)}\n`;
await writeFile(resolve(outputDir, "airport-names.json"), bundle);
await writeFile(resolve(outputDir, "manifest.json"), manifest);
console.log(JSON.stringify({ recordCount: records.length, sourceSha256: sha256(source), recordsSha256: sha256(bundle) }));
