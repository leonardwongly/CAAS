import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { CaasAdapter, ReferenceDatasetResult, ReferencePoint } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Security sweep (deferred candidate, fixed by triage): token kinds must never
// be cross-reusable (a browse cursor is not a flight id, a flight token is not
// a selection), and the ambiguity-group "duplicate" token must actually be
// consumable as an explicit selection — minting a token kind nothing validates
// is a dead issuance surface.
// (The forged duplicate-kind signature probe lives in
// tests/route-safety/explicit-selection.test.ts.)

function duplicateAdapter(): CaasAdapter {
  const base = sanitizedAdapter();
  const points: ReferencePoint[] = [
    { dataset: "navaids", identifier: "DUPX", coordinate: { lat: 35, lon: -90 } },
    { dataset: "navaids", identifier: "DUPX", coordinate: { lat: 36, lon: -91 } },
  ];
  const index = new Map<string, readonly ReferencePoint[]>();
  index.set("DUPX", points);
  return {
    ...base,
    navaids: async (): Promise<ReferenceDatasetResult> => ({
      dataset: "navaids",
      points,
      index,
      evidence: { family: "navaids", bytes: 128, records: points.length, acceptedRecords: points.length, rejectedRecords: 0, retried: false, durationMs: 0 },
    }),
  };
}

test("token kinds never cross-validate: browse cursor, flight id, and draft token each reject the others' roles", async () => {
  const server = await createApiServer({ adapter: sanitizedAdapter() });
  try {
    const browse = await server.app.inject({ method: "GET", url: "/api/v1/routes?limit=1" });
    const browseBody = browse.json() as { nextCursor?: string; data: Array<{ id: string }> };
    const cursor = browseBody.nextCursor!;
    const flightId = browseBody.data[0]!.id;

    // A browse cursor presented as a flight id must fail closed.
    const cursorAsFlight = await server.app.inject({ method: "GET", url: `/api/v1/routes/${encodeURIComponent(cursor)}` });
    assert.equal(cursorAsFlight.statusCode, 410, "a browse cursor must never validate as a flight id");
    // A flight id presented as a browse cursor must fail closed.
    const flightAsCursor = await server.app.inject({ method: "GET", url: `/api/v1/routes?limit=1&cursor=${encodeURIComponent(flightId)}` });
    assert.equal(flightAsCursor.statusCode, 409, "a flight id must never validate as a browse cursor");
    // A browse cursor presented as an explicit selection token must fail closed.
    const cursorAsSelection = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draft: { origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: 0, locationId: cursor }] } } });
    assert.equal(cursorAsSelection.statusCode, 400, "a browse cursor must never validate as a coordinate selection");
    assert.equal((cursorAsSelection.json() as { error?: { code?: string } }).error?.code, "TOKEN_INVALID");
  } finally {
    await server.app.close();
  }
});

test("the ambiguity-group duplicate token is consumable as an explicit selection", async () => {
  const server = await createApiServer({ adapter: duplicateAdapter() });
  try {
    const lookup = await server.app.inject({ method: "GET", url: "/api/v1/points/DUPX" });
    const lookupBody = lookup.json() as { matches?: Array<{ duplicateGroup?: string }> };
    const groupToken = lookupBody.matches?.[0]?.duplicateGroup;
    assert.ok(typeof groupToken === "string" && groupToken.length > 0, "a duplicate-identifier group carries a group token");

    const draft = await server.app.inject({ method: "POST", url: "/api/v1/drafts", payload: { origin: "KOR1", destination: "KDS1", via: ["DUPX"], selections: [{ sequence: 0, locationId: groupToken }] } });
    assert.equal(draft.statusCode, 201, "a group token must be accepted at draft create");
    const draftId = (draft.json() as { id: string }).id;

    const compared = await server.app.inject({ method: "POST", url: "/api/v1/drafts/compare", payload: { draftId } });
    assert.equal(compared.statusCode, 200, "the selection resolves through the group token at compare time");
    const body = compared.json() as { draft?: { via?: string[] } };
    assert.deepEqual(body.draft?.via, ["DUPX"], "the selected waypoint resolves to the exact chosen coordinate");
  } finally {
    await server.app.close();
  }
});
