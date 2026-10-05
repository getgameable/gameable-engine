/**
 * The contract with the Python exporter.
 *
 * `assets/aosrig_v0.glb` is produced by `soma.translators.aosrig_v0` on the
 * soma-x `aosrig_v0` branch, not by anything in this repository, so the only
 * thing keeping the two halves honest is this file. It reads the committed
 * bytes and asserts the container, the joint namespace and the four clips the
 * host's locomotion index is built from.
 *
 * Nothing here needs three or a GPU: a GLB is a 12-byte header and a JSON
 * chunk, and every assertion below is about that JSON.
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AOSRIG_CLIPS,
  AOSRIG_CLIP_SPEEDS,
  AOSRIG_GLB_FILE,
  AOSRIG_HEAD_AIM_JOINTS,
  AOSRIG_HEAD_JOINT,
  AOSRIG_JOINTS,
  AOSRIG_ROOT_JOINT,
  AOSRIG_ASSETS_BASE,
} from './index.js';

/** The rig is 3.1 MB today; the budget is the point at which to worry. */
const SIZE_BUDGET = 4 * 1024 * 1024;

/** `glTF` as a little-endian u32, the first four bytes of every GLB. */
const GLB_MAGIC = 0x46546c67;

/** Chunk type `JSON`, as a little-endian u32. */
const CHUNK_JSON = 0x4e4f534a;

/** Chunk type `BIN\0`, as a little-endian u32. */
const CHUNK_BIN = 0x004e4942;

/** How a Git LFS pointer file starts when the bytes were never fetched. */
const LFS_PREFIX = 'version https://git-lfs';

/** Absolute path of the committed rig. */
const GLB_PATH = fileURLToPath(new URL(`../assets/${AOSRIG_GLB_FILE}`, import.meta.url));

/** Only the bits of the glTF document this test looks at. */
interface GltfDocument {
  asset?: { version?: string };
  scenes?: { extras?: { aosrig?: Record<string, unknown> } }[];
  nodes?: { name?: string }[];
  skins?: { joints?: number[]; skeleton?: number; inverseBindMatrices?: number }[];
  meshes?: { primitives?: { attributes?: Record<string, number> }[] }[];
  animations?: {
    name?: string;
    channels?: unknown[];
    samplers?: unknown[];
    extras?: { aos?: { speed?: number; loop?: boolean; locomotion?: boolean } };
  }[];
}

/** The GLB, once it has been read and split. */
interface Glb {
  bytes: Buffer;
  version: number;
  json: GltfDocument;
  binBytes: number;
}

/** Memoised {@link readGlb} result, so eleven assertions parse the file once. */
let cached: Glb | undefined;

/**
 * Read and split the committed GLB.
 *
 * Every failure mode gets its own sentence, because the two most likely ones —
 * "the asset has not been exported yet" and "this clone has no LFS" — look
 * identical from a stack trace.
 *
 * @returns The parsed container.
 */
function readGlb(): Glb {
  if (cached !== undefined) return cached;

  let bytes: Buffer;
  try {
    bytes = readFileSync(GLB_PATH);
  } catch {
    throw new Error(
      `${GLB_PATH} is missing. It is exported by the soma-x aosrig_v0 branch — see ` +
        'packages/assets-aosrig/README.md — and copied in; this package cannot be ' +
        'built or tested without it.',
    );
  }

  if (bytes.subarray(0, LFS_PREFIX.length).toString('utf8') === LFS_PREFIX) {
    throw new Error(
      `${GLB_PATH} is a ${String(bytes.byteLength)}-byte Git LFS pointer, not a GLB. ` +
        'Run `git lfs install && git lfs pull` and try again.',
    );
  }

  if (bytes.byteLength < 20) {
    throw new Error(`${GLB_PATH} is ${String(bytes.byteLength)} bytes: too short to be a GLB.`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error(`${GLB_PATH} does not start with the glTF magic; it is not a GLB.`);
  }

  const version = view.getUint32(4, true);
  let offset = 12;
  let json: GltfDocument | undefined;
  let binBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === CHUNK_JSON) {
      json = JSON.parse(bytes.subarray(start, start + length).toString('utf8')) as GltfDocument;
    } else if (type === CHUNK_BIN) {
      binBytes = length;
    }
    // Chunks are padded to a four-byte boundary.
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (json === undefined) throw new Error(`${GLB_PATH} has no JSON chunk.`);

  cached = { bytes, version, json, binBytes };
  return cached;
}

/**
 * Every node name in declaration order.
 *
 * @returns The names, with `''` for an unnamed node.
 */
function nodeNames(): string[] {
  return (readGlb().json.nodes ?? []).map((node) => node.name ?? '');
}

/**
 * The skin's joints, resolved to node names.
 *
 * @returns One name per `JOINTS_0` index.
 */
function skinJointNames(): string[] {
  const glb = readGlb();
  const skin = glb.json.skins?.[0];
  expect(skin, 'the GLB declares no skin').toBeDefined();
  const names = nodeNames();
  return (skin?.joints ?? []).map((index) => names[index] ?? `<node ${String(index)}>`);
}

