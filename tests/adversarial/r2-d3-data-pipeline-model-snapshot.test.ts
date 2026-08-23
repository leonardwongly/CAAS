/**
 * R2-D3 — data pipelines & snapshot integrity.
 *
 * Gap-distance model trainer (scripts/estimation/train-gap-distance-model.mjs)
 * under hostile corpora, and snapshot integrity of the committed
 * apps/web/src/generated/gap-distance-model.json artifact.
 *
 * Dedupe note:
 * - packages/route-engine/test/gap-distance.test.ts pins training fail-closed
 *   on insufficient support and aggregate-only artifacts;
 * - sweep-d2-geometry-gap-core.test.ts pins prediction fallbacks on a small
 *   in-process corpus;
 * - sweep-d6-webdata-gapmodel.test.tsx pins the hostile-artifact table and
 *   the BUNDLED_GAP_DISTANCE_MODEL pass-through under vitest.
 * Covered here, previously uncovered: the trainer CLI itself (argument
 * validation, overwrite guard, coordinate/routeGroup filtering, envelope
 * shapes, digest provenance, byte determinism, no partial artifact on gate
 * failure) and the committed artifact's honesty contract pinned in a
 * node:test lane.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  predictGapDistance,
  validateGapDistanceModelFile,
  type TrainedGapDistanceModel,
  type UnavailableGapDistanceModel,
} from "../../packages/route-engine/src/gap-distance.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const trainerPath = join(repositoryRoot, "scripts/estimation/train-gap-distance-model.mjs");
const committedArtifactPath = join(repositoryRoot, "apps/web/src/generated/gap-distance-model.json");
const CREATED_AT = "2026-08-23T00:00:00Z";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

type TrainerResult = { code: number; stdout: string; stderr: string };

async function runTrainer(args: string[]): Promise<TrainerResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--experimental-strip-types", trainerPath, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

type CorpusRoute = { routeGroup: string; coordinates: Array<{ lat: number; lon: number }>; retrievedAt: string };

/** Deterministic corpus large enough to clear every training gate (≥50 groups). */
function sufficientCorpus(): { routes: CorpusRoute[]; maximumRetrievedAt: string } {
  let seed = 20260823;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const routes: CorpusRoute[] = [];
  for (let group = 0; group < 60; group += 1) {
    const startLat = 10 + random() * 30;
    const startLon = 10 + random() * 30;
    const endLat = 10 + random() * 30;
    const endLon = startLon + 5 + random() * 25;
    const bulge = (random() * 2 - 1) * 3;
    const pointCount = 5 + Math.floor(random() * 3);
    const coordinates = [];
    for (let point = 0; point < pointCount; point += 1) {
      const t = point / (pointCount - 1);
      coordinates.push({
        lat: Number((startLat + (endLat - startLat) * t + bulge * Math.sin(Math.PI * t)).toFixed(4)),
        lon: Number((startLon + (endLon - startLon) * t).toFixed(4)),
      });
    }
    routes.push({
      routeGroup: `r2d3-group-${group}`,
      coordinates,
      retrievedAt: `2026-08-${String(10 + (group % 5)).padStart(2, "0")}T00:00:00Z`,
    });
  }
  return { routes, maximumRetrievedAt: "2026-08-14T00:00:00Z" };
}

test("missing required CLI arguments exit with usage code 64 and write nothing", async () => {
  for (const args of [[], ["--input", "corpus.json"], ["--output", "model.json"]]) {
    const result = await runTrainer(args);
    assert.equal(result.code, 64, `args ${JSON.stringify(args)} must exit EX_USAGE`);
  }
});

