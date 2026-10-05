/**
 * The street on the authority, driven by `simulatePlayers`: twelve move in,
 * each to a house; chat, colours, benches, doors and cars.
 */
import { press, release, simulatePlayers } from 'gameable/test';
import { describe, expect, it } from 'vitest';

import { benches, cars, doors } from '../src/props';
import { residents } from '../src/residents';
import { boot, hudOf, moves, rows, stateOf } from './street';

/** The seats, 0 to 11. */
const ALL = Array.from({ length: 12 }, (_, i) => i);

describe('moving in', () => {
  it('seats twelve players, two to a house, each told their own house alone', () => {
    const { guest } = boot();
    const result = simulatePlayers(guest, {
      frames: 2,
      players: 12,
      script: (frame, tape) => {
        if (frame === 0) for (const seat of ALL) tape.join(seat);
      },
    });
    const views = result.views[0];
    expect(views.map((v) => v.player)).toEqual(ALL);
    expect(new Set(views.map((v) => v.entity)).size).toBe(12);
    for (const v of views) {
      const houses = v.sends.filter((s) => s.name === 'house');
      expect(houses).toHaveLength(1);
      expect(houses[0].broadcast).toBe(false);
      expect(JSON.parse(houses[0].payload)).toEqual({ house: v.player % 6 });
      expect(hudOf(v).text).toMatchObject({
        house: String((v.player % 6) + 1),
        street: '12/12',
      });
    }
    // Nobody is told again on the next tick.
    for (const v of result.views[1]) expect(v.sends.some((s) => s.name === 'house')).toBe(false);
  });
});

describe('chat', () => {
  it("reaches everyone with the sender's name, and shows in every HUD", () => {
    const { guest } = boot();
    const result = simulatePlayers(guest, {
      frames: 2,
      players: 12,
      script: (frame, tape) => {
        if (frame === 0) [0, 1, 2].forEach((s) => tape.join(s, s === 1 ? 'Ana' : undefined));
        if (frame === 1) tape.message(1, 'chat', JSON.stringify({ text: ' hi\u0000 <b>all</b> ' }));
      },
    });
    for (const v of result.views[1]) {
      const lines = v.sends.filter((s) => s.name === 'chat');
      expect(lines.map((s) => JSON.parse(s.payload) as unknown)).toEqual([
        { player: 1, name: 'Ana', text: 'hi <b>all</b>' },
      ]);
      expect(hudOf(v).text?.['chat 3']).toBe('Ana: hi <b>all</b>');
    }
  });
});

describe('cosmetics', () => {
  it("paints the sender's character for everyone, and drops a payload that is not a colour", () => {
    const { guest } = boot();
    const result = simulatePlayers(guest, {
      frames: 3,
      players: 12,
      keepOutputs: true,
      script: (frame, tape) => {
        if (frame === 0) [0, 1].forEach((s) => tape.join(s));
        if (frame === 1) tape.message(1, 'cosmetic', JSON.stringify({ color: '#FF0000' }));
        if (frame === 2) tape.message(0, 'cosmetic', JSON.stringify({ color: 'red' }));
      },
    });
    const paint = (frame: number) =>
      result.outputs[frame].commands.flatMap((c) =>
        c.tag === 'set-material-param' ? [c.val] : [],
      );
    const [p0, p1] = result.views[1].map((v) => v.entity);
    expect(paint(1)).toEqual([
      { entity: p1, name: 'color', value: { tag: 'color', val: { r: 1, g: 0, b: 0, a: 1 } } },
    ]);
    expect(residents.color[1]).toBe('#ff0000');
    expect(paint(2)).toEqual([]);
    expect(residents.color[0]).toBe('');
    expect(p0).not.toBe(p1);
  });

  it('saves the colour in the player document, and wears it again on the next visit', () => {
    const first = boot();
    const visit = simulatePlayers(first.guest, {
      frames: 2,
      players: 12,
      keepOutputs: true,
      script: (frame, tape) => {
        if (frame === 0) tape.join(3, 'Ana', JSON.stringify({ coins: 4 }));
        if (frame === 1) tape.message(3, 'cosmetic', JSON.stringify({ color: '#00FF00' }));
      },
    });
    const saves = visit.outputs[1].commands.flatMap((c) =>
      c.tag === 'save-player-data' ? [c.val] : [],
    );
    // Beside what the document already held.
    expect(saves).toEqual([{ player: 3, data: JSON.stringify({ coins: 4, color: '#00ff00' }) }]);

    // A new room, the same player, with the document the store kept.
    const second = boot();
    const back = simulatePlayers(second.guest, {
      frames: 1,
      players: 12,
      keepOutputs: true,
      script: (_frame, tape) => tape.join(0, 'Ana', saves[0]?.data),
    });
    const entity = back.views[0][0].entity;
    const paint = back.outputs[0].commands.flatMap((c) =>
      c.tag === 'set-material-param' && c.val.entity === entity ? [c.val] : [],
    );
    expect(paint).toEqual([
      { entity, name: 'color', value: { tag: 'color', val: { r: 0, g: 1, b: 0, a: 1 } } },
    ]);
    expect(residents.color[0]).toBe('#00ff00');
  });
});

