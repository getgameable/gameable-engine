/**
 * Determinism and parity hashing.
 *
 * FNV-1a over the packed transform floats and over a canonical JSON rendering
 * of the command list. Floats are hashed from their raw 32-bit pattern, so two
 * runs that differ in the last bit of a position are caught rather than
 * rounded away.
 */
import type { Command, FrameOutput } from '@gameable/sdk';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Scratch used to read the bit pattern of an f32 without allocating. */
const scratchF32 = new Float32Array(1);
const scratchU32 = new Uint32Array(scratchF32.buffer);

/**
 * Fold one byte into a running FNV-1a hash.
 *
 * @param hash The running hash.
 * @param byte The byte.
 * @returns The new hash.
 */
function fold(hash: number, byte: number): number {
  return Math.imul(hash ^ (byte & 0xff), FNV_PRIME) >>> 0;
}

/**
 * Fold a 32-bit word into a running FNV-1a hash, little-endian.
 *
 * @param hash The running hash.
 * @param word The word.
 * @returns The new hash.
 */
export function hashU32(hash: number, word: number): number {
  let h = fold(hash, word);
  h = fold(h, word >>> 8);
  h = fold(h, word >>> 16);
  h = fold(h, word >>> 24);
  return h;
}

/**
 * Fold a string into a running FNV-1a hash.
 *
 * @param hash The running hash.
 * @param text The string.
 * @returns The new hash.
 */
export function hashString(hash: number, text: string): number {
  let h = hash;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h = fold(h, c);
    h = fold(h, c >>> 8);
  }
  return h;
}

/**
 * Hash a packed transform buffer.
 *
 * @param transforms The `frame-output.transforms` list, stride 12.
 * @returns A 32-bit hash.
 *
 * @example
 * ```ts
 * import { hashTransforms } from 'gameable/test';
 *
 * expect(hashTransforms(a.transforms)).toBe(hashTransforms(b.transforms));
 * ```
 */
export function hashTransforms(transforms: ArrayLike<number>): number {
  let h = FNV_OFFSET;
  h = hashU32(h, transforms.length);
  for (let i = 0; i < transforms.length; i += 1) {
    scratchF32[0] = transforms[i];
    h = hashU32(h, scratchU32[0]);
  }
  return h;
}

/**
 * Hash a command list.
 *
 * Commands are JSON, not floats: their payloads are structural, and a textual
 * difference is exactly what a parity test wants to see.
 *
 * @param commands The `frame-output.commands` list.
 * @returns A 32-bit hash.
 *
 * @example
 * ```ts
 * import { hashCommands } from 'gameable/test';
 *
 * expect(hashCommands(out.commands)).toMatchInlineSnapshot();
 * ```
 */
export function hashCommands(commands: readonly Command[]): number {
  let h = FNV_OFFSET;
  h = hashU32(h, commands.length);
  for (const command of commands) {
    h = hashString(h, command.tag);
    h = hashString(h, stableJson(command.val));
  }
  return h;
}

/**
 * JSON with object keys sorted, so two structurally identical payloads hash
 * the same whatever order their fields were assigned in.
 *
 * @param value Anything JSON-serialisable.
 * @returns The canonical rendering.
 */
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as ArrayLike<number>;
    let out = '[';
    for (let i = 0; i < view.length; i += 1) {
      if (i > 0) out += ',';
      out += stableJson(view[i]);
    }
    return `${out}]`;
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = record[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableJson(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

/**
 * Hash a whole `frame-output`: transforms, commands, local commands, camera and HUD.
 *
 * Local commands fold in only when there are some, so a single-player frame
 * hashes exactly as it did before `local-commands` existed.
 *
 * @param out The output to hash.
 * @returns A 32-bit hash.
 *
 * @example
 * ```ts
 * import { hashFrameOutput } from 'gameable/test';
 *
 * expect(hashFrameOutput(direct)).toBe(hashFrameOutput(wasm));
 * ```
 */
export function hashFrameOutput(out: FrameOutput): number {
  let h = FNV_OFFSET;
  h = hashU32(h, hashTransforms(out.transforms));
  h = hashU32(h, hashCommands(out.commands));
  if (out.localCommands.length > 0) h = hashU32(h, hashCommands(out.localCommands));
  h = hashString(h, stableJson(out.camera));
  h = hashString(h, out.hud ?? '');
  return h;
}
