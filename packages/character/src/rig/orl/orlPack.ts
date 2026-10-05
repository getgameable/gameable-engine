// ONE file for a baked ORL head rig.
//
// The bake produces 12 separate members — DNA, neutral mesh, skin weights,
// blendshape deltas, two JSONs. Shipping them as 12 assets cost 12 requests per
// head, fetched serially, so a cold head paid ~12 round trips before the first
// frame. They are also all-or-nothing: half a rig deforms into nonsense, which is
// why presence had to be checked for all 12 names and a partial upload treated as
// absent. One container makes that atomicity structural rather than a check — a
// pack either parses or it does not.
//
// Layout (little-endian, offsets absolute from the start of the pack):
//
//   0   "ORLPACK1"                      8 bytes, magic + format version
//   8   u32 tocLen                      byte length of the TOC JSON
//   12  u32 totalLen                    byte length of the whole pack
//   16  TOC JSON (utf8)                 [{ n: name, o: offset, l: length }, …]
//       zero padding                    to the next 8-byte boundary
//   …   member blobs                    each zero-padded to an 8-byte boundary
//
// totalLen is not redundant with the member bounds: the last member is padded to
// an 8-byte boundary, so a download cut short by less than that padding still
// passes a per-member bounds check. Without the total, a truncated transfer could
// parse as a valid rig.
//
// Members are stored in the caller's given order and the TOC is written with a
// fixed key order, so packing the same bake twice is BYTE-IDENTICAL. That is
// load-bearing: the re-bake check is only meaningful if packing itself contributes
// no variance.
//
// 8-byte alignment costs at most 7 bytes per member and lets a reader hand a member
// straight to a Float32Array/Float64Array view without copying.
//
// Ported from aos-threejs-poc/src/lib/orl/orlPack.js @ cdd63b10

const MAGIC = 'ORLPACK1';
const HEADER = 16; // magic(8) + u32 tocLen + u32 totalLen
const ALIGN = 8;

const align = (n: number): number => (n + (ALIGN - 1)) & ~(ALIGN - 1);

/** One member on the way into a pack. */
export interface OrlPackMember {
  name: string;
  bytes: Uint8Array;
}

interface TocEntry {
  n: string;
  o: number;
  l: number;
}

/** A parsed pack. `get` hands back a VIEW into the input bytes, never a copy. */
export interface OrlPack {
  names: string[];
  has: (name: string) => boolean;
  get: (name: string) => Uint8Array | undefined;
  json: (name: string) => unknown;
}

/**
 * Build a pack from `[{ name, bytes }]`, in the given order.
 *
 * @param members The bake's members. Names must be unique and non-empty, and the
 *   given order is the order they are laid out in — that is what makes packing the
 *   same bake twice byte-identical.
 * @returns The whole container: header, TOC JSON, then the 8-byte-aligned blobs.
 */
export function packOrlBundle(members: OrlPackMember[]): Uint8Array {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error('[orl] packOrlBundle: no members');
  }
  const seen = new Set<string>();
  for (const m of members) {
    if (typeof m.name !== 'string' || !m.name) {
      throw new Error('[orl] packOrlBundle: member without a name');
    }
    if (seen.has(m.name)) throw new Error(`[orl] packOrlBundle: duplicate member "${m.name}"`);
    seen.add(m.name);
    if (!(m.bytes instanceof Uint8Array)) {
      throw new Error(`[orl] packOrlBundle: "${m.name}" is not a Uint8Array`);
    }
  }

  // Two passes: the TOC records absolute offsets, so its own length has to be
  // known first. Its length depends only on the names and the digits of the
  // offsets, so lay the blobs out against a provisional TOC and re-encode — the
  // second encoding can only be the same size or larger, so pad to fit.
  const encode = (entries: TocEntry[]) => new TextEncoder().encode(JSON.stringify(entries));
  let tocLen = encode(members.map((m) => ({ n: m.name, o: 0, l: m.bytes.length }))).length;
  let entries: TocEntry[] = [];
  let body = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    let off = align(HEADER + tocLen);
    entries = members.map((m) => {
      const e: TocEntry = { n: m.name, o: off, l: m.bytes.length };
      off = align(off + m.bytes.length);
      return e;
    });
    body = off;
    const enc = encode(entries);
    if (enc.length <= tocLen) break;
    tocLen = enc.length;
  }

  const out = new Uint8Array(body);
  const view = new DataView(out.buffer);
  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
  view.setUint32(8, tocLen, true);
  view.setUint32(12, body, true);
  const toc = encode(entries);
  if (toc.length > tocLen) throw new Error('[orl] packOrlBundle: TOC did not converge');
  out.set(toc, HEADER);
  for (let i = 0; i < members.length; i++) out.set(members[i].bytes, entries[i].o);
  return out;
}

