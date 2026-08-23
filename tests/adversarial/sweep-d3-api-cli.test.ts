// Adversarial sweep owner/domain: D3 — API HTTP surface & envelope.
//
// CLI argument/port parsing (apps/api/src/cli.ts) — previously zero coverage.
// Two layers:
// 1. Unit coverage of the exported pure parsing functions (parsePort,
//    requestedOption/optionValue/inlineOptionValue, parseEnvFileEntries).
// 2. Process-level fail-closed startup: the CLI is spawned with hostile
//    argument vectors and PORT env values; every failure must exit 1 with a
//    bounded "Startup failed:" stderr and never bind a port.
//
// The module-import guard is exercised implicitly: importing cli.ts here must
// not start a server (it previously ran main() at module scope).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertLocalEnvPath,
  inlineOptionValue,
  optionValue,
  parseEnvFileEntries,
  parsePort,
  requestedOption,
} from "../../apps/api/src/cli.ts";

const execFileAsync = promisify(execFile);
const CLI_PATH = new URL("../../apps/api/src/cli.ts", import.meta.url).pathname;

async function spawnCli(args: readonly string[], env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  try {
    await execFileAsync(process.execPath, ["--experimental-strip-types", CLI_PATH, ...args], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, ...env },
      timeout: 15_000,
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string };
    assert.equal(typeof failure.code, "number", `the CLI must exit with a numeric code, got ${String(failure.code)}`);
    return { code: failure.code as number, stderr: failure.stderr ?? "" };
  }
}

test("D3 cli: parsePort accepts only in-range decimal integers", () => {
  assert.equal(parsePort(undefined), 8080, "an absent port defaults to 8080");
  assert.equal(parsePort("1"), 1, "port 1 is the lower boundary");
  assert.equal(parsePort("65535"), 65535, "port 65535 is the upper boundary");
  assert.equal(parsePort("008080"), 8080, "leading zeros stay decimal");

  const rejected = [
    "0", // below range
    "65536", // above range
    "-1", // negative
    "abc", // not numeric
    "", // empty
    "80.5", // non-integer
    "80.", // trailing dot
    "0x1F90", // hex parses to 8080 via Number() but is not a decimal port
    "0o77", // octal notation
    "808e1", // exponent notation
    "1e3", // exponent notation
    "+80", // explicit sign
    " 80", // surrounding whitespace
    "80 ", // surrounding whitespace
    "1_000", // numeric separators
    "Infinity", // non-finite
    "NaN", // non-finite
    "٨٠", // non-ASCII digits
  ];
  for (const value of rejected) {
    assert.throws(() => parsePort(value), /integer from 1 to 65535/u, `parsePort(${JSON.stringify(value)}) must fail closed`);
  }
});

test("D3 cli: requestedOption resolves inline and separate forms and rejects every repeat", () => {
  assert.equal(requestedOption(["--port", "9090"], "--port"), "9090", "separate form resolves");
  assert.equal(requestedOption(["--port=9090"], "--port"), "9090", "inline form resolves");
  assert.equal(requestedOption(["--host", "h", "--port", "9090"], "--port"), "9090", "other flags do not interfere");
  assert.equal(requestedOption([], "--port"), undefined, "an absent flag resolves to undefined");
  assert.equal(requestedOption(["--port="], "--port"), "", "an empty inline value stays empty (the consumer rejects it)");

  // Every repeat shape fails closed — a silent first-wins on a network-binding
  // option hides operator typos (regression: separate-form repeats previously
  // resolved silently while mixed-form repeats threw).
  assert.throws(() => requestedOption(["--port", "1", "--port", "2"], "--port"), /more than once/u, "separate-form repeat");
  assert.throws(() => requestedOption(["--port=1", "--port=2"], "--port"), /more than once/u, "inline repeat");
  assert.throws(() => requestedOption(["--port=1", "--port", "2"], "--port"), /more than once/u, "mixed repeat (inline first)");
  assert.throws(() => requestedOption(["--port", "1", "--port=2"], "--port"), /more than once/u, "mixed repeat (separate first)");

  assert.throws(() => optionValue(["--port"], "--port"), /requires a value/u, "a trailing flag without a value fails closed");
  assert.throws(() => optionValue(["--port", "--host"], "--port"), /requires a value/u, "a flag cannot consume the next flag as its value");
  assert.equal(inlineOptionValue(["--other=x"], "--port"), undefined, "unrelated inline flags are ignored");
});

