import { describe, expect, it } from 'vitest';

import { createSeatMap } from './SeatMap.js';

describe('SeatMap', () => {
  it('seats from 0, the lowest free id first, and lists them ascending', () => {
    const seats = createSeatMap();
    expect(seats.add('s-a', 'Ana', 0).player.id).toBe(0);
    expect(seats.add('s-b', 'Ben', 0).player.id).toBe(1);
    expect(seats.add('s-c', 'Cy', 0).player.id).toBe(2);
    seats.remove('s-a');
    expect(seats.add('s-d', 'Dee', 0).player.id).toBe(0);
    expect(seats.list().map((s) => s.player.id)).toEqual([0, 1, 2]);
    expect(seats.size).toBe(3);
  });

  it('holds a dropped seat (it still counts) and gives it back on resume', () => {
    const seats = createSeatMap();
    const ana = seats.add('s-a', 'Ana', 0);
    seats.add('s-b', 'Ben', 0);
    expect(seats.hold('s-a', 10)).toBe(ana);
    expect(seats.summaries()).toEqual([
      { id: 0, name: 'Ana', connected: false },
      { id: 1, name: 'Ben', connected: true },
    ]);
    expect(seats.size).toBe(2);
    expect(seats.resume('s-a', 20)).toBe(ana);
    expect(ana.player.connected).toBe(true);
    expect(seats.get('s-a')).toBe(ana);
  });

  it('lets go of every held key when a seat drops: released edges, nothing down, unfocused', () => {
    const seats = createSeatMap();
    const ana = seats.add('s-a', 'Ana', 0);
    const p = ana.player;
    p.pending.down[0] = 5;
    p.pending.mouse.buttons = 1;
    p.pending.mods.shift = true;
    p.pending.focused = true;
    p.consumed();
    p.pending.pressed[1] = 8; // an edge that arrived since the last tick is kept
    seats.hold('s-a', 10);
    expect(p.hasPending).toBe(true);
    expect(p.pending.down[0]).toBe(0);
    expect(p.pending.released[0]).toBe(5);
    expect(p.pending.pressed[1]).toBe(8);
    expect(p.pending.mouse.buttons).toBe(0);
    expect(p.pending.mouse.released).toBe(1);
    expect(p.pending.mods.shift).toBe(false);
    expect(p.pending.focused).toBe(false);
  });

  it('gives each seat its own budgets', () => {
    const seats = createSeatMap({ text: { burst: 1, refill: 1, everyMs: 1000 } });
    const ana = seats.add('s-a', 'Ana', 0);
    const ben = seats.add('s-b', 'Ben', 0);
    expect([ana.text.spend(0), ana.text.spend(0), ben.text.spend(0)]).toEqual(['pass', 'tell', 'pass']);
    expect(ana.text).toBe(ana.player.text); // one limit per player, shared with our own Room's rule
  });
});
