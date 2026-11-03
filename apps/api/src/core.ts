import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export const REPO_ROOT = path.resolve(__dirname, "../../..");
const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
  storageDir: abs(process.env.STORAGE_DIR ?? "./.devdata/storage"),
  tesseractBin: process.env.TESSERACT_BIN ?? "C:/Program Files/Tesseract-OCR/tesseract.exe",
  tessdataDir: abs(process.env.TESSDATA_DIR ?? "./tessdata"),
  chromePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 15 * 1024 * 1024),
  isProd: process.env.NODE_ENV === "production",
};

function need(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith("dev-only") && config.isProd) throw new Error(`Missing/unsafe secret ${name}`);
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}
const masterKey = () => crypto.createHash("sha256").update(need("APP_MASTER_KEY")).digest();
const blindKey = () => crypto.createHash("sha256").update(need("APP_BLIND_INDEX_KEY")).digest();

// ---------- field encryption: v1:<iv>:<tag>:<ct> (AES-256-GCM) ----------
export function enc(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}
export function dec(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const [v, iv, tag, ct] = blob.split(":");
  if (v !== "v1") throw new Error("Unknown ciphertext version");
  const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}
export const blindIndex = (v: string) => crypto.createHmac("sha256", blindKey()).update(v.trim().toLowerCase()).digest("hex");
export const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function platformId(): string {
  const b = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += B32[b[i] % 32];
  return `FRM-${s}`;
}

export function normName(s: string | null | undefined) {
  return (s ?? "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------- storage (local driver behind a tiny interface) ----------
// Files at rest (source PDFs, page images, card files) are AES-256-GCM encrypted with the master key: "AGR1" | iv(12) | tag(16) | ciphertext.
// Files without the magic header (written before this was added) are still readable and are rewritten encrypted when next stored.
const MAGIC = Buffer.from("AGR1");
export function sealFile(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}
export function openFile(buf: Buffer): Buffer {
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) return buf; // legacy plaintext file
  const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  return Buffer.concat([d.update(buf.subarray(32)), d.final()]); // throws if the file was tampered with
}

@Injectable()
export class Storage {
  async put(buf: Buffer, ext = "bin"): Promise<string> {
    const key = `${randomToken(24)}.${ext}`; // unguessable, no user input in the path
    const p = path.join(config.storageDir, key.slice(0, 2), key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, sealFile(buf), { mode: 0o600 });
    return key;
  }
  async get(key: string): Promise<Buffer> {
    if (!/^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(key)) throw new Error("bad key");
    return openFile(await fs.readFile(path.join(config.storageDir, key.slice(0, 2), key)));
  }
  async del(key: string) {
    await fs.rm(path.join(config.storageDir, key.slice(0, 2), key), { force: true });
  }
}

@Injectable()
export class Prisma extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}

// ---------- audit (ids and keys only, never values) ----------
@Injectable()
export class Audit {
  constructor(@Inject(Prisma) private readonly db: Prisma) {}
  async log(e: { orgId: string; actorId?: string | null; action: string; entityType: string; entityId?: string | null; outcome?: "SUCCESS" | "DENIED" | "FAILURE"; correlationId?: string; meta?: Record<string, unknown> }) {
    await this.db.auditEvent.create({
      data: {
        orgId: e.orgId, actorId: e.actorId ?? null, action: e.action, entityType: e.entityType, entityId: e.entityId ?? null,
        outcome: e.outcome ?? "SUCCESS", correlationId: e.correlationId ?? crypto.randomUUID(), meta: (e.meta ?? undefined) as any,
      },
    });
  }
}