/**
 * One animation by name.
 *
 * @param name The clip name.
 * @returns The animation entry.
 */
function clip(name: string): NonNullable<GltfDocument['animations']>[number] {
  const found = readGlb().json.animations?.find((a) => a.name === name);
  expect(found, `the GLB has no animation named "${name}"`).toBeDefined();
  return found as NonNullable<GltfDocument['animations']>[number];
}

describe('the container', () => {
  it('is real bytes and not a Git LFS pointer', () => {
    const glb = readGlb();
    expect(glb.bytes.byteLength).toBeGreaterThan(1024);
    expect(glb.bytes.subarray(0, 4).toString('ascii')).toBe('glTF');
  });

  it('is glTF 2.0 binary with a BIN chunk', () => {
    const glb = readGlb();
    expect(glb.version).toBe(2);
    expect(glb.json.asset?.version).toBe('2.0');
    expect(glb.binBytes).toBeGreaterThan(0);
  });

  it('stays under the 4 MB budget', () => {
    expect(statSync(GLB_PATH).size).toBeLessThanOrEqual(SIZE_BUDGET);
  });

  it('resolves its own base URL to the assets directory', () => {
    expect(AOSRIG_ASSETS_BASE.endsWith('/assets/')).toBe(true);
  });

  it('marks itself as an aosrig scene, in metres, facing +Z', () => {
    const extras = readGlb().json.scenes?.[0]?.extras?.aosrig;
    expect(extras).toBeDefined();
    expect(extras?.version).toBe('v0');
    expect(extras?.units).toBe('m');
    expect(extras?.forward).toBe('+Z');
    expect(extras?.joints).toBe(AOSRIG_JOINTS.length);
  });
});

describe('the skin', () => {
  it('declares the 114 joints of AOSRIG_JOINTS, in order', () => {
    const names = skinJointNames();
    expect(names).toHaveLength(114);
    expect(names).toEqual([...AOSRIG_JOINTS]);
  });

  it('ships the joints the host looks up by name', () => {
    const names = new Set(nodeNames());
    expect(names.has(AOSRIG_ROOT_JOINT), AOSRIG_ROOT_JOINT).toBe(true);
    expect(names.has(AOSRIG_HEAD_JOINT), AOSRIG_HEAD_JOINT).toBe(true);
    for (const [joint] of AOSRIG_HEAD_AIM_JOINTS) {
      expect(names.has(joint), joint).toBe(true);
    }
  });

  it('roots the skeleton at body_world and carries inverse bind matrices', () => {
    const glb = readGlb();
    const skin = glb.json.skins?.[0];
    expect(skin?.inverseBindMatrices).toBeTypeOf('number');
    expect(nodeNames()[skin?.skeleton ?? -1]).toBe(AOSRIG_JOINTS[0]);
  });

  it('skins every primitive with JOINTS_0 and WEIGHTS_0', () => {
    const primitives = readGlb().json.meshes?.flatMap((mesh) => mesh.primitives ?? []) ?? [];
    expect(primitives.length).toBeGreaterThan(0);
    for (const primitive of primitives) {
      expect(Object.keys(primitive.attributes ?? {}).sort()).toEqual([
        'JOINTS_0',
        'NORMAL',
        'POSITION',
        'TEXCOORD_0',
        'WEIGHTS_0',
      ]);
    }
  });
});

describe('the clips', () => {
  it('are exactly idle, walk, run and wave', () => {
    const names = (readGlb().json.animations ?? []).map((a) => a.name ?? '');
    expect(names).toEqual([...AOSRIG_CLIPS]);
  });

  it('gives every clip channels, samplers and an extras.aos block', () => {
    for (const name of AOSRIG_CLIPS) {
      const animation = clip(name);
      expect((animation.channels ?? []).length, name).toBeGreaterThan(0);
      expect((animation.samplers ?? []).length, name).toBeGreaterThan(0);
      expect(animation.extras?.aos, name).toBeDefined();
    }
  });

  it('bakes the locomotion clips at 0, 1.4 and 3.6 m/s', () => {
    // These three numbers are what the host's blend divides by; a wrong one is
    // a character that skates rather than walks.
    expect(clip('idle').extras?.aos?.speed).toBe(AOSRIG_CLIP_SPEEDS.idle);
    expect(clip('walk').extras?.aos?.speed).toBe(AOSRIG_CLIP_SPEEDS.walk);
    expect(clip('run').extras?.aos?.speed).toBe(AOSRIG_CLIP_SPEEDS.run);
  });

  it('flags idle, walk and run as locomotion, and wave as not', () => {
    for (const name of ['idle', 'walk', 'run']) {
      expect(clip(name).extras?.aos?.locomotion, name).toBe(true);
    }
    expect(clip('wave').extras?.aos?.locomotion).toBe(false);
  });

  it('loops every clip, wave included', () => {
    for (const name of AOSRIG_CLIPS) {
      expect(clip(name).extras?.aos?.loop, name).toBe(true);
    }
  });
});
