/**
 * The character bridge, against fake GPU parts.
 *
 * `createCharacterBridge` talks to three real packages, and two of the three
 * want a `GPUDevice`. What is worth testing here is not WebGPU — the character
 * showcase's e2e suite does that against a real adapter — but the *wiring*: a
 * command arrives, the animator's state changes, and the control vector that
 * reaches the rig backend is the one the animator produced. So the device, the
 * backend, the sink and the preview are fakes, and everything between them is
 * the real code, including the real ARKit-to-GNM map.
 */
import type { Engine } from '@gameable/core';
import { SceneGraph } from '@gameable/core';
import type { Vec3 } from '@gameable/sdk';
import {
  AnimationClip,
  Bone,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  Object3D,
  PerspectiveCamera,
  QuaternionKeyframeTrack,
  Scene,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from 'three/webgpu';
import { createArkitToGnmMap } from '@gameable/character';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CharacterBridge,
  CharacterBridgeOptions,
  CharacterSpawnRequest,
  SkinnedGltf,
} from './characters';

/** The `head_ext` layout of a truncated myra pack, as `gnmPack.parseAosRig` reports it. */
const LAYOUT = {
  dim: 68,
  exprDim: 64,
  gazeDim: 4,
  regions: [
    ['left_eye', 16],
    ['right_eye', 16],
    ['lower_face', 24],
    ['tongue', 7],
    ['pupils', 1],
  ] as [string, number][],
  reduced: { left_eye: 16, right_eye: 16, lower_face: 24, tongue: 7, pupils: 1 },
};

/** Vertices the fake rig claims; the sink allocation follows it. */
const VERTEX_COUNT = 128;

/** Every `setControls` the fake backend saw, newest last. */
const controlLog: Float32Array[] = [];
/** How many times the fake preview drew. */
let renders = 0;
/** How many sinks were built, and how many were disposed. */
let sinksMade = 0;
let sinksDisposed = 0;
/** True once the fake backend was disposed. */
let backendDisposed = false;
/** The last joint overrides the fake backend was handed. */
let jointLog: { joint: string; rotation: readonly number[] }[] = [];
/** How many times the fake backend was handed overrides at all. */
let jointPushes = 0;

const exportedRuntimes: { render: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] =
  [];
let exportFailure = false;
/** When set, the exported package carries the teeth's files; the options the runtime was given. */
let exportTeeth = false;
/** When set, the exported package carries a pose correction with this many new splats. */
let exportCorrectivePoints = 0;
/** When set, the exported package is version 2: this skeleton and these clips (soma.ts). */
let exportSoma: unknown = null;
/** When set, the version 2 package carries its body mesh (`body.glb`). */
let exportBody = false;
/** The capacity each fake sink was made with, in order. */
const sinkCapacities: number[] = [];
/** The arguments each bundle load was given. */
const loadCalls: unknown[][] = [];
/** Every failed character load the bridge reported on its own channel. */
const failures: { entity: number; bundleId: string; message: string }[] = [];
let mouthBuilt = true;
const exportOptions: { renderer: unknown; mouth?: { sink: unknown } }[] = [];

/** A recorder standing in for `createSplatShadows`'s system. */
interface FakeShadows {
  options: { quality?: string };
  characters: { key: object; character: { holder: Object3D; rig: Object3D; captured: unknown } }[];
  removed: object[];
  places: unknown[];
  quality: string;
  updates: number;
  disposed: boolean;
}
/** Every shadow system the bridge started, in order. */
const shadowSystems: FakeShadows[] = [];
/** What the fake capture-light fit returns. */
const FAKE_KEY = {
  direction: [0, 0.7071, 0.7071],
  azimuth: 0,
  elevation: 45,
  keyToFill: 2,
  shadowStrength: 0.5,
  confidence: 0.6,
};

vi.mock('@gameable/splat', () => ({
  acquireStorageGPUBuffer: () => ({}),
  releaseStorageAttribute: () => true,
  /**
   * The capture-light fit, answering one fixed light.
   *
   * @returns The light.
   */
  estimateKeyLightFromSurfels: () => FAKE_KEY,
  /**
   * A shadow system that records what it is told.
   *
   * @param _renderer Unused.
   * @param _scene Unused.
   * @param options The options the bridge passed.
   * @returns The recorder.
   */
  createSplatShadows: (_renderer: unknown, _scene: unknown, options: { quality?: string }) => {
    const record: FakeShadows = {
      options,
      characters: [],
      removed: [],
      places: [],
      quality: options.quality ?? 'auto',
      updates: 0,
      disposed: false,
    };
    shadowSystems.push(record);
    return {
      get quality() {
        return record.quality;
      },
      get info() {
        return { route: 'character', quality: record.quality };
      },
      setQuality: (quality: string) => {
        record.quality = quality;
      },
      addCharacter: (key: object, character: FakeShadows['characters'][number]['character']) => {
        record.characters.push({ key, character });
      },
      removeCharacter: (key: object) => {
        record.removed.push(key);
      },
      addPlace: (splat: unknown) => {
        record.places.push(splat);
      },
      removePlace: () => undefined,
      setKeyLight: () => undefined,
      update: () => {
        record.updates += 1;
      },
      dispose: () => {
        record.disposed = true;
      },
    };
  },
  /**
   * A sink that records nothing but its lifetime.
   *
   * @returns The fake sink.
   */
  createAnimatedSplat: (_renderer: unknown, options?: { capacity?: number }) => {
    sinksMade += 1;
    sinkCapacities.push(options?.capacity ?? -1);
    return Promise.resolve({
      object3D: new Scene(),
      capacity: 1024,
      /**
       * Hand out a slot range.
       *
       * @returns The whole range.
       */
      allocate: () => ({ offset: 0, count: VERTEX_COUNT }),
      free: () => undefined,
      markGaussiansChanged: () => undefined,
      setBoundingSphere: () => undefined,
      /**
       * Count the disposal.
       *
       * @returns Nothing.
       */
      dispose: () => {
        sinksDisposed += 1;
      },
    });
  },
}));

// The exported character's runtime, faked where the character package builds it
// (`buildAosrigCharacter` calls it), so the bridge's sinks and options are the real ones.
vi.mock('../../character/src/aosrigSplat/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createAosrigSplat: (options: { renderer: unknown; mouth?: { sink: unknown } }) => {
      if (exportFailure) return Promise.reject(new Error('bad binding hash'));
      exportOptions.push(options);
      const runtime = {
        // read when a character is built, long after the imports below
        mapper: createArkitToGnmMap(LAYOUT),
        mouth: options.mouth && mouthBuilt ? { enabled: true } : null,
        corrective: null,
        hiddenPoints: null,
        render: vi.fn(),
        dispose: vi.fn(),
      };
      exportedRuntimes.push(runtime);
      return Promise.resolve(runtime);
    },
  };
});

