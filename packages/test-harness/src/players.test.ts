import { describe, expect, it } from 'vitest';

import {
  createGuest,
  DEFAULT_ROOM_SEATS,
  defineGame,
  keyIndex,
  prefab,
  Transform,
  type GameContext,
  type PlayerHandle,
} from '@gameable/sdk';

import { createGameConfig, press } from './frame-input';
import { createMockHost } from './mock-host';
import { createPlayersInput } from './players';
import { simulatePlayers } from './simulatePlayers';
import type { HostFrameInput } from '@gameable/sdk';

const Body = prefab({
  name: 'walker',
  body: { shape: 'capsule', dims: [0.3, 0.9], kind: 'character' },
});

/** The context while `walkAll` walks the players; a callback must not close over it. */
let current: GameContext | null = null;

/**
 * @param player One joined player.
 */
function walkOne(player: PlayerHandle): void {
  if (current === null || player.entity === 0) return;
  const w = player.input.isDown('W') ? 1 : 0;
  current.physics.moveCharacter(player.entity, 0, 0, -w, false);
  player.hud.set({ w });
}

const game = defineGame({
  player: { prefab: Body, spawn: [0, 1, 0] },
  features: { multiplayer: { maxPlayers: 4 } },
  systems: [
    (ctx) => {
      current = ctx;
      ctx.players.forEach(walkOne);
      current = null;
      const hellos = ctx.net.messages('hello');
      for (let i = 0; i < hellos.length; i += 1) ctx.net.send('welcome', { x: Transform.x[0] });
    },
  ],
});

/** @returns A guest booted as a four-seat room's authority. */
function authority(): ReturnType<typeof createGuest> {
  const guest = createGuest(createMockHost({ seed: 1, nowMs: () => 0 }), game);
  guest.init(createGameConfig({ options: '{"net":{"role":"authority","maxPlayers":3}}' }));
  return guest;
}

describe('createPlayersInput', () => {
  it('lists the joined seats ascending, with a seq that counts their steps, and queues the events', () => {
    const tape = createPlayersInput(4);
    tape.join(2, 'cy');
    tape.join(0);
    const first = tape.frame();
    expect(first.players.map((p) => [p.player, p.seq])).toEqual([
      [0, 1],
      [2, 1],
    ]);
    expect(first.events).toEqual([
      { tag: 'player-joined', val: { player: 2, name: 'cy', data: undefined } },
      { tag: 'player-joined', val: { player: 0, name: 'p0', data: undefined } },
    ]);
    expect(first.players[1].input).toBe(tape.input(2));

    tape.leave(2);
    tape.message(0, 'start');
    const second = tape.frame();
    expect(second.players.map((p) => [p.player, p.seq])).toEqual([[0, 2]]);
    expect(second.events).toEqual([
      { tag: 'player-left', val: { player: 2, reason: 'left' } },
      { tag: 'message', val: { player: 0, name: 'start', payload: 'null' } },
    ]);
    expect(tape.frame().events).toEqual([]);
  });

  it('refuses a seat out of range, a double join and leaving an empty seat', () => {
    const tape = createPlayersInput(2);
    expect(() => {
      tape.join(2);
    }).toThrow(/seat 2/);
    tape.join(1);
    expect(() => {
      tape.join(1);
    }).toThrow(/already/);
    expect(() => {
      tape.leave(0);
    }).toThrow(/not joined/);
  });

  it('lets a seat be left and taken again in one frame', () => {
    const tape = createPlayersInput(2);
    tape.join(0);
    tape.frame();
    tape.push({ tag: 'player-left', val: { player: 0, reason: 'timeout' } });
    tape.push({ tag: 'player-joined', val: { player: 0, name: 'new', data: undefined } });
    const lanes = tape.frame();
    expect(lanes.players.map((p) => [p.player, p.seq])).toEqual([[0, 1]]);
    expect(lanes.events.map((e) => e.tag)).toEqual(['player-left', 'player-joined']);
  });
});

