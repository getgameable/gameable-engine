/**
 * The day/night clock. Authority only.
 *
 * A day lasts `rules.daySeconds`, a night `rules.nightSeconds`. At dusk the
 * creatures come out of the tree line, more each night. At dawn they are
 * gone, every player still on their feet has survived one more night
 * (`nightsSurvived`, saved in their document), and every downed player gets
 * up at the camp. The room
 * list shows the phase: `day` or `night`.
 */
import { Health, type GameContext } from 'gameable';

import { CAMP, TREE_LINE, onCircle } from '../arena';
import { MAX_CREATURES, MAX_SEATS, PHASE_DAY, PHASE_NIGHT, camp } from '../camp';
import { COLOURS, CREATURE_CENTRE, Creature, tint } from '../prefabs';
import { num } from '../rules';

/** Reused spawn point. */
const at = { x: 0, y: CREATURE_CENTRE, z: 0 };
/** Reused payloads. */
const nightPayload = { night: 0 };

/**
 * Night falls: spawn this night's creatures, spread round the tree line from
 * a seeded starting angle, so they come from a different side each night.
 *
 * @param ctx The frame context.
 */
function dusk(ctx: GameContext): void {
  camp.phase = PHASE_NIGHT;
  camp.phaseStartedAt = ctx.elapsed;
  camp.night += 1;
  const first = num(ctx.rules.creaturesFirstNight, 3);
  const more = num(ctx.rules.creaturesPerNight, 1);
  const n = Math.min(MAX_CREATURES, Math.floor(first + more * (camp.night - 1)));
  const start = ctx.rng.float() * Math.PI * 2;
  for (let i = 0; i < n; i += 1) {
    onCircle(start + (i / n) * Math.PI * 2, TREE_LINE, at);
    const creature = ctx.spawn(Creature, at);
    tint(creature, COLOURS.creature);
    camp.cooldown[creature] = 0;
    camp.creatures.add(creature);
  }
  nightPayload.night = camp.night;
  ctx.net.send('night', nightPayload);
}

/**
 * The sun comes up: the creatures go, the night counts for everyone standing,
 * and the downed get up at the camp with full health.
 *
 * @param ctx The frame context.
 */
function dawn(ctx: GameContext): void {
  camp.phase = PHASE_DAY;
  camp.phaseStartedAt = ctx.elapsed;
  const creatures = camp.creatures;
  for (let i = 0; i < creatures.count; i += 1) ctx.despawn(creatures.items[i]);
  creatures.clear();
  for (let id = 0; id < MAX_SEATS; id += 1) {
    const entity = ctx.playerEntity(id);
    if (entity === 0) continue;
    if (camp.downed[id] === 0) {
      camp.nightsSurvived[id] += 1;
      // Kept in the player's document, beside whatever else it holds, so it outlasts the room.
      const doc = ctx.players.get(id)?.data;
      const kept = typeof doc === 'object' && doc !== null ? doc : {};
      ctx.data.save(id, { ...kept, nightsSurvived: camp.nightsSurvived[id] });
      continue;
    }
    camp.downed[id] = 0;
    Health.current[entity] = Health.max[entity];
    ctx.physics.teleport(entity, CAMP[0], CAMP[1], CAMP[2]);
  }
  ctx.net.send('dawn', nightPayload);
}

/**
 * The `clock` system.
 *
 * @param ctx The frame context.
 */
export function clock(ctx: GameContext): void {
  const night = camp.phase === PHASE_NIGHT;
  const length = night ? num(ctx.rules.nightSeconds, 45) : num(ctx.rules.daySeconds, 60);
  if (ctx.elapsed - camp.phaseStartedAt >= length) {
    if (night) dawn(ctx);
    else dusk(ctx);
  }
  ctx.net.setPhase(camp.phase === PHASE_NIGHT ? 'night' : 'day');
}

/**
 * @param ctx The frame context.
 * @returns Whole seconds left in this phase.
 */
export function secondsLeft(ctx: GameContext): number {
  const night = camp.phase === PHASE_NIGHT;
  const length = night ? num(ctx.rules.nightSeconds, 45) : num(ctx.rules.daySeconds, 60);
  return Math.max(0, Math.ceil(length - (ctx.elapsed - camp.phaseStartedAt)));
}
