// `loadCharacterBundle` over an in-memory resolver.
//
// The resolver is the whole seam: nothing below it knows about URLs, so a bundle can
// come from a CDN, from the asset manager, or — here — from a `Map`. That is also what
// makes the two bundle LAYOUTS testable without a server: the multi-region path, and
// the schema_version 1 path where there is no `scene.json` at all and
// `singleRegionScene()` adapts a flat export into a one-branch fused scene.
//
// What is NOT tested here: anything that needs ONNX or a GPU. `createCharacter` builds
// decoder sessions and compute pipelines on the first line, so it belongs in the e2e
// suite; everything up to it is here.

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three/webgpu';

import { loadCharacterBundle } from './bundle/loadCharacterBundle.js';
import { createFakeSplatSink } from './splatSink.js';
import type { AssetResolver } from './assets/urlBundleBytes.js';

const encoder = new TextEncoder();

/**
 * A `.npy` header + body for a 1-row f32 array — the shape a rig-params file has.
 *
 * @param row The single row's values; its length becomes the array's column count.
 * @returns The complete little-endian v1 `.npy` file, magic and padded header
 * included, ready to hand to the loader as bundle bytes.
 */
function npy(row: number[]): Uint8Array {
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (1, ${String(row.length)}), }`;
  const padded = header.padEnd(Math.ceil((10 + header.length + 1) / 64) * 64 - 10 - 1, ' ') + '\n';
  const out = new Uint8Array(10 + padded.length + row.length * 4);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  new DataView(out.buffer).setUint16(8, padded.length, true);
  out.set(encoder.encode(padded), 10);
  const values = new DataView(out.buffer, 10 + padded.length);
  row.forEach((v, i) => {
    values.setFloat32(i * 4, v, true);
  });
  return out;
}

/**
 * A `mesh.bin` + `mesh.json` pair for a tiny branch.
 *
 * The loader's whole job here is to build views over one blob at the offsets the
 * manifest declares, and to refuse a blob that is SHORT — a truncated download must
 * not surface as `RangeError: Invalid typed array length`, which reads like a code bug
 * and gets debugged like one.
 *
 * @param uvRes Side length of the square UV maps, so `idxim`, `barim`, `triim` and
 * `valid` are `uvRes * uvRes` texels.
 * @param vertices Vertex count, sizing `neutral_vertices` at three floats each.
 * @param faces Triangle count, sizing `faces` at three vertex indices each.
 * @returns The encoded `mesh.json`, a correctly sized all-zero `mesh.bin`, and that
 * blob's length so a test can hand the loader a deliberately short one.
 */
function meshFiles(uvRes: number, vertices: number, faces: number) {
  const hw = uvRes * uvRes;
  const entries = [
    { name: 'faces', dtype: 'u32', shape: [faces, 3], bytes: faces * 3 * 4 },
    { name: 'idxim', dtype: 'i32', shape: [uvRes, uvRes, 3], bytes: hw * 3 * 4 },
    { name: 'barim', dtype: 'f32', shape: [uvRes, uvRes, 3], bytes: hw * 3 * 4 },
    { name: 'triim', dtype: 'i32', shape: [uvRes, uvRes], bytes: hw * 4 },
    { name: 'valid', dtype: 'u8', shape: [uvRes, uvRes], bytes: hw },
    { name: 'neutral_vertices', dtype: 'f32', shape: [vertices, 3], bytes: vertices * 3 * 4 },
  ];
  let offset = 0;
  const buffers = entries.map((e) => {
    const entry = { name: e.name, dtype: e.dtype, shape: e.shape, offset, byte_length: e.bytes };
    offset += e.bytes;
    return entry;
  });
  return {
    json: encoder.encode(
      JSON.stringify({ uv_res: uvRes, num_vertices: vertices, num_faces: faces, buffers }),
    ),
    bin: new Uint8Array(offset),
    totalBytes: offset,
  };
}

/**
 * A resolver over a plain map, and the names it was asked for.
 *
 * @param files The in-memory bundle, keyed by the name the loader will ask for.
 * @returns A resolver that rejects on a missing name, with an `asked` array
 * recording every request in order so a test can assert what was fetched.
 */
function mapResolver(files: Map<string, Uint8Array>): AssetResolver & { asked: string[] } {
  const asked: string[] = [];
  const resolver = ((name: string) => {
    asked.push(name);
    const bytes = files.get(name);
    if (!bytes) return Promise.reject(new Error(`not in this bundle: ${name}`));
    return Promise.resolve(bytes);
  }) as AssetResolver & { asked: string[] };
  resolver.asked = asked;
  return resolver;
}

const HEAD_MESH = meshFiles(4, 6, 2);

function multiRegionFiles(extra: Record<string, Uint8Array> = {}): Map<string, Uint8Array> {
  const scene = {
    schema_version: '2',
    subject: 'test',
    mode: 'multi_region',
    num_poses: 1,
    world_scale: 0.01,
    world_offset: [0, 1.55, 0],
    branches: {
      head: {
        geom: 'geom_head.onnx',
        appr: 'appr_head.onnx',
        trunk: 'trunk_head.onnx',
        mesh_json: 'mesh_head.json',
        mesh_bin: 'mesh_head.bin',
        uv_res: 4,
        rig_dim: 3,
        rig_presets: 'rig_params_head.npy',
      },
    },
  };
  return new Map<string, Uint8Array>([
    ['scene.json', encoder.encode(JSON.stringify(scene))],
    ['mesh_head.json', HEAD_MESH.json],
    ['mesh_head.bin', HEAD_MESH.bin],
    ['trunk_head.onnx', new Uint8Array(8)],
    ['geom_head.onnx', new Uint8Array(16)],
    ['appr_head.onnx', new Uint8Array(32)],
    ['rig_params_head.npy', npy([0.25, 0.5, 0.75])],
    ...Object.entries(extra),
  ]);
}

describe('loadCharacterBundle: the multi_region layout', () => {
  it('loads the manifest, the mesh and every eager file', async () => {
    const resolver = mapResolver(multiRegionFiles());
    const bundle = await loadCharacterBundle('mem://test', { resolver });

    expect(bundle.manifest.scene.subject).toBe('test');
    expect(bundle.manifest.scene.worldScale).toBe(0.01);
    expect(bundle.manifest.scene.worldOffset).toEqual([0, 1.55, 0]);
    expect(bundle.scene.branches.map((b) => b.name)).toEqual(['head']);
    expect(bundle.scene.branches[0].mesh.manifest.num_vertices).toBe(6);
    expect(bundle.bytes.getBytes('geom_head.onnx')?.byteLength).toBe(16);
    expect(bundle.byteLength).toBeGreaterThan(0);
  });

  it("reads the branch's REFERENCE rig, which is not a zero vector", async () => {
    // Row 0 of the rig params is the pose `neutral_vertices` was exported at, and
    // therefore the only rig that decodes a neutral. An all-zero vector is not one: a
    // control space declaring `rig_range [0,1]` rests nowhere near zero, and the code
    // latent then comes out far wider than the decoder ever saw.
    const resolver = mapResolver(multiRegionFiles());
    const bundle = await loadCharacterBundle('mem://test', { resolver });
    const reference = bundle.scene.branches[0].referenceRig;
    expect(reference).not.toBeNull();
    expect([...reference!]).toEqual([0.25, 0.5, 0.75]);
  });

  it('falls back to a zero rig LOUDLY when the reference is unreadable', async () => {
    const files = multiRegionFiles();
    files.set('rig_params_head.npy', encoder.encode('not an npy'));
    const bundle = await loadCharacterBundle('mem://test', { resolver: mapResolver(files) });
    expect(bundle.scene.branches[0].referenceRig).toBeNull();
  });

  it('defaults to the ORL backend when the bundle ships a pack', async () => {
    const withPack = multiRegionFiles({ 'orl_pack.bin': new Uint8Array(64) });
    const bundle = await loadCharacterBundle('mem://test', { resolver: mapResolver(withPack) });
    expect(bundle.manifest.rig.backend).toBe('orl');
    expect(bundle.manifest.rig.pack).toBe('orl_pack.bin');
    expect(bundle.bytes.getBytes('orl_pack.bin')).toBeDefined();
  });

  it('reports `none` — not a crash — for a bundle with no rig at all', async () => {
    const bundle = await loadCharacterBundle('mem://test', {
      resolver: mapResolver(multiRegionFiles()),
    });
    expect(bundle.manifest.rig.backend).toBe('none');
    expect(bundle.manifest.expressionSpace.kind).toBe('arkit52');
  });

  it('picks up an fp16 sibling when the bundle ships one, and not otherwise', async () => {
    const plain = await loadCharacterBundle('mem://test', {
      resolver: mapResolver(multiRegionFiles()),
    });
    expect(plain.preferFp16).toBe(false);

    const withFp16 = await loadCharacterBundle('mem://test', {
      resolver: mapResolver(multiRegionFiles({ 'geom_head_fp16.onnx': new Uint8Array(8) })),
    });
    expect(withFp16.preferFp16).toBe(true);
    expect(withFp16.bytes.getBytes('geom_head_fp16.onnx')).toBeDefined();
  });

  it('refuses a SHORT mesh blob by name, not by RangeError', async () => {
    // These blobs are served cache-first, so a truncated copy KEEPS being served and a
    // plain reload changes nothing — which is why the message has to name the fix.
    const files = multiRegionFiles();
    files.set('mesh_head.bin', HEAD_MESH.bin.subarray(0, HEAD_MESH.totalBytes - 8));
    await expect(
      loadCharacterBundle('mem://test', { resolver: mapResolver(files) }),
    ).rejects.toThrow(/arrived incomplete/);
  });

  it('refuses a mesh manifest missing a buffer', async () => {
    const files = multiRegionFiles();
    const manifest = JSON.parse(new TextDecoder().decode(HEAD_MESH.json)) as {
      buffers: { name: string }[];
    };
    manifest.buffers = manifest.buffers.filter((b) => b.name !== 'barim');
    files.set('mesh_head.json', encoder.encode(JSON.stringify(manifest)));
    await expect(
      loadCharacterBundle('mem://test', { resolver: mapResolver(files) }),
    ).rejects.toThrow(/has no "barim" buffer/);
  });
});

describe('loadCharacterBundle: the schema_version 1 layout', () => {
  const single = (extra: Record<string, Uint8Array> = {}) =>
    new Map<string, Uint8Array>([
      ['mesh.json', HEAD_MESH.json],
      ['mesh.bin', HEAD_MESH.bin],
      ['geom.onnx', new Uint8Array(16)],
      ['appr.onnx', new Uint8Array(32)],
      ['rig_names.json', encoder.encode(JSON.stringify(['a', 'b', 'c']))],
      ['export_manifest.json', encoder.encode(JSON.stringify({ subject: 'flat' }))],
      ...Object.entries(extra),
    ]);

  it('adapts a flat bundle into a one-branch FUSED scene', async () => {
    const bundle = await loadCharacterBundle('mem://flat', { resolver: mapResolver(single()) });
    expect(bundle.manifest.scene.subject).toBe('flat');
    expect(bundle.manifest.scene.branches.head.fused).toBe(true);
    expect(bundle.manifest.scene.branches.head.trunk).toBeUndefined();
    expect(bundle.manifest.scene.branches.head.rigDim).toBe(3);
    // A fused geom takes `rig_params` straight in and animates with no rig -> verts
    // step, so `none` here is its normal, healthy state — never a missing asset.
    expect(bundle.manifest.rig.backend).toBe('none');
    expect(bundle.manifest.rigNames).toEqual(['a', 'b', 'c']);
  });

  it('REQUIRES rig_names.json, because nothing else states the control width', async () => {
    const files = single();
    files.delete('rig_names.json');
    await expect(
      loadCharacterBundle('mem://flat', { resolver: mapResolver(files) }),
    ).rejects.toThrow(/no other statement of its control-space width/);
  });
});

describe('the fake splat sink', () => {
  it('allocates the slot ranges a character would, and refuses an oversubscription', () => {
    // 4² per branch here; a real head is 750² = 562,500 slots, which is why the sink's
    // capacity is checked BEFORE a single ONNX session is created.
    const sink = createFakeSplatSink(32, new Object3D());
    const a = sink.allocate(16);
    const b = sink.allocate(16);
    expect(a).toEqual({ offset: 0, count: 16 });
    expect(b).toEqual({ offset: 16, count: 16 });
    expect(sink.live).toHaveLength(2);
    expect(() => sink.allocate(1)).toThrow(/no contiguous run/);

    sink.free(a);
    expect(sink.live).toHaveLength(1);
    expect(sink.allocate(16)).toEqual({ offset: 0, count: 16 });
  });

  it('records the re-sort request and the owner-supplied bounds', () => {
    // The sink never recomputes bounds from the GPU — reading a million centres back
    // every frame would cost more than the render — so the owner supplies them.
    const sink = createFakeSplatSink(32, new Object3D());
    expect(sink.sortRequests).toBe(0);
    sink.markGaussiansChanged();
    sink.markGaussiansChanged();
    expect(sink.sortRequests).toBe(2);
    expect(sink.bounds).toBeNull();
    sink.setBoundingSphere([0, 1.6, 0], 0.4);
    expect(sink.bounds).toEqual({ center: [0, 1.6, 0], radius: 0.4 });
  });

  it('exposes the four buffers the lift binds', () => {
    const sink = createFakeSplatSink(8, new Object3D());
    expect(Object.keys(sink.buffers).sort()).toEqual([
      'center',
      'color',
      'covarianceA',
      'covarianceB',
    ]);
  });
});
