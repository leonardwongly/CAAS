import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DRAFT_SAFETY_COPY, PERSISTENT_SAFETY_COPY, RANK_ONE_LABEL } from "../../packages/contracts/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appSource = readFileSync(resolve(ROOT, "apps/web/src/App.tsx"), "utf8");
const apiSource = readFileSync(resolve(ROOT, "apps/web/src/api.ts"), "utf8");
const labelsSource = readFileSync(resolve(ROOT, "apps/web/src/labels.ts"), "utf8");

/** Candidate-qualifying copy must never call a candidate valid, recommended, safe, cleared, or best. */
const FORBIDDEN_QUALIFIERS = /\b(valid|recommended|safe|cleared|best)\b/i;
/**
 * Candidate-qualifying copy lives in the named label constants below; refresh-
 * flow state copy (REFRESH_*) is UI state, not candidate qualification, so it
 * is excluded from the scan. App.tsx is scanned without "cleared" for the same
 * reason ("the selection will be cleared" describes UI state, not a candidate).
 */
const FORBIDDEN_QUALIFIERS_IN_APP = /\b(valid|recommended|safe|best)\b/i;
const CANDIDATE_COPY_CONSTANTS = [
  "RANK_ONE_LABEL",
  "RANK_CRITERION",
  "RANK_ONE_GROUP_DESCRIPTION",
  "COMPLETE_RANKED_GROUP_TITLE",
  "COMPLETE_RANKED_GROUP_DESCRIPTION",
  "INCOMPLETE_GROUP_TITLE",
  "INCOMPLETE_GROUP_DESCRIPTION",
  "OPERATIONAL_PROXY_EXPLANATION",
  "SAFETY_NOTICE",
  "DRAFT_SAFETY_COPY",
] as const;

test("the web client carries the exact qualified labels and safety copies verbatim", () => {
  assert.ok(labelsSource.includes(`"${RANK_ONE_LABEL}"`), "labels.ts must define the exact qualified rank-1 label");
  assert.ok(labelsSource.includes(PERSISTENT_SAFETY_COPY), "the persistent safety copy must appear verbatim in labels.ts");
  assert.ok(labelsSource.includes(DRAFT_SAFETY_COPY), "the draft safety copy must appear verbatim in labels.ts");
  // App.tsx renders the constants from labels.ts; the exact strings are pinned there.
  assert.ok(appSource.includes("RANK_ONE_LABEL"), "App.tsx must render the qualified rank-1 label");
  assert.ok(appSource.includes("SAFETY_NOTICE"), "App.tsx must render the persistent safety copy");
  assert.ok(appSource.includes("DRAFT_SAFETY_COPY"), "App.tsx must render the draft safety copy constant");
});

test("the web client rounds modeled distances for display only, at 0.1 NM", () => {
  const formatter = appSource.match(/formatDistance[\s\S]{0,200}?toFixed\(1\)/);
  assert.ok(formatter, "formatDistance must display distances with one decimal (0.1 NM)");
});

test("the web client never qualifies candidates as valid, recommended, safe, cleared, or best", () => {
  for (const name of CANDIDATE_COPY_CONSTANTS) {
    const declaration = labelsSource.match(new RegExp(`export const ${name} = "([^"]*)"`));
    assert.ok(declaration, `${name} must be exported from labels.ts`);
    const forbidden = declaration[1]!.match(FORBIDDEN_QUALIFIERS);
    assert.equal(forbidden, null, `${name} contains a forbidden qualifier: ${forbidden?.[0]}`);
  }
  const forbiddenInApi = apiSource.match(FORBIDDEN_QUALIFIERS);
  assert.equal(forbiddenInApi, null, `api.ts contains a forbidden qualifier: ${forbiddenInApi?.[0]}`);
  const forbiddenInApp = appSource.match(FORBIDDEN_QUALIFIERS_IN_APP);
  assert.equal(forbiddenInApp, null, `App.tsx contains a forbidden qualifier: ${forbiddenInApp?.[0]}`);
});

test("the web client uses the generation-bound selection protocol", () => {
  // The client never supplies coordinates: it posts reference waypoints plus
  // server-issued selection tokens to the two-operand comparison endpoint.
  assert.ok(apiSource.includes("/api/v1/routes/compare"), "validateDraft must post to the two-operand comparison endpoint");
  assert.ok(apiSource.includes("baselineId"), "validateDraft must send the selected baseline route id");
  assert.ok(apiSource.includes("selections"), "validateDraft must send explicit selections");
  // The request body carries only references and server-issued tokens — never coordinates.
  assert.ok(apiSource.includes("JSON.stringify({ baselineId, targetDraft: { origin, destination, via, selections } })"), "validateDraft must not send coordinates");
  assert.ok(appSource.includes("Exact coordinate selected from the ambiguous group."), "the editor must surface bound selections");
  assert.ok(appSource.includes("Choose exact location"), "ambiguous matches must offer an explicit choice");
  assert.ok(appSource.includes("Session reset."), "the reset copy was updated to avoid a cleared connotation");
  assert.ok(!appSource.includes("Session cleared."), "the old reset copy must be gone");
  assert.ok(!appSource.includes("It cannot be added until the service supports an explicit coordinate selection"), "the old blocking error must be gone");
});
