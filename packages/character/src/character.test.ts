// `createCharacter` end to end, against a recording device and a fake ONNX runtime.
//
// WHAT THIS IS FOR. Four of the character runtime's contracts are stated in comments,
// cost real frame time, and are invisible to every other kind of test:
//
//   ONE SUBMISSION PER UPDATE — `Character.ts` has said so since it was written and it
//   was `3B + 1` for B branches, because `setPoseGpu`, `GpuPlucker.compute` and
//   `GpuLifter.lift` each created and submitted an encoder of their own.
//
//   THE GEOM/APPEARANCE SPLIT — which could never fire, because every setter raised
//   `rigDirty` unconditionally. An idle bundle character ran trunk + geom + appr + lift
//   sixty times a second for a face that had not moved.
//
//   A FRESH WORLD MATRIX before the plücker camera reads it. The engine only updates
//   matrices inside `renderer.render`, which is AFTER this, so the rays were built from
//   where the avatar stood last frame.
//
//   `settled()` NOT SPINNING, and not queueing an extra appearance pass to find out
//   whether one was already running.
//
// The rig is REAL: the same 200-vertex myra fixture `gnm.test.ts` holds to the python
// oracle, posed by the real `GnmRigBackend` and anchored by the real calibration. Only
// the GPU and onnxruntime-web are fakes, because neither can run in node — and neither
// is what any of the above is about.

import { Object3D, PerspectiveCamera, Scene } from 'three/webgpu';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GNM_SEGMENTS, type CharacterManifest } from './assets/characterManifest.js';
import type { BranchAssets, MultiRegionScene } from './assets/loadMultiRegionScene.js';
import type { MeshAssets } from './assets/loader.js';
import type { BranchSpec, SceneManifest } from './assets/sceneManifest.js';
import type { CharacterBundle } from './bundle/loadCharacterBundle.js';
import { latestOnly } from './latestOnly.js';
import { parseAosRig } from './rig/gnm/gnmPack.js';
import { gnmPose } from './rig/gnm/gnmReference.js';
import { createFakeSplatSink } from './splatSink.js';
import {
  createFakeGpuDevice,
  installGpuGlobals,
  type FakeGpuDevice,
} from './testing/fakeDevice.js';

/** Everything the fake ORT module reports, reachable from a test. */
interface OrtState {
  /** The device `attachOrtDevice` handed over. */
  attached: object | null;
  /** When set, the getter reports THIS instead — ORT having built its own. */
  pretendOtherDevice: object | null;
  /** Runs per decoder role, so a test can see which halves of the chain re-ran. */
  runs: { trunk: number; geom: number; appr: number };
  /** Reset the run counters. */
  reset: () => void;
}

const ort = vi.hoisted<OrtState>(() => ({
  attached: null,
  pretendOtherDevice: null,
  runs: { trunk: 0, geom: 0, appr: 0 },
  reset() {
    this.runs = { trunk: 0, geom: 0, appr: 0 };
  },
}));

/** Marker byte identifying which decoder some fake `.onnx` bytes stand for. */
const ROLE_BYTE = { trunk: 1, geom: 2, appr: 3 } as const;

/** UV side length of the test branch; its splat count is the square. */
const UV_RES = 4;
const HW = UV_RES * UV_RES;