vi.mock('@gameable/character', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gameable/character')>();
  return {
    ...actual,
    /**
     * Samples for the capture-light fit (the fit itself is faked in the splat mock).
     *
     * @returns No samples.
     */
    capturedLightSamples: () => ({
      count: 0,
      normals: new Float32Array(0),
      luminance: new Float32Array(0),
      weights: new Float32Array(0),
      groups: new Uint16Array(0),
      medianGap: 0,
    }),
    loadAosrigSplatBundle: (...args: unknown[]) => {
      loadCalls.push(args);
      return Promise.resolve({
        descriptor: {
          splatCount: 128,
          bounds: { center: [0, 0.9, 0], radius: 0.9 },
          ...(exportSoma ? { version: 2 } : {}),
        },
        files: exportSoma
          ? new Map(exportBody ? [['body.glb', new Uint8Array(8)]] : [])
          : new Map([['rig.glb', new Uint8Array(8)]]),
        ...(exportSoma ? { soma: exportSoma } : {}),
        ...(exportTeeth
          ? {
              teeth: {
                info: { points: 64, ply: 'teeth.ply', binding: 'teeth.bin' },
                ply: new Uint8Array(4),
                binding: new Uint8Array(4),
              },
            }
          : {}),
        ...(exportCorrectivePoints > 0
          ? { corrective: [{ info: { name: 'arms_up_90', points: exportCorrectivePoints } }] }
          : {}),
      });
    },
    /**
     * Pretend the renderer handed over a device.
     *
     * @returns An empty object standing in for a `GPUDevice`.
     */
    prepareLiftDevice: () => ({}),
    /**
     * A tint of the right length, with no pack to read.
     *
     * @returns One packed colour per vertex.
     */
    jointTint: () => new Uint32Array(VERTEX_COUNT),
    GnmRigBackend: class {
      readonly kind = 'gnm' as const;
      readonly vertexCount = VERTEX_COUNT;
      readonly assets = { header: { headExt: LAYOUT }, vertexCount: VERTEX_COUNT };
      /**
       * Accept the init the bridge performs.
       *
       * @returns Resolves immediately.
       */
      init(): Promise<void> {
        return Promise.resolve();
      }
      /**
       * Record the control vector, copied because the bridge reuses it.
       *
       * @param controls The vector.
       *
       * @returns Nothing.
       */
      setControls(controls: Float32Array): void {
        controlLog.push(Float32Array.from(controls));
      }
      /**
       * Record the head-aim overrides, copied because the bridge reuses them.
       *
       * @param overrides One per aimed joint.
       *
       * @returns Nothing.
       */
      setJointOverrides(overrides: readonly { joint: string; rotation: number[] }[]): boolean {
        jointPushes += 1;
        jointLog = overrides.map((o) => ({ joint: o.joint, rotation: [...o.rotation] }));
        return true;
      }
      /**
       * Mark the backend disposed.
       *
       * @returns Nothing.
       */
      dispose(): void {
        backendDisposed = true;
      }
    },
    /**
     * A preview that forwards `setControls` and counts draws.
     *
     * @param options What the bridge asked for.
     *
     * @returns The fake preview.
     */
    createRigPreview: (options: {
      backend: { setControls(c: Float32Array): void; dispose(): void };
    }) =>
      Promise.resolve({
        backend: options.backend,
        /**
         * Forward to the backend, which is what the real preview does.
         *
         * @param controls The control vector.
         *
         * @returns Nothing.
         */
        setControls: (controls: Float32Array) => {
          options.backend.setControls(controls);
        },
        /**
         * Count the draw.
         *
         * @returns Nothing.
         */
        render: () => {
          renders += 1;
        },
        /**
         * Dispose the backend, which is what the real preview does.
         *
         * @returns Nothing.
         */
        dispose: () => {
          options.backend.dispose();
        },
      }),
  };
});

/** A manifest entry as the fake registry reports it. */
interface FakeEntry {
  id: string;
  type: string;
  src: string;
  rig?: { backend: string; pack?: string; clips?: string[] };
}

/** What {@link makeEngine} hands back. */
interface Harness {
  engine: Engine;
  scene: Scene;
  warnings: string[];
  logs: string[];
}

/**
 * Build the smallest engine the bridge reads: assets, camera, scene and caps.
 *
 * @param entries Manifest entries, indexed from handle 1.
 * @param characters Whether the renderer supports characters.
 *
 * @returns The harness.
 */
function makeEngine(entries: FakeEntry[], characters = true): Harness {
  const scene = new Scene();
  const camera = new PerspectiveCamera(70, 1, 0.1, 1000);
  const assets = {
    /**
     * Handle for an id, 1-based.
     *
     * @param id Manifest id.
     *
     * @returns The handle, or 0.
     */
    resolve: (id: string) => entries.findIndex((e) => e.id === id) + 1,
    /**
     * Id for a handle.
     *
     * @param handle The handle.
     *
     * @returns The id, or undefined.
     */
    idOf: (handle: number) => entries[handle - 1]?.id,
    /**
     * Entry for an id or handle.
     *
     * @param key Id or handle.
     *
     * @returns The entry, or undefined.
     */
    entry: (key: string | number) =>
      typeof key === 'number' ? entries[key - 1] : entries.find((e) => e.id === key),
    /**
     * URL for an id or handle; this manifest has no baseUrl.
     *
     * @param key Id or handle.
     *
     * @returns The URL, or undefined.
     */
    url: (key: string | number) =>
      typeof key === 'number' ? entries[key - 1]?.src : entries.find((e) => e.id === key)?.src,
  };
  const engine = {
    scene,
    camera,
    graph: new SceneGraph(scene),
    assets,
    renderer: {},
    ctx: { caps: { webgpu: characters, characters } },
  } as unknown as Engine;
  return { engine, scene, warnings: [], logs: [] };
}

/** The guide, with a GNM pack beside it. */
const GNM_ENTRY: FakeEntry = {
  id: 'char.guide',
  type: 'character',
  src: '/characters/guide/scene.json',
  rig: { backend: 'gnm', pack: '/generated/myra_head.e64.aosrig' },
};

/** The guide as it shipped before the pack: a rig this bridge cannot draw. */
const ORL_ENTRY: FakeEntry = {
  id: 'char.guide',
  type: 'character',
  src: '/characters/guide/scene.json',
  rig: { backend: 'orl' },
};

/** A skinned body, as the manifest declares one. */
const SKINNED_ENTRY: FakeEntry = {
  id: 'char.hero',
  type: 'character',
  src: '/assets/aosrig_v0.glb',
  rig: { backend: 'skinned' },
};

/** A bone the clips drive that head aim never touches, so the two are separable. */
const FREE_BONE = 'c_arm';

/**
 * A clip holding one bone at a fixed rotation about Y, with `extras.aos` on it.
 *
 * `GLTFLoader` copies a glTF animation's `extras` into `clip.userData`, so this
 * is exactly the shape the real exporter produces.
 *
 * @param name Clip name.
 * @param bone Bone the track drives.
 * @param angle Rotation in radians.
 * @param aos What `extras.aos` says about the clip.
 *
 * @returns The clip.
 */
function aosClip(name: string, bone: string, angle: number, aos: unknown): AnimationClip {
  const s = Math.sin(angle / 2);
  const c = Math.cos(angle / 2);
  const clip = new AnimationClip(name, 1, [
    new QuaternionKeyframeTrack(`${bone}.quaternion`, [0, 1], [0, s, 0, c, 0, s, 0, c]),
  ]);
  clip.userData = { aos };
  return clip;
}

/**
 * A synthetic `aosrig_v0`: `root -> c_spine0 -> c_neck -> c_head`, plus one arm
 * bone off the spine, bound to a `SkinnedMesh`.
 *
 * Small enough to assert against, and named exactly as the real rig is, so
 * `profileFor` picks the aosrig profile from it the same way.
 *
 * @param skinned Whether to bind a `SkinnedMesh` at all; false is the "someone
 *   pointed a skinned entry at a static prop" case.
 *
 * @returns The scene and its animations, as a loader would return them.
 */
