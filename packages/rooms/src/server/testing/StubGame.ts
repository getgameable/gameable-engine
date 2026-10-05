/**
 * `StubGame` — a `RoomGame` for room tests whose every answer names the
 * player it was asked for: the snapshot is `{"for":id}`, the view's entity
 * is `100 + id`, and its one row is entity `100 + id`. A room that hands one
 * player another's welcome or frames shows up at once. It records every call.
 */
import type { RowSource } from '@gameable/net';
import { type PlayerIdentity, RoomGame, type RoomView } from '@gameable/net/server';

import type { GameableRoomEntry } from '../GameableRoomEntry.js';
import type { CatalogGame } from '../host/RoomCatalog.js';

const position = new Float32Array(3);
const rotation = new Float32Array([0, 0, 0, 1]);

/**
 * @param entity The one row's entity.
 * @returns A row source with that one row.
 */
function oneRow(entity: number): RowSource {
  return {
    count: 1,
    entity: () => entity,
    flags: () => 3, // POSITION | ROTATION
    position: () => position,
    rotation: () => rotation,
    scale: () => position,
  };
}

/** The stub game. */
export class StubGame extends RoomGame {
  frame = 0;
  /** Every `snapshotFor` call's player, in order. */
  readonly snapshots: number[] = [];
  /** `viewFor` calls per player. */
  readonly views = new Map<number, number>();
  readonly joins: { player: number; name: string }[] = [];
  /** Each join's identity (Task 5.3), in join order; null without `Identities`. */
  readonly identities: (PlayerIdentity | null)[] = [];
  readonly leaves: { player: number; reason: string }[] = [];
  readonly inputs: number[] = [];
  /** Every `message` call, in order. */
  readonly messages: { player: number; name: string; payload: string }[] = [];
  /** Every `hold` call's player, in order. */
  readonly holds: number[] = [];
  /** Every `resume` call's player, in order. */
  readonly resumes: number[] = [];
  disposed = false;
  /** Where the game throws from now on, as a buggy game would; null for nowhere. */
  fault: 'tick' | 'message' | 'welcome' | 'leave' | 'dispose' | null = null;
  /** Calls into the game (dispose aside) after its first throw: a crashed room makes none. */
  callsAfterFault = 0;
  private tripped = false;

  tick(): void {
    this.called('tick');
    this.frame += 1;
  }

  join(player: number, name: string, _data: string | null, identity?: PlayerIdentity): void {
    this.called('join');
    this.joins.push({ player, name });
    this.identities.push(identity ?? null);
  }

  leave(player: number, reason: string): void {
    this.called('leave');
    this.leaves.push({ player, reason });
  }

  hold(player: number): void {
    this.holds.push(player);
  }

  resume(player: number): void {
    this.resumes.push(player);
  }

  input(player: number): void {
    this.called('input');
    this.inputs.push(player);
  }

  message(player: number, name: string, payload: string): void {
    this.called('message');
    this.messages.push({ player, name, payload });
  }

  viewFor(player: number): RoomView {
    this.called('viewFor');
    this.views.set(player, (this.views.get(player) ?? 0) + 1);
    return {
      frame: this.frame,
      entity: 100 + player,
      commands: [],
      messages: [],
      takeRows: () => oneRow(100 + player),
    };
  }

  entityOf(player: number): number {
    return 100 + player;
  }

  snapshotFor(player: number): string {
    this.called('welcome');
    this.snapshots.push(player);
    return `{"for":${String(player)},"frame":${String(this.frame)},"entities":[]}`;
  }

  /** @param phase Say what the game is doing, for the room list. */
  phaseTo(phase: string | null): void {
    this.setPhase(phase);
  }

  /** @param reason End the game from inside, as a crashed guest does. */
  crash(reason: string): void {
    this.end(reason);
  }

  dispose(): void {
    this.disposed = true;
    if (this.fault === 'dispose') throw new Error('stub: dispose threw');
  }

  /**
   * Count a call made after the first throw, then throw if this is the faulty one.
   *
   * @param where The method.
   */
  private called(
    where: 'tick' | 'join' | 'leave' | 'input' | 'message' | 'viewFor' | 'welcome',
  ): void {
    if (this.tripped) this.callsAfterFault += 1;
    if (this.fault !== where) return;
    this.tripped = true;
    throw new Error(`stub: ${where} threw`);
  }
}

/**
 * @param overrides Entry fields to change.
 * @returns An entry whose games are kept in `games`, newest last.
 */
export function stubEntry(overrides: Partial<GameableRoomEntry> = {}): GameableRoomEntry & {
  games: StubGame[];
} {
  const games: StubGame[] = [];
  return {
    maxPlayers: 2,
    sendHz: 20,
    games,
    create: () => {
      const game = new StubGame();
      games.push(game);
      return game;
    },
    ...overrides,
  };
}

/**
 * @param overrides Catalog fields to change.
 * @returns A catalog game whose games are kept in `games`, newest last.
 */
export function stubGame(overrides: Partial<CatalogGame> = {}): CatalogGame & {
  games: StubGame[];
} {
  const games: StubGame[] = [];
  return {
    maxPlayers: 2,
    sendHz: 20,
    games,
    create: () => {
      const game = new StubGame();
      games.push(game);
      return game;
    },
    ...overrides,
  };
}
