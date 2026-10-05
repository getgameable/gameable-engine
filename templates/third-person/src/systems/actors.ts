/**
 * Who is playing, one at a time: the systems that act on a player's keys
 * (interact, dialogue, the HUD) visit each player through here.
 *
 * - Alone (no `features.multiplayer`): one actor, the hero, from this page's
 *   keys, camera and HUD.
 * - On a room's authority (a room server's, or Play Solo's in the page): one
 *   actor per player with a hero, each with their own input and their own HUD.
 * - On a client: nobody. The authority decides; the page draws.
 *
 * The world they act on is shared. What belongs to one player (their pocket,
 * their conversation, their HUD) lives in a `SeatStore` (`./seats`), keyed by
 * player id; seat 0 is the single player's, so the exported state objects
 * (`interactState`, `questState`, `dialogueState`) still mean what they
 * always meant.
 */
import type { GameContext } from 'gameable';

import { locomotionState, playerLocomotion } from './locomotion';

/** One player, as a system acting for them sees them. Reused: never keep it. */
export interface Actor {
  /** The player id; 0 when alone. */
  id: number;
  /** The hero they control. */
  entity: number;
  /** Their keys. */
  input: GameContext['input'];
  /** Their HUD: only they see it. */
  hud: GameContext['hud'];
  /** Their camera yaw, radians: where "in front of me" is. */
  yaw: number;
  /** Their locomotion state name (`idle`, `walk`, ...). */
  motion: string;
}

/** The one actor object, filled in per visit so a system allocates nothing. */
let actor: Actor | null = null;

/**
 * Visit every player who has a hero, in id order.
 *
 * @param ctx The frame context.
 * @param visit Called once per player, with a reused {@link Actor}.
 */
export function eachActor(ctx: GameContext, visit: (ctx: GameContext, actor: Actor) => void): void {
  actor ??= { id: 0, entity: 0, input: ctx.input, hud: ctx.hud, yaw: 0, motion: '' };
  const a = actor;
  if (ctx.net.role === 'solo') {
    if (ctx.player === 0) return;
    a.id = 0;
    a.entity = ctx.player;
    a.input = ctx.input;
    a.hud = ctx.hud;
    a.yaw = locomotionState.yaw;
    a.motion = locomotionState.state;
    visit(ctx, a);
    return;
  }
  if (ctx.net.role !== 'authority') return;
  const list = ctx.players.list;
  for (let i = 0; i < list.length; i += 1) {
    const player = list[i];
    if (player.entity === 0) continue;
    const moving = playerLocomotion(player.id);
    a.id = player.id;
    a.entity = player.entity;
    a.input = player.input;
    a.hud = player.hud;
    a.yaw = moving?.yaw ?? 0;
    a.motion = moving?.state ?? '';
    visit(ctx, a);
  }
}