/**
 * Parse a pack.
 *
 * Throws on anything it cannot trust — a truncated download or an HTML error page
 * must not read as an empty-but-valid rig, which would render a head that simply
 * never moves.
 *
 * @param bytes The downloaded pack, as bytes or a whole buffer.
 * @returns The member names in TOC order, plus `has`/`get`/`json` accessors whose
 *   `get` returns a subarray view into `bytes` rather than a copy.
 */
export function parseOrlPack(bytes: Uint8Array | ArrayBuffer): OrlPack {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < HEADER) throw new Error(`[orl] pack too short (${String(u8.length)} bytes)`);
  for (let i = 0; i < MAGIC.length; i++) {
    if (u8[i] !== MAGIC.charCodeAt(i)) {
      const got = new TextDecoder()
        .decode(u8.subarray(0, 8))

        .replace(/[^\x20-\x7e]/g, '.');
      throw new Error(`[orl] not an ORL pack: magic is "${got}", expected "${MAGIC}"`);
    }
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tocLen = view.getUint32(8, true);
  const totalLen = view.getUint32(12, true);
  // Checked BEFORE the members: trailing padding on the last member means a small
  // truncation would otherwise pass every per-member bounds check.
  if (u8.length !== totalLen) {
    throw new Error(
      `[orl] pack is ${String(u8.length)} bytes, header says ${String(totalLen)} — truncated or corrupt download`,
    );
  }
  if (HEADER + tocLen > u8.length) {
    throw new Error(`[orl] pack TOC overruns the file (${String(tocLen)} bytes)`);
  }

  let entries: unknown;
  try {
    entries = JSON.parse(new TextDecoder().decode(u8.subarray(HEADER, HEADER + tocLen)));
  } catch (cause) {
    throw new Error('[orl] pack TOC is not valid JSON', { cause });
  }
  if (!Array.isArray(entries)) throw new Error('[orl] pack TOC is not an array');

  const byName = new Map<string, Uint8Array>();
  const names: string[] = [];
  for (const raw of entries as (Partial<TocEntry> | null)[]) {
    const e = raw;
    if (!e || typeof e.n !== 'string' || !Number.isInteger(e.o) || !Number.isInteger(e.l)) {
      throw new Error('[orl] pack TOC has a malformed entry');
    }
    const offset = e.o as number;
    const len = e.l as number;
    if (offset < 0 || len < 0 || offset + len > u8.length) {
      throw new Error(
        `[orl] pack member "${e.n}" runs past the end (${String(offset)}+${String(len)} > ${String(u8.length)}) — truncated download?`,
      );
    }
    names.push(e.n);
    byName.set(e.n, u8.subarray(offset, offset + len));
  }

  const get = (name: string) => byName.get(name);
  return {
    names,
    has: (name: string) => byName.has(name),
    get,
    json: (name: string) => {
      const b = get(name);
      if (!b) throw new Error(`[orl] pack has no member "${name}"`);
      return JSON.parse(new TextDecoder().decode(b)) as unknown;
    },
  };
}
