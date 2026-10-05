/**
 * Every player's HUD, written by the authority through their own handle:
 * day or night and the seconds left, their wood, their health, the nights
 * they have survived, and what to do now.
 *
 * Each HUD is rebuilt only on the ticks one of those numbers changed (a
 * signature per seat), so a quiet tick compares numbers and allocates nothing.
 */
import { Health, type GameContext } from 'gameable';

import { MAX_PLAYERS, MAX_SEATS, PHASE_NIGHT, camp } from './camp';
import { num } from './rules';
import { secondsLeft } from './systems/clock';

/** Last signature drawn per seat; the extra slot at the end is solo's. */
const drawn = new Float64Array(MAX_SEATS + 1);
/** The entity each seat had when it was drawn: a new occupant is always drawn. */
const drawnFor = new Int32Array(MAX_SEATS);

/** Forget what was drawn. Call from `defineGame({ init })`. */
export function resetHud(): void {
  drawn.fill(-1);
  drawnFor.fill(0);
}

/**
 * @param ctx The frame context.
 * @param id A player.
 * @param entity Their survivor.
 * @returns What their HUD says.
 */
function model(ctx: GameContext, id: number, entity: number): Record<string, unknown> {
  const night = camp.phase === PHASE_NIGHT;
  const left = String(secondsLeft(ctx));
  const time = night ? `night ${String(camp.night)} · ${left} s` : `day · ${left} s to dusk`;
  const cost = String(num(ctx.rules.wallCost, 2));
  let message = `E at a tree for wood · B builds a wall (${cost} wood)`;
  if (night) message = 'they are coming: hold the camp';
  if (camp.downed[id] === 1) message = 'you are down: you get up at dawn';
  return {
    text: {
      time,
      wood: String(camp.wood[id]),
      health: String(Math.ceil(Health.current[entity])),
      nights: String(camp.nightsSurvived[id]),
    },
    message,
  };
}

/**
 * @param ctx The frame context.
 * @param id A seated player.
 * @param entity Their survivor.
 * @returns The numbers their HUD depends on, packed into one.
 */
function signature(ctx: GameContext, id: number, entity: number): number {
  const health = Math.ceil(Health.current[entity]);
  const head = (camp.phase * 2 + camp.downed[id]) * 1024 + Math.min(1023, camp.wood[id]);
  return ((head * 1024 + camp.nightsSurvived[id]) * 256 + health) * 4096 + secondsLeft(ctx);
}

/**
 * The `hud` system.
 *
 * @param ctx The frame context.
 */
export function hud(ctx: GameContext): void {
  if (ctx.net.role === 'solo') {
    if (drawn[MAX_SEATS] === 0) return;
    drawn[MAX_SEATS] = 0;
    ctx.hud.set({ text: { players: `1/${String(MAX_PLAYERS)}` }, message: 'waiting for a room' });
    return;
  }
  for (let id = 0; id < MAX_SEATS; id += 1) {
    const entity = ctx.playerEntity(id);
    const handle = ctx.players.get(id);
    if (entity === 0 || handle === undefined) continue;
    const sig = signature(ctx, id, entity);
    if (drawn[id] === sig && drawnFor[id] === entity) continue;
    drawn[id] = sig;
    drawnFor[id] = entity;
    handle.hud.set(model(ctx, id, entity));
  }
}
