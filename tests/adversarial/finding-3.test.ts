import assert from "node:assert/strict";
import test from "node:test";
import { CheckCollector } from "../../scripts/validation/lib-evidence.mjs";

// Finding: CheckCollector.blocked() throws TypeError. The constructor sets an
// own instance counter `this.blocked = 0`, which shadows the prototype method
// blocked() (line 66). The documented contract inside pass() (lines 54-55)
// tells callers "must use fail() or blocked() explicitly" for an honest
// non-pass, so blocked() is part of the public API. The correct behavior:
// blocked() appends a "blocked" check, and summary() keeps
// passed + failed + blocked === checks.

test("CheckCollector.blocked() appends a blocked check", () => {
  const c = new CheckCollector();
  c.blocked("b1", "blocked check", "procedure", "start", "end", "env missing");
  assert.equal(c.checks.length, 1);
  assert.equal(c.checks[0].result, "blocked");
  assert.equal(c.checks[0].checkId, "b1");
  assert.equal(c.checks[0].measurement.summary, "env missing");
});

test("summary() satisfies passed + failed + blocked === checks", () => {
  const c = new CheckCollector();
  c.pass("c1", "n", "p", "s", "e", true, "bool");
  c.fail("c2", "n", "p", "s", "e", "boom");
  c.blocked("c3", "n", "p", "s", "e", "env missing");
  const s = c.summary();
  assert.equal(s.checks, 3);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.passed + s.failed + s.blocked, s.checks);
});
