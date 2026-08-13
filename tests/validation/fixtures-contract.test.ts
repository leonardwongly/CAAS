// Cross-checks the CAAS_CONTRACT mirror in scripts/validation/fixtures.mjs
// against the real contract in packages/upstream-caas/src/config.ts, so the
// loopback lanes can run without TypeScript stripping while never drifting
// from the production request policy.
import assert from "node:assert/strict";
import test from "node:test";
import { FAMILY_POLICIES, CAAS_ORIGIN } from "../../packages/upstream-caas/src/config.ts";
import type { CaasFamily } from "../../packages/upstream-caas/src/types.ts";
import { CAAS_CONTRACT, familyUrl } from "../../scripts/validation/fixtures.mjs";

test("fixture CAAS_CONTRACT mirrors the real origin", () => {
  assert.equal(CAAS_CONTRACT.origin, CAAS_ORIGIN);
});

test("fixture CAAS_CONTRACT mirrors every family policy exactly", () => {
  const families: CaasFamily[] = ["displayAll", "airways", "fixes", "airports", "navaids"];
  for (const family of families) {
    const real = FAMILY_POLICIES[family];
    const mirror = CAAS_CONTRACT.families[family];
    assert.ok(real, `real policy exists for ${family}`);
    assert.equal(mirror.path, real.path, `${family} path`);
    assert.equal(mirror.media, `${real.expectedMediaType}; charset=utf-8`, `${family} media type`);
    assert.equal(mirror.maxBytes, real.maxBytes, `${family} max bytes`);
    assert.equal(familyUrl(family), `${CAAS_ORIGIN}${real.path}`, `${family} url`);
  }
});

test("fixture reference datasets use the bound IDENTIFIER (lat,lon) form", () => {
  assert.match("MIDPT (35,-90)", /^[A-Z0-9]{3,5} \(-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\)$/);
});
