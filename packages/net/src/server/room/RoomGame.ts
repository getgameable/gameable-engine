/**
 * `RoomGame` — what a room drives: the game behind the seats.
 *
 * The room owns the connections, the seats and the clock; the game owns the
 * simulation. Each room tick the room hands every player's coalesced input to
 * {@link RoomGame.input}, calls {@link RoomGame.tick}, then takes each seat's
 * {@link RoomView} and turns it into that player's `cmd`, `msg` and rows
 * frames. `EngineRoomGame` is the one that runs a real guest on a headless
 * engine; a test or a lobby can subclass this directly.
 */
import type { Command } from '@gameable/sdk';

import type { MutableInputSnapshot, RowSource } from '../../protocol/types.js';
import type { PlayerIdentity } from '../identity/IdentityProvider.js';

/**
 * A message the authority sent to a player (a `send` whose `to` is them, or a
 * broadcast). It becomes a `msg` text frame with `from: AUTHORITY_SENDER`.
 *
 * @example
 * ```ts
 * import type { ViewMessage } from 'gameable/net/server';
 *
 * const pong: ViewMessage = { name: 'pong', payload: '{"frame":12}' };
 * ```
 */
export interface ViewMessage {
  /** The message name. */
  readonly name: string;
  /** The payload as the guest's JSON text, at most `MAX_PAYLOAD_BYTES`. */
  readonly payload: string;
}

/**
 * What changed for one player since the room last took their view.
 *
 * `commands` and `messages` cover every simulation step since the last
 * `viewFor` and are good until the next one. `takeRows` is called only on
 * the ticks the room sends rows (`1000 / sendHz` ms apart); it gathers the
 * rows whose pose changed since the last call and moves that player's row
 * watermark.
 *
 * @example
 * ```ts
 * import type { RoomView } from 'gameable/net/server';
 *
 * const empty: RoomView = {
 *   frame: 0,
 *   entity: 0,
 *   commands: [],
 *   messages: [],
 *   takeRows: () => ({
 *     count: 0,
 *     entity: () => 0,
 *     flags: () => 0,
 *     position: () => [],
 *     rotation: () => [],
 *     scale: () => [],
 *   }),
 * };
 * ```
 */
export interface RoomView {
  /** The authority's step counter at the end of the steps this view covers. */
  readonly frame: number;
  /** The entity this player controls, or 0: their `cmd` frame's `entity`. */
  readonly entity: number;
  /** The reliable commands for this player, in the order to apply them. */
  readonly commands: readonly Command[];
  /** Messages for this player, in the order sent. */
  readonly messages: readonly ViewMessage[];
  /**
   * @returns The rows to send now, read in place until the next call; may be empty.
   */
  takeRows(): RowSource;
}

/**
 * The game a room runs. The room calls it, never the other way round.
 *
 * Player ids are the room's: 0 upward, the lowest free id first, so the
 * first joiner is player 0, whose input is the frame's `input` and who gets
 * the frame camera and HUD (spec 4.3). A seat that
 * disconnects is kept (no `leave`) until it resumes or times out; on resume
 * the room asks for a fresh {@link RoomGame.snapshotFor}.
 *
 * @example
 * ```ts
 * import { RoomGame, type RoomView } from 'gameable/net/server';
 * import type { MutableInputSnapshot } from 'gameable/net';
 *
 * class EchoGame extends RoomGame {
 *   frame = 0;
 *   private readonly view: RoomView = {
 *     frame: 0,
 *     entity: 0,
 *     commands: [],
 *     messages: [],
 *     takeRows: () => ({
 *       count: 0,
 *       entity: () => 0,
 *       flags: () => 0,
 *       position: () => [],
 *       rotation: () => [],
 *       scale: () => [],
 *     }),
 *   };
 *   tick(): void {
 *     this.frame += 1;
 *   }
 *   join(): void {}
 *   leave(): void {}
 *   input(_player: number, _seq: number, _snapshot: MutableInputSnapshot): void {}
 *   message(): void {}
 *   viewFor(): RoomView {
 *     return this.view;
 *   }
 *   snapshotFor(): string {
 *     return '{"entities":[]}';
 *   }
 *   dispose(): void {}
 * }
 * ```
 */
export abstract class RoomGame {
  /** The authority's step counter; `welcome` carries it. */
  abstract readonly frame: number;

  private endReason: string | null = null;
  private phaseValue: string | null = null;

