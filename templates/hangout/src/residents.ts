/**
 * What the authority knows about each player, by seat: the body they were
 * last seen with, their house, their colour, and whether they are sitting or
 * driving. Flat lanes, so a system reads one number per seat and allocates
 * nothing. Authority state; reset in `init`.
 */
import type { GameContext } from 'gameable';

import { NAME_MAX_CHARS, cleanText } from './chat';

/** Seats a room has: `features.multiplayer.maxPlayers`. */
export const MAX_PLAYERS = 12;

/** Nothing in reach. */
export const PROMPT_NONE = 0;
/** A closed door in reach. */
export const PROMPT_OPEN = 1;
/** An open door in reach. */
export const PROMPT_CLOSE = 2;
/** A free car in reach. */
export const PROMPT_DRIVE = 3;
/** Driving: E gets out. */
export const PROMPT_EXIT = 4;
/** A bench in reach. */
export const PROMPT_SIT = 5;
/** Sitting: F stands up. */
export const PROMPT_STAND = 6;

/** Per-seat lanes. */
export const residents = {
  /** The entity each seat was last seen with; 0 for an empty seat. */
  entity: new Int32Array(MAX_PLAYERS),
  /** Their house, `-1` for none. */
  house: new Int8Array(MAX_PLAYERS),
  /** The colour they wear, `#rrggbb`, or `''` for the character's own. */
  color: new Array<string>(MAX_PLAYERS).fill(''),
  /** The bench they sit on, 0 for none. */
  bench: new Int32Array(MAX_PLAYERS),
  /** The car they drive, by index in `props.cars`, `-1` for none. */
  car: new Int8Array(MAX_PLAYERS),
  /** What E or F would do for them right now (`PROMPT_*`). */
  prompt: new Uint8Array(MAX_PLAYERS),
  /** Seats with a body, this tick. */
  count: 0,
};

/**
 * Empty one seat's lanes.
 *
 * @param seat The seat.
 */
export function clearSeat(seat: number): void {
  residents.entity[seat] = 0;
  residents.house[seat] = -1;
  residents.color[seat] = '';
  residents.bench[seat] = 0;
  residents.car[seat] = -1;
  residents.prompt[seat] = PROMPT_NONE;
}

/** Forget everyone. Call from `defineGame({ init })`. */
export function resetResidents(): void {
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) clearSeat(seat);
  residents.count = 0;
}

/**
 * A rule read as a number, with a fallback.
 *
 * @param value The rule value.
 * @param fallback What to use when it is missing or not a number.
 * @returns The number.
 */
export function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A player's display name, cleaned like a chat line, or their seat number.
 *
 * @param ctx The frame context.
 * @param player The player.
 * @returns The name.
 */
export function nameOf(ctx: GameContext, player: number): string {
  const name = cleanText(ctx.players.get(player)?.name ?? '', NAME_MAX_CHARS);
  return name === '' ? `player ${String(player + 1)}` : name;
}
