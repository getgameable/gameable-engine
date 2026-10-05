// The `.aosrig` pack: a baked GNM head as ONE browser-ready file.
//
// GNM is python-only — there is no ONNX export and there will not be one, because
// the model is a linear expression basis plus linear-blend skinning and running
// that through an inference runtime would be slower than the 60 lines of WGSL in
// `wgsl/gnm_blend.wgsl`. `tools/gnm_pack.py` converts aosRig's `BakedHead` npz into
// this container offline; nothing at runtime needs numpy, `gnm`, or `aosrig`.
//
// CONTAINER, little-endian, offsets absolute from the start of the pack — the same
// shape as `rig/orl/orlPack.ts`, and for the same reason: one file either parses or
// it does not, so a partially-uploaded rig is not expressible.
//
//   0   "AOSRIG01"                      8 bytes, magic + format version
//   8   u32 headerLen                   byte length of the header JSON
//   12  u32 totalLen                    byte length of the whole pack
//   16  header JSON (utf8)
//       zero padding                    to the next 8-byte boundary
//   …   blobs                           each zero-padded to an 8-byte boundary
//
// `totalLen` is not redundant with the blob bounds: the last blob is padded, so a
// download cut short by less than that padding would still pass a per-blob check.
//
// HEADER, and every field in it is load-bearing:
//
//   version        1
//   model          "gnm"
//   vertexCount    V — 17,821 for the shipped head
//   coeffCount     E — 383 expression coefficients
//   maxInfluence   4 — GNM's skinning is already fixed-width (see `skinIndex`)
//   units          "m" — GNM is metres; a bundle trained in cm converts once, in
//                  the lift's `worldScale`, never here
//   headExt        the parameter block: 383 expression + 4 gaze = 387, with the
//                  region segments (left_eye 100, right_eye 100, lower_face 150,
//                  tongue 32, pupils 1) and the reduced ML view (68)
//   joints         the COMPACT joint list this head is skinned to — names, parents
//                  and rest world matrices, remapped at pack time from the body
//                  rig's 54 down to the 4-8 the head actually references
//   eyes           GNM's own eye joints, which are NOT body joints: gaze is a
//                  rotation about each eyeball blended by that joint's own skinning
//                  weight, which is how the model poses gaze internally
//   bindTransform  `head_bind_world @ local_to_head`, row-major 4x4 — head-local into
//                  the body's BIND space. `BakedHead.pose` skins there, not
//                  head-local, so the vertices have to travel it. The pack keeps the
//                  MODEL head-local so gaze stays in the frame it is defined in, and
//                  the runtime folds this matrix into the skin matrices instead —
//                  exactly equivalent, because LBS is affine and comes after
//   buffers        name / dtype / shape / offset / byteLength, exactly as the mesh
//                  loader's manifest does it
//
// BLOBS:
//
//   neutral       f32  (V,3)    identity already applied, zero expression
//   basis         u32  packed   fp16 pairs, VERTEX-MAJOR (V,E,3) — see below
//   basisScale    f32  (E,)     per-coefficient dequantisation scale
//   skinIndex     u16  (V,4)    into `joints`
//   skinWeight    f16  (V,4)    packed as u16 lanes; expanded to f32 at load
//   eyePositions  f32  (2,3)    eye joint positions at this identity
//   eyeWeights    f32  (2,V)    per-eye skinning weight
//   restWorld     f32  (J,4,4)  row-major joint rest world matrices
//   jointParents  i32  (J,)     -1 for a root
//   faces         u32  (T,3)
//   quads         u32  (Q,4)    optional
//   uv            f32  (V,2)    optional
//   stitchLocal   f32  (V,3)    optional — the baked neck seam
//
// THE MOUTH'S INSIDE (optional, since the studio's 2026-09-24 exports). A header
// `mouth` entry names one u32 vertex-id blob per part (teeth, gums, tongue and the
// mouth bag, `mouthTeeth` … `mouthBag`, each with a standard sRGB `look`), the
// triangles all inside them (`mouthFaces`, u32 (T,3), this pack's vertex ids) and
// each triangle's part (`mouthFaceParts`, u32 (T,), 1 + the group's index). They
// move with the same expression as the rest of the head: the lower teeth with the
// jaw, the upper with the skull. A pack without the entry parses exactly as before.
//
// WHY THE BASIS IS VERTEX-MAJOR AND fp16. The bake stores `(E, V, 3)`: every vertex
// of coefficient 0, then coefficient 1, and so on. A GPU thread owns ONE VERTEX and
// walks all 383 coefficients, so in that layout it strides by `V*3` floats between
// reads — the worst possible access pattern. Transposing to `(V, E, 3)` at pack time
// makes a thread's 1,149 reads contiguous. fp16 halves a 383 × 17,821 × 3 array from
// 78 MB to 39 MB; WGSL has no `f16` storage type without the `shader-f16` feature,
// so pairs are packed into `u32` and the shader unpacks with `unpack2x16float`,
// which is core WGSL. `test/gnm.test.ts` measures what the quantisation costs.

