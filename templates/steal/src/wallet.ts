/**
 * The player document: what a player keeps between sessions, and the pure
 * rules over it. The room loads it at join (`ctx.players.get(id).data`) and
 * `ctx.data.save` writes it back; a steal moves one id between two of them
 * through `ctx.data.exchange`.
 *
 * Pure functions: no context, no clock, so the tests can call them alone.
 */

/** A player's saved progress. */
export interface Wallet {
  /** Coins earned, spent on shields and rebirths. */
  coins: number;
  /** The brainrots in this player's base, by id; income is paid per id. */
  owned: string[];
  /** Server time (ms since the epoch) the shield holds until; 0 for none. */
  shieldUntil: number;
  /** Rebirths taken; each one raises the income multiplier. */
  rebirths: number;
  /** Fields a game adds of its own (see the `save-player-progress` recipe), kept as they are. */
  [field: string]: unknown;
}

/**
 * @param value Anything.
 * @param fallback What to use when it is not a finite number.
 * @returns The number.
 */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Read a document as a wallet. A missing or odd field takes its starting
 * value, so a new player (`null`) and an older save both read cleanly; any
 * other field is kept as it is.
 *
 * @param data `PlayerHandle.data`.
 * @returns A fresh wallet object.
 */
export function readWallet(data: unknown): Wallet {
  const isDoc = typeof data === 'object' && data !== null && !Array.isArray(data);
  const doc = (isDoc ? data : {}) as Partial<Wallet>;
  const owned = Array.isArray(doc.owned) ? doc.owned.filter((id) => typeof id === 'string') : [];
  return {
    ...doc,
    coins: Math.max(0, finite(doc.coins, 0)),
    owned,
    shieldUntil: finite(doc.shieldUntil, 0),
    rebirths: Math.max(0, Math.floor(finite(doc.rebirths, 0))),
  };
}

/**
 * @param wallet A wallet.
 * @param rebirthBonus What each rebirth adds to the multiplier (`rules.rebirthBonus`).
 * @returns The income multiplier: 1, plus `rebirthBonus` per rebirth.
 */
export function multiplier(wallet: Wallet, rebirthBonus: number): number {
  return 1 + wallet.rebirths * rebirthBonus;
}

/**
 * @param wallet A wallet.
 * @param perItem Coins one brainrot earns per payout (`rules.incomePerItem`).
 * @param rebirthBonus `rules.rebirthBonus`.
 * @returns Coins one payout gives this wallet, whole.
 */
export function payout(wallet: Wallet, perItem: number, rebirthBonus: number): number {
  return Math.floor(wallet.owned.length * perItem * multiplier(wallet, rebirthBonus));
}

/**
 * Income for the time a player was away: one payout per whole `everySeconds`
 * between the save and now, the time capped at `capSeconds`.
 *
 * @param wallet The wallet as saved.
 * @param savedAt When it was saved, server ms (`PlayerHandle.savedAt`), or null.
 * @param now The server's clock at the join, ms (`PlayerHandle.joinedAt`), or null.
 * @param rules `everySeconds`, `capSeconds`, `perItem`, `rebirthBonus`.
 * @param rules.everySeconds Seconds between payouts.
 * @param rules.capSeconds The most offline time that counts.
 * @param rules.perItem Coins per brainrot per payout.
 * @param rules.rebirthBonus Multiplier added per rebirth.
 * @returns Coins to credit; 0 when either time is unknown.
 */
export function offlineIncome(
  wallet: Wallet,
  savedAt: number | null,
  now: number | null,
  rules: { everySeconds: number; capSeconds: number; perItem: number; rebirthBonus: number },
): number {
  if (savedAt === null || now === null || rules.everySeconds <= 0) return 0;
  const away = Math.min(Math.max(0, (now - savedAt) / 1000), rules.capSeconds);
  return Math.floor(away / rules.everySeconds) * payout(wallet, rules.perItem, rules.rebirthBonus);
}
