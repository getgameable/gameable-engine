/**
 * Body ids are reused (3.8 fix round 2): a freed id goes on a free list, the
 * next body takes the lowest free id, and the counter only moves when the list
 * is empty. So the live body count, not the lifetime spawn count, is what the
 * host's `maxBodies` must hold.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { defineGame, type GameContext } from './defineGame';
import { prefab, resetPrefabRegistry } from './prefab';
import { createGuest } from './runtime';
import { createStubHost, stubConfig, stubFrame } from './testing';
import type { FrameOutput } from './types';

/**
 * @param out A frame's output.
 * @returns The body ids its `add-body` commands name, in order.
 */
function addedBodies(out: FrameOutput): number[] {
  return out.commands.filter((c) => c.tag === 'add-body').map((c) => c.val.body);
}

describe('body ids', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('reuses the lowest freed id first, and counts up only when none is free', () => {
    const Box = prefab({ body: { shape: 'box', kind: 'dynamic' } });
    const made: number[] = [];
    const game = defineGame({
      systems: [
        (ctx: GameContext) => {
          if (ctx.frame === 1) for (let i = 0; i < 5; i += 1) made.push(ctx.spawn(Box, { x: 0, y: 0, z: 0 }));
          if (ctx.frame === 2) {
            ctx.despawn(made[3]); // body 4
            ctx.despawn(made[1]); // body 2
          }
          if (ctx.frame === 3) for (let i = 0; i < 3; i += 1) ctx.spawn(Box, { x: 0, y: 0, z: 0 });
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    const ids: number[][] = [];
    for (let frame = 0; frame < 4; frame += 1) ids.push(addedBodies(guest.tick(stubFrame(frame))));
    expect(ids[1]).toEqual([1, 2, 3, 4, 5]);
    expect(ids[3]).toEqual([2, 4, 6]);
  });

  it('keeps ids under the live count: 10,000 projectiles with at most 50 alive', () => {
    const Shot = prefab({ body: { shape: 'sphere', kind: 'dynamic', dims: [0.1] } });
    const alive: number[] = [];
    const game = defineGame({
      systems: [
        (ctx: GameContext) => {
          for (let i = 0; i < 50; i += 1) {
            if (alive.length >= 50) {
              const at = (ctx.frame * 7 + i * 13) % alive.length; // out of order: a scrambled free list
              ctx.despawn(alive[at]);
              alive[at] = alive[alive.length - 1];
              alive.pop();
            }
            alive.push(ctx.spawn(Shot, { x: 0, y: 0, z: 0 }));
          }
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    let count = 0;
    let highest = 0;
    for (let frame = 0; frame < 200; frame += 1) {
      for (const id of addedBodies(guest.tick(stubFrame(frame)))) {
        count += 1;
        highest = Math.max(highest, id);
      }
    }
    expect(count).toBe(10_000);
    expect(highest).toBe(50);
  });

  it('a restored guest hands out the same ids as the one that took the snapshot', () => {
    const Box = prefab({ body: { shape: 'box', kind: 'dynamic' } });
    const made: number[] = [];
    const game = defineGame({
      systems: [
        (ctx: GameContext) => {
          if (ctx.frame === 10) {
            ctx.despawn(made[6]); // body 7
            ctx.despawn(made[2]); // body 3: the snapshot holds two freed ids
          } else made.push(ctx.spawn(Box, { x: 0, y: 0, z: 0 }));
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    for (let frame = 0; frame <= 10; frame += 1) guest.tick(stubFrame(frame));
    const snapshot = guest.snapshot();
    const expected: number[] = [];
    for (let frame = 11; frame < 15; frame += 1) expected.push(...addedBodies(guest.tick(stubFrame(frame))));
    expect(expected).toEqual([3, 7, 11, 12]);
    guest.restore(snapshot); // nextBody back to 11, 3 and 7 free again: the list is rebuilt
    const actual: number[] = [];
    for (let frame = 11; frame < 15; frame += 1) actual.push(...addedBodies(guest.tick(stubFrame(frame))));
    expect(actual).toEqual(expected);
  });
  it('never hands out a live id after a restore that left nextBody unchanged (the re-review probe)', () => {
    const Box = prefab({ body: { shape: 'box', kind: 'dynamic' } });
    const made: number[] = [];
    const game = defineGame({
      systems: [
        (ctx: GameContext) => {
          if (ctx.frame < 10) made.push(ctx.spawn(Box, { x: 0, y: 0, z: 0 })); // ids 1-10
          if (ctx.frame === 10) {
            ctx.despawn(made[6]); // 7
            ctx.despawn(made[2]); // 3: snapshot here, nextBody 11
          }
          if (ctx.frame === 11) ctx.despawn(made[4]); // 5, then the restore brings it back alive
          if (ctx.frame === 12) for (let i = 0; i < 3; i += 1) ctx.spawn(Box, { x: 0, y: 0, z: 0 });
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    for (let frame = 0; frame <= 10; frame += 1) guest.tick(stubFrame(frame));
    const snapshot = guest.snapshot();
    guest.tick(stubFrame(11)); // frees 5: the pool holds 3, 5, 7 and nextBody is still 11
    guest.restore(snapshot); // 5 is alive again
    const ids = addedBodies(guest.tick(stubFrame(12)));
    expect(ids).toEqual([3, 7, 11]);
  });

  it('keeps the free list a restore brings back, after frames that reused ids', () => {
    const Box = prefab({ body: { shape: 'box', kind: 'dynamic' } });
    const made: number[] = [];
    const game = defineGame({
      systems: [
        (ctx: GameContext) => {
          if (ctx.frame < 10) made.push(ctx.spawn(Box, { x: 0, y: 0, z: 0 }));
          if (ctx.frame === 10) {
            ctx.despawn(made[6]);
            ctx.despawn(made[2]); // snapshot: 3 and 7 free, nextBody 11
          }
          if (ctx.frame === 11) {
            ctx.spawn(Box, { x: 0, y: 0, z: 0 }); // reuses 3
            ctx.spawn(Box, { x: 0, y: 0, z: 0 }); // reuses 7: nextBody still 11
          }
          if (ctx.frame === 12) for (let i = 0; i < 3; i += 1) ctx.spawn(Box, { x: 0, y: 0, z: 0 });
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    for (let frame = 0; frame <= 10; frame += 1) guest.tick(stubFrame(frame));
    const snapshot = guest.snapshot();
    guest.tick(stubFrame(11));
    guest.restore(snapshot);
    expect(addedBodies(guest.tick(stubFrame(12)))).toEqual([3, 7, 11]);
  });
});