/** Every dtype a pack blob can be. */
export type AosRigDType = 'f32' | 'f16' | 'u32' | 'i32' | 'u16' | 'u8' | 'i8';

/** One blob's entry in the header. */
export interface AosRigBuffer {
  name: string;
  dtype: AosRigDType;
  shape: number[];
  offset: number;
  byteLength: number;
}

/** One joint of the compact list the head is skinned to. */
export interface AosRigJoint {
  name: string;
  /** Index into `joints`, or -1 for a root. */
  parent: number;
}

/** The `head_ext` parameter block. */
export interface HeadExtLayout {
  /** 387 = expression + gaze. */
  dim: number;
  /** 383. */
  exprDim: number;
  /** 4: `[pitch_L, yaw_L, pitch_R, yaw_R]` radians. */
  gazeDim: number;
  /** `[["left_eye",100], ["right_eye",100], ["lower_face",150], ["tongue",32], ["pupils",1]]`. */
  regions: [string, number][];
  /** The reduced ML view's per-region counts; they sum to 64, plus gaze = 68. */
  reduced: Record<string, number>;
}

/** The header JSON, parsed. */
export interface AosRigHeader {
  version: number;
  model: 'gnm';
  vertexCount: number;
  coeffCount: number;
  maxInfluence: number;
  units: 'm' | 'cm';
  headExt: HeadExtLayout;
  joints: AosRigJoint[];
  eyes: { names: string[] };
  /** Row-major 4x4: head-local -> the body's bind space. See the header comment. */
  bindTransform: number[];
  buffers: AosRigBuffer[];
  /** Free-form provenance the packer writes; never read by the runtime. */
  source?: Record<string, unknown>;
  /** The mouth's inside, when the bake carried it. See the file comment. */
  mouth?: AosRigMouthEntry;
}

/** The header's `mouth` entry: which blobs hold the mouth's inside. */
export interface AosRigMouthEntry {
  /** One per part, in order; a triangle's part is 1 + an index into this list. */
  groups: { name: string; vertices: string; look?: { color?: number[]; gloss?: number } }[];
  /** Name of the u32 (T,3) triangle blob. */
  faces: string;
  /** Name of the u32 (T,) blob of each triangle's part. */
  faceParts: string;
}

/** One part of the mouth's inside, parsed. */
export interface AosRigMouthGroup {
  /** The part's name in the bake: `teeth`, `gums`, `tongue`, `mouth_sock`. */
  name: string;
  /** Its vertex ids, into the pack's vertices. */
  vertices: Uint32Array;
  /** Its standard colour, sRGB 0..1. */
  color: [number, number, number];
  /** How glossy it is, 0..1. */
  gloss: number;
}

/** The mouth's inside, parsed and range-checked. */
export interface AosRigMouth {
  groups: AosRigMouthGroup[];
  /** (T,3) vertex ids of the triangles all inside the mouth. */
  faces: Uint32Array;
  /** (T,) each triangle's part: 1 + an index into `groups`. */
  faceParts: Uint32Array;
}

