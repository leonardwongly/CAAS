import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// Finding sec-r2-3: the OCI evidence lane's git-archive extraction
// (scripts/validation/build-oci.mjs:68-69) runs
//   git archive --format=tar -o <contextTar> HEAD
//   tar -xf <contextTar> -C <contextDir>
// with no --no-same-owner / --no-absolute-names flags and no check that member
// names or symlink targets stay inside contextDir. Git cannot index `..` paths
// (no classic tar-slip), but git does allow committing symlinks whose targets
// are absolute or `..`-escaping (e.g. `evil -> ../../../etc/passwd`);
// `git archive` emits those entries and tar recreates them verbatim into the
// context handed to `docker build`.
//
// Correct behavior per the finding's expectation (and the evidence-lane
// contract in docs/security/safety-and-secrets.md): a crafted archive — a
// `..`-escaping member, an absolute member, or a symlink with an absolute/`..`
// target — must fail the build lane loudly instead of being materialized; the
// extracted context must stay contained inside contextDir. This test feeds
// crafted archives through the exact extraction commands the lane runs and
// asserts containment + loud failure.

const execFileAsync = promisify(execFile);

// The lane's guarded extraction is exercised directly — the single code path
// the build lane itself uses (build-oci.mjs extractBuildContext).
const { extractBuildContext } = await import("../../scripts/validation/build-oci.mjs");
const runExtraction = (tarPath: string, contextDir: string): Promise<void> => extractBuildContext(tarPath, contextDir);

// Walk contextDir (following no symlinks) and return every symlink whose
// target resolves outside contextDir.
async function escapingSymlinks(contextDir: string): Promise<Array<{ rel: string; target: string; resolved: string }>> {
  const found: Array<{ rel: string; target: string; resolved: string }> = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = join(contextDir, rel);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      const target = await readlink(abs);
      const resolved = resolve(dirname(abs), target);
      const inside = resolved === contextDir || resolved.startsWith(contextDir + sep);
      if (!inside) found.push({ rel, target, resolved });
    } else if (st.isDirectory()) {
      for (const entry of await readdir(abs)) stack.push(join(rel, entry));
    }
  }
  return found;
}

// Minimal ustar (POSIX) tar writer: enough to craft archive members with
// malicious names, which git itself refuses to index.
function ustarMember({ name, content }: { name: string; content: string }) {
  const nameBuf = Buffer.from(name, "utf8");
  const data = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512, 0);
  const prefixBuf = Buffer.alloc(155);
  if (nameBuf.length <= 100) {
    nameBuf.copy(header, 0);
  } else {
    const split = name.length - 100;
    nameBuf.copy(prefixBuf, 0, 0, split);
    nameBuf.copy(header, 0, split);
  }
  header.write("0000644\0", 100, "ascii"); // mode
  header.write("0000000\0", 108, "ascii"); // uid
  header.write("0000000\0", 116, "ascii"); // gid
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii"); // size
  header.write("00000000000\0", 136, "ascii"); // mtime
  header.write("        ", 148, "ascii"); // chksum placeholder
  header.write("0", 156, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.write("sec-r2-3", 265, "ascii"); // uname
  prefixBuf.copy(header, 345); // prefix
  // chksum: sum of header bytes with the chksum field as spaces
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  const paddedData = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(paddedData);
  return Buffer.concat([header, paddedData]);
}

// Symlink member (typeflag "2"): the data area carries the link target.
function ustarSymlink({ name, target }: { name: string; target: string }) {
  const member = ustarMember({ name, content: target });
  member[156] = "2".charCodeAt(0);
  return member;
}

function ustarEnd() {
  return Buffer.alloc(1024, 0);
}

