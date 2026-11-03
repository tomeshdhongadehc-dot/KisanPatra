import test from "node:test";
import assert from "node:assert/strict";
import { b32decode, b32encode, hotp, newRecoveryCodes, normRecovery, stepAt, verifyTotp } from "./totp";

const RFC = Buffer.from("12345678901234567890", "ascii"); // RFC 6238 appendix B test secret (SHA-1)

test("RFC 6238 test vectors (6-digit tails)", () => {
  assert.equal(hotp(RFC, stepAt(59_000), 8), "94287082");
  assert.equal(hotp(RFC, stepAt(1111111109_000), 8), "07081804");
  assert.equal(hotp(RFC, stepAt(1234567890_000), 8), "89005924");
});
test("base32 round-trips (RFC 4648 vector)", () => {
  assert.equal(b32encode(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.equal(b32decode("MZXW6YTBOI").toString(), "foobar");
  assert.throws(() => b32decode("not*base32"));
});
test("verifyTotp: accepts current and +-1 step, rejects older, rejects replay", () => {
  const now = 1_700_000_000_000, s = stepAt(now);
  assert.equal(verifyTotp(RFC, hotp(RFC, s), null, now), s);
  assert.equal(verifyTotp(RFC, hotp(RFC, s - 1), null, now), s - 1);
  assert.equal(verifyTotp(RFC, hotp(RFC, s + 1), null, now), s + 1);
  assert.equal(verifyTotp(RFC, hotp(RFC, s - 2), null, now), null);
  assert.equal(verifyTotp(RFC, hotp(RFC, s), s, now), null, "same step again = replay");
  assert.equal(verifyTotp(RFC, hotp(RFC, s - 1), s, now), null, "older step after a newer one is rejected");
  assert.equal(verifyTotp(RFC, "12345", null, now), null);
  assert.equal(verifyTotp(RFC, "abcdef", null, now), null);
});
test("recovery codes: unique, normalisable", () => {
  const c = newRecoveryCodes();
  assert.equal(new Set(c).size, 8);
  for (const x of c) assert.match(x, /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  assert.equal(normRecovery("A1B2C-D3E4F"), "a1b2cd3e4f");
});
