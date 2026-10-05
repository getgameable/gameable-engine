/**
 * The messages a player sends up, declared once with the game's own checks.
 * A payload that fails its check never reaches a system: the SDK drops it and
 * counts it in `ctx.net.stats.dropped`.
 *
 * What the authority sends down, to everyone: `grabbed` `{ player, id }` when
 * someone takes a brainrot off the belt, `stolen` `{ thief, victim, id }`
 * when a steal's exchange went through, and `shielded` `{ player }`.
 */
import { defineMessage } from 'gameable';

/** A payload that is exactly `null`: the message is the whole meaning. */
const isNull = (p: unknown): p is null => p === null;

/** Q: shield my base for `rules.shieldSeconds`, for `rules.shieldCost` coins. */
export const Shield = defineMessage('shield', isNull, { maxBytes: 8 });

/** R: give up my coins and brainrots for a higher income multiplier, once I can afford it. */
export const Rebirth = defineMessage('rebirth', isNull, { maxBytes: 8 });
