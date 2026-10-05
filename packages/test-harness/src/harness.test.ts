import { describe, expect, it } from 'vitest';

import { createGuest, defineGame, keyIndex, prefab, readKeyBit } from '@gameable/sdk';

import {
  createFrameInput,
  createGameConfig,
  createInputState,
  endFrame,
  packBodies,
  press,
  release,
} from './frame-input';
import { hashCommands, hashFrameOutput, hashTransforms, stableJson } from './hash';
import { createMockHost } from './mock-host';
import { simulate } from './simulate';

const Box = prefab({ asset: 'box', body: { shape: 'box', kind: 'dynamic' } });

const game = defineGame({
  assets: ['box'],
  spawns: [{ prefab: Box, position: [0, 0, 0] }],
  systems: [
    (ctx) => {
      if (ctx.input.isDown('W')) ctx.physics.applyImpulse(1, 0, 0, -1);
      if (ctx.input.mousePressed(1)) {
        ctx.physics.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 50);
      }
      ctx.hud.set({ tick: Math.floor(ctx.frame / 20) });
    },
  ],
});

/**
 * A guest wired to a mock host, ready to tick.
 *
 * @returns The guest and its host.
 */
function makeGuest(): {
  guest: ReturnType<typeof createGuest>;
  host: ReturnType<typeof createMockHost>;
} {
  const host = createMockHost({
    seed: 99,
    assets: ['box'],
    raycast: (origin) => ({
      body: 1,
      entity: 1,
      point: origin,
      normal: { x: 0, y: 0, z: 1 },
      distance: 3,
    }),
  });
  const guest = createGuest(host, game);
  guest.init(createGameConfig({ seed: 99n }));
  return { guest, host };
}

describe('createMockHost', () => {
  it('records log lines and query counts', () => {
    const { guest, host } = makeGuest();
    const input = createInputState();
    press(input, 'W');
    guest.tick(createFrameInput({ frame: 0, input }));
    expect(host.rayCalls.raycast).toBe(0);

    endFrame(input);
    input.mouse.pressed = 1;
    guest.tick(createFrameInput({ frame: 1, input }));
    expect(host.rayCalls.raycast).toBe(1);
    expect(host.warnings()).toEqual([]);
  });

  it('mints stable handles and describes them', () => {
    const host = createMockHost({ assets: [{ name: 'arena', kind: 'splat', hasCollider: true }] });
    const id = host.resolveId('arena');
    expect(id).toBe(1);
    expect(host.resolveId('arena')).toBe(1);
    expect(host.describe(id!)?.kind).toBe('splat');
    expect(host.describe(999)).toBeUndefined();
  });

  it('refuses unknown names by default', () => {
    const host = createMockHost({ assets: ['arena'] });
    expect(host.resolveId('arena')).toBe(1);
    expect(host.resolveId('nope')).toBeUndefined();

    // `handleOf` is the deliberate escape hatch, and it registers the name for
    // `resolveId` too.
    expect(host.handleOf('nope')).toBe(2);
    expect(host.resolveId('nope')).toBe(2);
  });

  it('mints a handle for any name when strictness is switched off', () => {
    const host = createMockHost({ assets: ['arena'], strictAssets: false });
    expect(host.resolveId('whatever')).toBe(2);
    expect(host.resolveId('whatever')).toBe(2);
  });
});

