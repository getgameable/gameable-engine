// `GnmRigBackend` against a recording device: what it uploads, and what it allocates.
//
// `gnm.test.ts` holds the ARITHMETIC to the python oracle and deliberately touches no
// GPU. This file is the other half — the per-frame bookkeeping around that arithmetic,
// which no amount of numerical agreement can see:
//
//   `setJointOverrides` rebuilt a name->index `Map` from the pack header, allocated two
//   `Float32Array(J*16)` and re-ran the whole skin-matrix pass on EVERY call, including
//   the sixty calls a second a converged head aim makes with identical quaternions.
//
//   `encode` raised one dirty flag for both uniforms, so a talking face re-uploaded the
//   joint matrices it had not moved and a turning neck re-uploaded the expression
//   coefficients it had not changed.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { GnmRigBackend } from './rig/gnm/GnmRigBackend.js';
import {
  createFakeGpuDevice,
  installGpuGlobals,
  type FakeGpuDevice,
} from './testing/fakeDevice.js';

const packBytes = new Uint8Array(
  readFileSync(new URL('../test/fixtures/gnm/myra-200.aosrig', import.meta.url)),
);

/** `head_ext` width of the shipped layout, which the fixture carries in full. */
const HEAD_EXT_DIM = 387;

/**
 * An initialised backend over the fixture pack and a recording device.
 *
 * @returns The backend and the device's books, already reset so the caller measures
 *   only what it does next.
 */
async function backend(): Promise<{ rig: GnmRigBackend; gpu: FakeGpuDevice }> {
  const gpu = createFakeGpuDevice();
  const rig = new GnmRigBackend({
    packFile: 'pack.aosrig',
    log: () => {
      /* silent */
    },
  });
  await rig.init({
    device: gpu.device,
    getBytes: (name) => (name === 'pack.aosrig' ? packBytes : undefined),
    controlNames: [],
  });
  gpu.log.reset();
  return { rig, gpu };
}

/**
 * A unit quaternion about +Y, as the pack's `(w, x, y, z)` order.
 *
 * @param angle Rotation in radians.
 *
 * @returns The rotation.
 */
function yaw(angle: number): [number, number, number, number] {
  return [Math.cos(angle / 2), 0, Math.sin(angle / 2), 0];
}

beforeEach(() => {
  installGpuGlobals();
});

describe('GnmRigBackend.setJointOverrides', () => {
  it('reports the first push as a change and an identical repeat as none', async () => {
    const { rig } = await backend();
    const overrides = [{ joint: 'head', rotation: yaw(0.2) }];

    // The first push moves the rig even though the rotation it carries may match the
    // rest: "never pushed" and "pushed the rest pose" are different states.
    expect(rig.setJointOverrides(overrides)).toBe(true);
    expect(rig.setJointOverrides(overrides)).toBe(false);
    expect(rig.setJointOverrides([{ joint: 'head', rotation: yaw(0.2) }])).toBe(false);
    expect(rig.setJointOverrides([{ joint: 'head', rotation: yaw(0.3) }])).toBe(true);
  });

  it('counts a joint DROPPED from the list as a change', async () => {
    const { rig } = await backend();
    rig.setJointOverrides([
      { joint: 'head', rotation: yaw(0.2) },
      { joint: 'neck_01', rotation: yaw(0.1) },
    ]);
    // `neck_01` has to fall back to its rest, which the rotations alone cannot say —
    // the set of NAMED joints is part of the comparison.
    expect(rig.setJointOverrides([{ joint: 'head', rotation: yaw(0.2) }])).toBe(true);
  });

  it('ignores a joint this pack does not carry', async () => {
    const { rig } = await backend();
    rig.setJointOverrides([{ joint: 'head', rotation: yaw(0.2) }]);
    // The body rig has joints the head does not; naming one must not read as movement.
    expect(rig.setJointOverrides([{ joint: 'head', rotation: yaw(0.2) }])).toBe(false);
    expect(
      rig.setJointOverrides([
        { joint: 'head', rotation: yaw(0.2) },
        { joint: 'c_not_in_this_pack', rotation: yaw(0.9) },
      ]),
    ).toBe(false);
  });

  it('does not grow its heap across a thousand MOVING pushes', async () => {
    const { rig } = await backend();
    // Deliberately a different angle every call, so the change gate cannot make this
    // vacuous: every one of these runs the full local-rest rebuild, the override
    // recompose, the forward walk and the skin-matrix pass.
    const overrides = [
      { joint: 'head', rotation: yaw(0) },
      { joint: 'neck_01', rotation: yaw(0) },
    ];
    /**
     * One aim step, at an angle nothing has been posed at before.
     *
     * @param i The step index, which picks the angle.
     */
    const step = (i: number): void => {
      overrides[0].rotation = yaw(0.3 + i * 1e-4);
      overrides[1].rotation = yaw(0.1 + i * 1e-4);
      rig.setJointOverrides(overrides);
    };

    // Warm up: JIT and the backend's own lazily sized buffers settle here.
    for (let i = 0; i < 200; i += 1) step(i);
    global.gc?.();
    const before = process.memoryUsage().heapUsed;

    for (let i = 200; i < 1200; i += 1) step(i);

    global.gc?.();
    const growth = process.memoryUsage().heapUsed - before;
    // A thousand frames of the old path allocated a Map, two `Float32Array(J*16)` and
    // a `Float32Array(J*16)` of skin matrices each — megabytes. 4 MB of slack covers
    // V8 noise without covering a real leak.
    expect(growth).toBeLessThan(4 * 1024 * 1024);
  }, 60_000);
});

