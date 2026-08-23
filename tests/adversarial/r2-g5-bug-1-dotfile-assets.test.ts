// Adversarial sweep round 2, gap-fill agent G5 — domain: Fastify BFF HTTP surface DEPTH.
//
// R2-G5-BUG-1 (dotfile disclosure): registerStaticAssets resolved and served any
// file under the asset root, including dot-leading paths. A deployment whose
// web-asset directory contains operator state (.env, .git/config, .DS_Store)
// leaked that state verbatim as 200 application/octet-stream bodies. The fix
// rejects every path whose any segment starts with "." with the same bounded
// 404 envelope used for unknown resources, before any filesystem resolution.
//
// Does not duplicate:
// - tests/adversarial/sweep-d3-api-methods.test.ts ("the static-asset fallback
//   serves the SPA and rejects traversal") — covers SPA serving, typed 404s,
//   the /api reservation, and ../-style traversal, but never requests a
//   dotfile that actually exists on disk.
// - tests/adversarial/deferred-3.test.ts and sec-r4-0.test.ts — draft TTL
//   semantics, unrelated to static assets.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApiServer } from "../../apps/api/src/index.ts";
import { synthesisAdapter } from "../fixtures/synthesis-caas.ts";

type ApiServer = Awaited<ReturnType<typeof createApiServer>>;

interface AssetDirectory {
  readonly root: string;
  readonly server: ApiServer;
}

async function assetServer(t: test.TestContext): Promise<AssetDirectory> {
  const root = await mkdtemp(join(tmpdir(), "r2-g5-assets-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, ".well-known"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>r2-g5</title>", "utf8");
  await writeFile(join(root, "assets", "app.js"), "export const probe = 1;", "utf8");
  await writeFile(join(root, ".env"), "UPSTREAM_SECRET=leaked-marker", "utf8");
  await writeFile(join(root, ".git", "config"), "[core]\n\tbare = false\n", "utf8");
  await writeFile(join(root, ".well-known", "probe.txt"), "well-known-marker", "utf8");
  await writeFile(join(root, "assets", ".DS_Store"), "binary-ds-store-marker", "utf8");
  const server = await createApiServer({ adapter: synthesisAdapter(), assetDirectory: root });
  t.after(async () => {
    await server.app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, server };
}

function assertBounded404(response: { statusCode: number; body: string }, context: string): void {
  assert.equal(response.statusCode, 404, `${context}: expected the bounded 404`);
  const envelope = JSON.parse(response.body) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, "NOT_FOUND", `${context}: the envelope names NOT_FOUND`);
  assert.equal(typeof envelope.error.message, "string", `${context}: bounded message`);
}

test("R2-G5-BUG-1: dotfiles under the asset root are never served, in any encoding", async (t) => {
  const { server } = await assetServer(t);

  // Before the fix each of these answered 200 with the raw file contents
  // (application/octet-stream) — an operator-state disclosure.
  const dotfiles = [
    "/.env",
    "/.git/config",
    "/.git",
    "/.well-known/probe.txt",
    "/assets/.DS_Store",
    // Encoded dot spellings must not smuggle a dotfile past the segment check.
    "/%2e%65nv",
    "/%2egit/config",
    "/.env%00",
  ];
  for (const url of dotfiles) {
    const response = await server.app.inject({ method: "GET", url });
    assertBounded404(response, `GET ${url}`);
    assert.equal(response.body.includes("leaked-marker"), false, `${url}: no .env contents`);
    assert.equal(response.body.includes("bare = false"), false, `${url}: no .git/config contents`);
    assert.equal(response.body.includes("well-known-marker"), false, `${url}: no dotfile contents`);
    assert.equal(response.body.includes("DS_Store"), false, `${url}: no .DS_Store contents`);
  }

  // A dotfile request must not fall back to the SPA either: the whole family
  // is operator state, so masking it with index.html would still be a lie
  // about what the server did with the request.
  const masked = await server.app.inject({ method: "GET", url: "/.env" });
  assert.equal(masked.body.includes("r2-g5"), false, "a dotfile request must not serve the SPA document");
});

test("R2-G5-BUG-1: relative-hop segments never reach dotfiles or leave the root", async (t) => {
  const { server } = await assetServer(t);

  // The router sanitizes relative hops before dispatch ("/assets/./app.js"
  // arrives as "assets/app.js"), so hops resolve to their normalized target:
  // still inside the root, still not a dotfile. Pin that normalization can
  // never be used to *reach* a dotfile — the collapsed path must hit the
  // dot-leading-segment rejection.
  const hops = [
    ["/./index.html", "<!doctype html>"],
    ["/../index.html", "<!doctype html>"],
    ["/assets/../index.html", "<!doctype html>"],
    ["/%2e/index.html", "<!doctype html>"],
    ["/assets/./app.js", "export const probe = 1;"],
  ] as const;
  for (const [url, expectedContent] of hops) {
    const response = await server.app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, `GET ${url}: the normalized target serves`);
    assert.ok(response.body.includes(expectedContent), `GET ${url}: serves the normalized target, not a foreign file`);
    assert.equal(response.body.includes("leaked-marker"), false, `${url}: hop never reaches a dotfile`);
  }

  // A hop that collapses ONTO a dotfile path must land on the dotfile
  // rejection, not on the file.
  for (const url of ["/assets/../.env", "/.git/../.env", "/x/../../.git/config"]) {
    const response = await server.app.inject({ method: "GET", url });
    assertBounded404(response, `GET ${url}`);
    assert.equal(response.body.includes("leaked-marker"), false, `${url}: collapsed dotfile stays unreachable`);
  }
});

test("R2-G5-BUG-1 fix leaves ordinary SPA serving intact", async (t) => {
  const { server } = await assetServer(t);

  const root = await server.app.inject({ method: "GET", url: "/" });
  assert.equal(root.statusCode, 200, "the SPA root still serves");
  assert.ok(String(root.headers["content-type"]).startsWith("text/html"), "HTML content type preserved");

  const asset = await server.app.inject({ method: "GET", url: "/assets/app.js" });
  assert.equal(asset.statusCode, 200, "regular assets still serve");
  assert.equal(asset.body, "export const probe = 1;");

  const fallback = await server.app.inject({ method: "GET", url: "/some/client/route" });
  assert.equal(fallback.statusCode, 200, "the extension-less SPA fallback still serves");
  assert.ok(fallback.body.includes("r2-g5"), "the fallback serves the index document");

  const apiReserved = await server.app.inject({ method: "GET", url: "/api/v1/never-registered" });
  assertBounded404(apiReserved, "GET /api/v1/never-registered");

  // Dot-containing (not dot-leading) file names are still ordinary files.
  const weird = await server.app.inject({ method: "GET", url: "/assets/app.js" });
  assert.equal(weird.statusCode, 200, "a normal multi-dot filename still serves");
});