describe('frame-input builders', () => {
  it('produces host-side shapes', () => {
    const input = createFrameInput({ frame: 3 });
    expect(typeof input.frame).toBe('bigint');
    expect(input.bodies).toBeInstanceOf(Float32Array);
    expect(input.input.keys.down).toBeInstanceOf(Uint32Array);
    expect(input.elapsed).toBeCloseTo(3 / 60, 6);
  });

  it('writes key bitsets through press and release', () => {
    const state = createInputState();
    press(state, 'W');
    expect(readKeyBit(state.keys.down, keyIndex('KeyW'))).toBe(true);
    expect(readKeyBit(state.keys.pressed, keyIndex('KeyW'))).toBe(true);

    endFrame(state);
    expect(readKeyBit(state.keys.down, keyIndex('KeyW'))).toBe(true);
    expect(readKeyBit(state.keys.pressed, keyIndex('KeyW'))).toBe(false);

    release(state, 'W');
    expect(readKeyBit(state.keys.down, keyIndex('KeyW'))).toBe(false);
    expect(readKeyBit(state.keys.released, keyIndex('KeyW'))).toBe(true);
  });

  it('covers both halves of a modifier alias', () => {
    const state = createInputState();
    press(state, 'Shift');
    expect(readKeyBit(state.keys.down, keyIndex('ShiftLeft'))).toBe(true);
    expect(readKeyBit(state.keys.down, keyIndex('ShiftRight'))).toBe(true);
  });

  it('rejects an unknown key name', () => {
    expect(() => {
      press(createInputState(), 'KeyNope');
    }).toThrow(/unknown key/);
  });

  it('packs bodies at stride 15, sorted by body id', () => {
    const bodies = packBodies([
      { body: 3, position: [1, 2, 3] },
      { body: 1, position: [4, 5, 6], linear: [7, 8, 9] },
    ]);
    expect(bodies).toHaveLength(30);
    expect(bodies[0]).toBe(1);
    expect(bodies[1]).toBe(4);
    expect(bodies[8]).toBe(7);
    expect(bodies[15]).toBe(3);
    expect(bodies[7]).toBe(1); // identity qw
  });
});

describe('hashing', () => {
  it('separates transform buffers that differ in one bit', () => {
    const a = new Float32Array([1, 2, 3]);
    // One f32 ulp at 3 is about 2.4e-7.
    const b = new Float32Array([1, 2, 3.0000005]);
    expect(hashTransforms(a)).toBe(hashTransforms(new Float32Array([1, 2, 3])));
    expect(hashTransforms(a)).not.toBe(hashTransforms(b));
  });

  it('is insensitive to key order but not to values', () => {
    expect(stableJson({ a: 1, b: 2 })).toBe(stableJson({ b: 2, a: 1 }));
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: 2 }));
    expect(stableJson(undefined)).toBe('null');
    expect(stableJson(new Float32Array([1, 2]))).toBe('[1,2]');
  });

  it('hashes command lists structurally', () => {
    expect(hashCommands([{ tag: 'despawn', val: 1 }])).toBe(
      hashCommands([{ tag: 'despawn', val: 1 }]),
    );
    expect(hashCommands([{ tag: 'despawn', val: 1 }])).not.toBe(
      hashCommands([{ tag: 'despawn', val: 2 }]),
    );
  });

  it('gives two identical runs the same frame hashes', () => {
    // One after the other: two direct guests share the SDK's component
    // arrays, so the second's init would take the first's away mid-run.
    const a = simulate(makeGuest().guest, { frames: 50 });
    const b = simulate(makeGuest().guest, { frames: 50 });
    expect(b.hashes).toEqual(a.hashes);
    expect(b.hash).toBe(a.hash);
  });
});

describe('simulate', () => {
  it('collects tags, hud and row counts, and scripts input', () => {
    const { guest } = makeGuest();
    const result = simulate(guest, {
      frames: 45,
      script: (frame, input) => {
        if (frame === 10) press(input, 'W');
        if (frame === 20) release(input, 'W');
      },
    });

    expect(result.hashes).toHaveLength(45);
    expect(result.commandTags[0]).toEqual(['spawn', 'add-body']);
    expect(result.commandTags[11]).toEqual(['apply-impulse']);
    expect(result.commandTags[25]).toEqual([]);
    expect(result.hud.map((h) => h.frame)).toEqual([0, 20, 40]);
    expect(result.transformRows[0]).toBe(1);
  });

  it('hashes the same tape identically twice', () => {
    const script = (frame: number, input: ReturnType<typeof createInputState>): void => {
      if (frame % 7 === 0) press(input, 'W');
      if (frame % 7 === 3) release(input, 'W');
    };
    const a = simulate(makeGuest().guest, { frames: 120, script });
    const b = simulate(makeGuest().guest, { frames: 120, script });
    expect(b.hash).toBe(a.hash);
  });

  it('hashes a whole frame-output including the camera and hud', () => {
    const { guest } = makeGuest();
    const out = guest.tick(createFrameInput({ frame: 0 }));
    expect(hashFrameOutput(out)).toBe(hashFrameOutput(out));
  });
});
