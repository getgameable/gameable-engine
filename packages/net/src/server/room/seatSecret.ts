/**
 * Seat secrets: what a client keeps to reclaim its seat after a reconnect.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Bytes of randomness in one secret. */
export const SECRET_BYTES = 16;

/**
 * A new seat secret: 16 bytes from `random`, base64url without padding (22
 * characters). Runs anywhere: no `Buffer`, no `crypto` (the room's port
 * decides how good `random` is).
 *
 * @param random A uniform source in `[0, 1)`, `ports.random`.
 * @returns The secret.
 *
 * @example
 * ```ts
 * import { newSeatSecret } from 'gameable/net/server';
 *
 * const secret = newSeatSecret(Math.random); // e.g. 'q1x0kZ...'; 22 characters
 * ```
 */
export function newSeatSecret(random: () => number): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  for (let i = 0; i < SECRET_BYTES; i += 1) bytes[i] = Math.floor(random() * 256) & 0xff;
  let out = '';
  for (let i = 0; i < SECRET_BYTES; i += 3) {
    const a = bytes[i];
    const b = i + 1 < SECRET_BYTES ? bytes[i + 1] : 0;
    const c = i + 2 < SECRET_BYTES ? bytes[i + 2] : 0;
    out += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < SECRET_BYTES) out += ALPHABET[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < SECRET_BYTES) out += ALPHABET[c & 63];
  }
  return out;
}
