// Sanitized, minimized wire-format fixture bodies and a mock CAAS transport for
// the loopback lanes. These are invented mathematical/structural vectors, not
// captured live records (design section 0.1 permits minimized, irreversibly
// sanitized captures and pure vectors). The mock apikey is a fixture value that
// is never used against the real CAAS origin.
//
// The CAAS contract values below mirror packages/upstream-caas/src/config.ts.
// A dedicated test (tests/validation/fixtures-contract.test.ts) imports the real
// module and asserts this mirror is exact, so script-only runs never depend on
// TypeScript stripping.
import { createHash } from "node:crypto";

export const FIXTURE_API_KEY = "loopback-fixture-key";
export const FIXTURE_REFRESH_SECRET = "loopback-fixture-refresh-secret";
// Distinctive marker values: the exclusion scan must never collide with
// legitimate response text (tokens, identifiers, prose).
export const FIXTURE_AIRWAY_VALUES = Object.freeze(["AIRWAY-A101", "AIRWAY-G202"]);

export const CAAS_CONTRACT = Object.freeze({
  origin: "https://api.swimapisg.info",
  families: Object.freeze({
    displayAll: Object.freeze({ path: "/flight-manager/displayAll", media: "application/json; charset=utf-8", maxBytes: 10 * 1024 * 1024 }),
    airways: Object.freeze({ path: "/geopoints/list/airways", media: "text/plain; charset=utf-8", maxBytes: 5 * 1024 * 1024 }),
    fixes: Object.freeze({ path: "/geopoints/list/fixes", media: "text/plain; charset=utf-8", maxBytes: 96 * 1024 * 1024 }),
    airports: Object.freeze({ path: "/geopoints/list/airports", media: "text/plain; charset=utf-8", maxBytes: 32 * 1024 * 1024 }),
    navaids: Object.freeze({ path: "/geopoints/list/navaids", media: "text/plain; charset=utf-8", maxBytes: 32 * 1024 * 1024 }),
  }),
});

export function familyUrl(family) {
  const policy = CAAS_CONTRACT.families[family];
  return `${CAAS_CONTRACT.origin}${policy.path}`;
}

// All reference strings follow the bound IDENTIFIER (latitude,longitude) form.
export const FIXTURE_FIXES = Object.freeze(["MIDPT (35,-90)", "FIX2 (35.5,-90.5)"]);
export const FIXTURE_AIRPORTS = Object.freeze([
  "KJFK (40.6413,-73.7781)",
  "KLAX (33.9416,-118.4085)",
  "KORD (41.9742,-87.9073)",
]);
// Duplicate identifier group preserved as explicit ambiguity (never inferred).
export const FIXTURE_NAVAIDS = Object.freeze(["DUPX (35,-90)", "DUPX (36,-91)"]);

function flightRecord(id, callsign, departure, destination, routeElements = undefined) {
  const record = {
    id,
    aircraftIdentification: callsign,
    departure: { departureAerodrome: departure },
    arrival: { destinationAerodrome: destination },
  };
  if (routeElements !== undefined) {
    record.filedRoute = {
      routeElement: routeElements.map((element, sequence) => ({
        seqNum: sequence,
        ...(typeof element === "string" ? { designator: element } : { position: { coordinate: element } }),
      })),
    };
  }
  return record;
}

// Six flights: a same-endpoint comparison group, a reverse route with an
// unresolved gap, a flight without a filed route, and an exact-signature
// duplicate group.
export function fixtureFlightBodies() {
  return [
    flightRecord("fixture-1", "FIXTURE1", "KJFK", "KLAX", ["MIDPT"]),
    flightRecord("fixture-2", "FIXTURE2", "KJFK", "KLAX", ["FIX2"]),
    flightRecord("fixture-3", "FIXTURE3", "KLAX", "KJFK", ["NOPE-FIX"]),
    flightRecord("fixture-4", "FIXTURE4", "KJFK", "KORD"),
    flightRecord("fixture-5", "FIXTURE5", "KJFK", "KLAX", ["MIDPT"]),
    flightRecord("fixture-6", "FIXTURE6", "KJFK", "KLAX", ["MIDPT"]),
  ];
}

export function fixtureBodies(displayAll = fixtureFlightBodies()) {
  return {
    displayAll: JSON.stringify(displayAll),
    airways: JSON.stringify(FIXTURE_AIRWAY_VALUES),
    fixes: JSON.stringify(FIXTURE_FIXES),
    airports: JSON.stringify(FIXTURE_AIRPORTS),
    navaids: JSON.stringify(FIXTURE_NAVAIDS),
  };
}

function bytesOf(text) {
  return new TextEncoder().encode(text).byteLength;
}

// Deterministic mock upstream. It serves the sanitized fixture bodies with the
// observed media types, asserts the bounded request contract per family, and
// returns 429 once for displayAll to exercise the single-retry policy.
export function createMockTransport(bodies = fixtureBodies(), options = {}) {
  const { failAll = false } = options;
  const state = {
    bodies,
    requests: [],
    displayAllAttempts: 0,
  };

  function responseFor(family) {
    if (failAll) return { status: 503, headers: { "retry-after": "0", "content-type": "text/plain; charset=utf-8" }, body: "" };
    if (family === "displayAll" && state.displayAllAttempts++ === 0) {
      return { status: 429, headers: { "retry-after": "0", "content-type": "application/json; charset=utf-8" }, body: "" };
    }
    return { status: 200, headers: { "content-type": CAAS_CONTRACT.families[family].media }, body: state.bodies[family] };
  }

  return {
    state,
    async get(request) {
      const policy = CAAS_CONTRACT.families[request.family];
      const expectedUrl = familyUrl(request.family);
      if (request.method !== "GET" || request.url !== expectedUrl || request.maxBytes !== policy.maxBytes) {
        throw new Error(`mock transport received an out-of-policy request for ${request.family}`);
      }
      if (request.headers.apikey !== FIXTURE_API_KEY) {
        throw new Error(`mock transport requires the fixture apikey header for ${request.family}`);
      }
      state.requests.push({ family: request.family, url: request.url, headers: Object.keys(request.headers).sort() });
      const response = responseFor(request.family);
      if (response.status === 200 && bytesOf(response.body) > request.maxBytes) {
        throw new Error(`fixture body exceeds the bounded size for ${request.family}`);
      }
      return response;
    },
  };
}

export function sha256Hex(contents) {
  return createHash("sha256").update(contents).digest("hex");
}
