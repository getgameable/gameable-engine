/**
 * In a room, each player's hero gets the hero colour the moment it exists.
 * Alone, `paintTheLevel` in `src/game.ts` paints the one hero at `init`.
 */
import type { GameContext } from 'gameable';

import { HERO_COLOUR, tint } from '../prefabs';
import { eachActor, type Actor } from './actors';

/** The entity each seat's hero was last painted on. */
const painted: number[] = [];

/** Forget every painted hero. Call from `defineGame({ init })`. */
export function resetPaint(): void {
  painted.length = 0;
}

/**
 * @param _ctx The frame context.
 * @param who A player.
 */
function paint(_ctx: GameContext, who: Actor): void {
  if (painted[who.id] === who.entity) return;
  painted[who.id] = who.entity;
  tint(who.entity, HERO_COLOUR);
}

/**
 * Paint every new hero, on a room's authority.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
export function paintPlayers(ctx: GameContext): void {
  if (ctx.net.role !== 'authority') return;
  eachActor(ctx, paint);
}
