import { describe, expect, it } from 'vitest';

import { defineMessage, resetMessageNames } from './messages';
import { NetFacade } from './NetFacade';
import type { RuntimeState } from '../state';
import type { GameEvent } from '../types';

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

/** Ticks per measured window. */
const TICKS = 20_000;

describe('ctx.net.messages(def)', () => {
  it('refills one pooled list each tick and allocates nothing per tick', () => {
    resetMessageNames();
    // Small integers parse to Smis, so JSON.parse itself allocates nothing here
    // and the window measures only the list, the entries and the check.
    const Seat = defineMessage('seat', (p): p is number => typeof p === 'number' && p >= 0);
    const events: GameEvent[] = [
      { tag: 'message', val: { player: 1, name: 'seat', payload: '3' } },
      { tag: 'message', val: { player: 2, name: 'chat', payload: '"hi"' } },
      { tag: 'message', val: { player: 3, name: 'seat', payload: '-1' } },
      { tag: 'message', val: { player: 4, name: 'seat', payload: '5' } },
    ];
    const rt = { net: { role: 'authority', localPlayer: 0 }, events } as unknown as RuntimeState;
    const net = new NetFacade(rt);
    net.beginTick();
    const first = net.messages(Seat);
    expect(first.map((m) => [m.player, m.payload])).toEqual([
      [1, 3],
      [4, 5],
    ]);

    let sum = 0;
    for (let i = 0; i < TICKS; i += 1) {
      net.beginTick();
      sum += net.messages(Seat).length;
    }
    // Median of five windows: a scavenge inside one window hides its garbage.
    // A fresh list or entry per tick is at least ~32 bytes per tick, about
    // 640 KB per window.
    const growth: number[] = [];
    for (let w = 0; w < 5; w += 1) {
      const before = heapUsed();
      for (let i = 0; i < TICKS; i += 1) {
        net.beginTick();
        sum += net.messages(Seat).length;
      }
      growth.push(heapUsed() - before);
    }
    growth.sort((a, b) => a - b);
    expect(growth[2]).toBeLessThan(100_000);
    expect(net.messages(Seat)).toBe(first);
    expect(sum).toBe(2 * TICKS * 6);
    expect(net.stats.dropped).toBe(1 + TICKS * 6);
  });
});
