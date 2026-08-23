/**
 * R2-D3 — data pipelines & snapshot integrity.
 *
 * airportDisplayLabel under hostile names: control characters, bidirectional
 * overrides, and extreme lengths. The display must stay bounded (≤ the
 * 160-character bundle cap plus the ICAO suffix) and honest (never invent a
 * name, fall back explicitly).
 *
 * Dedupe note: apps/api/test/airport-names.test.ts already pins the happy-path
 * label "John F. Kennedy International Airport (KJFK)" and the plain
 * "Name unavailable (ZZZZ)" fallback. This file only exercises hostile inputs
 * the baseline never supplies.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { airportDisplayLabel } from "../../apps/api/src/airport-names.ts";

const NAME_LIMIT = 160;

test("display labels are bounded for arbitrarily long supplied names", () => {
  const hostile = [
    "X".repeat(10_000),
    "Y".repeat(161),
    "A\u202e".repeat(5_000),
    "\u0000".repeat(10_000).concat("Z"),
  ];
  for (const name of hostile) {
    const label = airportDisplayLabel("KJFK", name);
    const namePart = label.slice(0, label.lastIndexOf(" ("));
    assert.ok(namePart.length <= NAME_LIMIT, `name part must stay within ${NAME_LIMIT} characters, got ${namePart.length}`);
    assert.ok(label.endsWith(" (KJFK)"), "the ICAO suffix must remain intact");
  }
});

test("an oversize supplied name is truncated with a visible ellipsis, never silently dropped", () => {
  const label = airportDisplayLabel("ZZZZ", "X".repeat(500));
  const namePart = label.slice(0, label.lastIndexOf(" ("));
  assert.equal(namePart.length, NAME_LIMIT);
  assert.ok(namePart.endsWith("\u2026"), "truncation must be visible to the reader");
  assert.ok(namePart.startsWith("X"), "the honest beginning of the name is preserved");
});

test("control characters are stripped from supplied names while visible text survives", () => {
  assert.equal(airportDisplayLabel("ZZZZ", "Al\u0000ph\u001ba\u007f Airport"), "Alpha Airport (ZZZZ)");
  assert.equal(airportDisplayLabel("ZZZZ", "Alpha\u0085Airport"), "AlphaAirport (ZZZZ)");
});

test("bidirectional formatting marks are stripped but genuine RTL letters are preserved", () => {
  assert.equal(airportDisplayLabel("ZZZZ", "\u202e\u2066Alpha\u202c\u2069 Airport"), "Alpha Airport (ZZZZ)");
  // Real Arabic script is honest content and must survive sanitization.
  const label = airportDisplayLabel("ZZZZ", "\u0645\u0637\u0627\u0631 \u200fAlpha");
  assert.match(label, /\u0645\u0637\u0627\u0631.*Alpha \(ZZZZ\)$/u);
  assert.doesNotMatch(label, /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
});

test("supplied names that sanitize to nothing fall back honestly instead of rendering an empty label", () => {
  assert.equal(airportDisplayLabel("ZZZZ", "\u202e\u2066\u200f"), "Name unavailable (ZZZZ)");
  assert.equal(airportDisplayLabel("ZZZZ", "\u0000\u001f\u007f"), "Name unavailable (ZZZZ)");
  assert.equal(airportDisplayLabel("ZZZZ", "   "), "Name unavailable (ZZZZ)");
});

test("a sanitized-empty supplied name for a known ICAO falls back to the bundled reference", () => {
  assert.equal(airportDisplayLabel("KJFK", "\u202e\u2066"), "John F. Kennedy International Airport (KJFK)");
});

test("honesty guard: the label never fabricates a name and never exceeds the bound under combined hostilities", () => {
  const combined = `\u202e${"Q".repeat(400)}\u0000${"\u200f".repeat(50)}\n`;
  const label = airportDisplayLabel("EGNX", combined);
  assert.ok(!label.includes("\u0000"));
  assert.ok(!label.includes("\u202e"));
  assert.ok(!label.includes("\n"));
  assert.ok(label.length <= NAME_LIMIT + " (EGNX)".length + 1);
  assert.match(label, /\(EGNX\)$/);
});
