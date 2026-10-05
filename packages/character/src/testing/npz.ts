// A minimal `.npz` reader, for the GNM reference fixture only.
//
// `tools/gnm_reference.py` writes `np.savez_compressed`, which is a zip of `.npy`
// members. The runtime's own `npyFloat32.ts` reads exactly one shape (2-D f32) because
// that is the only `.npy` a bundle ever ships; the oracle is 3-D and lives in a zip, so
// the test carries its own reader rather than widening the runtime's.
//
// Deliberately test-only: shipping a general npz reader would invite someone to put a
// `.npz` in a bundle, and the bundle format is a container with a manifest for a
// reason.

import { inflateRawSync } from 'node:zlib';

/** One array out of an `.npz`. */
export interface NpzArray {
  dtype: string;
  shape: number[];
  data: Float32Array | Float64Array | Int32Array | BigInt64Array;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD = 0x06054b50;

/**
 * Read every member of a `.npz` by name (without the `.npy` suffix).
 *
 * @param bytes The whole `.npz` file — a zip of `.npy` members, stored or deflated.
 * @returns Every member keyed by its name with `.npy` stripped, each carrying its
 * numpy dtype string, its shape and its samples as one flat typed array.
 */
export function readNpz(bytes: Uint8Array): Record<string, NpzArray> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Walk the central directory rather than the local headers: a streamed zip writes
  // sizes of 0 in the local header and defers them to a data descriptor.
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== EOCD) eocd--;
  if (eocd < 0) throw new Error('npz: no end-of-central-directory record');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const out: Record<string, NpzArray> = {};
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_HEADER) throw new Error('npz: bad central header');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (view.getUint32(localOffset, true) !== LOCAL_HEADER)
      throw new Error('npz: bad local header');
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localName + localExtra;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    const npy = method === 0 ? raw : new Uint8Array(inflateRawSync(raw));
    out[name.replace(/\.npy$/, '')] = parseNpy(npy);
  }
  return out;
}

/**
 * Parse one `.npy` member. Little-endian, C order, f32/f64/i32/i64/unicode.
 *
 * @param bytes One member's already-decompressed `.npy` bytes, header included.
 * @returns The dtype and shape from the header plus the payload as the matching
 * typed array. A unicode scalar instead reports its length and carries the decoded
 * string on an extra `text` field, which {@link npzText} reads.
 */
function parseNpy(bytes: Uint8Array): NpzArray {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder('latin1').decode(
    bytes.subarray(headerStart, headerStart + headerLength),
  );
  const dtype = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1] ?? '';
  const shapeRaw = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1] ?? '';
  const shape = shapeRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const dataStart = headerStart + headerLength;
  // Copy rather than view: the zip payload's offset is not guaranteed to be aligned.
  const payload = bytes.slice(dataStart).buffer;
  if (/^[<|=]f4$/.test(dtype)) return { dtype, shape, data: new Float32Array(payload) };
  if (/^[<|=]f8$/.test(dtype)) return { dtype, shape, data: new Float64Array(payload) };
  if (/^[<|=]i4$/.test(dtype)) return { dtype, shape, data: new Int32Array(payload) };
  if (/^[<|=]i8$/.test(dtype)) return { dtype, shape, data: new BigInt64Array(payload) };
  // A unicode scalar (the `oracle` field) — decode it as UCS-4 so the test can print it.
  if (/^[<|=]U\d+$/.test(dtype)) {
    const codes = new Uint32Array(payload);
    const text = String.fromCodePoint(...[...codes].filter((c) => c !== 0));
    return { dtype, shape, data: Float64Array.from([text.length]), ...{ text } };
  }
  throw new Error(`npz: unsupported dtype '${dtype}'`);
}

/**
 * The `oracle` string a reference npz records.
 *
 * @param bytes The whole `.npz` file; re-read in full on every call.
 * @param member Which member to decode, typically `'oracle'`.
 * @returns The member's text, or the empty string when it holds numbers rather
 * than a unicode scalar.
 */
export function npzText(bytes: Uint8Array, member: string): string {
  const arrays = readNpz(bytes);
  const entry = arrays[member] as NpzArray & { text?: string };
  return entry.text ?? '';
}
