/**
 * The test arena: the game booted headlessly as a room's authority, for
 * `simulatePlayers`. No browser, no room server, no Jolt. A fighter is moved
 * the way the authority's physics moves one, by a row in `frame-input.bodies`
 * (the guest copies it into `Transform`); `rows` builds them.
 */
import { BODY_STRIDE, createGuest, RigidBody, type Command } from 'gameable';
import { createGameConfig, createMockHost, type ReceivedSend, type Tickable } from 'gameable/test';

import game from '../src/game';

/** `game-config.options` for the room's authority. */
export const AUTHORITY = '{"net":{"role":"authority","maxPlayers":4}}';

/**
 * Boot the game as the authority. The guest reuses its output objects from
 * tick to tick, so the one handed back copies each output.
 *
 * @returns The guest.
 */
export function boot(): Tickable {
  const host = createMockHost({
    seed: 0x5eed,
    nowMs: () => 0,
    assets: ['env.arena', 'char.fighter', 'sfx.hit'],
  });
  const guest = createGuest(host, game);
  guest.init(createGameConfig({ seed: 0x5eedn, fixedHz: 60, options: AUTHORITY }));
  return { tick: (input) => structuredClone(guest.tick(input)) };
}

/**
 * Body rows that stand fighters on the arena floor.
 *
 * @param at Entity to `[x, z]`.
 * @returns The packed rows, ascending by body.
 */
export function rows(at: ReadonlyMap<number, readonly [number, number]>): Float32Array {
  const list = [...at].map(([entity, [x, z]]) => ({ body: RigidBody.handle[entity] ?? 0, x, z }));
  list.sort((a, b) => a.body - b.body);
  const out = new Float32Array(list.length * BODY_STRIDE);
  list.forEach((r, i) => {
    out.set([r.body, r.x, 1.2, r.z, 0, 0, 0, 1], i * BODY_STRIDE);
    out[i * BODY_STRIDE + 14] = 1; // grounded
  });
  return out;
}

/**
 * @param sends A player's sends on one frame.
 * @param name A message name.
 * @returns The payloads of that name, parsed.
 */
export function payloads<T = Record<string, unknown>>(
  sends: readonly ReceivedSend[],
  name: string,
): T[] {
  return sends.filter((s) => s.name === name).map((s) => JSON.parse(s.payload) as T);
}

/**
 * @param commands One frame's commands.
 * @param entity A fighter.
 * @returns The velocity that frame asked of the fighter's body, or null.
 */
export function velocityOf(
  commands: readonly Command[],
  entity: number,
): { x: number; z: number } | null {
  const body = RigidBody.handle[entity];
  for (const c of commands) {
    if (c.tag === 'move-character' && c.val.body === body) {
      return { x: c.val.desiredVelocity.x, z: c.val.desiredVelocity.z };
    }
  }
  return null;
}
