/** Camera-relative movement and presentation, with all continuous state guest-side. */
import {
  driveThirdPerson,
  makeLocomotionState,
  resetLocomotionState,
  type LocomotionState,
  type Rig,
} from './thirdPersonDrive';
import type { GameContext } from './defineGame';
import type { PlayerHandle } from './net';

export { FALL, IDLE, JUMP, RUN, WALK } from './thirdPersonDrive';

/** Optional authored clips; omit to use the animator's standard locomotion blend. */
export interface ThirdPersonClips {
  idle: string;
  walk: string;
  run: string;
  rise: string;
  fall: string;
  land: string;
}

/** One room seat's driven body: its state, and the entity it was last reset for. */
interface Seat {
  state: LocomotionState;
  entity: number;
}

/**
 * Create one allocation-free camera-relative controller.
 * Call reset in game init; update from a guest system. Tuning comes from ctx.rules:
 * walkSpeed, runSpeed, acceleration, deceleration, jumpSpeed, landingSeconds,
 * moveTurnRate, idleTurnRate, idleTurnThreshold and camera pitch/distance/height.
 *
 * `update` drives the single player: `ctx.player` from `ctx.input`, with
 * `ctx.camera`. `updatePlayers` drives a room on its authority: each player's
 * own entity (`PlayerHandle.entity`, so a `possess` moves the controller too)
 * from that player's own input, with that player's own camera. Each seat has
 * its own state, made the first time the seat is seen and reset whenever the
 * seat's entity changes (a join, a respawn, a possess).
 *
 * @param clips Optional complete base-layer clip mapping, configured once.
 * @returns Persistent state, reset and update functions.
 * @example
 * ```ts
 * const controller = createThirdPersonController();
 * // In init: controller.reset(ctx); in a system:
 * if (ctx.net.role === 'solo') controller.update(ctx);
 * else controller.updatePlayers(ctx);
 * ```
 */
export function createThirdPersonController(clips?: ThirdPersonClips) {
  const locomotionState = makeLocomotionState();
  const bodyClips = clips
    ? [clips.idle, clips.walk, clips.run, clips.rise, clips.fall, clips.land]
    : [];
  const rig: Rig = {
    clips: bodyClips,
    weights: new Float32Array(bodyClips.length),
    follow: { yaw: 0, pitch: 0, distance: 4.5, height: 0.55 },
  };
  /** Per room seat, indexed by player id; grown once per seat id. */
  const seats: (Seat | undefined)[] = [];

  /**
   * Reset the single player's state and look; forget every seat.
   *
   * @param ctx The init context.
   */
  function reset(ctx: GameContext): void {
    resetLocomotionState(locomotionState, ctx.camera, ctx.rules);
    seats.length = 0;
  }

  /**
   * Drive the single player one step.
   *
   * @param ctx The frame context.
   * @param freeze True to hold the player still.
   */
  function update(ctx: GameContext, freeze = false): void {
    driveThirdPerson(ctx, ctx.player, ctx.input, ctx.camera, locomotionState, rig, freeze);
  }

  /**
   * Drive every room player's own entity one step, from their own input.
   *
   * @param ctx The frame context, on the authority.
   * @param freeze True to hold everyone still, or a test per player (hoist it:
   *   a function made per frame allocates), such as "this player is talking".
   */
  function updatePlayers(
    ctx: GameContext,
    freeze: boolean | ((player: PlayerHandle) => boolean) = false,
  ): void {
    const list = ctx.players.list;
    for (let i = 0; i < list.length; i += 1) {
      const player = list[i];
      if (player.entity === 0) continue;
      const seat = seatFor(ctx, player);
      const frozen = typeof freeze === 'function' ? freeze(player) : freeze;
      driveThirdPerson(ctx, player.entity, player.input, player.camera, seat.state, rig, frozen);
    }
  }

  /**
   * @param ctx The frame context.
   * @param player A player with an entity.
   * @returns Their seat, reset if their entity changed since the last step.
   */
  function seatFor(ctx: GameContext, player: PlayerHandle): Seat {
    let seat = seats[player.id];
    if (seat === undefined) {
      seat = { state: makeLocomotionState(), entity: 0 };
      seats[player.id] = seat;
    }
    if (seat.entity !== player.entity) {
      resetLocomotionState(seat.state, player.camera, ctx.rules);
      seat.entity = player.entity;
    }
    return seat;
  }

  /**
   * @param player A player id.
   * @returns That seat's state, or undefined before it was first driven.
   */
  function stateOf(player: number): LocomotionState | undefined {
    return seats[player]?.state;
  }

  return { state: locomotionState, reset, update, updatePlayers, stateOf };
}
