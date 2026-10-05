/**
 * Who is in the room, read from `ctx.players` without iterating it (a `Map`
 * iterator is an allocation per tick; `get` by id is not).
 */
import type { GameContext } from 'gameable';

import { NAME_MAX_CHARS, cleanText } from './chat';
import { MAX_SEATS } from './round';

/**
 * The host: the room's `ctx.players.host`, when they have a body. That is the
 * first joiner, kept until they leave or their link drops (the room holds the
 * seat), and then the lowest seat still listed. A newcomer who takes seat 0
 * does not become host.
 *
 * @param ctx The frame context.
 * @returns The host's player id, or -1 in an empty room (and in solo).
 */
export function hostOf(ctx: GameContext): number {
  const host = ctx.players.host;
  if (host === undefined || host >= MAX_SEATS || ctx.playerEntity(host) === 0) return -1;
  return host;
}

/**
 * Every seated player with an entity, ascending.
 *
 * @param ctx The frame context.
 * @param out Filled from index 0.
 * @returns How many were written.
 */
export function seated(ctx: GameContext, out: Int32Array): number {
  let n = 0;
  for (let id = 0; id < MAX_SEATS && n < out.length; id += 1) {
    if (ctx.players.get(id)?.connected === true && ctx.playerEntity(id) !== 0) {
      out[n] = id;
      n += 1;
    }
  }
  return n;
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
 * Names come from the pages and are not unique, so the HUD shows the seat
 * beside them (`#2 You`).
 *
 * @param ctx The frame context.
 * @param player The player.
 * @returns The name.
 */
export function nameOf(ctx: GameContext, player: number): string {
  const name = cleanText(ctx.players.get(player)?.name ?? '', NAME_MAX_CHARS);
  return name === '' ? `player ${String(player + 1)}` : name;
}