vi.mock('./ort.js', () => {
  /** An ORT tensor, as much of one as this package reads. */
  class Tensor {
    constructor(
      readonly type: string,
      readonly data: Float32Array,
      readonly dims: readonly number[],
    ) {}

    /**
     * Wrap a `GPUBuffer` as a gpu-buffer tensor.
     *
     * @param gpuBuffer The buffer.
     * @param options Its declared type and shape.
     * @param options.dataType ORT's element type name.
     * @param options.dims The tensor shape.
     *
     * @returns The wrapper the appearance session is fed.
     */
    static fromGpuBuffer(
      gpuBuffer: GPUBuffer,
      options: { dataType: string; dims: readonly number[] },
    ): unknown {
      return { gpuBuffer, dims: options.dims, location: 'gpu-buffer', type: options.dataType };
    }
  }

  const spec = {
    [ROLE_BYTE.trunk]: {
      inputNames: ['rig_params'],
      outputNames: ['code'],
      role: 'trunk' as const,
      out: () => ({ code: { data: new Float32Array(32), dims: [1, 32] } }),
    },
    [ROLE_BYTE.geom]: {
      inputNames: ['code'],
      outputNames: ['geom_uv'],
      role: 'geom' as const,
      out: () => ({
        geom_uv: { data: new Float32Array(11 * HW), dims: [1, 11, UV_RES, UV_RES] },
      }),
    },
    [ROLE_BYTE.appr]: {
      inputNames: ['code', 'plucker'],
      outputNames: ['color_uv'],
      role: 'appr' as const,
      out: () => ({
        color_uv: { data: new Float32Array(3 * HW), dims: [1, 3, UV_RES, UV_RES] },
      }),
    },
  };

  return {
    Tensor,
    env: {
      wasm: {},
      webgpu: {
        get device(): Promise<unknown> {
          return Promise.resolve(ort.pretendOtherDevice ?? ort.attached);
        },
        set device(value: object) {
          ort.attached = value;
        },
      },
    },
    InferenceSession: {
      /**
       * Build the fake session the marker byte names.
       *
       * @param src The model bytes; `src[0]` says which decoder this is.
       *
       * @returns A session that reports its IO names and answers with zeros.
       */
      create(src: Uint8Array): Promise<unknown> {
        const declared = spec[src[0] as 1 | 2 | 3];
        return Promise.resolve({
          inputNames: declared.inputNames,
          outputNames: declared.outputNames,
          run: () => {
            ort.runs[declared.role] += 1;
            return Promise.resolve(declared.out());
          },
          release: () => undefined,
        });
      },
    },
  };
});

const packBytes = new Uint8Array(
  readFileSync(new URL('../test/fixtures/gnm/myra-200.aosrig', import.meta.url)),
);
const pack = parseAosRig(packBytes);
/** The pack's own rest mesh, so calibration fits the identity with no residual. */
const neutralVertices = gnmPose(pack, new Float32Array(pack.header.headExt.dim));

/**
 * `.onnx` bytes for one decoder role, distinguishable by their first byte.
 *
 * @param role Which decoder these stand for.
 *
 * @returns The marker bytes the fake `InferenceSession.create` reads.
 */
function onnx(role: keyof typeof ROLE_BYTE): Uint8Array {
  return Uint8Array.from([ROLE_BYTE[role], 0, 0, 0]);
}

/**
 * A mesh the lift can bind: right sizes, all-valid, and the pack's own vertices.
 *
 * @returns The mesh assets one branch is built over.
 */
function meshAssets(): MeshAssets {
  const faces = 8;
  return {
    manifest: { uv_res: UV_RES, num_vertices: pack.vertexCount, num_faces: faces, buffers: [] },
    faces: new Uint32Array(faces * 3),
    idxim: new Int32Array(HW * 3),
    barim: new Float32Array(HW * 3),
    triim: new Int32Array(HW),
    valid: new Uint8Array(HW).fill(1),
    neutralVertices,
  };
}

/**
 * The one branch's `scene.json` entry, with every out-of-ONNX clamp off.
 *
 * @returns The branch spec.
 */
function branchSpec(): BranchSpec {
  return {
    name: 'head',
    geom: 'head_geom.onnx',
    appr: 'head_appr.onnx',
    trunk: 'head_trunk.onnx',
    uvRes: UV_RES,
    rigDim: pack.header.headExt.dim,
    scaleLogBias: 0,
    scaleLogMax: 0,
    sigmaMax: 0,
    sigmaOffset: 0,
    triKappa: 0,
    sliverQMin: 0,
    uvErode: 0,
  };
}

