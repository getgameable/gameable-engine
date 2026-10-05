/**
 * Driving a room's authority for many frames from a multi-player tape, and
 * reading back what each player is shown.
 *
 * The same script against a direct guest and a wasm component must produce
 * the same `hashes` and the same `views`, frame for frame.
 */
import { DEFAULT_ROOM_SEATS } from '@gameable/sdk';
import type { Command } from '@gameable/sdk';

import { createInputState, type FrameInputOverrides } from './frame-input';
import { stableJson } from './hash';
import { createPlayersInput, type PlayersInput } from './players';
import { simulate, type SimulateResult, type Tickable } from './simulate';

/**
 * A per-frame script over the seats. Join, leave, message and press on
 * `players`, or return fields to merge into the frame; returned `events`
 * follow the tape's.
 *
 * There is no separate input lane to press: as in a room, the frame's own
 * `input` is seat 0's (`players.input(0)`) while seat 0 is joined, and
 * neutral otherwise.
 */
export type PlayersScript = (
  frame: number,
  players: PlayersInput,
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
) => FrameInputOverrides | void;

/** How to run a room simulation. */
export interface SimulatePlayersOptions {
  /** How many frames to run. */
  frames: number;
  /** The seats: a count (default `DEFAULT_ROOM_SEATS`, 8, the SDK's default room) or a tape to reuse. */
  players?: number | PlayersInput;
  /** Per-frame joins, leaves, messages and input. */
  script?: PlayersScript;
  /** Fixed timestep in seconds. Default `1 / 60`. */
  dt?: number;
  /** Keep every `frame-output`. */
  keepOutputs?: boolean;
}

/** One `send` a player receives on a frame. */
export interface ReceivedSend {
  name: string;
  payload: string;
  reliable: boolean;
  /** True for a send with no `to`: everyone got it. */
  broadcast: boolean;
}

/** What one joined player is shown on one frame, beyond the shared world. */
export interface PlayerView {
  player: number;
  /** The entity this player controls, from the latest `set-player-entity`; 0 for none. */
  entity: number;
  /** Their own HUD JSON (`set-player-hud`), only on the frames it changed. */
  hud: string | undefined;
  /** Their own camera (`set-player-camera`) as canonical JSON, on the frames it was set. */
  camera: string | undefined;
  /** The sends addressed to them or to everyone, in command order. */
  sends: ReceivedSend[];
}

/** What a room simulation produced. */
export interface SimulatePlayersResult extends SimulateResult {
  /** `views[frame]`: one entry per seat joined on that frame, ascending. */
  views: PlayerView[][];
  /** The tape, as it stands after the last frame. */
  players: PlayersInput;
}

/**
 * Run a room's authority for `frames` fixed steps from a multi-player tape.
 *
 * Each step is built the way a room builds it: `frame-input.players` from the
 * joined seats, and `frame-input.input` aliased to seat 0's input while seat 0
 * is joined (a neutral input otherwise), so `ctx.input` and
 * `ctx.players.get(0).input` agree.
 *
 * @param guest Anything with a `tick`, including a `Sandbox`, booted as an authority.
 * @param options Frame count, seats and the per-frame script.
 * @returns `simulate`'s hashes, tags and HUD, plus every player's view per frame.
 *
 * @example
 * ```ts
 * import { press, simulatePlayers } from 'gameable/test';
 *
 * const result = simulatePlayers(sandbox, {
 *   frames: 200,
 *   players: 2,
 *   script: (frame, players) => {
 *     if (frame === 0) players.join(0);
 *     if (frame === 10) players.join(1);
 *     if (frame === 12) press(players.input(1), 'W');
 *     if (frame === 150) players.leave(1);
 *   },
 * });
 * console.log(result.views[100].map((v) => v.entity));
 * ```
 */
export function simulatePlayers(
  guest: Tickable,
  options: SimulatePlayersOptions,
): SimulatePlayersResult {
  const tape =
    typeof options.players === 'object'
      ? options.players
      : createPlayersInput(options.players ?? DEFAULT_ROOM_SEATS);
  const views: PlayerView[][] = [];
  // What a room puts in `frame-input.input` while seat 0 is empty; never pressed.
  const neutral = createInputState();
  const result = simulate(guest, {
    frames: options.frames,
    dt: options.dt,
    keepOutputs: options.keepOutputs,
    script: (frame) => {
      const overrides = options.script?.(frame, tape) ?? {};
      const lanes = tape.frame();
      return {
        ...overrides,
        input: tape.isJoined(0) ? tape.input(0) : neutral,
        players: lanes.players,
        events: [...lanes.events, ...(overrides.events ?? [])],
      };
    },
    onOutput: (_frame, out) => {
      tape.observe(out.commands);
      views.push(viewsOf(out.commands, tape));
      tape.endFrame();
    },
  });
  return { ...result, views, players: tape };
}

/**
 * @param commands One step's commands.
 * @param tape The tape, already updated from them.
 * @returns Each joined seat's view, ascending.
 */
function viewsOf(commands: readonly Command[], tape: PlayersInput): PlayerView[] {
  return tape.joined().map((player) => {
    const view: PlayerView = {
      player,
      entity: tape.entityOf(player),
      hud: undefined,
      camera: undefined,
      sends: [],
    };
    for (const c of commands) {
      if (c.tag === 'set-player-hud' && c.val.player === player) view.hud = c.val.hud;
      else if (c.tag === 'set-player-camera' && c.val.player === player) {
        view.camera = stableJson(c.val.camera);
      } else if (c.tag === 'send') {
        // A wasm guest's absent `to` may cross as null.
        const to = c.val.to ?? -1;
        if (to !== -1 && to !== player) continue;
        const { name, payload, reliable } = c.val;
        view.sends.push({ name, payload, reliable, broadcast: to === -1 });
      }
    }
    return view;
  });
}
