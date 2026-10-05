import { beforeEach, describe, expect, it } from 'vitest';

import { commandPoolSize } from './commands';
import { defineGame } from './defineGame';
import { RigidBody, Transform, Velocity } from './ecs';
import {
  BODY_STRIDE,
  BodyIndex,
  TRANSFORM_FLAGS,
  TRANSFORM_STRIDE,
  TransformPacker,
  markMoved,
} from './packing';
import { physics } from './physics';
import { prefab, resetPrefabRegistry } from './prefab';
import { createGuest } from './runtime';
import { createStubHost, stubConfig, stubFrame, stubInput } from './testing';

describe('TransformPacker', () => {
  it('writes stride-12 rows in ascending entity order', () => {
    const packer = new TransformPacker(16);
    Transform.x[3] = 1;
    Transform.qw[3] = 1;
    Transform.x[1] = 2;
    Transform.qw[1] = 1;
    packer.mark(3, 1);
    packer.mark(1, 3);

    const out = packer.pack();
    expect(out.length).toBe(2 * TRANSFORM_STRIDE);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(3);
    expect(out[TRANSFORM_STRIDE]).toBe(3);
    expect(out[TRANSFORM_STRIDE + 1]).toBe(1);
  });

  it('never returns a zero-length list', () => {
    const packer = new TransformPacker(16);
    const out = packer.pack();
    expect(out.length).toBe(TRANSFORM_STRIDE);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });

  it('memoises one subarray per row count', () => {
    const packer = new TransformPacker(16);
    packer.mark(1, 1);
    const first = packer.pack();
    packer.mark(1, 1);
    const second = packer.pack();
    expect(second).toBe(first);
  });

  it('clears dirty flags after packing', () => {
    const packer = new TransformPacker(16);
    packer.mark(2, 7);
    expect(packer.pack().length).toBe(TRANSFORM_STRIDE);
    expect(packer.pack().length).toBe(TRANSFORM_STRIDE);
    expect(packer.pack()[0]).toBe(0);
  });

  it('raises the high-water mark, then lets it decay', () => {
    const packer = new TransformPacker(64);
    packer.mark(40, 1);
    expect(packer.highWater).toBe(40);
    packer.pack();
    // Everything above the last dirty entity was clean, so the next scan
    // stops there instead of walking 40 slots a frame forever.
    expect(packer.highWater).toBe(40);

    packer.mark(3, 1);
    expect(packer.highWater).toBe(40);
    packer.pack();
    expect(packer.highWater).toBe(3);

    packer.pack();
    expect(packer.highWater).toBe(0);

    // And it comes straight back when something high moves again.
    packer.mark(41, 1);
    expect(packer.highWater).toBe(41);
    expect(packer.pack()[0]).toBe(41);
  });

  it('marks a hand-written transform through markMoved', () => {
    resetPrefabRegistry();
    const Ghost = prefab({ asset: 'ghost' });
    const game = defineGame({
      spawns: [{ prefab: Ghost, position: [0, 0, 0] }],
      systems: [
        (ctx) => {
          if (ctx.frame !== 2) return;
          Transform.y[1] = 5;
          markMoved(1, TRANSFORM_FLAGS.POSITION);
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    guest.tick(stubFrame(0)); // carries the spawn
    expect(guest.tick(stubFrame(1)).transforms[0]).toBe(0); // nothing moved
    const moved = guest.tick(stubFrame(2)).transforms;
    expect(moved[0]).toBe(1);
    expect(moved[1]).toBe(TRANSFORM_FLAGS.POSITION);
    expect(moved[3]).toBe(5);
    expect(guest.tick(stubFrame(3)).transforms[0]).toBe(0);
  });
});

describe('body ingestion', () => {
  it('carries real ground contact even at zero vertical speed', () => {
    const index = new BodyIndex(8);
    index.bind(1, 3);
    RigidBody.handle[3] = 1;
    const row = new Float32Array(BODY_STRIDE);
    row[0] = 1;
    row[7] = 1;
    for (const contact of [1, 4, 2, 3, 0]) {
      row[14] = contact;
      index.ingest(row);
      expect(Velocity.y[3]).toBe(0);
      expect(RigidBody.groundState[3]).toBe(contact);
      expect(physics.isGrounded(3)).toBe(contact === 1);
    }
  });
  it('maps stride-15 rows onto Transform and Velocity', () => {
    resetPrefabRegistry();
    const Box = prefab({ body: { shape: 'box', kind: 'dynamic' } });
    const game = defineGame({ spawns: [{ prefab: Box, position: [0, 0, 0] }] });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    const bodies = new Float32Array(BODY_STRIDE);
    bodies[0] = 1; // body id minted by the first spawn
    bodies[1] = 4;
    bodies[2] = 5;
    bodies[3] = 6;
    bodies[7] = 1; // qw
    bodies[8] = 0.5; // linear x

    guest.tick(stubFrame(0, stubInput(), bodies));

    expect(Transform.x[1]).toBe(4);
    expect(Transform.y[1]).toBe(5);
    expect(Transform.z[1]).toBe(6);
    expect(Velocity.x[1]).toBe(0.5);
  });

  it('does not mark an ingested body, because the host already drew it', () => {
    const index = new BodyIndex(8);
    const packer = new TransformPacker(8);
    index.bind(1, 3);

    const bodies = new Float32Array(BODY_STRIDE);
    bodies[0] = 1;
    bodies[2] = 5;
    bodies[7] = 1;
    index.ingest(bodies);

    expect(Transform.y[3]).toBe(5);
    expect(index.lastRowCount).toBe(1);
    // Nothing dirty: the physics module handed these same rows to the adapter
    // the moment it stepped, so packing them again would send the host twelve
    // floats it has already applied.
    expect(packer.pack()[0]).toBe(0);
    expect(packer.highWater).toBe(0);

    // A guest that authors a move says so, and that row does cross.
    Transform.y[3] = 9;
    packer.mark(3, TRANSFORM_FLAGS.POSITION);
    const packed = packer.pack();
    expect(packed[0]).toBe(3);
    expect(packed[3]).toBe(9);
  });
});

describe('steady-state allocation', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('reuses the transform subarray and the command pool across 1000 ticks', () => {
    const Mover = prefab({ asset: 'box', body: { shape: 'box', kind: 'dynamic' } });
    const game = defineGame({
      spawns: [
        { prefab: Mover, position: [0, 0, 0] },
        { prefab: Mover, position: [1, 0, 0] },
      ],
      systems: [
        (ctx) => {
          ctx.physics.setVelocity(1, 1, 0, 0);
          ctx.hud.set({ frame: 0 });
          // A guest-authored move: ingesting the body rows no longer marks
          // anything, so this is what keeps a row in `frame-output.transforms`
          // and proves the memoised subarray is reused rather than never used.
          Transform.y[2] = Math.sin(ctx.frame * 0.05);
          markMoved(2, TRANSFORM_FLAGS.POSITION);
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    const bodies = new Float32Array(BODY_STRIDE * 2);
    bodies[0] = 1;
    bodies[7] = 1;
    bodies[BODY_STRIDE] = 2;
    bodies[BODY_STRIDE + 7] = 1;
    const input = stubInput();

    /**
     * Move body 1 a little, so the packed values really change every tick and
     * the memoised subarray is proved to be reused rather than never touched.
     *
     * @param frame The frame number.
     * @returns The body rows to hand the guest.
     */
    function step(frame: number): Float32Array {
      bodies[2] = Math.sin(frame * 0.05);
      bodies[BODY_STRIDE + 2] = Math.cos(frame * 0.05);
      return bodies;
    }

    // Warm up: the first few ticks grow the pools and mint the subarrays.
    for (let frame = 0; frame < 5; frame += 1) guest.tick(stubFrame(frame, input, step(frame)));

    const poolBefore = commandPoolSize();
    const transformsBefore = guest.tick(stubFrame(5, input, step(5))).transforms;
    const commandsBefore = guest.tick(stubFrame(6, input, step(6))).commands;

    for (let frame = 7; frame < 1007; frame += 1) {
      const out = guest.tick(stubFrame(frame, input, step(frame)));
      expect(out.transforms).toBe(transformsBefore);
      expect(out.commands).toBe(commandsBefore);
      // One row, entity 2, the one the system moved; lane 3 is its y.
      expect(out.transforms[0]).toBe(2);
      expect(out.transforms[3]).toBe(Math.fround(Math.sin(frame * 0.05)));
    }

    expect(commandPoolSize()).toBe(poolBefore);
  });
});
