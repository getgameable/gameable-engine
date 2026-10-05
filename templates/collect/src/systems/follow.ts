/**
 * Pets follow their owners, on the authority. Each player shows their newest
 * `VISIBLE_PETS` pets (three): a pet body per slot, spawned when the slot
 * fills, re-tinted when it shows another pet, despawned when it empties. Every
 * tick each pet glides toward its place beside its owner, `rules.petFollow`
 * of the way per second, and pages interpolate it.
 */
import { Transform, type GameContext } from 'gameable';

import { collection, MAX_SEATS, VISIBLE_PETS } from '../collection';
import { docOf } from '../docs';
import { colourOf } from '../pets';
import { PET_HALF, PetBody, place, tint } from '../prefabs';
import { num } from '../rules';

/** Where each slot stands from its owner, metres, x then z: left, right, behind. */
const OFFSETS = [-0.9, 0.6, 0.9, 0.6, 0, 1.3] as const;
/** Reused spawn point. */
const at = { x: 0, y: PET_HALF[1], z: 0 };

/**
 * Bring one player's pet bodies in line with their document.
 *
 * @param ctx The frame context.
 * @param seat The owner.
 * @param owner Their entity.
 */
function sync(ctx: GameContext, seat: number, owner: number): void {
  const pets = docOf(ctx, seat)?.pets ?? [];
  for (let slot = 0; slot < VISIBLE_PETS; slot += 1) {
    const i = seat * VISIBLE_PETS + slot;
    const pet = pets[pets.length - 1 - slot];
    const entity = collection.petEntity[i];
    if (pet === undefined) {
      if (entity !== 0) ctx.despawn(entity);
      collection.petEntity[i] = 0;
      collection.petShown[i] = '';
      continue;
    }
    if (entity === 0) {
      at.x = Transform.x[owner] + OFFSETS[slot * 2];
      at.z = Transform.z[owner] + OFFSETS[slot * 2 + 1];
      collection.petEntity[i] = ctx.spawn(PetBody, at);
      collection.petX[i] = at.x;
      collection.petZ[i] = at.z;
    }
    if (collection.petShown[i] !== pet.id) {
      tint(collection.petEntity[i], colourOf(pet.kind));
      collection.petShown[i] = pet.id;
    }
  }
}

/**
 * The `follow` system.
 *
 * @param ctx The frame context.
 */
export function follow(ctx: GameContext): void {
  const step = Math.min(1, num(ctx.rules.petFollow, 4) * ctx.dt);
  for (let seat = 0; seat < MAX_SEATS; seat += 1) {
    const owner = ctx.playerEntity(seat);
    if (owner === 0) continue;
    if (collection.dirty[seat] === 1) sync(ctx, seat, owner);
    for (let slot = 0; slot < VISIBLE_PETS; slot += 1) {
      const i = seat * VISIBLE_PETS + slot;
      const pet = collection.petEntity[i];
      if (pet === 0) continue;
      const x = collection.petX[i];
      const z = collection.petZ[i];
      const dx = (Transform.x[owner] + OFFSETS[slot * 2] - x) * step;
      const dz = (Transform.z[owner] + OFFSETS[slot * 2 + 1] - z) * step;
      if (Math.abs(dx) + Math.abs(dz) < 1e-4) continue; // at rest: no command
      collection.petX[i] = x + dx;
      collection.petZ[i] = z + dz;
      place(pet, collection.petX[i], PET_HALF[1], collection.petZ[i], false);
    }
  }
}
