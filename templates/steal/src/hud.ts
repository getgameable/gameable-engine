/**
 * Every player's HUD, written by the authority through their own handle:
 * their coins, their brainrots, the multiplier, the shield, and how far a
 * steal has got.
 *
 * A HUD is rebuilt only on the ticks one of those numbers changed (the last
 * drawn values per seat), so a quiet tick compares numbers and allocates nothing.
 */
import type { GameContext } from 'gameable';

import { walletOf } from './bank';
import { heist, MAX_SEATS, NOBODY } from './heist';
import { MAX_PLAYERS } from './ring';
import { num } from './rules';
import { multiplier, type Wallet } from './wallet';

/** What each seat's HUD showed, the last time it was drawn. */
const LANES = 5;
const drawn = new Float64Array(MAX_SEATS * LANES);
/** The entity each seat had when it was drawn: a new occupant is always drawn. */
const drawnFor = new Int32Array(MAX_SEATS);
let soloDrawn = false;

/** Forget what was drawn. Call from `defineGame({ init })`. */
export function resetHud(): void {
  drawn.fill(-1);
  drawnFor.fill(0);
  soloDrawn = false;
}

/**
 * @param ctx The frame context.
 * @param wallet Their wallet.
 * @returns Whole seconds of shield left.
 */
function shieldLeft(ctx: GameContext, wallet: Wallet): number {
  return Math.max(0, Math.ceil((wallet.shieldUntil - heist.now(ctx)) / 1000));
}

/**
 * @param ctx The frame context.
 * @param id A player.
 * @param wallet Their wallet.
 * @returns What their HUD says.
 */
function model(ctx: GameContext, id: number, wallet: Wallet): Record<string, unknown> {
  const shield = shieldLeft(ctx, wallet);
  const bonus = num(ctx.rules.rebirthBonus, 0.5);
  const rebirthCost = num(ctx.rules.rebirthCost, 100);
  let message = `walk into a brainrot on the belt · stand in another base to steal · Q shield (${String(num(ctx.rules.shieldCost, 10))})`;
  if (wallet.coins >= rebirthCost)
    message = `R: rebirth for x${String(multiplier(wallet, bonus) + bonus)} income`;
  if (heist.standingIn[id] !== NOBODY) {
    const left = Math.max(0, num(ctx.rules.stealSeconds, 3) - heist.standing[id]);
    message = `stealing… ${left.toFixed(1)} s`;
  }
  return {
    text: {
      coins: String(wallet.coins),
      brainrots: String(wallet.owned.length),
      multiplier: `x${String(multiplier(wallet, bonus))}`,
      shield: shield > 0 ? `${String(shield)} s` : 'off',
    },
    message,
  };
}

/**
 * @param seat A seat.
 * @param lane Which of its numbers.
 * @param value That number now.
 * @returns True when it changed since the last draw (and records it).
 */
function record(seat: number, lane: number, value: number): boolean {
  const at = seat * LANES + lane;
  if (drawn[at] === value) return false;
  drawn[at] = value;
  return true;
}

/**
 * The `hud` system.
 *
 * @param ctx The frame context.
 */
export function hud(ctx: GameContext): void {
  if (ctx.net.role === 'solo') {
    if (soloDrawn) return;
    soloDrawn = true;
    ctx.hud.set({ text: { players: `1/${String(MAX_PLAYERS)}` }, message: 'waiting for a room' });
    return;
  }
  const list = ctx.players.list;
  for (let i = 0; i < list.length; i += 1) {
    const handle = list[i];
    const id = handle.id;
    const wallet = walletOf(ctx, id);
    if (id >= MAX_SEATS || handle.entity === 0 || wallet === undefined) continue;
    const steal = heist.standingIn[id] === NOBODY ? -1 : Math.floor(heist.standing[id] * 10);
    // Bitwise OR, not ||: every lane is recorded, even after the first change.
    const dirty =
      Number(record(id, 0, wallet.coins)) |
      Number(record(id, 1, wallet.owned.length)) |
      Number(record(id, 2, wallet.rebirths)) |
      Number(record(id, 3, shieldLeft(ctx, wallet))) |
      Number(record(id, 4, steal));
    if (dirty === 0 && drawnFor[id] === handle.entity) continue;
    drawnFor[id] = handle.entity;
    handle.hud.set(model(ctx, id, wallet));
  }
}
