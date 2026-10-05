import { beforeEach, describe, expect, it } from 'vitest';

import { defineGame } from './defineGame';
import { DEFAULT_MAX_PLAYERS, MAX_PLAYER_ID, parseMaxPlayers } from './net';
import { resetPrefabRegistry } from './prefab';
import { createGuest } from './runtime';
import { createStubHost, hold, stubConfig, stubFrame, stubInput } from './testing';
import type { GameContext } from './defineGame';
import type { FrameInput, GameEvent, PlayerInput } from './types';

/**
 * One frame carrying a players lane.
 *
 * @param frame Fixed-step counter.
 * @param players The per-player records.
 * @param events Host events.
 * @returns A frame input in guest-side shapes.
 */
function roomFrame(
  frame: number,
  players: readonly PlayerInput[],
  events: readonly GameEvent[] = [],
): FrameInput {
  return { ...stubFrame(frame), players, events };
}

/** A game that keeps its last context, so a test can read it after a tick. */
function capture(): { game: ReturnType<typeof defineGame>; ctx: () => GameContext } {
  let last: GameContext | null = null;
  const game = defineGame({
    update: (ctx) => {
      last = ctx;
    },
  });
  return {
    game,
    ctx: () => {
      if (last === null) throw new Error('no tick ran');
      return last;
    },
  };
}

describe('per-player input', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('decodes every player, each with its own keys', () => {
    const seen: boolean[] = [];
    const game = defineGame({
      update: (ctx) => {
        seen.push(
          ctx.players.get(1)?.input.isDown('W') ?? false,
          ctx.players.get(2)?.input.isDown('W') ?? false,
          ctx.input.isDown('W'),
        );
      },
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    const one = stubInput();
    hold(one, 'W');
    guest.tick(
      roomFrame(0, [
        { player: 1, seq: 4, input: one },
        { player: 2, seq: 9, input: stubInput() },
      ]),
    );
    // Player 1 holds W, player 2 does not, and frame-input.input (player 0) is untouched.
    expect(seen).toEqual([true, false, false]);
  });

  it('keeps the players map until the set of ids changes', () => {
    const { game, ctx } = capture();
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    const players: PlayerInput[] = [{ player: 3, seq: 0, input: stubInput() }];
    guest.tick(roomFrame(0, players));
    const first = ctx().players;
    const handle = first.get(3);
    expect(handle?.id).toBe(3);

    expect(handle?.input.isDown('W')).toBe(false);
    hold(players[0].input as ReturnType<typeof stubInput>, 'W');
    guest.tick(roomFrame(1, players));
    expect(ctx().players.get(3)).toBe(handle);
    expect([...ctx().players.keys()]).toEqual([3]);
    // The reused entry reads this tick's input.
    expect(handle?.input.isDown('W')).toBe(true);

    guest.tick(roomFrame(2, [...players, { player: 5, seq: 0, input: stubInput() }]));
    expect([...ctx().players.keys()]).toEqual([3, 5]);

    guest.tick(roomFrame(3, []));
    expect(ctx().players.size).toBe(0);
  });

  it('accepts ids up to the default 16 and rejects 17', () => {
    const host = createStubHost();
    const { game, ctx } = capture();
    const guest = createGuest(host, game);
    guest.init(stubConfig());
    guest.tick(
      roomFrame(0, [
        { player: 16, seq: 0, input: stubInput() },
        { player: 17, seq: 0, input: stubInput() },
      ]),
    );
    expect([...ctx().players.keys()]).toEqual([16]);
    expect(host.lines.filter((l) => l.includes('maxPlayers'))).toHaveLength(1);
  });

  it('clamps net.maxPlayers to the server ceiling', () => {
    expect(parseMaxPlayers('{"net":{"maxPlayers":100000}}')).toBe(MAX_PLAYER_ID);
    expect(parseMaxPlayers('{"net":{"maxPlayers":4}}')).toBe(4);
    expect(parseMaxPlayers('{"mode":1}')).toBe(DEFAULT_MAX_PLAYERS);
    expect(() => parseMaxPlayers('not json')).toThrow(/not JSON/);
  });

  it('ignores a player id past net.maxPlayers and says so once', () => {
    const host = createStubHost();
    const { game, ctx } = capture();
    const guest = createGuest(host, game);
    guest.init(stubConfig({ options: '{"net":{"maxPlayers":2}}' }));

    const far: PlayerInput[] = [{ player: 7, seq: 0, input: stubInput() }];
    guest.tick(roomFrame(0, far));
    guest.tick(roomFrame(1, far));
    expect(ctx().players.size).toBe(0);
    const warnings = host.lines.filter((l) => l.includes('maxPlayers'));
    expect(warnings).toHaveLength(1);
  });

  it('a single-player frame has no players and nothing changes', () => {
    const { game, ctx } = capture();
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    const out = guest.tick(stubFrame(0));
    expect(ctx().players.size).toBe(0);
    expect(out.localCommands).toEqual([]);
  });
});

describe('net events', () => {
  it('a message event is visible as ctx.events', () => {
    const { game, ctx } = capture();
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    const message: GameEvent = {
      tag: 'message',
      val: { player: 2, name: 'vote', payload: '{"for":1}' },
    };
    guest.tick(roomFrame(0, [], [message]));
    expect(ctx().events).toEqual([message]);
  });
});