/** A parsed pack: the header plus typed views over the blobs. */
export interface AosRigPack {
  header: AosRigHeader;
  vertexCount: number;
  coeffCount: number;
  maxInfluence: number;
  /** (V,3) f32, metres. */
  neutral: Float32Array;
  /** Packed fp16 pairs, vertex-major (V,E,3). Feed to the shader verbatim. */
  basis: Uint32Array;
  /** (E,) f32 per-coefficient scale. */
  basisScale: Float32Array;
  /** (V,4) u16 into `header.joints`. */
  skinIndex: Uint16Array;
  /** (V,4), expanded from the packed f16 lanes at load. */
  skinWeight: Float32Array;
  /** (2,3) f32. */
  eyePositions: Float32Array;
  /** (2,V) f32. */
  eyeWeights: Float32Array;
  /** (J,16) f32 row-major rest world matrices. */
  restWorld: Float32Array;
  /** (J,) i32 parents, -1 for a root. */
  jointParents: Int32Array;
  /** Row-major 4x4 head-local -> body bind space. Identity when the bake had none. */
  bindTransform: Float32Array;
  faces: Uint32Array;
  quads?: Uint32Array;
  uv?: Float32Array;
  /** (V,3) f32 neck-seam displacement, head-local. Absent when the bake had no seam. */
  stitchLocal?: Float32Array;
  /** The teeth, gums, tongue and mouth bag. Absent when the bake had none. */
  mouth?: AosRigMouth;
  /** Total bytes of the pack, for `memoryReport()`. */
  byteLength: number;
}

const MAGIC = 'AOSRIG01';
const HEADER = 16;
const ALIGN = 8;
const align = (n: number): number => (n + (ALIGN - 1)) & ~(ALIGN - 1);

const BYTES_PER: Record<AosRigDType, number> = {
  f32: 4,
  f16: 2,
  u32: 4,
  i32: 4,
  u16: 2,
  u8: 1,
  i8: 1,
};

/** One blob on the way into a pack. */
export interface AosRigBlob {
  name: string;
  dtype: AosRigDType;
  shape: number[];
  data: ArrayBufferView;
}

/**
 * Build a pack.
 *
 * Blobs are written in the given order and the header's key order is fixed, so
 * packing the same bake twice is BYTE-IDENTICAL — which is what makes a re-bake
 * diff meaningful.
 *
 * @param header Everything but `buffers`, which is derived from the laid-out blobs.
 * @param blobs The blobs, in the order they are written. Each is copied verbatim;
 *   the declared `shape` and `dtype` are what `parseAosRig` checks its length
 *   against.
 * @returns The whole container: magic, header JSON, then the 8-byte-aligned blobs.
 * @throws {Error} When the header's encoded length does not converge in four passes.
 */
export function packAosRig(header: Omit<AosRigHeader, 'buffers'>, blobs: AosRigBlob[]): Uint8Array {
  const encode = (h: AosRigHeader) => new TextEncoder().encode(JSON.stringify(h));
  const withOffsets = (headerLen: number): { full: AosRigHeader; body: number } => {
    let off = align(HEADER + headerLen);
    const buffers: AosRigBuffer[] = blobs.map((b) => {
      const entry: AosRigBuffer = {
        name: b.name,
        dtype: b.dtype,
        shape: b.shape,
        offset: off,
        byteLength: b.data.byteLength,
      };
      off = align(off + b.data.byteLength);
      return entry;
    });
    return { full: { ...header, buffers }, body: off };
  };

  let headerLen = encode(withOffsets(0).full).length;
  let resolved = withOffsets(headerLen);
  for (let attempt = 0; attempt < 4; attempt++) {
    const enc = encode(resolved.full);
    if (enc.length <= headerLen) break;
    headerLen = enc.length;
    resolved = withOffsets(headerLen);
  }
  const encoded = encode(resolved.full);
  if (encoded.length > headerLen) throw new Error('[aosrig] header did not converge');

  const out = new Uint8Array(resolved.body);
  const view = new DataView(out.buffer);
  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
  view.setUint32(8, headerLen, true);
  view.setUint32(12, resolved.body, true);
  out.set(encoded, HEADER);
  for (let i = 0; i < blobs.length; i++) {
    const entry = resolved.full.buffers[i];
    const src = blobs[i].data;
    out.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), entry.offset);
  }
  return out;
}

/**
 * Decode one IEEE-754 half into a double.
 *
 * @param half The 16 raw bits, as a u16.
 * @returns The value, with subnormals, infinities and NaN all handled.
 */
export function halfToFloat(half: number): number {
  const sign = (half & 0x8000) >> 15;
  const exponent = (half & 0x7c00) >> 10;
  const fraction = half & 0x03ff;
  let value: number;
  if (exponent === 0) value = fraction * 2 ** -24;
  else if (exponent === 0x1f) value = fraction ? NaN : Infinity;
  else value = (fraction / 1024 + 1) * 2 ** (exponent - 15);
  return sign ? -value : value;
}