function makeSkinnedGltf(skinned = true): SkinnedGltf {
  const scene = new Object3D();
  scene.name = 'aosrig_v0';
  const chain = ['root', 'c_spine0', 'c_neck', 'c_head'];
  const bones: Bone[] = [];
  let parent: Object3D = scene;
  for (const name of chain) {
    const bone = new Bone();
    bone.name = name;
    bone.position.set(0, 0.45, 0);
    parent.add(bone);
    bones.push(bone);
    parent = bone;
  }
  const arm = new Bone();
  arm.name = FREE_BONE;
  arm.position.set(0.2, 0, 0);
  bones[1].add(arm);
  bones.push(arm);

  if (skinned) {
    const mesh = new SkinnedMesh(undefined, new MeshStandardNodeMaterial());
    mesh.name = 'body';
    scene.add(mesh);
    mesh.bind(new Skeleton(bones));
  }
  scene.updateMatrixWorld(true);

  return {
    scene,
    animations: [
      aosClip('idle', 'c_spine0', 0, { speed: 0, loop: true, locomotion: true }),
      aosClip('walk', 'c_spine0', 0.5, { speed: 1.4, loop: true, locomotion: true }),
      aosClip('run', 'c_spine0', 1, { speed: 3.6, loop: true, locomotion: true }),
      aosClip('wave', FREE_BONE, 0.8, { loop: true, locomotion: false }),
    ],
  };
}

/** A loader that counts its calls, so "one parse, three spawns" is observable. */
interface CountingLoader {
  /** The loader to hand the bridge. */
  load: (url: string) => Promise<SkinnedGltf>;
  /** URLs asked for, one entry per parse. */
  urls: string[];
}

/**
 * An injected `loadGltf` over one synthetic rig.
 *
 * @param skinned Whether the file has a `SkinnedMesh`.
 *
 * @returns The loader and its call log.
 */
function countingLoader(skinned = true): CountingLoader {
  const urls: string[] = [];
  return {
    urls,
    load: (url: string) => {
      urls.push(url);
      return Promise.resolve(makeSkinnedGltf(skinned));
    },
  };
}

/**
 * Build a bridge over a harness, importing the module fresh each time so the
 * mocks above are in place.
 *
 * @param harness From {@link makeEngine}.
 * @param extra Options merged over the defaults, such as an injected loader.
 *
 * @returns The bridge.
 */
async function makeBridge(
  harness: Harness,
  extra: Partial<CharacterBridgeOptions> = {},
): Promise<CharacterBridge> {
  // The bridge loads both heavy packages with `await import(...)` inside the
  // boot, so pull them into the module registry first: `settle()` then only has
  // to wait for promises, not for vitest to transform a package.
  await Promise.all([
    import('@gameable/character'),
    import('@gameable/splat'),
    import('three/addons/utils/SkeletonUtils.js'),
  ]);
  const { createCharacterBridge } = await import('./characters');
  return createCharacterBridge({
    engine: harness.engine,
    warn: (message) => harness.warnings.push(message),
    log: (message) => harness.logs.push(message),
    onLoadFailed: (info) => failures.push(info),
    ...extra,
  });
}

/**
 * Let every pending promise in an asynchronous boot resolve.
 *
 * A macrotask turn rather than a microtask one, because a boot now begins with
 * `await import(...)` and a module load is not a fixed number of microtasks.
 *
 * @returns Resolves once the boot has settled.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Spawn entity 1 and wait for the asynchronous boot to finish.
 *
 * @param bridge The bridge.
 * @param parent Where the head hangs.
 *
 * @returns Resolves once the boot has settled.
 */
async function spawnAndSettle(bridge: CharacterBridge, parent: Scene): Promise<void> {
  bridge.spawn({
    entity: 1,
    bundle: 1,
    parent,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  });
  await settle();
}

/**
 * Spawn a skinned character and wait for its boot.
 *
 * @param bridge The bridge.
 * @param parent Where the body hangs.
 * @param extra Fields to override on the spawn request.
 *
 * @returns Resolves once the boot has settled.
 */
async function spawnSkinned(
  bridge: CharacterBridge,
  parent: Object3D,
  extra: Partial<CharacterSpawnRequest> = {},
): Promise<void> {
  bridge.spawn({
    entity: 1,
    bundle: 1,
    parent,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    ...extra,
  });
  await settle();
}

/**
 * A live bone of a spawned character's cloned rig.
 *
 * @param harness The harness whose scene holds the character.
 * @param entity The entity.
 * @param name The bone name.
 *
 * @returns The bone.
 */
function liveBone(harness: Harness, entity: number, name: string): Object3D {
  const holder = harness.scene.getObjectByName(`character:${String(entity)}`);
  const bone = holder?.getObjectByName(name);
  if (bone === undefined) throw new Error(`no bone "${name}" on entity ${String(entity)}`);
  return bone;
}

/**
 * A bone's local rotation, as an angle about Y.
 *
 * @param bone The bone.
 *
 * @returns The angle in radians.
 */
function boneYaw(bone: Object3D): number {
  return 2 * Math.atan2(bone.quaternion.y, bone.quaternion.w);
}

/** A vector with one ARKit channel raised. */
const JAW_OPEN = 17;

beforeEach(() => {
  exportedRuntimes.length = 0;
  shadowSystems.length = 0;
  exportFailure = false;
  exportTeeth = false;
  mouthBuilt = true;
  exportCorrectivePoints = 0;
  exportSoma = null;
  exportBody = false;
  sinkCapacities.length = 0;
  loadCalls.length = 0;
  failures.length = 0;
  exportOptions.length = 0;
  controlLog.length = 0;
  renders = 0;
  sinksMade = 0;
  sinksDisposed = 0;
  backendDisposed = false;
  jointLog = [];
  jointPushes = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        /**
         * The pack bytes; the fake backend never parses them.
         *
         * @returns Eight bytes.
         */
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    ),
  );
});

