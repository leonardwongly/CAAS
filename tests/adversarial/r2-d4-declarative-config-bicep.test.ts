// Owner: R2-D4 — declarative config correctness (round-2 adversarial sweep 2026-08-23).
//
// Bicep parameter drift between infra/bicep/main.bicep and
// infra/bicep/resource-group.bicep BEYOND validate-offline.mjs's textual
// invariants (which only grep for fixed marker strings). This lane parses
// both files structurally:
//   1. The module params block in main.bicep must pass EXACTLY the parameter
//      set resource-group.bicep declares — no orphan parameter on either
//      side, so a renamed or dropped param fails loudly instead of silently
//      deploying a default.
//   2. Types must agree across the module boundary (param-vs-param, and the
//      var-derived values commonTags/image against their declared shapes).
//   3. Every passed value must be a bare symbol — a hardcoded literal would
//      be an identifier committed into infrastructure.
//   4. Every resourceGroupResources.outputs.X referenced by main must be a
//      declared output of resource-group.bicep.
//   5. Cross-domain pins: the Container App targetPort/probe ports equal the
//      edge runtime's CONTAINER_DEFAULT_PORT, and the container env var that
//      receives the API key equals wrangler's required secret name.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

interface ParamDeclaration {
  name: string;
  type: string;
}

function parseParams(source: string): ParamDeclaration[] {
  const declarations: ParamDeclaration[] = [];
  for (const match of source.matchAll(/^\s*param\s+([A-Za-z][A-Za-z0-9]*)\s+(string|int|bool|object|array)\b/gm)) {
    const [name, type] = [match[1], match[2]];
    assert.ok(name !== undefined && type !== undefined, "param declaration regex must capture name and type");
    declarations.push({ name, type });
  }
  return declarations;
}

/** Extract the `params: { ... }` block of the resource-group module via brace matching. */
function extractModuleParams(mainSource: string): Record<string, string> {
  const moduleStart = mainSource.indexOf("module resourceGroupResources 'resource-group.bicep'");
  assert.ok(moduleStart >= 0, "main.bicep must invoke the resource-group module under its committed name");
  const paramsStart = mainSource.indexOf("params: {", moduleStart);
  assert.ok(paramsStart >= 0, "the module invocation must pass an explicit params block");
  const openBrace = mainSource.indexOf("{", paramsStart);
  let depth = 0;
  let closeBrace = -1;
  for (let index = openBrace; index < mainSource.length; index += 1) {
    if (mainSource[index] === "{") depth += 1;
    else if (mainSource[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        closeBrace = index;
        break;
      }
    }
  }
  assert.ok(closeBrace > openBrace, "the params block must be balanced");
  const body = mainSource.slice(openBrace + 1, closeBrace);
  const params: Record<string, string> = {};
  for (const match of body.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*(.+?)\s*$/gm)) {
    const key = match[1];
    const value = match[2];
    assert.ok(key !== undefined && value !== undefined, "params entry regex must capture key and value");
    params[key] = value.replace(/\/\/.*$/, "").trim();
  }
  return params;
}

async function loadBicep(): Promise<{ mainSource: string; groupSource: string; mainParams: ParamDeclaration[]; groupParams: ParamDeclaration[]; moduleParams: Record<string, string> }> {
  const mainSource = await readFile(resolve(root, "infra/bicep/main.bicep"), "utf8");
  const groupSource = await readFile(resolve(root, "infra/bicep/resource-group.bicep"), "utf8");
  return {
    mainSource,
    groupSource,
    mainParams: parseParams(mainSource),
    groupParams: parseParams(groupSource),
    moduleParams: extractModuleParams(mainSource),
  };
}

test("main.bicep passes exactly the parameter set resource-group.bicep declares", async () => {
  const { groupParams, moduleParams } = await loadBicep();
  const declared = groupParams.map((param) => param.name).sort();
  const passed = Object.keys(moduleParams).sort();
  assert.deepEqual(passed, declared, "module params and resource-group param declarations must be set-identical (no orphan or missing parameter on either side)");
  assert.ok(passed.length >= 10, "the module boundary is not trivially small; a collapse indicates a parse failure");
  const duplicates = declared.filter((name, index) => declared.indexOf(name) !== index);
  assert.deepEqual(duplicates, [], "resource-group must not declare duplicate parameters");
});

