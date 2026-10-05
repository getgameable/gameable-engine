/**
 * Minimal `.npy` reader for 2-D float32 arrays.
 *
 * A character bundle ships its trained rig poses as `rig_presets.npy` — the only
 * `.npy` the runtime ever reads. Rather than pull in a general npy library for one
 * file shape, this parses exactly what those files are and throws loudly on
 * anything else: a silently mis-parsed pose table drives the decoders with
 * garbage, which looks like a broken character rather than a bad read.
 *
 * Ported from aos-threejs-poc/src/lib/npyFloat32.js @ cdd63b10
 */

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

/** A parsed 2-D float32 npy. */
export interface NpyFloat32 {
  data: Float32Array;
  rows: number;
  cols: number;
}

/**
 * Parse a little-endian, C-order, 2-D float32 `.npy`. Throws on anything else.
 *
 * @param input The whole file, as the bytes came off the network or out of the
 * bundle zip; a `Uint8Array` is read in place rather than copied.
 * @returns The sample data as one flat row-major `Float32Array` of `rows * cols`
 * values, alongside the two dimensions read from the npy header.
 */
export function parseNpyFloat32(input: ArrayBuffer | Uint8Array): NpyFloat32 {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 12) throw new Error('npy: too short');
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('npy: bad magic (not a .npy file)');
  }

  const major = bytes[6];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // v1 uses a u16 header length at offset 8; v2+ a u32.
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder('latin1').decode(
    bytes.subarray(headerStart, headerStart + headerLen),
  );

  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  if (!descr) throw new Error('npy: no descr in header');
  if (!/^[<|=]f4$/.test(descr)) {
    throw new Error(`npy: expected little-endian float32 ('<f4'), got '${descr}'`);
  }
  if (/'fortran_order'\s*:\s*True/.test(header)) {
    throw new Error('npy: fortran_order arrays are not supported');
  }

  const shapeRaw = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (shapeRaw === undefined) throw new Error('npy: no shape in header');
  const dims = shapeRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (dims.some((d) => !Number.isFinite(d) || d < 0))
    throw new Error(`npy: bad shape (${shapeRaw})`);
  if (dims.length !== 2) throw new Error(`npy: expected a 2-D array, got ${String(dims.length)}-D`);

  const [rows, cols] = dims;
  const dataStart = headerStart + headerLen;
  const expected = rows * cols * 4;
  const available = bytes.byteLength - dataStart;
  if (available < expected) {
    throw new Error(
      `npy: truncated — need ${String(expected)} data bytes, have ${String(available)}`,
    );
  }

  // byteOffset may be unaligned for Float32Array, so copy rather than view.
  const data = new Float32Array(rows * cols);
  const dv = new DataView(bytes.buffer, bytes.byteOffset + dataStart, expected);
  for (let i = 0; i < data.length; i++) data[i] = dv.getFloat32(i * 4, true);

  return { data, rows, cols };
}
