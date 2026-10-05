// Static asset loader for mesh.bin / mesh.json produced by the exporter
// (web/export/export_static_assets.py).
//
// The fetch half is injectable: the engine resolves bundle files through an
// AssetResolver, so nothing here reaches for a global `fetch` or a URL layout.
//
// Ported from aos-threejs-poc/src/ogs/assets/loader.ts @ cdd63b10

export type DType = 'f32' | 'i32' | 'u32' | 'u8';

export interface BufferEntry {
  name: string;
  dtype: DType;
  shape: number[];
  offset: number;
  byte_length: number;
}

export interface MeshManifest {
  uv_res: number;
  num_vertices: number;
  num_faces: number;
  buffers: BufferEntry[];
}

export interface MeshAssets {
  manifest: MeshManifest;
  faces: Uint32Array; // (F, 3)
  idxim: Int32Array; // (H, W, 3)
  barim: Float32Array; // (H, W, 3)
  triim: Int32Array; // (H, W)
  valid: Uint8Array; // (H, W)
  neutralVertices: Float32Array; // (V, 3)
  frameVertices?: Float32Array; // (F, V, 3) — flat, 48 frames * V * 3
  numFrames?: number;
}

/**
 * Bytes the manifest expects the blob to hold.
 * Exported for the test — the arithmetic is the whole check.
 *
 * @param manifest The branch's parsed `mesh.json`, whose entries declare an offset
 * and a byte length each.
 * @returns The highest `offset + byte_length` over every entry, which is the
 * smallest blob the manifest can be satisfied from. Entries need not be contiguous
 * or ordered.
 */
export function requiredBlobBytes(manifest: MeshManifest): number {
  let needed = 0;
  for (const b of manifest.buffers) {
    needed = Math.max(needed, b.offset + b.byte_length);
  }
  return needed;
}

/**
 * Fail on a SHORT blob before building any view over it.
 *
 * Without this, a truncated download surfaces from
 * `new Float32Array(blob, offset, len)` as
 * `RangeError: Invalid typed array length: 1769472` — a bare number with no
 * file name, no byte count, and nothing to suggest the bytes simply arrived
 * incomplete. It reads like a code bug and gets debugged like one.
 *
 * Naming the fix matters as much as naming the cause: these blobs are served
 * cache-first (aamAssetCache), so a truncated copy KEEPS being served and a
 * plain reload changes nothing.
 *
 * @param blob The downloaded `mesh.bin` bytes.
 * @param manifest The matching `mesh.json`, which says how many bytes are needed.
 * @param meshBin The blob's filename, used only to name it in the error.
 */
export function assertBlobComplete(
  blob: ArrayBuffer,
  manifest: MeshManifest,
  meshBin: string,
): void {
  const needed = requiredBlobBytes(manifest);
  if (blob.byteLength >= needed) return;
  throw new Error(
    `${meshBin} arrived incomplete: got ${String(blob.byteLength)} bytes, manifest needs ${String(needed)} ` +
      `(short by ${String(needed - blob.byteLength)}). Bundle files are cached, so reloading may ` +
      `keep failing — clear the asset cache first. If it survives a clear, the download ` +
      `itself is being truncated in transport.`,
  );
}

/**
 * One manifest entry as a typed-array view over the shared blob.
 *
 * @param blob The whole `mesh.bin`, already checked for length.
 * @param e The manifest entry to map, or undefined when the export omitted it.
 * @param meshBin The blob's filename, for the error message.
 * @param name The buffer's expected name, for the error message.
 * @returns A view — not a copy — over the blob at the entry's offset, with the
 * element type its `dtype` names.
 */
function view(blob: ArrayBuffer, e: BufferEntry | undefined, meshBin: string, name: string) {
  // A manifest missing an entry would otherwise throw on `e.dtype` — equally
  // cryptic, and a different failure (bad export) needing a different fix.
  if (!e)
    throw new Error(`${meshBin}: manifest has no "${name}" buffer — the export is incomplete`);
  switch (e.dtype) {
    case 'f32':
      return new Float32Array(blob, e.offset, e.byte_length / 4);
    case 'i32':
      return new Int32Array(blob, e.offset, e.byte_length / 4);
    case 'u32':
      return new Uint32Array(blob, e.offset, e.byte_length / 4);
    case 'u8':
      return new Uint8Array(blob, e.offset, e.byte_length);
  }
}

/** Bytes for one bundle file, by name. Supplied by `loadCharacterBundle`. */
export interface MeshSource {
  json: (name: string) => Promise<unknown>;
  bytes: (name: string) => Promise<ArrayBuffer>;
}

/**
 * Load one branch's static mesh from arbitrary filenames (`mesh_<b>.json`/`.bin`
 * for multi-region; `mesh.json`/`.bin` for single-region).
 *
 * `mesh_<b>.bin` carries no `frame_vertices` in the multi-region export (baked
 * verts ship separately, or not at all — the live rig drives), so `frameVertices`
 * is typically undefined here.
 *
 * @param source Byte and JSON accessors over the bundle, from `loadCharacterBundle`.
 * @param meshJson Name of the manifest file to parse.
 * @param meshBin Name of the blob the manifest's offsets index into.
 * @returns The manifest plus one view per buffer — the UV-space `idxim`, `barim`,
 * `triim` and `valid` maps the lift samples, the `faces` topology, and the branch's
 * `neutralVertices` in the trained frame. All share the one blob.
 */
export async function loadBranchMesh(
  source: MeshSource,
  meshJson: string,
  meshBin: string,
): Promise<MeshAssets> {
  const [manifest, blob] = await Promise.all([
    source.json(meshJson) as Promise<MeshManifest>,
    source.bytes(meshBin),
  ]);
  assertBlobComplete(blob, manifest, meshBin);
  // A Map, not an index signature: TS types `record[key]` as present, so `view`'s
  // "the export is incomplete" branch would read as dead code — and it is the branch
  // that turns a bad export into a message naming the missing buffer.
  const byName = new Map(manifest.buffers.map((b) => [b.name, b]));
  const frames = byName.get('frame_vertices');
  return {
    manifest,
    faces: view(blob, byName.get('faces'), meshBin, 'faces') as Uint32Array,
    idxim: view(blob, byName.get('idxim'), meshBin, 'idxim') as Int32Array,
    barim: view(blob, byName.get('barim'), meshBin, 'barim') as Float32Array,
    triim: view(blob, byName.get('triim'), meshBin, 'triim') as Int32Array,
    valid: view(blob, byName.get('valid'), meshBin, 'valid') as Uint8Array,
    neutralVertices: view(
      blob,
      byName.get('neutral_vertices'),
      meshBin,
      'neutral_vertices',
    ) as Float32Array,
    frameVertices: frames
      ? (view(blob, frames, meshBin, 'frame_vertices') as Float32Array)
      : undefined,
    numFrames: frames?.shape[0],
  };
}