test("D3 cli: parseEnvFileEntries parses the documented .env grammar and rejects malformed lines", () => {
  const entries = parseEnvFileEntries([
    "# a comment",
    "",
    "PORT=9090",
    "export HOST=\"127.0.0.1\"",
    "REFRESH_SECRET='s3cret'",
    "URL=a=b=c",
    "  PADDED =  value  ",
  ].join("\n"));
  assert.deepEqual(entries, [
    { key: "PORT", value: "9090" },
    { key: "HOST", value: "127.0.0.1" },
    { key: "REFRESH_SECRET", value: "s3cret" },
    { key: "URL", value: "a=b=c" },
    { key: "PADDED", value: "value" },
  ], "the parser strips quotes, export prefixes, comments, blanks, and padding");

  assert.deepEqual(parseEnvFileEntries("A=1\r\nB=2"), [
    { key: "A", value: "1" },
    { key: "B", value: "2" },
  ], "CRLF line endings are supported");

  assert.throws(() => parseEnvFileEntries("not an entry"), /line 1/u, "a malformed line names its line number");
  assert.throws(() => parseEnvFileEntries("OK=1\n9BAD=2"), /line 2/u, "an invalid key names its line number");
  assert.throws(() => parseEnvFileEntries("no-equals-sign"), /line 1/u, "a missing separator fails closed");
});

test("D3 cli: hostile --port values fail closed at process startup", async () => {
  const cases: Array<readonly [string, string[]]> = [
    ["zero port", ["--port", "0"]],
    ["above-range port", ["--port", "65536"]],
    ["hex port", ["--port", "0x1F90"]],
    ["non-numeric port", ["--port", "abc"]],
    ["missing port value", ["--port"]],
    ["repeated port", ["--port", "8080", "--port", "8081"]],
    ["repeated inline port", ["--port=8080", "--port=8081"]],
    ["unknown option", ["--bogus"]],
    ["unknown inline option", ["--bogus=1"]],
  ];
  for (const [label, args] of cases) {
    const { code, stderr } = await spawnCli(args);
    assert.equal(code, 1, `${label}: the CLI must exit 1`);
    assert.ok(stderr.startsWith("Startup failed: "), `${label}: stderr must carry the bounded startup-failure prefix, got: ${stderr.slice(0, 120)}`);
    assert.ok(stderr.length < 600, `${label}: the failure line stays bounded`);
  }
});

test("D3 cli: the --env-file guard only admits the literal local .env path", () => {
  // Node ≥20.6 intercepts --env-file before the script runs (exit 9 on a
  // missing file), so this containment rule is attacked at function level:
  // anything but the working directory's own .env must fail closed.
  const cwd = new URL("../..", import.meta.url).pathname;
  const rejected = [
    "../.env", // escapes the working directory
    "../../etc/passwd", // classic traversal
    "other.env", // a sibling file that is not .env
    "./.envrc", // same directory, wrong name
    ".env.example", // suffix trick
    "apps/api/.env", // nested .env outside the root
    "/etc/passwd", // absolute path outside the working directory
  ];
  for (const value of rejected) {
    assert.throws(() => assertLocalEnvPath(value, cwd), /local \.env file/u, `assertLocalEnvPath(${JSON.stringify(value)}) must fail closed`);
  }
  // Only paths that resolve onto the literal local .env are admitted —
  // including shapes that detour through . and .. before landing back on it.
  for (const value of [".env", "./.env", "./.env/../.env"]) {
    assert.equal(assertLocalEnvPath(value, cwd), `${cwd.replace(/\/$/u, "")}/.env`, `assertLocalEnvPath(${JSON.stringify(value)}) admits the local .env`);
  }
});

test("D3 cli: a hostile PORT environment variable fails closed like --port", async () => {
  for (const [label, port] of [["non-numeric PORT", "abc"], ["above-range PORT", "65536"], ["hex PORT", "0x1F90"]] as const) {
    const { code, stderr } = await spawnCli([], { PORT: port });
    assert.equal(code, 1, `${label}: the CLI must exit 1`);
    assert.ok(stderr.startsWith("Startup failed: "), `${label}: bounded failure prefix`);
    assert.ok(stderr.includes("integer from 1 to 65535"), `${label}: the port error names the bound`);
  }
});