describe('createCharacterBridge', () => {
  it('spawns a GNM head, parents it under the entity and tells the caller', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    let attached = 0;

    bridge.spawn({
      entity: 1,
      bundle: 1,
      parent: harness.scene,
      position: { x: 2, y: 0, z: 3 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      onAttached: () => {
        attached += 1;
      },
    });
    await settle();

    expect(attached, harness.warnings.join('\n')).toBe(1);
    const entry = bridge.entryOf(1);
    expect(entry?.kind).toBe('gnm-rig');
    expect(entry?.ready).toBe(true);
    expect(entry?.bundleId).toBe('char.guide');
    expect(entry?.controls?.length).toBe(LAYOUT.dim);
    expect(sinksMade).toBe(1);

    // The head hangs under the entity, raised to where a head goes.
    const holder = harness.scene.getObjectByName('character:1');
    expect(holder).toBeDefined();
    expect(holder?.position.y).toBeCloseTo(0.6, 5);
    // The command's world position minus the parent's is the local offset.
    expect(holder?.position.x).toBeCloseTo(2, 5);
    expect(holder?.position.z).toBeCloseTo(3, 5);
  });

  it('fetches the pack named by rig.pack', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    await spawnAndSettle(bridge, harness.scene);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/generated/myra_head.e64.aosrig');
  });

  it('resolves a relative rig.pack against the entry directory', async () => {
    const harness = makeEngine([
      { ...GNM_ENTRY, rig: { backend: 'gnm', pack: 'myra_head.e64.aosrig' } },
    ]);
    const bridge = await makeBridge(harness);
    await spawnAndSettle(bridge, harness.scene);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/characters/guide/myra_head.e64.aosrig');
  });

  it('turns set-character-state into animator locomotion', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    await spawnAndSettle(bridge, harness.scene);

    const velocity: Vec3 = { x: 3, y: 0, z: 4 };
    bridge.setState(1, 'run', velocity, true);

    const entry = bridge.entryOf(1);
    expect(entry?.state).toBe('run');
    // The animator owns the state object the bridge mutates; the velocity it
    // blends from is the one the guest sent, not the name.
    expect(entry?.animator).not.toBeNull();
    bridge.update(1 / 60);
    expect(renders).toBe(1);
  });

  it('maps an ARKit-52 expression into the pack control vector', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    await spawnAndSettle(bridge, harness.scene);

    const neutral = new Float32Array(52);
    bridge.setExpression(1, 'arkit52', neutral);
    bridge.update(1 / 60);
    // The FIRST push lands even though every control is zero: "never pushed" and
    // "pushed an all-zero neutral" are different states, and a rig that has never been
    // told anything is still at its bind pose. The gate compares against what was
    // pushed, not against zero.
    const rest = controlLog[controlLog.length - 1];
    expect(rest).toBeDefined();
    expect(rest.length).toBe(LAYOUT.dim);
    expect(rest.every((v) => v === 0)).toBe(true);

    // ...and an identical repeat does not reach the rig at all. An idle face resends
    // one vector sixty times a second, and each push used to re-upload the whole
    // expression uniform.
    const pushes = controlLog.length;
    bridge.setExpression(1, 'arkit52', neutral);
    bridge.update(1 / 60);
    expect(controlLog.length).toBe(pushes);

    const open = new Float32Array(52);
    open[JAW_OPEN] = 1;
    bridge.setExpression(1, 'arkit52', open);
    bridge.update(1 / 60);
    const moved = controlLog[controlLog.length - 1];
    // The real `createArkitToGnmMap` put JawOpen somewhere in `lower_face`,
    // which starts after the two eye regions.
    const lowerFaceStart = LAYOUT.regions[0][1] + LAYOUT.regions[1][1];
    const touched = moved.slice(lowerFaceStart, lowerFaceStart + LAYOUT.regions[2][1]);
    expect(touched.some((v) => v !== 0)).toBe(true);
  });

  it('refuses an expression that is not in this character space', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    await spawnAndSettle(bridge, harness.scene);

    bridge.setExpression(1, 'gnm', new Float32Array(387));
    expect(harness.warnings.some((w) => w.includes('does not match'))).toBe(true);
  });

  it('turns look-at into eye gaze in the control vector tail', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    await spawnAndSettle(bridge, harness.scene);

    // Far off to one side, so the neck runs out of travel and the eyes take
    // the rest. The aim approaches its target over time, hence the frames.
    bridge.lookAt(1, { x: 20, y: 1.6, z: 0 }, 1);
    for (let i = 0; i < 60; i += 1) bridge.update(1 / 60);

    const controls = controlLog[controlLog.length - 1];
    const gaze = controls.subarray(LAYOUT.exprDim, LAYOUT.exprDim + 4);
    expect(gaze.some((v) => v !== 0)).toBe(true);
    // Both eyes agree, because a pair of eyes converging on one point is one
    // angle to this rig.
    expect(gaze[1]).toBeCloseTo(gaze[3], 6);

    // The neck turned too, and the rig was told about it in its own quaternion
    // order: `(w, x, y, z)`, not three's `(x, y, z, w)`.
    expect(jointLog.map((j) => j.joint)).toEqual(['neck_01', 'neck_02', 'head']);
    expect(jointLog.some((j) => Math.abs(j.rotation[0]) < 0.999)).toBe(true);

    // Clearing the target walks the gaze back to centre.
    bridge.lookAt(1, undefined, 0);
    for (let i = 0; i < 120; i += 1) bridge.update(1 / 60);
    const centred = controlLog[controlLog.length - 1];
    expect(Math.abs(centred[LAYOUT.exprDim + 1])).toBeLessThan(1e-3);
  });

  it('pushes joint overrides only while the aim is still moving', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    await spawnAndSettle(bridge, harness.scene);

    // The first frame always pushes: the rig has never been handed a rotation.
    bridge.update(1 / 60);
    expect(jointPushes).toBe(1);

    // Nothing is aiming, so the animator keeps writing the same identity rotations —
    // and each push used to rebuild a name->index map, allocate two `J*16` matrices
    // and re-run the whole skin pass in the backend.
    for (let i = 0; i < 30; i += 1) bridge.update(1 / 60);
    expect(jointPushes).toBe(1);

    // A target the neck has to turn toward moves them again, every frame, until the
    // aim converges.
    bridge.lookAt(1, { x: 20, y: 1.6, z: 0 }, 1);
    bridge.update(1 / 60);
    expect(jointPushes).toBe(2);
    for (let i = 0; i < 10; i += 1) bridge.update(1 / 60);
    expect(jointPushes).toBeGreaterThan(2);

    // And once it has settled on the target they stop again.
    for (let i = 0; i < 600; i += 1) bridge.update(1 / 60);
    const settled = jointPushes;
    for (let i = 0; i < 30; i += 1) bridge.update(1 / 60);
    expect(jointPushes).toBe(settled);
  });

  it('attaches a face to the animated head bone and restores the static head on removal', async () => {
    const harness = makeEngine([SKINNED_ENTRY, GNM_ENTRY]);
    const gltf = makeSkinnedGltf();
    const staticHead = new Mesh(undefined, new MeshStandardNodeMaterial());
    staticHead.material.name = 'static-head';
    staticHead.name = 'static-head';
    gltf.scene.add(staticHead);
    const bridge = await makeBridge(harness, { loadGltf: () => Promise.resolve(gltf) });
    await spawnSkinned(bridge, harness.scene);
    bridge.spawn({
      entity: 2,
      bundle: 2,
      parent: harness.scene,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    await settle();
    expect(bridge.attachFace?.(1, 2, 'c_head', 'static-head', [0, 0.05, 0])).toBe(true);
    const face = harness.scene.getObjectByName('character:2')!;
    expect(face.parent?.name).toBe('c_head');
    expect(face.position.y).toBe(0.05);
    const hidden = harness.scene.getObjectByName('static-head')!;
    expect(hidden.visible).toBe(false);
    bridge.despawn(2);
    expect(hidden.visible).toBe(true);
    bridge.dispose();
  });

  it('forwards speech to an optional host player and stops it on despawn', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const speech = { say: vi.fn(), stop: vi.fn() };
    const bridge = await makeBridge(harness, { speech });
    await spawnAndSettle(bridge, harness.scene);
    bridge.say(1, 'A spoken line', 2, '[]');
    expect(speech.say).toHaveBeenCalledWith(1, 'A spoken line', 2, '[]');
    bridge.despawn(1);
    expect(speech.stop).toHaveBeenCalledWith(1);
    expect(harness.logs).toEqual([]);
  });

  it('logs a say() instead of pretending to speak', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    await spawnAndSettle(bridge, harness.scene);
    bridge.say(1, 'You are awake.');
    expect(harness.logs).toEqual(['[character 1] You are awake.']);
  });

  it('records clip weights even with no clip library to play them', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    await spawnAndSettle(bridge, harness.scene);
    expect(() => {
      bridge.setClipWeights(1, ['walk', 'run'], new Float32Array([0.3, 0.7]), 1);
      bridge.update(1 / 60);
    }).not.toThrow();
  });

  it('despawn releases the sink, the backend and the scene node', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    await spawnAndSettle(bridge, harness.scene);

    bridge.despawn(1);
    expect(bridge.entryOf(1)).toBeNull();
    expect(sinksDisposed).toBe(1);
    expect(backendDisposed).toBe(true);
    expect(harness.scene.getObjectByName('character:1')).toBeUndefined();
    // A stale command after despawn is a no-op, not a crash.
    expect(() => {
      bridge.setState(1, 'idle', { x: 0, y: 0, z: 0 }, true);
      bridge.update(1 / 60);
    }).not.toThrow();
  });

  it('keeps the placeholder and warns once for a rig it cannot draw', async () => {
    const harness = makeEngine([ORL_ENTRY]);
    const bridge = await makeBridge(harness);
    let attached = 0;
    bridge.spawn({
      entity: 1,
      bundle: 1,
      parent: harness.scene,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      onAttached: () => {
        attached += 1;
      },
    });
    await settle();

    expect(attached).toBe(0);
    expect(bridge.entryOf(1)?.kind).toBe('placeholder');
    expect(harness.warnings.filter((w) => w.includes('no GNM rig pack'))).toHaveLength(1);
  });

  it('degrades to placeholders on the WebGL fallback without throwing', async () => {
    const harness = makeEngine([GNM_ENTRY], false);
    const bridge = await makeBridge(harness);
    expect(bridge.available).toBe(false);
    await spawnAndSettle(bridge, harness.scene);

    expect(bridge.entryOf(1)?.kind).toBe('placeholder');
    expect(sinksMade).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(harness.warnings.some((w) => w.includes('WebGL fallback'))).toBe(true);
    expect(() => {
      bridge.setState(1, 'walk', { x: 1, y: 0, z: 0 }, true);
      bridge.setExpression(1, 'arkit52', new Float32Array(52));
      bridge.lookAt(1, { x: 0, y: 1, z: 0 }, 1);
      bridge.say(1, 'hello');
      bridge.update(1 / 60);
      bridge.dispose();
    }).not.toThrow();
  });

  it('warns for a bundle handle that is not in the manifest', async () => {
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    bridge.spawn({
      entity: 7,
      bundle: 99,
      parent: harness.scene,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    expect(harness.warnings.some((w) => w.includes('not in the manifest'))).toBe(true);
    expect(bridge.entryOf(7)?.kind).toBe('placeholder');
  });

  it('throws nothing when the pack is missing, and keeps the placeholder', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 404 })),
    );
    const harness = makeEngine([GNM_ENTRY]);
    const bridge = await makeBridge(harness);
    await spawnAndSettle(bridge, harness.scene);
    expect(bridge.entryOf(1)?.kind).toBe('placeholder');
    expect(harness.warnings.some((w) => w.includes('HTTP 404'))).toBe(true);
  });
});

