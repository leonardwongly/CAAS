import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import type { FlightPlanRecord } from "../../packages/upstream-caas/src/index.ts";
import { sanitizedAdapter } from "../fixtures/sanitized-caas.ts";

// Candidate finding: the plan 6.1 pair is enforced only on the request side —
// Fastify bodyLimit 64 KiB (server.ts:1094) plus the 413 REQUEST_TOO_LARGE
// mapping (server.ts:1114). No response-size, content-length, or compression
// guard exists anywhere in apps/api, so a browser-facing endpoint can emit a
// 200 body larger than the plan's hard "Browser response 2 MiB" limit.
//
// North-star contract (plan 6, "Quantitative POC policy"): "Crossing a hard
// limit fails closed with a bounded error and never silently truncates
// required results" and the 6.1 row "Browser response | 2 MiB; use
// summary/detail pagination rather than truncate". The sibling "Browser
// request body 64 KiB" limit is enforced; the response limit must be too.
//
// Reachable over-limit surface: /api/v1/routes/options returns every
// same-endpoint candidate (up to the plan-sanctioned 500, each with the
// plan-sanctioned 256 endpoint-inclusive occurrences) in one unpaginated 200
// body — with no response-size guard the payload exceeds 2 MiB.
//
// Correct behavior: the server must never answer 200 with a body larger than
// 2 MiB; it must fail closed with a bounded error (or paginate).

const INTERMEDIATE_ELEMENTS = 254; // plan 6.1: 254 intermediate; 256 endpoint-inclusive
const SAME_ENDPOINT_CANDIDATES = 500; // plan 6.1: 500; above this TOO_MANY_CANDIDATES

function bigFixture(count: number): readonly FlightPlanRecord[] {
  return Array.from({ length: count }, (_unused, flightIndex) => {
    // Distinct per-flight offset keeps every candidate signature distinct so
    // deduplicateRouteCandidates does not collapse the 500 projections.
    const offset = flightIndex * 0.0001;
    return {
      id: `fixture-flight-${flightIndex + 1}`,
      callsign: `BIG${String(flightIndex + 1).padStart(4, "0")}`,
      departure: "KOR1",
      destination: "KDS1",
      routeElements: Array.from({ length: INTERMEDIATE_ELEMENTS }, (_element, elementIndex) => {
        const t = (elementIndex + 1) / (INTERMEDIATE_ELEMENTS + 1);
        return {
          sequence: elementIndex,
          coordinate: {
            lat: 40 - (40 - 33) * t + offset,
            lon: -73 + (-118 + 73) * t + offset,
          },
        };
      }),
    } satisfies FlightPlanRecord;
  });
}

test("a browser-facing response never exceeds the plan 6.1 hard 2 MiB limit (fails closed rather than emitting an over-limit 200 body)", async (t) => {
  const server = await createApiServer({ adapter: sanitizedAdapter(bigFixture(SAME_ENDPOINT_CANDIDATES)) });
  t.after(() => server.app.close());

  const browse = await server.app.inject({ method: "GET", url: "/api/v1/routes" });
  assert.equal(browse.statusCode, 200);
  const flightId = String((browse.json() as { data: Array<{ id: string }> }).data[0]!.id);

  const options = await server.app.inject({ method: "POST", url: "/api/v1/routes/options", payload: { flightId } });
  const bytes = Buffer.byteLength(options.payload, "utf8");
  const limit = 2 * 1024 * 1024;
  assert.ok(
    bytes <= limit,
    `plan 6.1 hard limit: a browser response must never exceed 2 MiB (got ${bytes} bytes at status ${options.statusCode}); the server must paginate or fail closed with a bounded error instead of emitting an over-limit 200 body`,
  );
});
