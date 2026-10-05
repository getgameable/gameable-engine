/**
 * A two-seat ledger, for the boundary test of player data (Task 5.2): each
 * `earn` message adds a coin to the sender's document, a `trade` message
 * gives the other seat coins through `ctx.data.exchange`, and each player's
 * HUD shows their coins, when their document was saved, and the last result.
 */
import { defineGame, type GameContext } from 'gameable';

/** A player's document. */
interface Wallet {
  coins?: number;
}

/** One HUD model per seat, reused: `hud.set` sends only a changed model. */
const huds = [
  { coins: 0, since: 0, last: '' },
  { coins: 0, since: 0, last: '' },
];

/** The last exchange result, as `id:ok` or `id:reason`. */
let last = '';

/**
 * @param ctx The frame context.
 * @param player A seat.
 * @returns The seat's coins.
 */
function coinsOf(ctx: GameContext, player: number): number {
  return ((ctx.players.get(player)?.data ?? {}) as Wallet).coins ?? 0;
}

/** @param ctx The frame context. */
function ledger(ctx: GameContext): void {
  const earned = ctx.net.messages('earn');
  for (let i = 0; i < earned.length; i += 1) {
    const from = earned[i].player;
    ctx.data.save(from, { coins: coinsOf(ctx, from) + 1 });
  }
  const trades = ctx.net.messages<{ coins: number }>('trade');
  for (let i = 0; i < trades.length; i += 1) {
    const from = trades[i].player;
    ctx.data.exchange(from, 1 - from, { coins: trades[i].payload.coins }, {});
  }
  const results = ctx.data.results();
  for (let i = 0; i < results.length; i += 1) {
    last = `${String(results[i].id)}:${results[i].ok ? 'ok' : results[i].reason}`;
  }
  const list = ctx.players.list;
  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    const model = huds[p.id];
    model.coins = coinsOf(ctx, p.id);
    model.since = p.savedAt ?? 0;
    model.last = last;
    p.hud.set(model);
  }
}

export default defineGame({
  features: { multiplayer: { maxPlayers: 2 } },
  init: () => {
    last = '';
  },
  systems: [ledger],
});
