/**
 * Verify an admin password.
 *
 * Two accepted forms, so the bootstrap experience is simple and the production
 * one is correct:
 *
 *   - `ADMIN_PASSWORD` starts with "scrypt$" -> compare the hash (production).
 *   - otherwise -> compare as plaintext, constant-time (development bootstrap).
 *
 * Plaintext in an environment variable is defensible for a family store getting
 * started, but it means the password is readable by anyone who can see the
 * environment. `npm run admin:hash` prints the hash to paste in instead, and
 * README explains when to switch.
 */
import "server-only";
import { env } from "@/lib/env";
import { safeEqual, verifyPassword } from "./password";

export function verifyAdminPassword(candidate: string): boolean {
  const configured = env().ADMIN_PASSWORD;
  if (configured.startsWith("scrypt$")) {
    return verifyPassword(candidate, configured);
  }
  return safeEqual(candidate, configured);
}