test("git-archive context extraction rejects symlinks whose targets escape the context dir", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "sec-r2-3-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  // Throwaway repo committing symlinks with escaping targets — git allows it.
  await execFileAsync("git", ["init", "-q"], { cwd: sandbox });
  await execFileAsync("git", ["config", "user.email", "sec-r2-3@example.com"], { cwd: sandbox });
  await execFileAsync("git", ["config", "user.name", "sec-r2-3"], { cwd: sandbox });
  await symlink("../../../etc/passwd", join(sandbox, "evil-dotdot"));
  await symlink("/etc/passwd", join(sandbox, "evil-abs"));
  await execFileAsync("git", ["add", "-A"], { cwd: sandbox });
  await execFileAsync("git", ["commit", "-qm", "probe"], { cwd: sandbox });

  // The lane's exact commands (build-oci.mjs:68-69).
  const contextTar = join(sandbox, "context.tar");
  await execFileAsync("git", ["archive", "--format=tar", "-o", contextTar, "HEAD"], { cwd: sandbox });
  const contextDir = join(sandbox, "context");
  await mkdir(contextDir);

  let threw = false;
  try {
    await runExtraction(contextTar, contextDir);
  } catch {
    threw = true;
  }

  // Correct behavior: the lane fails loudly instead of materializing the
  // escaping symlinks into the docker build context.
  assert.ok(threw, "extraction of an escaping-symlink archive must fail loudly, not exit 0");
  const escaping = await escapingSymlinks(contextDir);
  assert.equal(
    escaping.length,
    0,
    `no symlink may escape contextDir, found: ${escaping.map((e) => `${e.rel} -> ${e.target}`).join(", ") || "none"}`,
  );
});

test("a symlink member whose NAME contains ' -> ' cannot mask an escaping target", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "sec-r2-3-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const contextDir = join(sandbox, "context");
  await mkdir(contextDir);
  // The listing line becomes: `lrwxr-xr-x ... evil -> hidden -> /etc/passwd`.
  // A naive `split(" -> ")[1]` would read the target as "hidden" (contained)
  // while tar materializes the real escaping target /etc/passwd.
  const craftedTar = join(sandbox, "arrow-name.tar");
  await writeFile(
    craftedTar,
    Buffer.concat([
      ustarSymlink({ name: "evil -> hidden", target: "/etc/passwd" }),
      ustarEnd(),
    ]),
  );

  let threw = false;
  try {
    await runExtraction(craftedTar, contextDir);
  } catch {
    threw = true;
  }
  assert.ok(threw, "an unparseable ' -> ' sequence must fail the lane loudly");
  const escaping = await escapingSymlinks(contextDir);
  assert.equal(escaping.length, 0, "no escaping symlink may materialize");
});

test("crafted tar with ..-escaping and absolute members stays contained in the context dir", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "sec-r2-3-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const contextDir = join(sandbox, "context");
  await mkdir(contextDir);
  const contextParent = dirname(contextDir);
  const payload = "sec-r2-3 pwned payload";

  // Absolute member at a fixed unique location, so containment is checkable.
  const absTarget = join(tmpdir(), "sec-r2-3-escaped-abs.txt");
  const craftedTar = join(sandbox, "crafted.tar");
  await writeFile(
    craftedTar,
    Buffer.concat([
      ustarMember({ name: `../sec-r2-3-escaped-dotdot.txt`, content: payload }),
      ustarMember({ name: absTarget, content: payload }),
      ustarEnd(),
    ]),
  );

  let threw = false;
  try {
    await runExtraction(craftedTar, contextDir);
  } catch {
    threw = true;
  }

  // Nothing may be materialized outside contextDir, and the lane must not
  // silently succeed-and-escape: either it rejects the archive loudly, or the
  // members land (sanitized) inside the context only.
  assert.ok(!existsSync(join(contextParent, "sec-r2-3-escaped-dotdot.txt")), "`..` member must not write into the context parent");
  assert.ok(!existsSync(absTarget), `absolute member must not write to ${absTarget}`);
  if (!threw) {
    const escaping = await escapingSymlinks(contextDir);
    assert.equal(escaping.length, 0, "no escaping symlink materialized");
  }
});