describe('benches', () => {
  it('sits a player beside a bench, refuses one far away, and stands on WASD', () => {
    const { guest } = boot();
    const at = new Map<number, readonly [number, number]>();
    const result = simulatePlayers(guest, {
      frames: 8,
      players: 12,
      keepOutputs: true,
      script: (frame, tape) => {
        if (frame === 0) [0, 1].forEach((s) => tape.join(s));
        if (frame === 1) {
          at.set(tape.entityOf(0), [-3.5, -3.6]); // a metre from the first bench
          at.set(tape.entityOf(1), [8, 0]); // nowhere near one
        }
        if (frame === 2) {
          tape.message(0, 'sit');
          tape.message(1, 'sit');
        }
        if (frame === 6) press(tape.input(0), 'W');
        return { bodies: rows(at) };
      },
    });
    const [p0, p1] = result.views[1].map((v) => v.entity);
    expect(benches[0]).not.toBe(0);
    for (const frame of [2, 3, 4, 5]) {
      expect(stateOf(result.outputs[frame], p0)).toBe('sit');
      expect(stateOf(result.outputs[frame], p1)).not.toBe('sit');
    }
    expect(hudOf(result.views[3][0]).message).toBe('F or WASD: stand up');
    expect(stateOf(result.outputs[6], p0)).not.toBe('sit');
    expect(residents.bench[0]).toBe(0);
  });
});

describe('doors', () => {
  it('opens the door in reach for everyone with E, sliding it until it is open', () => {
    const { guest } = boot();
    const result = simulatePlayers(guest, {
      frames: 60,
      players: 12,
      keepOutputs: true,
      script: (frame, tape) => {
        if (frame === 0) tape.join(0);
        if (frame === 2) press(tape.input(0), 'E');
      },
    });
    expect(hudOf(result.views[0][0]).message).toBe('E: open the door');
    const door = doors.entity[0];
    const slides = result.outputs.flatMap((out) => moves(out, door));
    expect(slides.length).toBeGreaterThan(10);
    expect(slides.at(-1)?.position.x).toBeCloseTo(doors.x[0] + 1.2, 4);
    expect(moves(result.outputs[59], door)).toEqual([]);
  });
});

describe('cars', () => {
  it('lets one player in, drives the car from their keys, and lets them out', () => {
    const { guest } = boot();
    const at = new Map<number, readonly [number, number]>();
    const car = cars.entity;
    const result = simulatePlayers(guest, {
      frames: 90,
      players: 12,
      keepOutputs: true,
      script: (frame, tape) => {
        if (frame === 0) [0, 1].forEach((s) => tape.join(s));
        if (frame === 1) {
          at.set(tape.entityOf(0), [-4, 1.5]);
          at.set(tape.entityOf(1), [-4, -1.5]);
        }
        if (frame === 3) press(tape.input(0), 'E');
        if (frame === 4) {
          release(tape.input(0), 'E');
          press(tape.input(1), 'E'); // taken: stays on foot
          press(tape.input(0), 'W');
        }
        if (frame === 70) {
          release(tape.input(0), 'W');
          press(tape.input(0), 'E');
        }
        return { bodies: rows(at) };
      },
    });
    expect(hudOf(result.views[1][0]).message).toBe('E: drive');
    const driven = result.outputs.slice(4, 70).flatMap((out) => moves(out, car[0]));
    expect(driven.length).toBe(66);
    // Parked facing west, so W drives it towards -X, and never by teleport.
    expect(driven.at(-1)?.position.x).toBeLessThan(-6);
    expect(driven.every((m) => !m.teleport)).toBe(true);
    const p0 = result.views[4][0].entity;
    expect(stateOf(result.outputs[40], p0)).toBe('sit');
    expect(residents.car[1]).toBe(-1);
    // Out at frame 70: the car stops and is no longer moved.
    expect(residents.car[0]).toBe(-1);
    expect(cars.driver[0]).toBe(-1);
    expect(result.outputs.slice(71).flatMap((out) => moves(out, car[0]))).toEqual([]);
  });
});

describe('an empty street', () => {
  it('ticks with nobody on it, then seats the first comer, and never logs an error or a warning', () => {
    const { guest, host } = boot();
    const result = simulatePlayers(guest, {
      frames: 120,
      players: 12,
      script: (frame, tape) => {
        if (frame === 60) tape.join(5);
      },
    });
    expect(result.views[59]).toEqual([]);
    expect(hudOf(result.views[60][0]).text).toMatchObject({
      house: '6',
      street: '1/12',
    });
    expect(host.log_.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
  });
});