describe('createCharacterBridge, the skinned path', () => {
  it('clones the body under the entity, registers its clips and drops the placeholder', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const loader = countingLoader();
    const bridge = await makeBridge(harness, { loadGltf: loader.load });
    let attached = 0;

    await spawnSkinned(bridge, harness.scene, {
      onAttached: () => {
        attached += 1;
      },
    });

    expect(attached, harness.warnings.join('\n')).toBe(1);
    expect(loader.urls).toEqual(['/assets/aosrig_v0.glb']);
    const entry = bridge.entryOf(1);
    expect(entry?.kind).toBe('skinned');
    expect(entry?.ready).toBe(true);
    expect(entry?.bundleId).toBe('char.hero');
    expect(entry?.clips).toEqual(['idle', 'walk', 'run', 'wave']);

    // The body hangs under the entity, and it is a CLONE: the source scene the
    // loader handed over is still unparented and reusable.
    const holder = harness.scene.getObjectByName('character:1');
    expect(holder?.getObjectByName('c_head')).toBeDefined();
    // Bind-pose bounds would pop the body out of view mid-wave.
    const mesh = holder?.getObjectByName('body');
    expect(mesh?.frustumCulled).toBe(false);
  });

  it('puts the feet on the floor with the ground offset instead of the head offset', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene, { groundOffset: -1.15 });

    const holder = harness.scene.getObjectByName('character:1');
    expect(holder?.position.y).toBeCloseTo(-1.15, 6);
  });

  it('builds the locomotion blend from extras.aos and blends it by velocity', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);
    const spine = liveBone(harness, 1, 'c_spine0');

    bridge.setState(1, 'idle', { x: 0, y: 0, z: 0 }, true);
    bridge.update(1 / 60);
    expect(boneYaw(spine)).toBeCloseTo(0, 4);

    bridge.setState(1, 'walk', { x: 1.4, y: 0, z: 0 }, true);
    bridge.update(1 / 60);
    expect(boneYaw(spine)).toBeCloseTo(0.5, 4);

    bridge.setState(1, 'run', { x: 3.6, y: 0, z: 0 }, true);
    bridge.update(1 / 60);
    expect(boneYaw(spine)).toBeCloseTo(1, 4);

    // Between walk and run is between their poses.
    bridge.setState(1, 'run', { x: 2.5, y: 0, z: 0 }, true);
    bridge.update(1 / 60);
    const half = boneYaw(spine);
    expect(half).toBeGreaterThan(0.5);
    expect(half).toBeLessThan(1);
  });

  it('never gives a non-locomotion clip weight from set-character-state', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);

    bridge.setState(1, 'run', { x: 3.6, y: 0, z: 0 }, true);
    for (let i = 0; i < 10; i += 1) bridge.update(1 / 60);
    expect(boneYaw(liveBone(harness, 1, FREE_BONE))).toBeCloseTo(0, 6);
  });

  it('plays a clip the guest asks for by name, with no timeScale warning at rate 1', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);

    bridge.setClipWeights(1, ['wave'], [1], 1);
    bridge.update(1 / 60);
    expect(boneYaw(liveBone(harness, 1, FREE_BONE))).toBeCloseTo(0.8, 4);
    expect(harness.warnings.filter((w) => w.includes('timeScale'))).toEqual([]);
  });

  it('aims the head by the aosrig bone names, and moves the live bone', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);

    const overrides = [...(bridge.entryOf(1)?.animator?.jointOverrides.keys() ?? [])];
    expect(overrides).toEqual(['c_neck', 'c_head']);

    const head = liveBone(harness, 1, 'c_head');
    expect(boneYaw(head)).toBeCloseTo(0, 6);

    bridge.lookAt(1, { x: -100, y: 1.6, z: 0 }, 1);
    for (let i = 0; i < 400; i += 1) bridge.update(1 / 60);
    // The animator only folds its overrides into `bodyPose`; the bridge is what
    // puts them on three's bones, and a three skeleton IS the renderer.
    expect(boneYaw(head)).toBeLessThan(-0.1);
    const turned = boneYaw(head);

    // Another 400 frames at the same target must not keep turning: the aim is
    // an absolute pose, not an increment.
    for (let i = 0; i < 400; i += 1) bridge.update(1 / 60);
    expect(boneYaw(head)).toBeCloseTo(turned, 5);

    // Even with every action stopped, so the mixer writes nothing at all.
    bridge.setClipWeights(1, ['wave'], [0], 1);
    for (let i = 0; i < 400; i += 1) bridge.update(1 / 60);
    expect(boneYaw(head)).toBeCloseTo(turned, 5);

    bridge.lookAt(1, undefined, 0);
    for (let i = 0; i < 400; i += 1) bridge.update(1 / 60);
    expect(Math.abs(boneYaw(head))).toBeLessThan(1e-3);
  });

  it('clamps the aim against the entity facing, not the rig root', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    const entity = new Group();
    entity.name = 'entity:1';
    harness.scene.add(entity);
    await spawnSkinned(bridge, entity);

    const head = liveBone(harness, 1, 'c_head');
    bridge.lookAt(1, { x: -100, y: 1.6, z: 0 }, 1);
    for (let i = 0; i < 400; i += 1) bridge.update(1 / 60);
    expect(boneYaw(head)).toBeLessThan(-0.1);

    // Turn the body to face the target. Nothing is left for the neck, and the
    // rig itself is never rotated — it inherits the entity's yaw.
    entity.rotation.y = Math.atan2(-100, 0);
    entity.updateMatrixWorld(true);
    for (let i = 0; i < 400; i += 1) bridge.update(1 / 60);
    expect(Math.abs(boneYaw(head))).toBeLessThan(1e-3);
    const rig = harness.scene.getObjectByName('aosrig_v0');
    expect(rig?.rotation.y).toBe(0);
  });

  it('draws on the WebGL fallback, where a splat character cannot', async () => {
    const harness = makeEngine([SKINNED_ENTRY], false);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    expect(bridge.available).toBe(false);
    await spawnSkinned(bridge, harness.scene);

    expect(bridge.entryOf(1)?.kind).toBe('skinned');
    expect(bridge.entryOf(1)?.ready).toBe(true);
  });

  it('parses the file once for three spawns, and keeps the parse across a despawn', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const loader = countingLoader();
    const bridge = await makeBridge(harness, { loadGltf: loader.load });

    for (const entity of [1, 2, 3]) {
      bridge.spawn({
        entity,
        bundle: 1,
        parent: harness.scene,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      });
    }
    await settle();
    expect(loader.urls).toHaveLength(1);
    expect([1, 2, 3].map((e) => bridge.entryOf(e)?.kind)).toEqual([
      'skinned',
      'skinned',
      'skinned',
    ]);

    // Each clone has its own skeleton, so posing one does not pose the others.
    bridge.setState(1, 'run', { x: 3.6, y: 0, z: 0 }, true);
    bridge.update(1 / 60);
    expect(boneYaw(liveBone(harness, 1, 'c_spine0'))).toBeCloseTo(1, 4);
    expect(boneYaw(liveBone(harness, 2, 'c_spine0'))).toBeCloseTo(0, 4);

    // Despawning is not a reason to re-download three megabytes.
    bridge.despawn(1);
    expect(harness.scene.getObjectByName('character:1')).toBeUndefined();
    await spawnSkinned(bridge, harness.scene);
    expect(loader.urls).toHaveLength(1);
    expect(bridge.entryOf(1)?.kind).toBe('skinned');
  });

  it('keeps the placeholder and warns once for a glTF with no skinned mesh', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader(false).load });
    let attached = 0;
    await spawnSkinned(bridge, harness.scene, {
      onAttached: () => {
        attached += 1;
      },
    });

    expect(attached).toBe(0);
    expect(bridge.entryOf(1)?.kind).toBe('placeholder');
    expect(harness.warnings.filter((w) => w.includes('no skinned mesh'))).toHaveLength(1);
  });

  it('warns once when no clip claims to be locomotion, and still plays them', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const bridge = await makeBridge(harness, {
      loadGltf: () => {
        const gltf = makeSkinnedGltf();
        return Promise.resolve({
          scene: gltf.scene,
          animations: gltf.animations.filter((c) => c.name === 'wave'),
        });
      },
    });
    await spawnSkinned(bridge, harness.scene);

    expect(bridge.entryOf(1)?.kind).toBe('skinned');
    expect(harness.warnings.filter((w) => w.includes('extras.aos.locomotion'))).toHaveLength(1);

    bridge.setClipWeights(1, ['wave'], [1], 1);
    bridge.update(1 / 60);
    expect(boneYaw(liveBone(harness, 1, FREE_BONE))).toBeCloseTo(0.8, 4);
  });

  it('tints one body without repainting the others cloned from the same file', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    for (const entity of [1, 2]) {
      bridge.spawn({
        entity,
        bundle: 1,
        parent: harness.scene,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      });
    }
    await settle();

    // Green, not red: the default material is white, so `r` going to 0 is a
    // change only a repaint can explain.
    expect(
      bridge.setMaterialParam?.(1, 'color', { tag: 'color', val: { r: 0, g: 1, b: 0, a: 1 } }),
    ).toBe(true);
    const tinted = liveBone(harness, 1, 'body') as unknown as {
      material: { color: { r: number; g: number } };
    };
    const plain = liveBone(harness, 2, 'body') as unknown as {
      material: { color: { r: number; g: number } };
    };
    expect(tinted.material.color.r).toBeCloseTo(0, 6);
    expect(tinted.material.color.g).toBeCloseTo(1, 6);
    // The other body was cloned from the same file and still shares nothing.
    expect(plain.material.color.r).toBeCloseTo(1, 6);
    expect(tinted.material).not.toBe(plain.material);

    // A parameter this path does not understand says so and changes nothing.
    expect(bridge.setMaterialParam?.(1, 'roughness', { tag: 'scalar', val: 0.2 })).toBe(false);
    expect(harness.warnings.some((w) => w.includes('set-material-param'))).toBe(true);
  });

  it('records an expression and warns that a skinned body has no face', async () => {
    const harness = makeEngine([SKINNED_ENTRY]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);

    expect(() => {
      bridge.setExpression(1, 'arkit52', new Float32Array(52));
      bridge.update(1 / 60);
    }).not.toThrow();
    expect(harness.warnings.filter((w) => w.includes('has none'))).toHaveLength(1);
  });
});

