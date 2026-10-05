/**
 * Test support for the net folder: a guest wrapped so a test can read its
 * context after a tick, and the frames and events a room hands a guest.
 *
 * Not exported from `src/index.ts`: this is not public API.
 */
import { defineGame } from '../defineGame';
import { createGuest, type Guest } from '../runtime';
import { createStubHost, stubConfig, stubFrame, type StubHost } from '../testing';
import type { GameContext, GameSpec } from '../defineGame';
import type { Command, FrameInput, GameEvent, PlayerInput } from '../types';

/** A guest, its host, and the context its last tick saw. */
export interface Rig {
  guest: Guest;
  host: StubHost;
  ctx: () => GameContext;
}

/**
 * Build and `init` a guest over a spec, capturing the context in `update`.
 *
 * @param spec The game, minus `update`.
 * @param options `game-config.options`, as JSON.
 * @returns The rig.
 */
export function rig(spec: GameSpec, options?: string): Rig {
  let last: GameContext | null = null;
  const game = defineGame({
    ...spec,
    update: (ctx) => {
      last = ctx;
      spec.update?.(ctx);
    },
  });
  const host = createStubHost();
  const guest = createGuest(host, game);
  guest.init(stubConfig({ options }));
  return {
    guest,
    host,
    ctx: () => {
      if (last === null) throw new Error('no tick ran');
      return last;
    },
  };
}

/**
 * One frame carrying players and events.
 *
 * @param frame Fixed-step counter.
 * @param events Host events.
 * @param players Per-player input.
 * @returns A frame input.
 */
export function roomFrame(
  frame: number,
  events: readonly GameEvent[] = [],
  players: readonly PlayerInput[] = [],
): FrameInput {
  return { ...stubFrame(frame), events, players };
}

/**
 * @param player The id.
 * @param name The display name.
 * @returns A `player-joined` event.
 */
export function joined(player: number, name = `p${String(player)}`): GameEvent {
  return { tag: 'player-joined', val: { player, name, data: undefined } };
}

/**
 * @param player The id.
 * @returns A `player-left` event.
 */
export function left(player: number): GameEvent {
  return { tag: 'player-left', val: { player, reason: 'left' } };
}

/**
 * @param player The sender.
 * @param name The message name.
 * @param payload The JSON payload.
 * @returns A `message` event.
 */
export function message(player: number, name: string, payload: string): GameEvent {
  return { tag: 'message', val: { player, name, payload } };
}

/**
 * @param commands A command list.
 * @param tag The tag to keep.
 * @returns The payloads with that tag, in order.
 */
export function payloads<T>(commands: readonly Command[], tag: Command['tag']): T[] {
  return commands.filter((c) => c.tag === tag).map((c) => c.val as T);
}
