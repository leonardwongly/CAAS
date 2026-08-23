import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";

// An optional positional argument points validation at an alternate root
// (adversarial fixtures); the repository root remains the default.
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dirname, "..");
const requiredFiles = [
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".env.example",
  ".dockerignore"
];

const readRequired = async (relativePath) => {
  try {
    return await readFile(resolve(root, relativePath), "utf8");
  } catch (error) {
    throw new Error(`Missing required root file: ${relativePath}`, { cause: error });
  }
};

for (const relativePath of requiredFiles) {
  await readRequired(relativePath);
}

const packageJson = JSON.parse(await readRequired("package.json"));
const workspace = parseYaml(await readRequired("pnpm-workspace.yaml"));
JSON.parse(await readRequired("tsconfig.base.json"));

if (packageJson.packageManager !== "pnpm@11.5.2") {
  throw new Error("package.json must pin pnpm@11.5.2");
}

const expectedPatterns = ["apps/*", "packages/*", "tests"];
const actualPatterns = workspace?.packages ?? [];
if (JSON.stringify(actualPatterns) !== JSON.stringify(expectedPatterns)) {
  throw new Error(`pnpm-workspace.yaml must declare ${expectedPatterns.join(", ")}`);
}

const envExample = await readRequired(".env.example");
// Every apikey assignment (any casing/spacing around "=") must be exactly the
// documented placeholder — a lone placeholder line must not launder a second,
// secret-bearing apikey line past the check.
const apikeyLines = envExample.split(/\r?\n/).filter((line) => /^apikey\s*=/i.test(line));
if (apikeyLines.length === 0 || apikeyLines.some((line) => line !== "apikey=replace-with-a-local-secret")) {
  throw new Error(".env.example must contain only the documented placeholder for apikey");
}

console.log("Root JSON, YAML, TypeScript config, and environment placeholders are valid.");
