import assert from "node:assert/strict";
import test from "node:test";
import { isApiRequest } from "../src/routing.ts";

test("routes only /api/ paths to the API container", () => {
  assert.equal(isApiRequest("/api/v1/health/ready"), true);
  assert.equal(isApiRequest("/api"), false);
  assert.equal(isApiRequest("/assets/index.js"), false);
  assert.equal(isApiRequest("/"), false);
});
