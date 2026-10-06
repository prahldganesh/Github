/**
 * Admin password hashing.
 *
 * Uses Node's built-in `crypto.scrypt`, so no dependency. scrypt is a
 * memory-hard KDF, which is what makes a stolen hash expensive to crack
 * offline; a plain SHA-256 of a password is not.
 *
 * Stored format (self-describing, so parameters can change later):
 *
 *   scrypt$<N>$<r>$<p>$<salt-hex>$<key-hex>
 *
 * Existing hashes keep working when the cost parameters are raised, because
 * verification reads the parameters out of the stored string rather than
 * assuming the current constants.
 */
import crypto from "node:crypto";

/**
 * Cost parameters. N=2^15 is ~100ms on a laptop: slow for an attacker, fine
 * once per login.
 *
 * `maxmem` must be raised explicitly. scrypt needs 128 * N * r bytes, which is
 * exactly 32 MB here, and Node's default limit is 32 MB - so the default
 * rejects these parameters with "memory limit exceeded". Giving it headroom is
 * the correct fix; lowering N to fit the default would weaken the hash.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 64 * 1024 * 1024;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = crypto.scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return ["scrypt", N, R, P, salt.toString("hex"), key.toString("hex")].join("$");
}

/**
 * Verify a password against a stored hash. Constant-time comparison, and never
 * throws on a malformed hash - a corrupt value simply does not authenticate.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nRaw, rRaw, pRaw, saltHex, keyHex] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(keyHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: MAX_MEM });
  } catch {
    // Absurd parameters in a tampered hash can make scrypt throw.
    return false;
  }

  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Constant-time string comparison for the plaintext-env fallback.
 *
 * Comparing plaintext passwords with `===` leaks length and prefix information
 * through timing. This is the same defence the hashed path gets from
 * `timingSafeEqual`.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    // Still spend the time, so a wrong length is not detectably faster.
    crypto.timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}