describe('exported Gaussian characters', () => {
  const exported: FakeEntry = {
    id: 'char.hero',
    type: 'character',
    src: '/hero/character.json',
    rig: { backend: 'aosrig-splat' },
  };

  it('drives body clips and facial controls together with independent instance lifetimes', async () => {
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);
    await spawnSkinned(bridge, harness.scene, { entity: 2 });
    expect(bridge.entryOf(1)?.kind, harness.warnings.join('\n')).toBe('aosrig-splat');
    expect(exportedRuntimes).toHaveLength(2);
    const expression = new Float32Array(52);
    expression[JAW_OPEN] = 1;
    bridge.setExpression(1, 'arkit52', expression);
    bridge.setClipWeights(1, ['wave'], [1], 1);
    bridge.update(0.1);
    expect(exportedRuntimes[0].render).toHaveBeenCalledOnce();
    expect(exportedRuntimes[1].render).toHaveBeenCalledOnce();
    expect(exportedRuntimes[0].render.mock.calls[0][0]).not.toEqual(
      exportedRuntimes[1].render.mock.calls[0][0],
    );
    expect(harness.scene.getObjectByName('character:1')?.getObjectByName('body')?.visible).toBe(
      false,
    );
    bridge.despawn(1);
    expect(exportedRuntimes[0].dispose).toHaveBeenCalledOnce();
    expect(exportedRuntimes[1].dispose).not.toHaveBeenCalled();
    expect(bridge.entryOf(2)?.ready).toBe(true);
    bridge.dispose();
    expect(sinksMade).toBe(sinksDisposed);
  });

  it('cleans up the sink and rig on a failed binding load', async () => {
    exportFailure = true;
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);
    expect(bridge.entryOf(1)?.ready).toBe(false);
    expect(sinksMade).toBe(sinksDisposed);
    expect(harness.warnings.join(' ')).toContain('bad binding hash');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('bad binding hash');
    bridge.dispose();
  });

  it('casts shadows by default: the rig, the holder and the captured light reach the shadows', async () => {
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    expect(bridge.shadows?.info).toBeNull();
    await spawnSkinned(bridge, harness.scene);
    await spawnSkinned(bridge, harness.scene, { entity: 2 });
    // One system for the scene, both characters in it.
    expect(shadowSystems).toHaveLength(1);
    const system = shadowSystems[0];
    expect(system.options.quality).toBe('auto');
    expect(system.characters).toHaveLength(2);
    expect(system.characters[0].character.holder.name).toBe('character:1');
    expect(system.characters[0].character.rig.getObjectByName('body')).toBeDefined();
    expect(system.characters[0].character.captured).toEqual(FAKE_KEY);
    bridge.update(0.1);
    expect(system.updates).toBe(1);
    bridge.despawn(1);
    expect(system.removed).toEqual([system.characters[0].key]);
    bridge.dispose();
    expect(system.disposed).toBe(true);
  });

  it('starts no shadows when the host says none', async () => {
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load, shadows: false });
    await spawnSkinned(bridge, harness.scene);
    expect(bridge.entryOf(1)?.ready).toBe(true);
    expect(shadowSystems).toHaveLength(0);
    expect(bridge.shadows?.quality).toBe('off');
    bridge.shadows?.setQuality('soft');
    expect(bridge.shadows?.quality).toBe('off');
    bridge.dispose();
  });

  it('keeps a level and a place given before the first character, and applies them', async () => {
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness, {
      loadGltf: countingLoader().load,
      shadows: 'simple',
    });
    expect(bridge.shadows?.quality).toBe('simple');
    bridge.shadows?.setQuality('contact');
    const place = {} as never;
    bridge.shadows?.addPlace(place);
    await spawnSkinned(bridge, harness.scene);
    expect(shadowSystems[0].options.quality).toBe('contact');
    expect(shadowSystems[0].places).toEqual([place]);
    expect(bridge.shadows?.quality).toBe('contact');
    bridge.shadows?.setQuality('off');
    expect(shadowSystems[0].quality).toBe('off');
    bridge.dispose();
  });

  it('does not call the failure channel for an optional part that is not there', async () => {
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);
    expect(bridge.entryOf(1)?.ready).toBe(true);
    expect(bridge.entryOf(1)?.mouth).toBeNull();
    expect(bridge.entryOf(1)?.corrective).toBeNull();
    expect(failures).toEqual([]);
    bridge.dispose();
  });

  it('draws the mouth interior when the package carries it', async () => {
    exportTeeth = true;
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);
    await spawnSkinned(bridge, harness.scene, { entity: 2 });
    // The runtime (and the mouth's soft mask) draws on the engine's renderer; no stencil buffer
    // is asked of the frame and nothing is logged.
    expect(exportOptions[0].renderer).toBe(harness.engine.renderer);
    expect(exportOptions[1].mouth?.sink).toBeDefined();
    expect(bridge.entryOf(1)?.mouth).not.toBeNull();
    expect(bridge.entryOf(2)?.mouth).not.toBeNull();
    expect(harness.logs).toEqual([]);
    expect(harness.warnings).toEqual([]);
    // A character sink and a teeth sink each, all given back.
    expect(sinksMade).toBe(4);
    bridge.dispose();
    expect(sinksMade).toBe(sinksDisposed);
  });

  it('asks the loader for the extras a host wants, both by default', async () => {
    const plain = makeEngine([exported]);
    const both = await makeBridge(plain, { loadGltf: countingLoader().load });
    await spawnSkinned(both, plain.scene);
    expect(loadCalls[0]?.[2]).toEqual({
      pause: expect.any(Function) as unknown,
      mouth: true,
      corrective: true,
      sharedClips: true,
    });
    both.dispose();
    const harness = makeEngine([exported]);
    const noMouth = await makeBridge(harness, {
      loadGltf: countingLoader().load,
      extras: { mouth: false },
    });
    await spawnSkinned(noMouth, harness.scene);
    expect(loadCalls[1]?.[2]).toEqual({
      pause: expect.any(Function) as unknown,
      mouth: false,
      corrective: true,
      sharedClips: true,
    });
    noMouth.dispose();
    // a host that will swap in a fuller copy keeps the head and skeleton for it
    const lighter = makeEngine([exported]);
    const first = await makeBridge(lighter, {
      loadGltf: countingLoader().load,
      extras: { keepSharedFiles: true },
    });
    await spawnSkinned(first, lighter.scene);
    expect(loadCalls[2]?.[2]).toMatchObject({ keepShared: true });
    first.dispose();
  });

  it("hands the loader the host's fetch, so a private store's files carry its key", async () => {
    const harness = makeEngine([exported]);
    const keyed = (): Promise<Response> => Promise.resolve(new Response(''));
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load, fetch: keyed });
    await spawnSkinned(bridge, harness.scene);
    expect((loadCalls[0]?.[2] as { fetch?: unknown } | undefined)?.fetch).toBe(keyed);
    bridge.dispose();
    const plain = makeEngine([exported]);
    const none = await makeBridge(plain, { loadGltf: countingLoader().load });
    await spawnSkinned(none, plain.scene);
    expect(loadCalls[1]?.[2]).not.toHaveProperty('fetch');
    none.dispose();
  });

  it("gives the sink room for a pose correction's new splats", async () => {
    const plain = makeEngine([exported]);
    const without = await makeBridge(plain, { loadGltf: countingLoader().load });
    await spawnSkinned(without, plain.scene);
    expect(sinkCapacities).toEqual([128]);
    without.dispose();
    exportCorrectivePoints = 3094;
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);
    expect(sinkCapacities).toEqual([128, 128 + 3094]);
    expect(bridge.entryOf(1)?.corrective).toBeNull();
    bridge.dispose();
    expect(sinksMade).toBe(sinksDisposed);
  });

  it('gives the teeth sink back when the mouth could not be built', async () => {
    exportTeeth = true;
    mouthBuilt = false;
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);
    expect(bridge.entryOf(1)?.kind).toBe('aosrig-splat');
    expect(bridge.entryOf(1)?.mouth).toBeNull();
    expect(sinksMade).toBe(2);
    expect(sinksDisposed).toBe(1);
    bridge.dispose();
    expect(sinksMade).toBe(sinksDisposed);
  });

  it('draws on WebGL too, through the TSL passes', async () => {
    const harness = makeEngine([exported], false);
    const bridge = await makeBridge(harness, { loadGltf: countingLoader().load });
    await spawnSkinned(bridge, harness.scene);
    expect(exportedRuntimes).toHaveLength(1);
    expect((exportOptions[0] as { webgl?: boolean }).webgl).toBe(true);
    expect(bridge.entryOf(1)?.kind).toBe('aosrig-splat');
    bridge.dispose();
  });
});

