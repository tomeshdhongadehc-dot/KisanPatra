import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Storage, config, openFile, sealFile } from "./core";

test("sealFile/openFile round-trip, tamper detection, legacy passthrough", () => {
  const plain = Buffer.from("%PDF-1.4 secret farmer document");
  const sealed = sealFile(plain);
  assert.ok(!sealed.includes(Buffer.from("secret farmer")), "plaintext must not appear in the sealed bytes");
  assert.deepEqual(openFile(sealed), plain);
  const bad = Buffer.from(sealed); bad[bad.length - 1] ^= 1;
  assert.throws(() => openFile(bad), "tampered file must not decrypt");
  assert.deepEqual(openFile(plain), plain, "files written before encryption stay readable");
  assert.notDeepEqual(sealFile(plain), sealed, "fresh IV every time");
});

test("Storage writes ciphertext to disk and reads plaintext back", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agri-store-"));
  const old = config.storageDir; (config as any).storageDir = dir;
  try {
    const s = new Storage(), plain = Buffer.from("%PDF-1.7 on-disk check");
    const key = await s.put(plain, "pdf");
    const onDisk = await fs.readFile(path.join(dir, key.slice(0, 2), key));
    assert.ok(!onDisk.subarray(0, 5).equals(Buffer.from("%PDF-")), "file on disk must not look like a PDF");
    assert.deepEqual(await s.get(key), plain);
    await assert.rejects(() => s.get("../etc/passwd"));
  } finally { (config as any).storageDir = old; await fs.rm(dir, { recursive: true, force: true }); }
});
