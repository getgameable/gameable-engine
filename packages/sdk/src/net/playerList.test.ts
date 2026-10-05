import { describe, expect, it } from 'vitest';

import { stubInput } from '../testing';
import { joined, left, rig, roomFrame } from './netTesting';
import type { GameContext } from '../defineGame';
import type { PlayerInput } from '../types';

const AUTHORITY = '{"net":{"role":"authority"}}';
/** Ticks per measured window, and in all (the first two windows warm up). */
const WINDOW = 2000;
const WARM = 2;
const TICKS = 7 * WINDOW;

/** The node globals the allocation check needs, typed narrowly (the SDK has no node types). */
const nodeEnv = globalThis as unknown as {
  gc?: () => void;
  process?: { memoryUsage: () => { heapUsed: number } };
};

/** @returns Bytes of JS heap in use, after a full GC when the runner exposes one. */
function heapUsed(): number {
  nodeEnv.gc?.();
  return nodeEnv.process?.memoryUsage().heapUsed ?? 0;
}

describe('ctx.players.list', () => {
  it('holds the players in id order, the same array every tick', () => {
    const { guest, ctx } = rig({}, AUTHORITY);
    guest.tick(roomFrame(0, [joined(3), joined(1)]));
    const list = ctx().players.list;
    expect(list.map((p) => p.id)).toEqual([1, 3]);

    guest.tick(roomFrame(1));
    expect(ctx().players.list).toBe(list);

    guest.tick(roomFrame(2, [left(1), joined(0)]));
    expect(ctx().players.list).toBe(list);
    expect(list.map((p) => p.id)).toEqual([0, 3]);
  });

  it('allocates nothing when a system walks it every tick', () => {
    let sum = 0;
    let visits = 0;
    const { guest } = rig(
      {
        systems: [
          {
            on: 'authority',
            run: (ctx: GameContext) => {
              const list = ctx.players.list;
              for (let i = 0; i < list.length; i += 1) {
                const p = list[i];
                visits += 1;
                if (p.input.isDown('W')) sum += p.id;
                sum += p.entity;
              }
            },
          },
        ],
      },
      AUTHORITY,
    );
    const players: PlayerInput[] = [0, 1, 2, 3].map((player) => ({
      player,
      seq: 0,
      input: stubInput(),
    }));
    const frames = [];
    for (let i = 0; i < TICKS; i += 1) frames.push(roomFrame(i + 1, [], players));
    guest.tick(roomFrame(0, [joined(0), joined(1), joined(2), joined(3)], players));
    for (let i = 0; i < WARM * WINDOW; i += 1) guest.tick(frames[i]);
    // Without --expose-gc a scavenge can land inside a window and hide its
    // garbage, and a busy machine adds noise to one window, so take the median
    // of five. A spread of the Map per tick is ~240 KB per window (observed);
    // walking the list is a few KB of noise.
    const growth: number[] = [];
    for (let w = WARM; w < TICKS / WINDOW; w += 1) {
      const before = heapUsed();
      for (let i = w * WINDOW; i < (w + 1) * WINDOW; i += 1) guest.tick(frames[i]);
      growth.push(heapUsed() - before);
    }
    growth.sort((a, b) => a - b);
    expect(growth[growth.length >> 1]).toBeLessThan(150_000);
    expect(sum).toBe(0);
    // Every tick walked all four players: the loop really ran.
    expect(visits).toBe(4 * (TICKS + 1));
  });
});