  /**
   * @returns The seats this game holds (ids `0..maxPlayers - 1`), when it
   *   knows them; a room over it then needs no `maxPlayers` of its own.
   *   `EngineRoomGame` says the game's `features.multiplayer.maxPlayers`.
   *   Undefined here: the room's option decides.
   */
  get maxPlayers(): number | undefined {
    return undefined;
  }

  /**
   * @returns Null while the game runs; once it has ended itself (a crashed
   *   guest: `crashed`), the reason. The room closes with it after the tick.
   */
  get ended(): string | null {
    return this.endReason;
  }

  /**
   * End the game from inside; the room closes on its next tick check.
   *
   * @param reason Why, in a word.
   */
  protected end(reason: string): void {
    this.endReason ??= reason;
  }

  /**
   * @returns What the game says it is doing, in a word (`lobby`, `playing`),
   *   or null. The room server lists it beside the room's code and seats.
   */
  get phase(): string | null {
    return this.phaseValue;
  }

  /**
   * Say what the game is doing, for the public room list. The room server
   * re-lists the room on the tick after a change; the same phase again costs
   * nothing.
   *
   * @param phase A short word (at most 32 characters, else it is not listed), or null.
   */
  protected setPhase(phase: string | null): void {
    this.phaseValue = phase;
  }

  /**
   * Advance the simulation to `nowMs`.
   *
   * @param nowMs The room's clock, `ports.now()`.
   */
  abstract tick(nowMs: number): void;

  /**
   * A player took a new seat.
   *
   * @param player The seat's id.
   * @param name The seat's name: a signed-in player's portal name, else the
   *   name the page sent (capped).
   * @param data Saved player data, or null (Task 5.x fills it).
   * @param identity Who the player is (Task 5.3): `identity.id` is the stable
   *   key their saved data lives under. Undefined where the room resolves no
   *   identity (Play Solo, a bare room server without `Identities`).
   */
  abstract join(player: number, name: string, data: string | null, identity?: PlayerIdentity): void;

  /**
   * A seat was freed.
   *
   * @param player The seat's id.
   * @param reason Why: `timeout` for a held seat that was never resumed.
   */
  abstract leave(player: number, reason: string): void;

  /**
   * A seat's player dropped, and the room holds the seat for them: no
   * `leave` yet. Optional. `EngineRoomGame` leaves a held seat out of the
   * guest's players list, so `ctx.players.host` passes off a host who dropped.
   *
   * @param player The held seat.
   */
  hold?(player: number): void;

  /**
   * A held seat's player is back. Optional; follows {@link RoomGame.hold}.
   *
   * @param player The seat.
   */
  resume?(player: number): void;

  /**
   * A player's input for the next tick, coalesced over every input frame since
   * the last tick. Read during the call; the room reuses the snapshot.
   *
   * @param player The seat's id.
   * @param seq The newest input `seq` in it; acks name it.
   * @param snapshot Held keys and mouse buttons as of the newest frame; the
   *   key and button edges OR-ed and the mouse deltas summed over all of them.
   */
  abstract input(player: number, seq: number, snapshot: MutableInputSnapshot): void;

  /**
   * A player sent a `msg`.
   *
   * @param player The sender.
   * @param name The message name.
   * @param payload The payload as JSON text.
   */
  abstract message(player: number, name: string, payload: string): void;

  /**
   * @param player A seated player.
   * @returns What changed for that player since their last view.
   */
  abstract viewFor(player: number): RoomView;

  /**
   * The entity a player controls (the guest's `set-player-entity`), for
   * their `welcome`. Optional: a game without entities says 0 by leaving it out.
   *
   * @param player A seated player.
   * @returns The entity, or 0.
   */
  entityOf?(player: number): number;

  /**
   * The `welcome` snapshot for a player who just joined or resumed. Taking it
   * also resets that player's view to it: what follows is relative to it.
   *
   * @param player A seated player.
   * @returns The snapshot as JSON text.
   */
  abstract snapshotFor(player: number): string;

  /**
   * Whether a newcomer may take a seat.
   *
   * @param name The name from `hello`.
   * @param token The `hello` token, if any.
   * @returns Null to admit, or the refusal in words the page shows.
   */
  admit?(name: string, token: string | undefined): Promise<string | null>;

  /**
   * The last input `seq` a simulation step has actually applied for a
   * player. Optional: without it the room acks what it handed to `input`,
   * which a tick that ran no step has not used yet.
   *
   * @param player A seated player.
   * @returns The seq.
   */
  ackFor?(player: number): number;

  /** Release everything the game holds. */
  abstract dispose(): void;
}
