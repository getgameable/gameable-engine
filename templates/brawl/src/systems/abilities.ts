/**
 * The three abilities, on the authority: every `punch`, `dash` and `slam` a
 * page sent is checked here, and only here, before anything happens.
 *
 * - **Cooldown**: an ability used again before its cooldown is over is
 *   refused (`refused` `{ why: 'cooldown' }`), and the cooldown is not reset.
 * - **Range**: a punch reaches `punchRange`, a slam everyone within
 *   `slamRadius`. Nobody in reach is a refusal (`'range'`); the cooldown
 *   still starts, as a swing at the air does.
 * - **Facing**: a punch only lands on someone in front, within
 *   `punchArcDegrees` of where the attacker faces (`'facing'`).
 *
 * A hit takes health, knocks the victim back away from the attacker, flashes
 * them red, and is confirmed with a `hit` to the attacker and to the victim.
 * Health at 0 is a knockout (`src/systems/round.ts`).
 *
 * Positions are the authority's own `Transform`: what the server says is
 * where the hit lands.
 */
import { Transform, type GameContext, type PlayerHandle } from 'gameable';

import { fight, MAX_PLAYERS, num, PHASE_FIGHTING } from '../fight';
import { Dash, Hit, Punch, Refused, Slam, type HitPayload, type RefusedWhy } from '../messages';
import { tint } from '../prefabs';
import { knockOut } from './round';

/** `ABILITIES` indices. */
const PUNCH = 0;
const DASH = 1;
const SLAM = 2;

/** Reused payloads and send options: a system must not allocate. */
const hit: HitPayload = { by: 0, to: 0, ability: 0, damage: 0, hp: 0 };
const refused: { ability: number; why: RefusedWhy } = { ability: 0, why: 'cooldown' };
const to = { to: 0 };

/**
 * @param ctx The frame context.
 * @param seat Who asked.
 * @param ability Which ability.
 * @param why Why not.
 */
function refuse(ctx: GameContext, seat: number, ability: number, why: RefusedWhy): void {
  refused.ability = ability;
  refused.why = why;
  to.to = seat;
  ctx.net.send(Refused, refused, to);
}

/**
 * Land one hit: damage, knockback away from the attacker, flash, confirmation.
 *
 * @param ctx The frame context.
 * @param by The attacker.
 * @param victim The victim.
 * @param ability `PUNCH` or `SLAM`.
 * @param damage Health taken.
 * @param knockback Metres per second, along the line from attacker to victim.
 */
function land(
  ctx: GameContext,
  by: PlayerHandle,
  victim: PlayerHandle,
  ability: number,
  damage: number,
  knockback: number,
): void {
  const a = by.entity;
  const v = victim.entity;
  const dx = Transform.x[v] - Transform.x[a];
  const dz = Transform.z[v] - Transform.z[a];
  const length = Math.hypot(dx, dz);
  const nx = length > 1e-4 ? dx / length : fight.faceX[by.id];
  const nz = length > 1e-4 ? dz / length : fight.faceZ[by.id];
  fight.knockX[victim.id] = nx * knockback;
  fight.knockZ[victim.id] = nz * knockback;
  fight.hp[victim.id] = Math.max(0, fight.hp[victim.id] - damage);
  fight.flash[victim.id] = num(ctx.rules.flashSeconds, 0.15);
  tint(v, 1, 0.25, 0.25);

  hit.by = by.id;
  hit.to = victim.id;
  hit.ability = ability;
  hit.damage = damage;
  hit.hp = fight.hp[victim.id];
  to.to = by.id;
  ctx.net.send(Hit, hit, to);
  to.to = victim.id;
  ctx.net.send(Hit, hit, to);
  if (fight.hp[victim.id] === 0) knockOut(ctx, by.id, victim.id);
}

/**
 * The ground distance between two fighters, and whether `target` is inside the
 * attacker's facing arc.
 *
 * @param attacker The attacker's seat and entity.
 * @param target The target's entity.
 * @param arcCos The cosine of half the arc; -1 for all the way round.
 * @returns The distance, or -1 when the target is outside the arc.
 */
function reach(attacker: PlayerHandle, target: number, arcCos: number): number {
  const dx = Transform.x[target] - Transform.x[attacker.entity];
  const dz = Transform.z[target] - Transform.z[attacker.entity];
  const d = Math.hypot(dx, dz);
  if (d < 1e-4 || arcCos <= -1) return d;
  const dot = (dx * fight.faceX[attacker.id] + dz * fight.faceZ[attacker.id]) / d;
  return dot >= arcCos ? d : -1;
}

/**
 * A strike in front: the nearest fighter within `range` and the facing arc.
 * The punch is one; a new move in front of the fighter is another call.
 *
 * @param ctx The frame context.
 * @param by The attacker.
 * @param ability Its number, as `hit` and `refused` name it.
 * @param range Reach, metres.
 * @param arcDegrees The arc in front it lands in, degrees.
 * @param damage Health taken.
 * @param knockback Metres per second.
 */