/**
 * A one-branch GNM bundle over the fixture pack.
 *
 * @returns The bundle, with every file it names resident.
 */
function bundle(): CharacterBundle {
  const spec = branchSpec();
  const sceneManifest: SceneManifest = {
    schemaVersion: '2',
    subject: 'fixture',
    mode: 'multi_region',
    numPoses: 0,
    order: ['head'],
    branches: { head: spec },
    rigRange: [-3, 3],
    worldScale: 1,
    momentScale: 0,
    worldOffset: [0, 0, 0],
    worldRotation: [0, 0, 0],
  };
  const manifest: CharacterManifest = {
    scene: sceneManifest,
    rig: { backend: 'gnm', pack: 'head.aosrig', controlNames: [], vertexCount: pack.vertexCount },
    expressionSpace: {
      kind: 'gnm',
      dim: pack.header.headExt.dim,
      names: [],
      segments: GNM_SEGMENTS,
    },
    rigNames: null,
  };
  const assets: BranchAssets = {
    name: 'head',
    spec,
    mesh: meshAssets(),
    uvRes: UV_RES,
    rigDim: spec.rigDim,
    referenceRig: null,
  };
  const scene: MultiRegionScene = { manifest: sceneManifest, branches: [assets], numPoses: 0 };
  const files = new Map<string, Uint8Array>([
    ['head.aosrig', packBytes],
    ['head_trunk.onnx', onnx('trunk')],
    ['head_geom.onnx', onnx('geom')],
    ['head_appr.onnx', onnx('appr')],
  ]);
  return {
    manifest,
    scene,
    bytes: {
      getBytes: (name) => files.get(name),
      fetchBytes: (name) => {
        const found = files.get(name);
        return found ? Promise.resolve(found) : Promise.reject(new Error(`no ${name}`));
      },
      totalBytes: 0,
    },
    resolver: (name) => {
      const found = files.get(name);
      return found ? Promise.resolve(found) : Promise.reject(new Error(`no ${name}`));
    },
    preferFp16: false,
    byteLength: 0,
  };
}

/** A live character plus everything a test needs to poke at it. */
interface Harness {
  character: Awaited<ReturnType<typeof import('./Character.js').createCharacter>>;
  gpu: FakeGpuDevice;
  camera: PerspectiveCamera;
  scene: Scene;
  logs: string[];
}

/**
 * Build a character over the fixture bundle.
 *
 * @returns The harness, with the device's books reset so a test measures only what it
 *   does next. The load-time pass has already run.
 */
async function harness(): Promise<Harness> {
  const { createCharacter } = await import('./Character.js');
  const gpu = createFakeGpuDevice();
  const scene = new Scene();
  const sink = createFakeSplatSink(4096, new Object3D());
  const logs: string[] = [];
  const character = await createCharacter(bundle(), {
    renderer: { backend: { device: gpu.device, isWebGPUBackend: true } },
    scene,
    sink,
    options: { log: (message) => logs.push(message) },
  });
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 2);
  camera.updateMatrixWorld(true);
  // Settle the first camera state so a test's own update is the only thing moving.
  character.update(1 / 60, camera);
  await character.settled();
  gpu.log.reset();
  ort.reset();
  return { character, gpu, camera, scene, logs };
}

/**
 * A full `head_ext` vector with one coefficient set.
 *
 * @param value What to put in slot 0.
 *
 * @returns The vector.
 */
function expression(value: number): Float32Array {
  const out = new Float32Array(pack.header.headExt.dim);
  out[0] = value;
  return out;
}

beforeEach(() => {
  installGpuGlobals();
  ort.pretendOtherDevice = null;
  ort.attached = null;
  ort.reset();
});

