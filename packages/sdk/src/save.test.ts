import { beforeEach, describe, expect, it } from 'vitest';

import { defineGame } from './defineGame';
import { Health, RigidBody, Transform } from './ecs';
import { prefab, resetPrefabRegistry } from './prefab';
import { createGuest } from './runtime';
import { SNAPSHOT_VERSION } from './save';
import { createStubHost, stubConfig, stubFrame } from './testing';

/**
 * A game that drifts every frame, so a snapshot taken mid-run is meaningfully
 * different from a fresh `init`.
 *
 * @returns The definition and the prefab it spawns.
 */
function makeGame(): ReturnType<typeof defineGame> {
  const Box = prefab({ asset: 'box', health: 50, body: { shape: 'box', kind: 'dynamic' } });
  return defineGame({
    spawns: [
      { prefab: Box, position: [0, 0, 0] },
      { prefab: Box, position: [1, 0, 0] },
    ],
    systems: [
      (ctx) => {
        Transform.x[1] = Transform.x[1] + ctx.rng.float();
        Health.current[2] = Health.current[2] - 0.25;
        ctx.hud.set({ x: Math.round(Transform.x[1] * 1000) });
      },
    ],
    snapshot: () => ({ marker: 'user-state', at: Transform.x[1] }),
    restore: (state) => {
      restored = state;
    },
  });
}

let restored: unknown;

describe('snapshot and restore', () => {
  beforeEach(() => {
    resetPrefabRegistry();
    restored = undefined;
  });

  it('round-trips component arrays, counters and the RNG', () => {
    const game = makeGame();
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    for (let frame = 0; frame < 40; frame += 1) guest.tick(stubFrame(frame));

    RigidBody.groundState[1] = 1;
    const snapshot = guest.snapshot();
    RigidBody.groundState[1] = 4;
    expect(snapshot).toBeInstanceOf(Uint8Array);
    expect(snapshot[0]).toBe(0x41); // 'A'
    expect(new DataView(snapshot.buffer).getUint32(4, true)).toBe(SNAPSHOT_VERSION);

    const expected: number[] = [];
    for (let frame = 40; frame < 50; frame += 1) {
      guest.tick(stubFrame(frame));
      expected.push(Transform.x[1], Health.current[2]);
    }

    guest.restore(snapshot);
    expect(RigidBody.groundState[1]).toBe(1);
    const user = restored as { marker: string; at: number };
    expect(user.marker).toBe('user-state');
    expect(typeof user.at).toBe('number');

    const actual: number[] = [];
    for (let frame = 40; frame < 50; frame += 1) {
      guest.tick(stubFrame(frame));
      actual.push(Transform.x[1], Health.current[2]);
    }
    expect(actual).toEqual(expected);
  });

  it('restores into a second guest instance', () => {
    const game = makeGame();
    const first = createGuest(createStubHost(), game);
    first.init(stubConfig());
    for (let frame = 0; frame < 20; frame += 1) first.tick(stubFrame(frame));
    const snapshot = first.snapshot();
    const expected = first.tick(stubFrame(20));
    const expectedTransforms = Array.from(expected.transforms);

    const second = createGuest(createStubHost(), game);
    second.init(stubConfig());
    second.restore(snapshot);
    const actual = second.tick(stubFrame(20));
    expect(Array.from(actual.transforms)).toEqual(expectedTransforms);
  });

  it('refuses foreign and mis-versioned payloads', () => {
    const game = makeGame();
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    expect(() => {
      guest.restore(new Uint8Array(4));
    }).toThrow();
    expect(() => {
      guest.restore(new Uint8Array(64));
    }).toThrow();

    const snapshot = guest.snapshot();
    new DataView(snapshot.buffer).setUint32(4, SNAPSHOT_VERSION + 1, true);
    expect(() => {
      guest.restore(snapshot);
    }).toThrow(/snapshot version/);
  });

  it('accepts a plain array, the way a non-typed-array host might send one', () => {
    const game = makeGame();
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));
    const snapshot = Array.from(guest.snapshot());
    expect(() => {
      guest.restore(snapshot);
    }).not.toThrow();
  });
});