/**
 * Round a double to the nearest IEEE-754 half, as a u16. Ties to even.
 *
 * @param value The value to quantise.
 * @returns The 16 raw bits. Overflow saturates to a signed infinity and underflow
 *   to a signed zero, rather than wrapping.
 */
export function floatToHalf(value: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exponent = ((x >>> 23) & 0xff) - 127 + 15;
  let fraction = x & 0x7fffff;
  if (((x >>> 23) & 0xff) === 0xff) {
    return sign | 0x7c00 | (fraction ? 0x200 : 0);
  }
  if (exponent >= 0x1f) return sign | 0x7c00; // overflow -> Inf
  if (exponent <= 0) {
    if (exponent < -10) return sign; // underflow -> signed zero
    fraction |= 0x800000;
    const shift = 14 - exponent;
    const rounded = (fraction + (1 << (shift - 1)) + ((fraction >>> shift) & 1) - 1) >>> shift;
    return sign | rounded;
  }
  const rounded = fraction + 0x1000 + ((fraction >>> 13) & 1) - 1;
  if (rounded & 0x800000) {
    exponent += 1;
    fraction = 0;
    if (exponent >= 0x1f) return sign | 0x7c00;
  } else {
    fraction = rounded;
  }
  return sign | (exponent << 10) | (fraction >>> 13);
}

/**
 * Read a blob's typed view, refusing a shape that disagrees with its byte length.
 *
 * @param bytes The whole pack.
 * @param entry The blob's header record.
 * @returns A view of the blob in its declared dtype — `f16` comes back as raw u16
 *   lanes for the caller to widen. Zero-copy when the combined byte offset is
 *   aligned for that dtype, otherwise a copy.
 * @throws {Error} When the shape does not account for `byteLength`, or the blob runs
 *   past the end of the pack.
 */
function viewOf(bytes: Uint8Array, entry: AosRigBuffer): ArrayBufferView {
  const count = entry.shape.reduce((total, d) => total * d, 1);
  const expected = count * BYTES_PER[entry.dtype];
  if (entry.byteLength !== expected) {
    throw new Error(
      `[aosrig] ${entry.name}: byteLength ${String(entry.byteLength)} != shape ${entry.shape.join('x')} ` +
        `of ${entry.dtype} (${String(expected)})`,
    );
  }
  if (entry.offset + entry.byteLength > bytes.length) {
    throw new Error(`[aosrig] ${entry.name} runs past the end of the pack`);
  }
  // Blobs are 8-byte aligned by construction, but `bytes` itself may be a view at
  // an arbitrary offset, so copy when the combined offset is not aligned.
  const base = bytes.byteOffset + entry.offset;
  const aligned = base % BYTES_PER[entry.dtype] === 0;
  const src = aligned
    ? bytes.buffer
    : bytes.slice(entry.offset, entry.offset + entry.byteLength).buffer;
  const off = aligned ? base : 0;
  switch (entry.dtype) {
    case 'f32':
      return new Float32Array(src, off, count);
    case 'u32':
      return new Uint32Array(src, off, count);
    case 'i32':
      return new Int32Array(src, off, count);
    case 'f16':
    case 'u16':
      return new Uint16Array(src, off, count);
    case 'u8':
      return new Uint8Array(src, off, count);
    case 'i8':
      return new Int8Array(src, off, count);
  }
}

/**
 * A lighter pack's blob widened to what the runtime reads (the pack lab's smaller heads): an `f16`
 * blob where an `f32` one is read, a `u16` one where a `u32` one is read. A blob already in the
 * wanted type is returned as it is.
 *
 * @param view The blob as `viewOf` read it.
 * @param entry Its header record.
 * @param want The type the runtime reads.
 * @returns The blob in the wanted type.
 */
function widen(view: ArrayBufferView, entry: AosRigBuffer, want: 'f32' | 'u32'): ArrayBufferView {
  if (want === 'f32' && entry.dtype === 'f16') {
    const halves = view as Uint16Array;
    const out = new Float32Array(halves.length);
    for (let i = 0; i < halves.length; i++) out[i] = halfToFloat(halves[i]);
    return out;
  }
  if (want === 'u32' && (entry.dtype === 'u16' || entry.dtype === 'u8'))
    return Uint32Array.from(view as Uint16Array);
  return view;
}

