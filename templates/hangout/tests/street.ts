/**
 * The test street: the game booted headlessly as a room's authority, for
 * `simulatePlayers`. No browser, no room server, no Jolt. A body is moved the
 * way the authority's physics moves one, by a row in `frame-input.bodies`
 * (the guest copies it into `Transform`); `rows` builds them.
 */
import { BODY_STRIDE, createGuest, RigidBody, type Command, type FrameOutput } from 'gameable';
import { createGameConfig, createMockHost, type MockHost, type Tickable } from 'gameable/test';

import game from '../src/game';

/** `game-config.options` for the room's authority. */
export const AUTHORITY = '{"net":{"role":"authority","maxPlayers":12}}';

/**
 * Boot the game.
 *
 * The guest reuses its output objects from tick to tick, so the one handed
 * back copies each output: `keepOutputs` then keeps every frame's own.
 *
 * @param options `game-config.options`, or undefined for solo.
 * @returns The guest and its mock host.
 */
export function boot(options: string | undefined = AUTHORITY): {
  guest: Tickable;
  host: MockHost;
} {
  const host = createMockHost({
    seed: 0x5eed,
    nowMs: () => 0,
    assets: ['env.arena', 'char.resident'],
  });
  const guest = createGuest(host, game);
  guest.init(createGameConfig({ seed: 0x5eedn, fixedHz: 60, options }));
  return { guest: { tick: (input) => structuredClone(guest.tick(input)) }, host };
}

/**
 * Body rows that stand entities at points on the floor plan.
 *
 * @param at Entity to `[x, z]`.
 * @returns The packed rows, ascending by body.
 */
export function rows(at: ReadonlyMap<number, readonly [number, number]>): Float32Array {
  const list = [...at].map(([entity, [x, z]]) => ({ body: RigidBody.handle[entity] ?? 0, x, z }));
  list.sort((a, b) => a.body - b.body);
  const out = new Float32Array(list.length * BODY_STRIDE);
  list.forEach((r, i) => {
    out.set([r.body, r.x, 1.15, r.z, 0, 0, 0, 1], i * BODY_STRIDE);
    out[i * BODY_STRIDE + 14] = 1; // grounded
  });
  return out;
}

/**
 * @param output One frame's output.
 * @param entity An entity.
 * @returns The last character state that frame set on it, or undefined.
 */
export function stateOf(output: FrameOutput, entity: number): string | undefined {
  let state: string | undefined;
  for (const c of output.commands) {
    if (c.tag === 'set-character-state' && c.val.entity === entity) state = c.val.state;
  }
  return state;
}

/**
 * @param output One frame's output.
 * @param entity An entity with a body.
 * @returns Every `set-body-transform` that frame wrote to its body.
 */
export function moves(
  output: FrameOutput,
  entity: number,
): Extract<Command, { tag: 'set-body-transform' }>['val'][] {
  const body = RigidBody.handle[entity] ?? 0;
  const out: Extract<Command, { tag: 'set-body-transform' }>['val'][] = [];
  for (const c of output.commands)
    if (c.tag === 'set-body-transform' && c.val.body === body) out.push(c.val);
  return out;
}

/**
 * @param view One player's view on one frame, from `simulatePlayers`.
 * @param view.hud Their HUD JSON, when it changed that frame.
 * @returns The HUD model, or an empty one on a frame it did not change.
 */
export function hudOf(view: { hud: string | undefined }): {
  text?: Record<string, string>;
  message?: string;
} {
  return JSON.parse(view.hud ?? '{}') as { text?: Record<string, string>; message?: string };
}
