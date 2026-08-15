import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { startServer } from "./server.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function inlineOptionValue(args: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const value = args.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

function requestedOption(args: readonly string[], name: string): string | undefined {
  const inline = inlineOptionValue(args, name);
  const separate = optionValue(args, name);
  if (inline !== undefined && separate !== undefined) throw new Error(`${name} was provided more than once`);
  return inline ?? separate;
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
  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) throw new Error(`Invalid local .env entry on line ${index + 1}`);
    const key = match[1]!;
    let value = match[2]!.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
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
  for (const [index, argument] of args.entries()) {
    if (!argument.startsWith("--")) continue;
    const name = argument.split("=", 1)[0]!;
    if (!knownOptions.has(name)) throw new Error(`Unknown option: ${name}`);
    if (!argument.includes("=") && index + 1 < args.length && !args[index + 1]!.startsWith("--")) continue;
  }
  await startServer({ host, port });
}

try {
  await main();
} catch (error) {
  // Fail closed loudly: a silent exit hides why startup aborted (missing
  // credential, unusable mandatory family, bad option). Keep the message
  // bounded and error-only — no upstream payload ever reaches this log.
  console.error(`Startup failed: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`);
  process.exitCode = 1;
}