test("identical input and output paths are rejected before any read or write", async () => {
  const work = await mkdtemp(join(tmpdir(), "r2d3-trainer-"));
  const target = join(work, "same.json");
  await writeFile(target, "{}");
  try {
    const result = await runTrainer(["--input", target, "--output", target]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Input and output paths must be different/);
    assert.equal(await readFile(target, "utf8"), "{}");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("invalid JSON corpora fail closed without emitting an artifact", async () => {
  const work = await mkdtemp(join(tmpdir(), "r2d3-trainer-"));
  const input = join(work, "corpus.json");
  const output = join(work, "model.json");
  await writeFile(input, "{ not json");
  try {
    const result = await runTrainer(["--input", input, "--output", output]);
    assert.notEqual(result.code, 0);
    await assert.rejects(stat(output), "no artifact may be written from an unparseable corpus");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("hostile records are filtered: bad coordinates, short routes, and malformed routeGroups never reach training", async () => {
  const work = await mkdtemp(join(tmpdir(), "r2d3-trainer-"));
  const input = join(work, "corpus.json");
  const output = join(work, "model.json");
  const hostileOnly = [
    { routeGroup: "lat-out-of-range", coordinates: [{ lat: 91, lon: 0 }, { lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
    { routeGroup: "lon-out-of-range", coordinates: [{ lat: 0, lon: -181 }, { lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
    { routeGroup: "non-numeric", coordinates: [{ lat: "0", lon: 0 }, { lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
    { routeGroup: "nan", coordinates: [{ lat: Number.NaN, lon: 0 }, { lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
    { routeGroup: "too-short-after-filter", coordinates: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 200, lon: 0 }] },
    { routeGroup: "two-points", coordinates: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
    { routeGroup: "", coordinates: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
    { routeGroup: "   ", coordinates: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
    { routeGroup: 42, coordinates: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
    { coordinates: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
    { routeGroup: "no-coordinates" },
    null,
  ];
  await writeFile(input, JSON.stringify({ routes: hostileOnly }));
  try {
    const result = await runTrainer(["--input", input, "--output", output]);
    assert.equal(result.code, 2, "a fully filtered corpus must exit with the gate-failure code");
    assert.match(result.stderr, /INSUFFICIENT_INDEPENDENT_COMPLETE_ROUTES/);
    await assert.rejects(stat(output), "a gated-out corpus must not leave a partial artifact behind");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("the overwrite guard refuses without --force and preserves the existing artifact", async () => {
  const work = await mkdtemp(join(tmpdir(), "r2d3-trainer-"));
  const input = join(work, "corpus.json");
  const output = join(work, "model.json");
  await writeFile(input, JSON.stringify([]));
  await writeFile(output, "SENTINEL");
  try {
    const guarded = await runTrainer(["--input", input, "--output", output]);
    assert.notEqual(guarded.code, 0);
    assert.match(guarded.stderr, /Refusing to overwrite/);
    assert.equal(await readFile(output, "utf8"), "SENTINEL");

    const forced = await runTrainer(["--input", input, "--output", output, "--force"]);
    assert.equal(forced.code, 2, "--force must pass the guard and then fail honestly at the support gate");
    assert.match(forced.stderr, /INSUFFICIENT_INDEPENDENT_COMPLETE_ROUTES/);
    assert.equal(await readFile(output, "utf8"), "SENTINEL", "a gated-out training run must not clobber the reviewed artifact");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("a sufficient corpus produces a deterministic artifact whose provenance matches its input bytes", async () => {
  const work = await mkdtemp(join(tmpdir(), "r2d3-trainer-"));
  const input = join(work, "corpus.json");
  const outputOne = join(work, "one.json");
  const outputTwo = join(work, "two.json");
  const { routes, maximumRetrievedAt } = sufficientCorpus();
  // Hostile records that must be silently excluded from an otherwise valid corpus.
  const withHostiles = {
    routes: [
      ...routes,
      { routeGroup: "dropped-bad-coordinate", coordinates: [{ lat: 91, lon: 0 }, { lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
      { routeGroup: "dropped-short", coordinates: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
      { routeGroup: (routes[0] as CorpusRoute).routeGroup, coordinates: (routes[0] as CorpusRoute).coordinates, retrievedAt: "garbage" },
    ],
  };
  const corpusText = `${JSON.stringify(withHostiles, null, 2)}\n`;
  await writeFile(input, corpusText);
  try {
    const first = await runTrainer(["--input", input, "--output", outputOne, "--created-at", CREATED_AT]);
    assert.equal(first.code, 0, `trainer must succeed on a sufficient corpus: ${first.stderr}`);
    const second = await runTrainer(["--input", input, "--output", outputTwo, "--created-at", CREATED_AT]);
    assert.equal(second.code, 0);

    const firstArtifact = await readFile(outputOne, "utf8");
    const secondArtifact = await readFile(outputTwo, "utf8");
    assert.equal(firstArtifact, secondArtifact, "identical corpus and timestamp must produce byte-identical artifacts");

    const digest = sha256(Buffer.from(corpusText, "utf8"));
    const model = validateGapDistanceModelFile(JSON.parse(firstArtifact));
    assert.equal(model.status, "trained", `the committed validation path must accept the trained artifact: ${model.status === "unavailable" ? model.reason : ""}`);
    const trained = model as TrainedGapDistanceModel;

    // Provenance honesty: digest covers the exact input bytes and the version embeds it.
    assert.equal(trained.training.digestSha256, digest);
    assert.equal(trained.modelVersion, `gap-distance-${digest.slice(0, 16)}`);
    assert.equal(trained.createdAt, new Date(CREATED_AT).toISOString());
    assert.equal(trained.trainedThrough, maximumRetrievedAt, "trainedThrough must be the maximum valid retrievedAt, ignoring garbage timestamps");

    // Only the 60 valid groups reach training; hostiles are excluded.
    assert.equal(trained.training.routeGroups, 60);

    // Cell honesty: every emitted cell met the independent-route support floor.
    for (const cell of trained.cells) {
      assert.ok(cell.independentRouteGroups >= trained.minimumIndependentRouteGroupsPerCell, "cells below the support floor must not be emitted");
      assert.ok(cell.exampleCount > 0);
    }
    assert.ok(trained.support.minimumAnchorDistanceNm >= 0);
    assert.ok(trained.support.maximumAnchorDistanceNm >= trained.support.minimumAnchorDistanceNm);
    assert.ok(trained.validation.heldOutCoverage >= 0 && trained.validation.heldOutCoverage <= 1);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("the committed gap-distance-model.json validates and makes no provenance claims it cannot back", async () => {
  const raw = await readFile(committedArtifactPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const validated = validateGapDistanceModelFile(parsed);
  assert.equal(validated.status, "unavailable", "the committed artifact is the honest unavailable record");
  const unavailable = validated as UnavailableGapDistanceModel;
  assert.equal(unavailable.reason, "INSUFFICIENT_INDEPENDENT_COMPLETE_ROUTES");
  assert.equal(unavailable.message, "No approved historical corpus has passed independent-route calibration and held-out coverage gates. Lower bounds remain available.");

  // Honesty bounds: an unavailable artifact must not smuggle trained-looking provenance.
  for (const forbidden of ["modelVersion", "createdAt", "training", "cells", "support", "calibrationResidualsLog", "validation", "trainedThrough"]) {
    assert.ok(!(forbidden in parsed), `unavailable artifact must not carry ${forbidden}`);
  }
  assert.deepEqual(Object.keys(parsed).sort(), ["message", "reason", "schemaVersion", "status"], "the committed artifact must be exactly the minimal unavailable record");

  // The unavailability propagates into predictions instead of fabricating estimates.
  const prediction = predictGapDistance(
    {
      anchorDistanceNm: 500,
      logAnchorDistanceNm: Math.log(500),
      midpointAbsoluteLatitude: 10,
      headingContext: "unbounded",
      endpointCorridor: false,
      coveredGapCount: 1,
    },
    validated,
  );
  assert.equal(prediction.status, "unavailable");
  if (prediction.status === "unavailable") {
    assert.equal(prediction.reason, "INSUFFICIENT_INDEPENDENT_COMPLETE_ROUTES");
  }
});

test("byte snapshot: the committed artifact has not drifted from its pinned content", async () => {
  const raw = await readFile(committedArtifactPath, "utf8");
  assert.equal(
    sha256(raw),
    sha256(JSON.stringify({
      schemaVersion: 1,
      status: "unavailable",
      reason: "INSUFFICIENT_INDEPENDENT_COMPLETE_ROUTES",
      message: "No approved historical corpus has passed independent-route calibration and held-out coverage gates. Lower bounds remain available.",
    }, null, 2).concat("\n")),
    "the committed artifact must remain the exact canonical unavailable record",
  );
});