/**
 * An 8-bit expression table (`basis` stored as `i8`, its dequantisation folded into `basisScale`)
 * as the fp16 pairs the blend shader reads: every value is a whole number from -127 to 127, which
 * fp16 holds exactly.
 *
 * @param q The 8-bit table, (V,E,3) vertex-major.
 * @returns The packed fp16 pairs.
 */
function basisFromI8(q: Int8Array): Uint32Array {
  const halves = new Uint16Array(q.length + (q.length % 2));
  const table = new Uint16Array(256);
  for (let v = -128; v < 128; v++) table[v & 255] = floatToHalf(v);
  for (let i = 0; i < q.length; i++) halves[i] = table[q[i] & 255];
  return new Uint32Array(halves.buffer);
}

/**
 * Parse a `.aosrig` pack.
 *
 * Throws on anything it cannot trust. A GNM head that silently loads half its
 * expression basis renders a face that moves a little and looks nearly right,
 * which is the failure mode with no symptom.
 *
 * @param bytes The downloaded pack, as bytes or a whole buffer.
 * @returns The parsed pack: the header plus typed views over the blobs. Only
 *   `skinWeight` is materialised (widened from its f16 lanes); everything else is a
 *   view into `bytes`. `bindTransform` falls back to the identity when the bake
 *   declared none.
 * @throws {Error} On a bad magic, a length that disagrees with the header, a
 *   version or model this build does not read, a missing required blob, or any
 *   array whose length contradicts V, E, the joint list or `maxInfluence`.
 *
 * @example
 * ```ts
 * import { parseAosRig } from 'gameable/character';
 *
 * const pack = parseAosRig(await (await fetch('/assets/myra.aosrig')).arrayBuffer());
 * console.log(pack.vertexCount, pack.header.headExt.dim); // 17821 387
 * ```
 */
