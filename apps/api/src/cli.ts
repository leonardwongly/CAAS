import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startServer } from "./server.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const SHUTDOWN_DEADLINE_MS = 10_000;

// Exported for adversarial/unit coverage: the CLI runs once as a process
// entry point, so its parsing surface is exercised through these pure
// functions and through spawned-process startup failures.

export function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  // A repeated separate-form flag must fail closed like the mixed-form repeat:
  // silently first-wins hides operator typos on a network-binding option.
  if (args.indexOf(name, index + 1) !== -1) throw new Error(`${name} was provided more than once`);
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function inlineOptionValue(args: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const values = args.filter((argument) => argument.startsWith(prefix));
  if (values.length > 1) throw new Error(`${name} was provided more than once`);
  const value = values[0];
  return value === undefined ? undefined : value.slice(prefix.length);
}

export function requestedOption(args: readonly string[], name: string): string | undefined {
  const inline = inlineOptionValue(args, name);
  const separate = optionValue(args, name);
  if (inline !== undefined && separate !== undefined) throw new Error(`${name} was provided more than once`);
  return inline ?? separate;
}

export interface EnvFileEntry {
  readonly key: string;
  readonly value: string;
}

export function parseEnvFileEntries(contents: string): EnvFileEntry[] {
  const entries: EnvFileEntry[] = [];
  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) throw new Error(`Invalid local .env entry on line ${index + 1}`);
    const key = match[1]!;
    let value = match[2]!.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    entries.push({ key, value });
  }
  return entries;
}

async function loadExplicitLocalEnv(envFile: string): Promise<void> {
  const workingDirectory = resolve(process.cwd());
  const path = resolve(workingDirectory, envFile);
  const relativePath = relative(workingDirectory, path);
  if (relativePath.startsWith("..") || relativePath.includes("/") && !relativePath.startsWith("./")) {
    throw new Error("--env-file must point to the local .env file");
  }
  if (path !== resolve(workingDirectory, ".env")) {
    throw new Error("--env-file must point to the local .env file");
  }

  const contents = await readFile(path, "utf8");
  for (const { key, value } of parseEnvFileEntries(contents)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  // Decimal digits only: Number() also accepts hex ("0x1F90"), exponent
  // notation ("808e1"), surrounding whitespace, and "+" signs — none of which
  // an operator typing a port number means to submit.
  if (!/^[0-9]+$/.test(value)) throw new Error("--port and PORT must be an integer from 1 to 65535");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port and PORT must be an integer from 1 to 65535");
  return port;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const envFile = requestedOption(args, "--env-file");
  if (envFile !== undefined) await loadExplicitLocalEnv(envFile);
  const host = requestedOption(args, "--host") ?? process.env.HOST ?? DEFAULT_HOST;
  const port = parsePort(requestedOption(args, "--port") ?? process.env.PORT);
  const knownOptions = new Set(["--env-file", "--host", "--port"]);
  for (const argument of args) {
    if (!argument.startsWith("--")) continue;
    const name = argument.split("=", 1)[0]!;
    if (!knownOptions.has(name)) throw new Error(`Unknown option: ${name}`);
  }
  const { app } = await startServer({ host, port });
  // Cloudflare Containers sends SIGTERM when stopping an instance (sleepAfter
  // expiry or rollout replacement) and only force-kills after 15 minutes. Node
  // has no default SIGTERM termination under this runtime, so without an
  // explicit handler a stale or replaced instance lingers for the full drain
  // window. Close the server on the stop signals and exit promptly.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Bounded forced-exit deadline: if close hangs, exit non-zero well before
    // the platform's 15-minute SIGKILL so replacement and sleep stay fast.
    const forcedExit = setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS);
    forcedExit.unref();
    try {
      await app.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

// Run only as the process entry point: importing this module (tests, tooling)
// must never start a server. A symlinked or differently-spelled entry path
// resolves through realpath-less URL comparison on purpose — the documented
// invocation is `node apps/api/src/cli.ts` from the repository root.
const entry = process.argv[1];
const directRun = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (directRun) {
  try {
    await main();
  } catch (error) {
    // Fail closed loudly: a silent exit hides why startup aborted (missing
    // credential, unusable mandatory family, bad option). Keep the message
    // bounded and error-only — no upstream payload ever reaches this log.
    console.error(`Startup failed: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`);
    process.exitCode = 1;
  }
}
