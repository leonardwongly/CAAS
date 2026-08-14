import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { root, sha256Hex, writeJsonRecord } from "../../scripts/validation/lib-evidence.mjs";

// Finding: writeJsonRecord() (scripts/validation/lib-evidence.mjs:31-36) writes
// the record, then hashes whatever the record path holds at re-read time:
// `return sha256Hex(await readFile(absolute))`. The hash therefore does not
// attest the bytes the lane wrote — it attests the path's content after the
// write. A symlink planted at the record path is followed by writeFile (no
// O_NOFOLLOW) and by readFile alike: the lane's write "succeeds" while the
// returned sha256 is the hash of the symlink target's read view, not of the
// serialized record. That bogus hash is later bound by
// validate-evidence-bundle.mjs:97, breaking the artifact-hash contract that
// the recorded sha256 must attest exactly the lane's own bytes. A file swap
// between the write and the re-read (TOCTOU) has the same effect; the symlink
// plant is the deterministic way to exercise the same window.
//
// Correct behavior: hash the exact written buffer (the serialized record
// bytes), or write+hash through one fd opened with O_NOFOLLOW|O_EXCL. In
// either form, the returned sha256 must equal sha256 of the lane's own bytes
// regardless of what the record path points at or holds when re-read.

const relPath = "tests/adversarial/.sec-r2-2-swap/record.json";
const abs = resolve(root, relPath);
const record = { checkId: "sec-r2-2", result: "pass", value: 42 };
// writeJsonRecord serializes as JSON.stringify(record, null, 2) + "\n".
const expectedBytes = `${JSON.stringify(record, null, 2)}\n`;

test("writeJsonRecord returns the hash of the exact bytes it wrote even when a symlink is planted at the record path", async () => {
  await rm(dirname(abs), { recursive: true, force: true });
  await mkdir(dirname(abs), { recursive: true });
  // Attacker plants a symlink at the record path: writeFile follows it and
  // "succeeds" against the target, but the re-read then yields the target's
  // content (empty for /dev/null), not the bytes the lane wrote.
  await symlink("/dev/null", abs);
  try {
    const returned = await writeJsonRecord(relPath, record);
    assert.equal(
      returned,
      sha256Hex(expectedBytes),
      "recorded sha256 must attest the lane's own serialized bytes, not whatever the record path yields at re-read time",
    );
  } finally {
    await rm(dirname(abs), { recursive: true, force: true });
  }
});