export function strike(
  ctx: GameContext,
  by: PlayerHandle,
  ability: number,
  range: number,
  arcDegrees: number,
  damage: number,
  knockback: number,
): void {
  const arcCos = Math.cos((arcDegrees * Math.PI) / 360);
  const list = ctx.players.list;
  let best: PlayerHandle | null = null;
  let bestDistance = Infinity;
  let behind = false;
  for (let i = 0; i < list.length; i += 1) {
    const other = list[i];
    if (other.id === by.id || other.entity === 0 || other.id >= MAX_PLAYERS) continue;
    if (fight.out[other.id] === 1) continue;
    const d = reach(by, other.entity, arcCos);
    if (d < 0) {
      behind ||= reach(by, other.entity, -1) <= range;
      continue;
    }
    if (d <= range && d < bestDistance) {
      best = other;
      bestDistance = d;
    }
  }
  if (best === null) refuse(ctx, by.id, ability, behind ? 'facing' : 'range');
  else land(ctx, by, best, ability, damage, knockback);
}

/**
 * A ground slam: everyone within the radius, all the way round.
 *
 * @param ctx The frame context.
 * @param by The attacker.
 */
function slam(ctx: GameContext, by: PlayerHandle): void {
  const radius = num(ctx.rules.slamRadius, 2.5);
  const list = ctx.players.list;
  let landed = 0;
  for (let i = 0; i < list.length; i += 1) {
    const other = list[i];
    if (other.id === by.id || other.entity === 0 || other.id >= MAX_PLAYERS) continue;
    if (fight.out[other.id] === 1 || reach(by, other.entity, -1) > radius) continue;
    land(ctx, by, other, SLAM, num(ctx.rules.slamDamage, 20), num(ctx.rules.slamKnockback, 10));
    landed += 1;
  }
  if (landed === 0) refuse(ctx, by.id, SLAM, 'range');
}

/**
 * Check what every ability has in common: a live fighter, a round on, and
 * the cooldown over. Starts the cooldown when it passes.
 *
 * @param ctx The frame context.
 * @param player Who asked, or undefined for a seat with no player.
 * @param ability Which ability.
 * @param ready The ability's cooldown lane.
 * @param cooldown Its cooldown, seconds.
 * @returns True when the ability may go off.
 */
export function allowed(
  ctx: GameContext,
  player: PlayerHandle | undefined,
  ability: number,
  ready: Float32Array,
  cooldown: number,
): player is PlayerHandle {
  if (player === undefined || player.entity === 0 || player.id >= MAX_PLAYERS) return false;
  const seat = player.id;
  let why: RefusedWhy | null = null;
  if (fight.phase !== PHASE_FIGHTING) why = 'round-over';
  else if (fight.out[seat] === 1) why = 'out';
  else if (ready[seat] > 0) why = 'cooldown';
  if (why !== null) {
    refuse(ctx, seat, ability, why);
    return false;
  }
  ready[seat] = cooldown;
  return true;
}

/**
 * The `abilities` system. Authority only.
 *
 * @param ctx The frame context.
 */
export function abilities(ctx: GameContext): void {
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    fight.punchReady[seat] = Math.max(0, fight.punchReady[seat] - ctx.dt);
    fight.dashReady[seat] = Math.max(0, fight.dashReady[seat] - ctx.dt);
    fight.slamReady[seat] = Math.max(0, fight.slamReady[seat] - ctx.dt);
    if (fight.flash[seat] <= 0) continue;
    fight.flash[seat] -= ctx.dt;
    const entity = ctx.playerEntity(seat);
    if (fight.flash[seat] <= 0 && entity !== 0) tint(entity, 1, 1, 1);
  }

  const punches = ctx.net.messages(Punch);
  for (let i = 0; i < punches.length; i += 1) {
    const player = ctx.players.get(punches[i].player);
    if (allowed(ctx, player, PUNCH, fight.punchReady, num(ctx.rules.punchCooldown, 0.4))) {
      const r = ctx.rules;
      strike(
        ctx,
        player,
        PUNCH,
        num(r.punchRange, 1.6),
        num(r.punchArcDegrees, 120),
        num(r.punchDamage, 12),
        num(r.punchKnockback, 7),
      );
    }
  }
  const dashes = ctx.net.messages(Dash);
  for (let i = 0; i < dashes.length; i += 1) {
    const player = ctx.players.get(dashes[i].player);
    if (allowed(ctx, player, DASH, fight.dashReady, num(ctx.rules.dashCooldown, 1.5))) {
      fight.dashing[player.id] = num(ctx.rules.dashSeconds, 0.15);
    }
  }
  const slams = ctx.net.messages(Slam);
  for (let i = 0; i < slams.length; i += 1) {
    const player = ctx.players.get(slams[i].player);
    if (allowed(ctx, player, SLAM, fight.slamReady, num(ctx.rules.slamCooldown, 3))) {
      slam(ctx, player);
    }
  }
}
