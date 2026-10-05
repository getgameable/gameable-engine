/**
 * The template as a room's authority: each player walks their own hero.
 *
 * The single-player behaviour is `game.test.ts`; this file only checks that
 * on an authority the controller reads each player's own input and moves
 * that player's own entity, with their own camera.
 */
import { createGuest, type Command, type GameEvent, type PlayerInput } from 'gameable';
import {
  createFrameInput,
  createGameConfig,
  createInputState,
  createMockHost,
  press,
  type MutableInputState,
} from 'gameable/test';
import { describe, expect, it } from 'vitest';

import game from '../src/game';

const AUTHORITY = '{"net":{"role":"authority"}}';

/** What one authority run saw. */
interface Run {
  /** Player id to the entity the SDK says they control. */
  entity: Map<number, number>;
  /** Entity to its character body. */
  body: Map<number, number>;
  /** Body to its last requested horizontal velocity. */
  velocity: Map<number, { x: number; z: number }>;
  /** Player id to the entity their camera last followed. */
  follows: Map<number, number | undefined>;
}

/**
 * Boot the template as an authority, seat two players, and run some steps.
 *
 * @param inputs Each player's input, held for the whole run.
 * @param frames Steps to run after the join.
 * @returns What the commands said.
 */
function run(inputs: MutableInputState[], frames: number): Run {
  const host = createMockHost({ seed: 7, nowMs: () => 0, raycast: () => null });
  const guest = createGuest(host, game);
  guest.init(createGameConfig({ fixedHz: 60, options: AUTHORITY }));
  const seen: Run = { entity: new Map(), body: new Map(), velocity: new Map(), follows: new Map() };
  const players: PlayerInput[] = inputs.map((input, player) => ({ player, seq: 0, input }));
  const joins: GameEvent[] = inputs.map((_, player) => ({
    tag: 'player-joined',
    val: { player, name: `p${String(player)}` },
  }));
  for (let frame = 0; frame <= frames; frame += 1) {
    const out = guest.tick(createFrameInput({ frame, events: frame === 0 ? joins : [], players }));
    record(seen, out.commands);
  }
  return seen;
}

/**
 * @param seen Where to write.
 * @param commands One step's commands.
 */
function record(seen: Run, commands: readonly Command[]): void {
  for (const c of commands) {
    if (c.tag === 'set-player-entity') seen.entity.set(c.val.player, c.val.entity);
    else if (c.tag === 'add-body') seen.body.set(c.val.entity, c.val.body);
    else if (c.tag === 'move-character') {
      seen.velocity.set(c.val.body, { x: c.val.desiredVelocity.x, z: c.val.desiredVelocity.z });
    } else if (c.tag === 'set-player-camera') seen.follows.set(c.val.player, c.val.camera.follow);
  }
}

/**
 * @param seen A run.
 * @param player A player id.
 * @returns The last velocity requested for that player's own body.
 */
function velocityOf(seen: Run, player: number): { x: number; z: number } | undefined {
  const entity = seen.entity.get(player) ?? 0;
  const body = seen.body.get(entity);
  return body === undefined ? undefined : seen.velocity.get(body);
}

describe('the template in a room', () => {
  it("walks each player's own hero from that player's own keys", () => {
    const still = createInputState();
    const walking = createInputState();
    press(walking, 'W');
    const seen = run([still, walking], 30);

    const zero = seen.entity.get(0) ?? 0;
    const one = seen.entity.get(1) ?? 0;
    expect(zero).not.toBe(0);
    expect(one).not.toBe(0);
    expect(one).not.toBe(zero);

    // W at camera yaw zero travels -Z, at the walk speed.
    expect(velocityOf(seen, 1)?.z).toBeCloseTo(-1.6, 1);
    expect(velocityOf(seen, 0)).toEqual({ x: 0, z: 0 });
  });

  it("points each player's camera at their own hero", () => {
    const seen = run([createInputState(), createInputState()], 2);
    expect(seen.follows.get(0)).toBe(seen.entity.get(0));
    expect(seen.follows.get(1)).toBe(seen.entity.get(1));
  });

  it('moves nothing on a client, even for the local player with an entity', () => {
    const host = createMockHost({ seed: 7, nowMs: () => 0, raycast: () => null });
    const guest = createGuest(host, game);
    guest.init(
      createGameConfig({ fixedHz: 60, options: '{"net":{"role":"client","localPlayer":1}}' }),
    );
    const walking = createInputState();
    press(walking, 'W');
    const players: PlayerInput[] = [{ player: 1, seq: 0, input: walking }];
    const join: GameEvent[] = [{ tag: 'player-joined', val: { player: 1, name: 'p1' } }];
    // Hand the local player a body-carrying entity (the guide, entity 1 on a
    // client, which spawns the level but no hero), as a possess would.
    guest.state.players.handle(1)?.restoreSeat(true, 'p1', 1, null);
    const tags: string[] = [];
    for (let frame = 0; frame < 10; frame += 1) {
      const out = guest.tick(createFrameInput({ frame, events: frame === 0 ? join : [], players }));
      for (const c of out.commands) tags.push(c.tag);
    }
    expect(guest.state.players.handle(1)?.entity).toBe(1);
    expect(tags).not.toContain('move-character');
  });
});