describe('exported Gaussian characters, version 2 (the aosrig-v2 skeleton)', () => {
  const exported: FakeEntry = {
    id: 'char.hero',
    type: 'character',
    src: '/hero/character.json',
    rig: { backend: 'aosrig-splat', clips: ['../clips/shared.json'] },
  };

  /**
   * A small aosrig-v2 skeleton (Root, Hips, a spine, two neck joints, the head and an arm)
   * and one clip that turns the arm, parsed by the real readers.
   *
   * @returns What the loader would hand the bridge as `bundle.soma`.
   */
  async function fixtureSoma(): Promise<unknown> {
    const { parseSomaClips, parseSomaSkeleton } = await import('@gameable/character');
    const chain: [string, number, [number, number, number]][] = [
      ['Root', -1, [0, 0, 0]],
      ['Hips', 0, [0, 1, 0]],
      ['Chest', 1, [0, 0.3, 0]],
      ['Neck1', 2, [0, 0.2, 0]],
      ['Neck2', 3, [0, 0.05, 0]],
      ['Head', 4, [0, 0.05, 0]],
      ['LeftForeArm', 2, [0.3, 0.1, 0]],
    ];
    const identity = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    const skeleton = parseSomaSkeleton(
      {
        format: 'aosrig-v2',
        floor_y: 0,
        ground_offset: 0,
        joints: chain.map(([name, parent, at]) => ({
          name,
          parent,
          local_position: at,
          local_rotation_xyzw: [0, 0, 0, 1],
          inverse_bind_matrix_row_major: identity,
        })),
      },
      chain.map(([name]) => name),
    );
    const frames = 3;
    const turn = [0, 0, Math.sin(0.4), Math.cos(0.4)];
    const clips = parseSomaClips(
      {
        format: 'soma-clips',
        version: 1,
        clips: [
          {
            name: 'ual_celebration',
            loop: true,
            fps: 30,
            frames,
            bones: { LeftForeArm: [0, 0, 0, 1, ...turn, ...turn] },
            root: [0, 1, 0, 0, 1, 0, 0, 1, 0],
          },
        ],
      },
      skeleton,
    );
    return { skeleton, clips: clips.clips };
  }

  it('builds the body from the package, plays its clips by name and draws them', async () => {
    exportSoma = await fixtureSoma();
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness);
    await spawnSkinned(bridge, harness.scene);
    const entry = bridge.entryOf(1);
    expect(entry?.kind, harness.warnings.join('\n')).toBe('aosrig-splat');
    expect(entry?.clips).toEqual(['ual_celebration']);
    // the shared clip files the manifest names reach the loader
    expect(loadCalls[0]?.[2]).toMatchObject({ clipFiles: ['../clips/shared.json'] });
    const rest = liveBone(harness, 1, 'LeftForeArm').quaternion.clone();
    bridge.setClipWeights(1, ['ual_celebration'], [1], 1);
    bridge.update(1 / 30);
    expect(exportedRuntimes[0].render).toHaveBeenCalledOnce();
    expect(liveBone(harness, 1, 'LeftForeArm').quaternion.angleTo(rest)).toBeGreaterThan(0.01);
    bridge.dispose();
    expect(sinksMade).toBe(sinksDisposed);
  });

  /**
   * A body.glb as GLTFLoader would hand it over: one skinned triangle on the named joints.
   *
   * @param joints The joint names its skin uses.
   * @returns A loader that answers every URL with it.
   */
  function bodyLoader(joints: string[]): CharacterBridgeOptions['loadGltf'] {
    return () => {
      const bones = joints.map((name) => Object.assign(new Bone(), { name }));
      const geometry = makeSkinnedGltf().scene.getObjectByProperty('isSkinnedMesh', true) as
        SkinnedMesh | undefined;
      const mesh = new SkinnedMesh(geometry?.geometry, new MeshStandardNodeMaterial());
      mesh.bind(new Skeleton(bones));
      const scene = new Group();
      scene.add(bones[0], mesh);
      return Promise.resolve({ scene, animations: [] });
    };
  }

  it('never walks in place: a walk blend with no standing clip is not used', async () => {
    const soma = (await fixtureSoma()) as { skeleton: unknown; clips: Record<string, unknown>[] };
    // the fixture's clip, tagged as a walk: the only locomotion clip, none at speed 0
    soma.clips = soma.clips.map((c) => ({ ...c, name: 'walk', locomotion: true, speed: 1.2 }));
    exportSoma = soma;
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness);
    await spawnSkinned(bridge, harness.scene);
    const rest = liveBone(harness, 1, 'LeftForeArm').quaternion.clone();
    for (let i = 0; i < 10; i += 1) bridge.update(1 / 30);
    expect(liveBone(harness, 1, 'LeftForeArm').quaternion.angleTo(rest)).toBeLessThan(1e-6);
    expect(harness.logs.join(' ')).toContain('no standing clip');
    expect(harness.warnings).toEqual([]);
    bridge.setClipWeights(1, ['walk'], [1], 1);
    bridge.update(1 / 30);
    expect(liveBone(harness, 1, 'LeftForeArm').quaternion.angleTo(rest)).toBeGreaterThan(0.01);
    bridge.dispose();
  });

  it('binds its body mesh to the live bones, hidden, for the shadows', async () => {
    exportSoma = await fixtureSoma();
    exportBody = true;
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness, { loadGltf: bodyLoader(['Hips', 'Head']) });
    await spawnSkinned(bridge, harness.scene);
    expect(bridge.entryOf(1)?.ready, harness.warnings.join('\n')).toBe(true);
    const body = liveBone(harness, 1, 'body') as SkinnedMesh;
    expect(body.isSkinnedMesh).toBe(true);
    expect(body.visible).toBe(false);
    expect(body.skeleton.bones[1]).toBe(liveBone(harness, 1, 'Head'));
    bridge.dispose();
  });

  it('still loads, without shadows, when the body mesh skins a joint it does not have', async () => {
    exportSoma = await fixtureSoma();
    exportBody = true;
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness, { loadGltf: bodyLoader(['Hips', 'Tail']) });
    await spawnSkinned(bridge, harness.scene);
    expect(bridge.entryOf(1)?.ready).toBe(true);
    expect(harness.warnings.join(' ')).toContain('casts no shadow');
    bridge.dispose();
  });

  it("aims the head over the new skeleton's two neck joints and its head", async () => {
    exportSoma = await fixtureSoma();
    const harness = makeEngine([exported]);
    const bridge = await makeBridge(harness);
    await spawnSkinned(bridge, harness.scene);
    const overrides = [...(bridge.entryOf(1)?.animator?.jointOverrides.keys() ?? [])];
    expect(overrides).toEqual(['Neck1', 'Neck2', 'Head']);
    const head = liveBone(harness, 1, 'Head');
    const before = head.getWorldDirection(new Vector3()).clone();
    bridge.lookAt(1, { x: -100, y: 1.5, z: 0 }, 1);
    for (let i = 0; i < 300; i += 1) bridge.update(1 / 60);
    head.updateWorldMatrix(true, false);
    expect(head.getWorldDirection(new Vector3()).angleTo(before)).toBeGreaterThan(0.1);
    bridge.dispose();
  });
});
