/**
 * Coins, on the authority: `rules.coinCount` of them lie about the arena,
 * placed with `ctx.rng`. Walk within `rules.coinRange` of one and it is worth
 * `rules.coinValue` bucks to you; it moves somewhere else at once.
 */
import { Transform, type GameContext } from 'gameable';

import { coinSpot } from '../arena';
import { collection, MAX_COINS, MAX_SEATS } from '../collection';
import { docOf, saveDoc } from '../docs';
import { COIN_HALF, CoinBody, GOLD, place, tint } from '../prefabs';
import { num } from '../rules';

/** Reused spot and payload. */
const spot = { x: 0, y: COIN_HALF[1], z: 0 };
const toOne = { to: 0 };

/**
 * Move coin `i` to a fresh random spot.
 *
 * @param ctx The frame context.
 * @param i The coin's index.
 * @param teleport True after a pick-up, so pages snap it.
 */
function scatter(ctx: GameContext, i: number, teleport: boolean): void {
  coinSpot(ctx.rng, spot);
  collection.coinX[i] = spot.x;
  collection.coinZ[i] = spot.z;
  if (teleport) place(collection.coins[i], spot.x, spot.y, spot.z, true);
}

/**
 * Lay the coins, once, on the authority's first tick.
 *
 * @param ctx The frame context.
 */
function lay(ctx: GameContext): void {
  const count = Math.min(MAX_COINS, Math.max(1, num(ctx.rules.coinCount, 16)));
  for (let i = 0; i < count; i += 1) {
    scatter(ctx, i, false);
    const coin = ctx.spawn(CoinBody, spot);
    tint(coin, GOLD);
    collection.coins[i] = coin;
  }
  collection.coinCount = count;
}

/**
 * @param ctx The frame context.
 * @param player The collector.
 * @param i The coin they reached.
 */
function pickUp(ctx: GameContext, player: number, i: number): void {
  const doc = docOf(ctx, player);
  if (doc !== null) {
    const bucks = doc.bucks + num(ctx.rules.coinValue, 5);
    saveDoc(ctx, player, { bucks, pets: doc.pets, eggs: doc.eggs });
    toOne.to = player;
    ctx.net.send('coin', { bucks }, toOne);
  }
  scatter(ctx, i, true);
}

/**
 * The `coins` system.
 *
 * @param ctx The frame context.
 */
export function coins(ctx: GameContext): void {
  if (collection.coinCount === 0) lay(ctx);
  const range = num(ctx.rules.coinRange, 1.2);
  for (let player = 0; player < MAX_SEATS; player += 1) {
    const entity = ctx.playerEntity(player);
    if (entity === 0) continue;
    const x = Transform.x[entity];
    const z = Transform.z[entity];
    for (let i = 0; i < collection.coinCount; i += 1) {
      const d = Math.hypot(collection.coinX[i] - x, collection.coinZ[i] - z);
      if (d <= range) pickUp(ctx, player, i);
    }
  }
}
