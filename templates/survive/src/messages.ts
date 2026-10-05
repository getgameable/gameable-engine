/**
 * The messages a player sends up, declared once with the game's own checks.
 * A payload that fails its check never reaches a system: the SDK drops it and
 * counts it in `ctx.net.stats.dropped`.
 *
 * What the authority sends down: `wood` `{ wood }` to the one player whose
 * count changed, `downed` `{ player }`, `night` `{ night }` at dusk and
 * `dawn` `{ night }` at dawn, to everyone.
 */
import { defineMessage } from 'gameable';

/** A payload that is exactly `null`: the message is the whole meaning. */
const isNull = (p: unknown): p is null => p === null;

/** E: take wood from the tree beside me. */
export const Gather = defineMessage('gather', isNull, { maxBytes: 8 });

/** B: put a wall up in front of me, if I hold the wood. */
export const Build = defineMessage('build', isNull, { maxBytes: 8 });
