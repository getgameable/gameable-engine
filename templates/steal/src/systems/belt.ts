/**
 * The conveyor. Authority only: the authority owns the brainrots, so a page
 * can walk into one but never mint one.
 *
 * Every `rules.conveyorSeconds` a brainrot appears at the belt's start and
 * rides to its end at `rules.beltSpeed`, where it falls off and is gone. A
 * player who walks within `rules.grabRadius` of one takes it: its id joins
 * their wallet's `owned`, and the wallet is saved.
 */
import { Transform, type GameContext } from 'gameable';

import { keep, walletOf } from '../bank';
import { heist, MAX_ON_BELT } from '../heist';
import { Brainrot, COLOURS, tint } from '../prefabs';
import { BELT_END, BELT_START, BRAINROT_Y } from '../ring';
import { num } from '../rules';

/** What brainrots are called; an id is a name and a random tag. */
const NAMES = ['tralalero', 'bombardiro', 'tung-tung', 'lirili', 'brr-brr', 'cappuccino'];

/** Reused spawn point and payload. */
const at = { x: BELT_START, y: BRAINROT_Y, z: 0 };
const grabbedPayload = { player: 0, id: '' };

/**
 * Put a new brainrot at the start of the belt.
 *
 * @param ctx The frame context.
 */
function spawnOne(ctx: GameContext): void {
  if (heist.onBelt >= MAX_ON_BELT) return;
  const name = NAMES[heist.spawned % NAMES.length];
  const tag = Math.floor(ctx.rng.float() * 0x100000).toString(36);
  heist.spawned += 1;
  const entity = ctx.spawn(Brainrot, at);
  tint(entity, COLOURS.brainrot);
  const slot = heist.onBelt;
  heist.beltEntity[slot] = entity;
  heist.beltId[slot] = `${name}-${tag}`;
  heist.beltSpawnedAt[slot] = ctx.elapsed;
  heist.onBelt += 1;
}

/**
 * @param ctx The frame context.
 * @param x A brainrot's x.
 * @returns The first seated player within `rules.grabRadius`, or -1.
 */
function grabber(ctx: GameContext, x: number): number {
  const radius = num(ctx.rules.grabRadius, 0.9);
  const list = ctx.players.list;
  for (let i = 0; i < list.length; i += 1) {
    const entity = list[i].entity;
    if (entity === 0) continue;
    if (Math.hypot(Transform.x[entity] - x, Transform.z[entity]) <= radius) return list[i].id;
  }
  return -1;
}

/**
 * A player takes the brainrot in a belt slot.
 *
 * @param ctx The frame context.
 * @param player The grabber.
 * @param slot The belt slot.
 * @returns False when the player's wallet is not loaded yet (the brainrot stays).
 */
function grab(ctx: GameContext, player: number, slot: number): boolean {
  const wallet = walletOf(ctx, player);
  if (wallet === undefined) return false;
  const id = heist.beltId[slot];
  keep(ctx, player, { ...wallet, owned: [...wallet.owned, id] });
  grabbedPayload.player = player;
  grabbedPayload.id = id;
  ctx.net.send('grabbed', grabbedPayload);
  ctx.despawn(heist.beltEntity[slot]);
  heist.removeFromBelt(slot);
  return true;
}

/**
 * The `belt` system.
 *
 * @param ctx The frame context.
 */
export function belt(ctx: GameContext): void {
  if (ctx.elapsed >= heist.nextSpawn) {
    spawnOne(ctx);
    heist.nextSpawn = ctx.elapsed + num(ctx.rules.conveyorSeconds, 8);
  }
  const speed = num(ctx.rules.beltSpeed, 1.2);
  for (let slot = heist.onBelt - 1; slot >= 0; slot -= 1) {
    const x = BELT_START + (ctx.elapsed - heist.beltSpawnedAt[slot]) * speed;
    if (x > BELT_END) {
      ctx.despawn(heist.beltEntity[slot]);
      heist.removeFromBelt(slot);
      continue;
    }
    const player = grabber(ctx, x);
    if (player >= 0 && grab(ctx, player, slot)) continue;
    ctx.physics.teleport(heist.beltEntity[slot], x, BRAINROT_Y, 0);
  }
}