describe('one character update, one pair of submissions', () => {
  it('submits exactly twice for a full pass, whatever the branch count', async () => {
    const test = await harness();
    test.character.setExpression(expression(0.5));
    test.character.update(1 / 60, test.camera);
    await test.character.settled();

    // Geometry + plücker, then the lift. Never `3B + 1`.
    expect(test.gpu.log.submits).toHaveLength(2);
    const [geometry, lift] = test.gpu.log.submits;
    // The rig deform, the copy into the lifter, the vertex transform, the jacobians
    // and the rays — all in the encoder that is submitted before ORT is awaited.
    expect(geometry).toEqual(['gnm_blend', 'copy', 'vert_transform', 'jacobian', 'plucker']);
    expect(lift).toEqual(['pass1', 'pass2']);
  });

  it('submits exactly twice for a camera-only pass, and re-decodes appearance alone', async () => {
    const test = await harness();
    test.camera.position.set(1.5, 0.5, 2);
    test.camera.updateMatrixWorld(true);
    test.character.update(1 / 60, test.camera);
    await test.character.settled();

    expect(test.gpu.log.submits).toHaveLength(2);
    // No rig pass at all: the cached `code` is re-coloured against new rays.
    expect(test.gpu.log.submits[0]).toEqual(['plucker']);
    expect(ort.runs).toEqual({ trunk: 0, geom: 0, appr: 1 });
  });

  it('does not re-upload the geometry map on an appearance-only pass', async () => {
    const test = await harness();
    test.camera.position.set(1.5, 0.5, 2);
    test.camera.updateMatrixWorld(true);
    test.character.update(1 / 60, test.camera);
    await test.character.settled();

    const labels = test.gpu.log.writes.map((w) => w.label);
    // `color_uv` is exactly what this pass recomputed; `geom_uv` is the array the last
    // full pass already uploaded, and on a 750² head that is 11 MB of nothing.
    expect(labels).toContain('color_uv');
    expect(labels).not.toContain('geom_uv');
  });
});

describe('the dirty flags actually gate the pass', () => {
  it('runs nothing for an identical expression', async () => {
    const test = await harness();
    test.character.setExpression(expression(0.5));
    test.character.update(1 / 60, test.camera);
    await test.character.settled();
    test.gpu.log.reset();
    ort.reset();

    // The same vector, pushed again — which is what an idle face does sixty times a
    // second while it waits for the next viseme.
    test.character.setExpression(expression(0.5));
    test.character.update(1 / 60, test.camera);
    await test.character.settled();

    expect(ort.runs).toEqual({ trunk: 0, geom: 0, appr: 0 });
    expect(test.gpu.log.submits).toEqual([]);
    expect(test.gpu.log.writes).toEqual([]);
  });

  it('runs nothing for an identical look-at target', async () => {
    const test = await harness();
    test.character.setLookAt([0, 1.6, 3]);
    test.character.update(1 / 60, test.camera);
    await test.character.settled();
    ort.reset();
    test.gpu.log.reset();

    test.character.setLookAt([0, 1.6, 3]);
    test.character.update(1 / 60, test.camera);
    await test.character.settled();
    expect(ort.runs.trunk).toBe(0);

    // A target that actually moved still costs a full pass.
    test.character.setLookAt([1, 1.6, 3]);
    test.character.update(1 / 60, test.camera);
    await test.character.settled();
    expect(ort.runs.trunk).toBe(1);
  });

  it('runs nothing for an identical expression WHILE a look-at target is live', async () => {
    const test = await harness();
    // The bridge sends both, every frame, on any character that tracks the player.
    // Folding the gaze into the vector the setters compare against left four floats in
    // it that no caller ever wrote, so the next `setExpression` saw a zero gaze where
    // the applied one sat, called it a change, and ran a full pass — every frame, for
    // as long as the character was looking at anything.
    for (let i = 0; i < 3; i += 1) {
      test.character.setExpression(expression(0.5));
      test.character.setLookAt([0, 1.6, 3]);
      test.character.update(1 / 60, test.camera);
      await test.character.settled();
    }
    const settled = ort.runs.trunk;

    test.character.setExpression(expression(0.5));
    test.character.setLookAt([0, 1.6, 3]);
    test.character.update(1 / 60, test.camera);
    await test.character.settled();
    expect(ort.runs.trunk).toBe(settled);
  });

  it('runs nothing for a body pose whose joints did not move', async () => {
    const test = await harness();
    const bones = [{ joint: 'head', rotation: [1, 0, 0, 0] as const }];
    test.character.setBodyPose({ bones });
    test.character.update(1 / 60, test.camera);
    await test.character.settled();
    ort.reset();

    // The BACKEND decides: a converged head aim resends the same quaternions, and a
    // rig with no addressable joints ignores them outright.
    test.character.setBodyPose({ bones });
    test.character.update(1 / 60, test.camera);
    await test.character.settled();
    expect(ort.runs).toEqual({ trunk: 0, geom: 0, appr: 0 });
  });
});

