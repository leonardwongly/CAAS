import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { trainGapDistanceModel, validateGapDistanceModelFile } from "../../packages/route-engine/src/gap-distance.ts";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  console.error("Usage: pnpm --filter @flight-route-explorer/route-engine train:gap-distance -- --input <approved-corpus.json> --output <model.json> [--created-at <ISO>] [--force]");
}

function coordinate(value) {
  return value && typeof value === "object"
    && Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90
    && Number.isFinite(value.lon) && value.lon >= -180 && value.lon <= 180
    ? { lat: value.lat, lon: value.lon }
    : undefined;
}

function trainingRoutes(value) {
  const records = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray(value.routes) ? value.routes : [];
  return records.flatMap((record) => {
    if (!record || typeof record !== "object" || typeof record.routeGroup !== "string" || !record.routeGroup.trim() || !Array.isArray(record.coordinates)) return [];
    const coordinates = record.coordinates.flatMap((item) => {
      const parsed = coordinate(item);
      return parsed ? [parsed] : [];
    });
    if (coordinates.length !== record.coordinates.length || coordinates.length < 3) return [];
    return [{
      routeGroup: record.routeGroup.trim(),
      coordinates,
      ...(typeof record.retrievedAt === "string" && !Number.isNaN(Date.parse(record.retrievedAt)) ? { retrievedAt: record.retrievedAt } : {}),
    }];
  });
}

const inputArgument = option("--input");
const outputArgument = option("--output");
if (!inputArgument || !outputArgument) {
  usage();
  process.exitCode = 64;
} else {
  const inputPath = resolve(inputArgument);
  const outputPath = resolve(outputArgument);
  if (inputPath === outputPath) throw new Error("Input and output paths must be different.");
  if (!process.argv.includes("--force")) {
    const exists = await access(outputPath).then(() => true).catch(() => false);
    if (exists) throw new Error(`Refusing to overwrite ${outputPath}; pass --force after reviewing the existing artifact.`);
  }
  const raw = await readFile(inputPath);
  const parsed = JSON.parse(raw.toString("utf8"));
  const routes = trainingRoutes(parsed);
  const trainingDigestSha256 = createHash("sha256").update(raw).digest("hex");
  const createdAt = option("--created-at") ?? new Date().toISOString();
  const model = trainGapDistanceModel(routes, {
    modelVersion: `gap-distance-${trainingDigestSha256.slice(0, 16)}`,
    createdAt,
    trainingDigestSha256,
  });
  const validated = validateGapDistanceModelFile(model);
  if (validated.status !== "trained") {
    console.error(`Model not emitted: ${validated.reason}: ${validated.message}`);
    process.exitCode = 2;
  } else {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    console.log(`Wrote ${validated.modelVersion} to ${outputPath}.`);
    console.log(`Independent route groups: ${validated.training.routeGroups}; held-out coverage: ${(validated.validation.heldOutCoverage * 100).toFixed(1)}%.`);
  }
}