export function parseAosRig(bytes: Uint8Array | ArrayBuffer): AosRigPack {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < HEADER) throw new Error(`[aosrig] pack too short (${String(u8.length)} bytes)`);
  for (let i = 0; i < MAGIC.length; i++) {
    if (u8[i] !== MAGIC.charCodeAt(i)) {
      const got = new TextDecoder()
        .decode(u8.subarray(0, 8))

        .replace(/[^\x20-\x7e]/g, '.');
      throw new Error(`[aosrig] not an .aosrig pack: magic is "${got}", expected "${MAGIC}"`);
    }
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const headerLen = view.getUint32(8, true);
  const totalLen = view.getUint32(12, true);
  if (u8.length !== totalLen) {
    throw new Error(
      `[aosrig] pack is ${String(u8.length)} bytes, header says ${String(totalLen)} — truncated or corrupt download`,
    );
  }
  let header: AosRigHeader;
  try {
    header = JSON.parse(
      new TextDecoder().decode(u8.subarray(HEADER, HEADER + headerLen)),
    ) as AosRigHeader;
  } catch (cause) {
    throw new Error('[aosrig] header is not valid JSON', { cause });
  }
  if (header.version !== 1) {
    throw new Error(`[aosrig] pack version ${String(header.version)}, this build reads 1`);
  }
  // `as string`: the declared type says 'gnm', but this is parsed JSON, so the value is
  // a claim — and a pack from a different model would otherwise be read as this one.
  if ((header.model as string) !== 'gnm') {
    throw new Error(`[aosrig] pack model "${header.model}", expected "gnm"`);
  }
  const bindTransform =
    Array.isArray(header.bindTransform) && header.bindTransform.length === 16
      ? Float32Array.from(header.bindTransform)
      : Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  const byName = new Map(header.buffers.map((b) => [b.name, b]));
  const need = (name: string, want?: 'f32' | 'u32'): ArrayBufferView => {
    const entry = byName.get(name);
    if (!entry) throw new Error(`[aosrig] pack has no "${name}" buffer — the bake is incomplete`);
    const view = viewOf(u8, entry);
    return want ? widen(view, entry, want) : view;
  };
  const optional = (name: string, want?: 'f32' | 'u32'): ArrayBufferView | undefined => {
    const entry = byName.get(name);
    if (!entry) return undefined;
    const view = viewOf(u8, entry);
    return want ? widen(view, entry, want) : view;
  };

  const V = header.vertexCount;
  const E = header.coeffCount;
  const maxInfluence = header.maxInfluence;

  const neutral = need('neutral', 'f32') as Float32Array;
  if (neutral.length !== V * 3) {
    throw new Error(
      `[aosrig] neutral has ${String(neutral.length / 3)} vertices, header says ${String(V)}`,
    );
  }
  const basisRaw = need('basis');
  const basis = basisRaw instanceof Int8Array ? basisFromI8(basisRaw) : (basisRaw as Uint32Array);
  const expectedLanes = V * E * 3;
  if (basis.length !== Math.ceil(expectedLanes / 2)) {
    throw new Error(
      `[aosrig] basis holds ${String(basis.length * 2)} fp16 lanes, (V=${String(V)}, E=${String(E)}) needs ${String(expectedLanes)}`,
    );
  }
  const basisScale = need('basisScale') as Float32Array;
  if (basisScale.length !== E) {
    throw new Error(
      `[aosrig] basisScale has ${String(basisScale.length)} entries, header says ${String(E)}`,
    );
  }

  const skinIndex = need('skinIndex') as Uint16Array;
  const skinWeightHalf = need('skinWeight') as Uint16Array;
  if (skinIndex.length !== V * maxInfluence || skinWeightHalf.length !== V * maxInfluence) {
    throw new Error(
      `[aosrig] skin arrays are ${String(skinIndex.length)}/${String(skinWeightHalf.length)}, expected ${String(V * maxInfluence)}`,
    );
  }
  const skinWeight = new Float32Array(skinWeightHalf.length);
  for (let i = 0; i < skinWeightHalf.length; i++) skinWeight[i] = halfToFloat(skinWeightHalf[i]);

  const restWorld = need('restWorld') as Float32Array;
  const jointParents = need('jointParents') as Int32Array;
  if (
    restWorld.length !== header.joints.length * 16 ||
    jointParents.length !== header.joints.length
  ) {
    throw new Error(
      `[aosrig] joint arrays disagree with the ${String(header.joints.length)}-joint header`,
    );
  }

  return {
    header,
    vertexCount: V,
    coeffCount: E,
    maxInfluence,
    neutral,
    basis,
    basisScale,
    skinIndex,
    skinWeight,
    eyePositions: need('eyePositions', 'f32') as Float32Array,
    eyeWeights: need('eyeWeights', 'f32') as Float32Array,
    restWorld,
    jointParents,
    bindTransform,
    faces: need('faces', 'u32') as Uint32Array,
    quads: optional('quads', 'u32') as Uint32Array | undefined,
    uv: optional('uv', 'f32') as Float32Array | undefined,
    stitchLocal: optional('stitchLocal', 'f32') as Float32Array | undefined,
    mouth:
      header.mouth === undefined
        ? undefined
        : parseMouth(header.mouth, (name) => need(name, 'u32'), V),
    byteLength: u8.length,
  };
}

/**
 * The header's `mouth` entry and its blobs, range-checked against the pack.
 *
 * @param entry The header entry (parsed JSON, so every field is a claim).
 * @param need Reads a named blob, throwing when it is absent.
 * @param V The pack's vertex count.
 * @returns The mouth's parts, triangles and each triangle's part.
 * @throws {Error} When a named blob is missing, the wrong type or names a vertex or
 *   part the pack does not have.
 */
function parseMouth(
  entry: AosRigMouthEntry,
  need: (name: string) => ArrayBufferView,
  V: number,
): AosRigMouth {
  const bad = (what: string): never => {
    throw new Error(`[aosrig] mouth: ${what}`);
  };
  if (!Array.isArray(entry.groups) || entry.groups.length < 1 || entry.groups.length > 16)
    bad('expected 1 to 16 groups');
  const u32 = (name: unknown): Uint32Array => {
    if (typeof name !== 'string') return bad('a blob name is not a string');
    const view = need(name);
    return view instanceof Uint32Array ? view : bad(`"${name}" is not u32`);
  };
  const groups = entry.groups.map((g): AosRigMouthGroup => {
    const vertices = u32(g.vertices);
    for (const v of vertices) if (v >= V) bad(`"${g.vertices}" names vertex ${String(v)}`);
    const c = g.look?.color;
    const color: [number, number, number] =
      Array.isArray(c) && c.length === 3 && c.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)
        ? [c[0], c[1], c[2]]
        : [0.5, 0.5, 0.5];
    const gloss = g.look?.gloss;
    return {
      name: typeof g.name === 'string' ? g.name : '',
      vertices,
      color,
      gloss: typeof gloss === 'number' && gloss >= 0 && gloss <= 1 ? gloss : 0.5,
    };
  });
  const faces = u32(entry.faces);
  const faceParts = u32(entry.faceParts);
  if (faces.length % 3 !== 0 || faceParts.length * 3 !== faces.length)
    bad('faces and faceParts disagree');
  for (const v of faces) if (v >= V) bad(`a face names vertex ${String(v)}`);
  for (const p of faceParts) if (p < 1 || p > groups.length) bad(`a face names part ${String(p)}`);
  return { groups, faces, faceParts };
}