describe('the root world matrix', () => {
  it('is fresh before the local-frame camera reads it', async () => {
    const test = await harness();
    // Move the AVATAR, not the camera. Nothing else in the engine updates matrices
    // before `characters.update` — `renderer.render` does it afterwards — so a stale
    // `root.matrixWorld` means the local-frame camera sees the avatar where it was
    // last frame and this update notices nothing at all.
    test.character.object3D.position.set(0, 0, -1);
    test.character.update(1 / 60, test.camera);
    await test.character.settled();

    expect(ort.runs.appr).toBe(1);
    expect(test.gpu.log.submits).toHaveLength(2);
  });
});

describe('verifyOrtDevice', () => {
  it('demotes every decoder to CPU outputs when ORT built its own device', async () => {
    const { createCharacter } = await import('./Character.js');
    const gpu = createFakeGpuDevice();
    // The setter succeeds — it always does — and the getter then reports a different
    // object, which is the only honest signal that ORT ignored it.
    ort.pretendOtherDevice = { notTheRenderers: true };
    const logs: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const character = await createCharacter(bundle(), {
      renderer: { backend: { device: gpu.device, isWebGPUBackend: true } },
      scene: new Scene(),
      sink: createFakeSplatSink(4096, new Object3D()),
      options: { log: (message) => logs.push(message) },
    });

    expect(logs.some((line) => line.includes('demoting'))).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toContain('ORT built its own WebGPU device');
    warn.mockRestore();
    character.dispose();
  });
});

describe('settled()', () => {
  it('drains the in-flight pass without queueing another one', async () => {
    const test = await harness();
    test.character.setExpression(expression(0.25));
    test.character.update(1 / 60, test.camera);
    // The old implementation spun on `isRunning()` and called the pump on every turn,
    // so draining a full pass ran an EXTRA appearance pass to discover it was done.
    await test.character.settled();
    expect(ort.runs).toEqual({ trunk: 1, geom: 1, appr: 1 });
  });

  it('resolves immediately when nothing is in flight', async () => {
    const test = await harness();
    await test.character.settled();
    expect(ort.runs).toEqual({ trunk: 0, geom: 0, appr: 0 });
  });
});

describe('latestOnly.whenIdle', () => {
  it('waits for the run and its replays, and starts nothing itself', async () => {
    const started: string[] = [];
    const pump = latestOnly(async (tag: string) => {
      started.push(tag);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    void pump('first');
    void pump('second'); // parked as the newest arguments; replays on the way out
    await pump.whenIdle();

    // Both the run and the replay it coalesced have finished, and waiting for them
    // did not itself invoke the task — which is exactly what the old `while
    // (isRunning()) await pump(...)` loop did, once per microtask turn.
    expect(started).toEqual(['first', 'second']);
    expect(pump.isRunning()).toBe(false);
    await pump.whenIdle();
    expect(started).toEqual(['first', 'second']);
  });
});