test("parameter types agree across the module boundary", async () => {
  const { mainParams, groupParams, moduleParams } = await loadBicep();
  const mainByName = new Map(mainParams.map((param) => [param.name, param.type]));
  const groupByName = new Map(groupParams.map((param) => [param.name, param.type]));
  // Values sourced from a main.bicep var rather than a param, with the shape
  // the var definition imposes.
  const varShapes: Record<string, string> = { commonTags: "object", image: "string" };
  for (const [name, value] of Object.entries(moduleParams)) {
    const declaredType = groupByName.get(name);
    assert.ok(declaredType, `resource-group.bicep must declare the passed parameter '${name}'`);
    if (mainByName.has(value)) {
      assert.equal(declaredType, mainByName.get(value), `parameter '${name}' (from main param '${value}') has mismatched types`);
    } else if (value in varShapes) {
      assert.equal(declaredType, varShapes[value], `parameter '${name}' (from main var '${value}') has the wrong shape`);
    }
  }
});

test("every module param value is a bare symbol — no committed literals", async () => {
  const { moduleParams } = await loadBicep();
  for (const [name, value] of Object.entries(moduleParams)) {
    assert.match(value, /^[A-Za-z][A-Za-z0-9]*$/, `module param '${name}' must reference a symbol, got '${value}' (a literal would commit an identifier into infrastructure)`);
  }
});

test("every module output referenced by main.bicep is declared by resource-group.bicep", async () => {
  const { mainSource, groupSource } = await loadBicep();
  const declared = new Set([...groupSource.matchAll(/^\s*output\s+([A-Za-z][A-Za-z0-9]*)\s+/gm)].map((match) => match[1]));
  const referenced = [...mainSource.matchAll(/resourceGroupResources\.outputs\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]);
  assert.ok(referenced.length >= 2, "main.bicep is expected to consume module outputs");
  for (const name of referenced) assert.ok(declared.has(name), `resource-group.bicep must declare output '${name}' referenced by main.bicep`);
});

test("Container App ports match the edge runtime's container port", async () => {
  const { groupSource } = await loadBicep();
  const routingSource = await readFile(resolve(root, "apps/edge/src/routing.ts"), "utf8");
  const portMatch = routingSource.match(/export const CONTAINER_DEFAULT_PORT = (\d+)/);
  assert.ok(portMatch && portMatch[1] !== undefined, "routing.ts must keep exporting the container port constant");
  const runtimePort = Number(portMatch[1]);
  assert.match(groupSource, new RegExp(`targetPort: ${runtimePort}`), "ingress targetPort must equal the edge runtime port");
  const probePorts = [...groupSource.matchAll(/port: (\d+)/g)].map((match) => Number(match[1]));
  assert.ok(probePorts.length >= 3, "startup, liveness, and readiness probes must all declare ports");
  for (const port of probePorts) assert.equal(port, runtimePort, "every probe must hit the edge runtime port");
});

test("the container env var receiving the key equals wrangler's required secret name", async () => {
  const { groupSource } = await loadBicep();
  const wranglerSource = await readFile(resolve(root, "wrangler.jsonc"), "utf8");
  // The runtime contract: the Worker secret is injected as the container env
  // var the Fastify BFF reads. Both sides must name the same key.
  const envMatch = groupSource.match(/name: '([a-z]+)'\n\s*secretRef: caasApiKeySecretName/);
  assert.ok(envMatch && envMatch[1] !== undefined, "resource-group.bicep must wire the CAAS key secret into a container env var");
  const secretMatch = wranglerSource.match(/"required":\s*\[\s*"([a-z]+)"\s*\]/);
  assert.ok(secretMatch && secretMatch[1] !== undefined, "wrangler.jsonc must declare its required secret");
  assert.equal(envMatch[1], secretMatch[1], "the Bicep container env var and the wrangler required secret must name the same key");
});

test("safety defaults stay declared in the subscription-scoped entry point", async () => {
  const { mainSource, groupSource } = await loadBicep();
  assert.match(mainSource, /^targetScope = 'subscription'$/m);
  assert.match(groupSource, /^targetScope = 'resourceGroup'$/m);
  assert.match(mainSource, /param deployResources bool = false/, "cloud writes must default off");
  assert.match(mainSource, /param bootstrap bool = true/, "bootstrap must default on (ingress disabled)");
  assert.match(groupSource, /external: bootstrap \? false : enableExternalIngress/, "external ingress must stay gated behind the bootstrap split");
});