/**
 * `head_ext` -> the two halves the model consumes.
 *
 * The split is a slice, not a parse, and it is the one place the 383/4 boundary is
 * written down on this side. Gaze is `[pitch_L, yaw_L, pitch_R, yaw_R]` in radians,
 * head-local: pitch > 0 looks DOWN (about +X), yaw > 0 looks toward character-LEFT
 * (about +Y). Neck and head rotation are NOT here — they live in the body joints
 * `neck_01` / `neck_02` / `head`.
 *
 * @param headExt One frame's rig vector, at least `layout.dim` long. A longer one is
 *   accepted and its tail ignored.
 * @param layout The pack's `header.headExt`, which owns the 383/4 boundary.
 * @param out Optional destination buffers, reused across frames so the per-frame
 *   caller (`GnmRigBackend.encode`) allocates nothing. Either buffer that is too
 *   short is replaced by a fresh one of the right width.
 * @param out.expr Destination for the `exprDim` expression coefficients.
 * @param out.gaze Destination for the `gazeDim` gaze angles.
 * @returns The `exprDim` expression coefficients and the `gazeDim` gaze angles —
 *   `out`'s buffers when they were supplied and wide enough, else fresh arrays.
 * @throws {Error} When `headExt` is shorter than the layout declares.
 *
 * @example
 * ```ts
 * import { parseAosRig, unpackHeadExt } from 'gameable/character';
 *
 * const pack = parseAosRig(bytes);
 * const { expr, gaze } = unpackHeadExt(new Float32Array(pack.header.headExt.dim), pack.header.headExt);
 * console.log(expr.length, gaze.length);
 * ```
 */
export function unpackHeadExt(
  headExt: ArrayLike<number>,
  layout: HeadExtLayout,
  out?: { expr: Float32Array; gaze: Float32Array },
): { expr: Float32Array; gaze: Float32Array } {
  if (headExt.length < layout.dim) {
    throw new Error(
      `[aosrig] head_ext is ${String(headExt.length)} floats, the layout declares ${String(layout.dim)}`,
    );
  }
  const expr =
    out && out.expr.length >= layout.exprDim ? out.expr : new Float32Array(layout.exprDim);
  for (let i = 0; i < layout.exprDim; i++) expr[i] = headExt[i];
  const gaze =
    out && out.gaze.length >= layout.gazeDim ? out.gaze : new Float32Array(layout.gazeDim);
  for (let i = 0; i < layout.gazeDim; i++) gaze[i] = headExt[layout.exprDim + i];
  return { expr, gaze };
}

/**
 * Where each expression region sits inside `head_ext`.
 *
 * @param layout The pack's `header.headExt`.
 * @returns A `{ start, end }` half-open COEFFICIENT range per region name, tiled in
 *   declaration order from 0. Gaze sits past the last region and is not included.
 */
export function regionSlices(
  layout: HeadExtLayout,
): Record<string, { start: number; end: number }> {
  const out: Record<string, { start: number; end: number }> = {};
  let i = 0;
  for (const [name, n] of layout.regions) {
    out[name] = { start: i, end: i + n };
    i += n;
  }
  return out;
}

/**
 * Every control name the layout declares, in order — the manifest's `control_names`.
 *
 * @param layout The pack's `header.headExt`.
 * @returns `layout.dim` names: `<region>_000`-style per-coefficient names, then the
 *   four gaze angles.
 */
export function headExtNames(layout: HeadExtLayout): string[] {
  const names: string[] = [];
  for (const [region, n] of layout.regions) {
    for (let k = 0; k < n; k++) names.push(`${region}_${String(k).padStart(3, '0')}`);
  }
  return names.concat(['gaze_pitch_l', 'gaze_yaw_l', 'gaze_pitch_r', 'gaze_yaw_r']);
}
