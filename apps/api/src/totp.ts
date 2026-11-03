// RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) with replay protection, built on node:crypto: no dependency.
import crypto from "node:crypto";

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function b32encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}
export function b32decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "")) {
    const i = ALPHA.indexOf(ch); if (i < 0) throw new Error("BAD_BASE32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => crypto.randomBytes(20);
export const stepAt = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Returns the matched time-step, or null. Accepts +-1 step of clock drift. A step <= lastStep is rejected: a code works once. */
export function verifyTotp(secret: Buffer, code: string, lastStep: number | null, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(nowMs);
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const a = Buffer.from(hotp(secret, step)), b = Buffer.from(code);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return step;
  }
  return null;
}

export const otpauthUri = (secretB32: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

/** 8 one-time recovery codes: shown once, stored only as hashes. */
export function newRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => { const h = crypto.randomBytes(5).toString("hex"); return `${h.slice(0, 5)}-${h.slice(5)}`; });
}
export const normRecovery = (c: string) => c.toLowerCase().replace(/[^0-9a-f]/g, "");
