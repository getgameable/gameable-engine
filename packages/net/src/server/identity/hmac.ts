/**
 * HMAC-SHA256 and base64url on Web Crypto, so identity runs on Node and in a
 * page alike (Play Solo bundles `net/server`): no `Buffer`, no `node:crypto`.
 */

const encoder = new TextEncoder();

/**
 * @param bytes Bytes.
 * @returns Them as base64url, no padding.
 */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param count How many.
 * @returns That many bytes from the platform's secure random source.
 */
export function randomBytes(count: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(count));
}

/**
 * @param secret The key, as UTF-8.
 * @returns A key for HMAC-SHA256 signing.
 */
export function hmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * @param key The key.
 * @param text What to sign, as UTF-8.
 * @returns The 32-byte HMAC as base64url (43 characters).
 */
export async function sign(key: Promise<CryptoKey>, text: string): Promise<string> {
  const mac = await globalThis.crypto.subtle.sign('HMAC', await key, encoder.encode(text));
  return base64url(new Uint8Array(mac));
}

/**
 * Compare two strings in time that depends only on their lengths, never on
 * where they first differ.
 *
 * @param a One.
 * @param b The other.
 * @returns True when equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