describe('GnmRigBackend uniform uploads', () => {
  it('uploads nothing at all when neither the face nor the joints moved', async () => {
    const { rig, gpu } = await backend();
    const encoder = gpu.device.createCommandEncoder();
    rig.setControls(new Float32Array(HEAD_EXT_DIM));
    rig.encode(encoder);
    expect(gpu.log.writes.length).toBeGreaterThan(0);

    gpu.log.reset();
    rig.setControls(new Float32Array(HEAD_EXT_DIM));
    rig.encode(gpu.device.createCommandEncoder());
    // Same vector, same joints: the dispatch is still recorded (the output buffer is
    // the lift's input and has to be rewritten), but not one byte is re-uploaded.
    expect(gpu.log.writes).toEqual([]);
  });

  it('uploads the expression half alone when only the face moved', async () => {
    const { rig, gpu } = await backend();
    rig.setControls(new Float32Array(HEAD_EXT_DIM));
    rig.encode(gpu.device.createCommandEncoder());

    gpu.log.reset();
    const moved = new Float32Array(HEAD_EXT_DIM);
    moved[0] = 0.5;
    rig.setControls(moved);
    rig.encode(gpu.device.createCommandEncoder());
    const labels = gpu.log.writes.map((w) => w.label);
    expect(labels).toContain('gnm_expr');
    expect(labels).toContain('gnm_params');
    // The neck did not turn, so 42 KB of joint matrices stay where they are.
    expect(labels).not.toContain('gnm_skin_rows');
  });

  it('uploads the skin rows alone when only the joints moved', async () => {
    const { rig, gpu } = await backend();
    rig.setControls(new Float32Array(HEAD_EXT_DIM));
    rig.encode(gpu.device.createCommandEncoder());

    gpu.log.reset();
    rig.setJointOverrides([{ joint: 'head', rotation: yaw(0.4) }]);
    rig.encode(gpu.device.createCommandEncoder());
    const labels = gpu.log.writes.map((w) => w.label);
    expect(labels).toEqual(['gnm_skin_rows']);
  });

  it('records its dispatch into the caller-supplied encoder and submits nothing', async () => {
    const { rig, gpu } = await backend();
    const encoder = gpu.device.createCommandEncoder();
    rig.setControls(new Float32Array(HEAD_EXT_DIM));
    rig.encode(encoder);
    // "One submission per character update" is only true if every producer records.
    expect(gpu.log.submits).toEqual([]);
  });
});
