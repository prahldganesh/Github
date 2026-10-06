/**
 * Print a scrypt hash of a password, for `ADMIN_PASSWORD` in production.
 *
 *   npm run admin:hash -- "your password"
 *
 * Paste the printed value into ADMIN_PASSWORD. The app detects the "scrypt$"
 * prefix and verifies against the hash instead of comparing plaintext.
 *
 * Why bother: a plaintext password in the environment is readable by anyone who
 * can see the environment (a screenshot, a CI log, a leaked .env). A hash is
 * not.
 */
import { hashPassword } from "../src/lib/auth/password";

const password = process.argv[2];

if (!password) {
  console.error('Usage: npm run admin:hash -- "your password"');
  process.exit(1);
}
if (password.length < 12) {
  console.error("Use at least 12 characters. Length beats cleverness.");
  process.exit(1);
}

console.log(hashPassword(password));
