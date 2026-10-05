/**
 * A projectile game for the body-id parity test: every frame it fires 20
 * bodies and, past 40 alive, retires one per shot out of order, so the SDK's
 * free list is reordered all the time. Built to wasm by
 * `buildTinyGame({ game: 'churn' })`; the boundary test compares the body ids
 * it hands Jolt in direct and in wasm mode.
 */
import { defineGame, prefab, type GameContext } from 'gameable';

/** A small dynamic sphere. */
export const ShotPrefab = prefab({
  name: 'shot',
  body: { shape: 'sphere', kind: 'dynamic', dims: [0.1] },
});

/** Shots alive, in firing order (a swap-remove reorders it). */
const alive: number[] = [];

/**
 * Fire and retire.
 *
 * @param ctx The frame context.
 */
function churn(ctx: GameContext): void {
  for (let i = 0; i < 20; i += 1) {
    if (alive.length >= 40) {
      const at = (ctx.frame * 7 + i * 13) % alive.length;
      ctx.despawn(alive[at]);
      alive[at] = alive[alive.length - 1];
      alive.pop();
    }
    alive.push(ctx.spawn(ShotPrefab, { x: i, y: 10, z: 0 }));
  }
}

export default defineGame({
  world: { gravity: 0, maxEntities: 512 },
  init: () => {
    alive.length = 0;
  },
  systems: [churn],
});
