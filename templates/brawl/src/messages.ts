/**
 * Every message in the game, declared once with its check. A payload that
 * fails its check never reaches a system: the SDK drops it and counts it in
 * `ctx.net.stats.dropped`.
 *
 * Up, from a player's page: `punch`, `dash` and `slam`, each `null`. The
 * authority decides whether it lands (cooldown, range, facing); the page only
 * asks.
 *
 * Down, from the authority:
 * - `hit` `{ by, to, ability, damage, hp }` to the attacker and to the victim;
 * - `refused` `{ ability, why }` to the player whose ability did not go off;
 * - `ko` `{ by, to }` and `respawn` `{ player }` to everyone;
 * - `round` `{ winner }` to everyone when someone reaches the knockouts to win.
 */
import { defineMessage } from 'gameable';

/** A payload that is exactly `null`: the message is the whole meaning. */
const isNull = (p: unknown): p is null => p === null;

/** @returns True for a plain object (not null, not an array). */
const isObject = (p: unknown): p is Record<string, unknown> =>
  typeof p === 'object' && p !== null && !Array.isArray(p);

/** J: punch whoever is in front of me and close. */
export const Punch = defineMessage('punch', isNull, { maxBytes: 8 });
/** K: dash the way I face. */
export const Dash = defineMessage('dash', isNull, { maxBytes: 8 });
/** L: slam the ground, hitting everyone around me. */
export const Slam = defineMessage('slam', isNull, { maxBytes: 8 });

/** The abilities, by number, as `hit` and `refused` name them. */
export const ABILITIES = ['punch', 'dash', 'slam'] as const;

/** A hit that landed, as the attacker and the victim are told. */
export interface HitPayload {
  /** The attacker's seat. */
  by: number;
  /** The victim's seat. */
  to: number;
  /** 0 punch, 2 slam (`ABILITIES`). */
  ability: number;
  damage: number;
  /** The victim's health after the hit. */
  hp: number;
}

/** A hit confirmation, down to the attacker and the victim. */
export const Hit = defineMessage(
  'hit',
  (p): p is HitPayload =>
    isObject(p) && Number.isInteger(p.by) && Number.isInteger(p.to) && typeof p.hp === 'number',
  { maxBytes: 96 },
);

/** Why an ability did not go off. */
export type RefusedWhy = 'cooldown' | 'range' | 'facing' | 'out' | 'round-over';

/** An ability the authority turned down, to the one who asked. */
export const Refused = defineMessage(
  'refused',
  (p): p is { ability: number; why: RefusedWhy } =>
    isObject(p) && Number.isInteger(p.ability) && typeof p.why === 'string',
  { maxBytes: 64 },
);

/** A knockout, to everyone. */
export const Ko = defineMessage(
  'ko',
  (p): p is { by: number; to: number } =>
    isObject(p) && Number.isInteger(p.by) && Number.isInteger(p.to),
  { maxBytes: 32 },
);

/** A knocked-out fighter is back at their spawn, to everyone. */
export const Respawn = defineMessage(
  'respawn',
  (p): p is { player: number } => isObject(p) && Number.isInteger(p.player),
  { maxBytes: 32 },
);

/** Someone won the round, to everyone. The next round starts a few seconds later. */
export const Round = defineMessage(
  'round',
  (p): p is { winner: number } => isObject(p) && Number.isInteger(p.winner),
  { maxBytes: 32 },
);
