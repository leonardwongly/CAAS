import { describe, expect, it, vi } from "vitest";
import { fetchRouteOverview } from "../../apps/web/src/api.ts";

const generation = (id: string) => ({
  id,
  retrievedAt: "2026-08-16T00:00:00.000Z",
  live: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  reference: { state: "fresh", retrievedAt: "2026-08-16T00:00:00.000Z", freshUntil: "2026-08-17T00:00:00.000Z", staleUntil: "2026-08-18T00:00:00.000Z" },
  overall: "fresh",
});

const route = (flightId: string) => ({
  id: `route-${flightId}`,
  flightId,
  callsign: `CALL-${flightId}`,
  status: "complete",
  complete: true,
  origin: "Origin (KAAA)",
  destination: "Destination (KBBB)",
  pointCount: 2,
  legs: [{ id: `leg-${flightId}`, status: "resolved", from: "Origin (KAAA)", to: "Destination (KBBB)", distanceNm: 1 }],
  distanceNm: 1,
  geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
  gaps: [],
});

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("all-flight overview client traversal", () => {
  it("follows every cursor and returns each flight identity exactly once", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      return body.cursor === "page-2"
        ? response({ data: [route("f3")], generation: generation("g1"), loaded: 3, total: 3 })
        : response({ data: [route("f1"), route("f2")], generation: generation("g1"), nextCursor: "page-2", loaded: 2, total: 3 });
    }));

    const result = await fetchRouteOverview();
    expect(result.routes.map((item) => item.flightId)).toEqual(["f1", "f2", "f3"]);
    expect(calls).toEqual([{ limit: 25 }, { limit: 25, cursor: "page-2" }]);
  });

  it("rejects a duplicate flight identity across pages", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return body.cursor
        ? response({ data: [route("f1")], generation: generation("g1") })
        : response({ data: [route("f1")], generation: generation("g1"), nextCursor: "page-2" });
    }));

    await expect(fetchRouteOverview()).rejects.toThrow("duplicate flight identity");
  });

  it("rejects a generation change during traversal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return body.cursor
        ? response({ data: [route("f2")], generation: generation("g2") })
        : response({ data: [route("f1")], generation: generation("g1"), nextCursor: "page-2" });
    }));

    await expect(fetchRouteOverview()).rejects.toMatchObject({ code: "GENERATION_CHANGED", status: 409 });
  });

  it("rejects a cursor page that adds no routes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return body.cursor
        ? response({ data: [], generation: generation("g1"), nextCursor: "page-3" })
        : response({ data: [route("f1")], generation: generation("g1"), nextCursor: "page-2" });
    }));

    await expect(fetchRouteOverview()).rejects.toThrow("did not make progress");
  });
});