describe('simulatePlayers', () => {
  it('drives each seat from its own input, joins and leaves, and reports every view', () => {
    const result = simulatePlayers(authority(), {
      frames: 6,
      players: 4,
      script: (frame, tape) => {
        if (frame === 0) tape.join(0);
        if (frame === 2) {
          tape.join(1);
          press(tape.input(1), 'W');
        }
        if (frame === 3) tape.message(1, 'hello');
        if (frame === 4) tape.leave(0);
      },
    });
    expect(result.hashes).toHaveLength(6);
    expect(result.views.map((v) => v.map((p) => p.player))).toEqual([
      [0],
      [0],
      [0, 1],
      [0, 1],
      [1],
      [1],
    ]);
    const at2 = result.views[2];
    expect(at2[0].entity).not.toBe(0);
    expect(at2[1].entity).not.toBe(0);
    expect(at2[1].entity).not.toBe(at2[0].entity);
    expect(JSON.parse(at2[1].hud ?? '{}')).toEqual({ w: 1 });
    // Player 0 never held W: their own HUD says so, and only on the frame it changed.
    expect(JSON.parse(result.views[0][0].hud ?? '{}')).toEqual({ w: 0 });
    // A broadcast reaches everyone joined that frame.
    expect(result.views[3].map((p) => p.sends.map((s) => s.name))).toEqual([
      ['welcome'],
      ['welcome'],
    ]);
    expect(result.views[3][0].sends[0].broadcast).toBe(true);
    expect(result.views[5][0].entity).toBe(at2[1].entity);
  });

  it('is deterministic: the same script hashes the same twice', () => {
    const script = (frame: number, tape: ReturnType<typeof createPlayersInput>): void => {
      if (frame === 0) tape.join(0);
      if (frame === 5) tape.join(1);
      if (frame === 8) press(tape.input(0), 'W');
    };
    const a = simulatePlayers(authority(), { frames: 20, script });
    const b = simulatePlayers(authority(), { frames: 20, script });
    expect(b.hashes).toEqual(a.hashes);
    expect(b.views).toEqual(a.views);
  });

  it('drives frame-input.input from seat 0, as a room does, and neutral while seat 0 is empty (I4)', () => {
    const inner = authority();
    const w = keyIndex('W');
    /** Whether W is held in each frame's main lane and in seat 0's lane, read during the tick. */
    const main: number[] = [];
    const seat0: number[] = [];
    const held = (input: HostFrameInput['input']): number =>
      ((input.keys.down[w >>> 5] ?? 0) >>> (w & 31)) & 1;
    simulatePlayers(
      {
        tick: (input) => {
          main.push(held(input.input));
          const zero = input.players.find((p) => p.player === 0);
          seat0.push(zero === undefined ? -1 : held(zero.input));
          return inner.tick(input);
        },
      },
      {
        frames: 4,
        players: 2,
        script: (frame, tape) => {
          if (frame === 1) {
            tape.join(0);
            press(tape.input(0), 'W');
          }
          if (frame === 2) {
            tape.join(1);
            press(tape.input(1), 'W');
          }
          if (frame === 3) tape.leave(0);
        },
      },
    );
    // Frame 0: nobody seated, a neutral main lane. Frames 1 and 2: seat 0 holds W, and the
    // main lane is seat 0's. Frame 3: seat 0 has left, so the main lane is neutral although
    // seat 1 still holds W: seat 1's keys never reach it.
    expect(seat0).toEqual([-1, 1, 1, -1]);
    expect(main).toEqual([0, 1, 1, 0]);
  });

  it('defaults to the SDK default room of DEFAULT_ROOM_SEATS seats', () => {
    const result = simulatePlayers(authority(), { frames: 1 });
    expect(result.players.count).toBe(DEFAULT_ROOM_SEATS);
    expect(DEFAULT_ROOM_SEATS).toBe(8);
  });
});
