/**
 * A held seat: the room keeps a dropped player's seat for a while, joined but
 * left out of the players list. Their keys must let go, and the host must move.
 */
import { RigidBody, type Command } from 'gameable';
import { press } from 'gameable/test';
import { describe, expect, it } from 'vitest';

import { PHASE_LIVE, PHASE_WAITING, round } from '../src/round';
import { joined, left, message } from './room';
import { lobby } from './rounds';

/**
 * @param commands A step's commands.
 * @param entity A player's entity.
 * @returns The speed the step asked of that entity's character body.
 */
function speedOf(commands: readonly Command[], entity: number): number {
  const body = RigidBody.handle[entity];
  for (const c of commands) {
    if (c.tag !== 'move-character' || c.val.body !== body) continue;
    const v = c.val.desiredVelocity;
    return Math.hypot(v.x, v.z);
  }
  return Number.NaN;
}

describe('a held seat', () => {
  it('stops walking when its link drops with W held, and walks again on its return', () => {
    const room = lobby(3);
    press(room.input(1), 'KeyW');
    const walking = room.step();
    const entity = room.entities.get(1) ?? 0;
    expect(speedOf(walking.commands, entity)).toBeGreaterThan(0);

    room.hold(1);
    for (let i = 0; i < 3; i += 1) {
      expect(speedOf(room.step().commands, entity)).toBe(0);
    }

    room.resume(1);
    expect(speedOf(room.step().commands, entity)).toBeGreaterThan(0);
  });
});

describe('the host in the lobby', () => {
  it('is ctx.players.host: a newcomer in seat 0 cannot start while seat 1 is host', () => {
    const room = lobby(3);
    room.step([left(0)]);
    room.step([joined(0)]);
    room.step([message(0, 'start')]);
    expect(round.phase).toBe(PHASE_WAITING);
    room.step([message(1, 'start')]);
    expect(round.phase).toBe(PHASE_LIVE);
  });

  it('moves off a host whose link dropped, and the new host can start', () => {
    const room = lobby(4);
    room.hold(0);
    room.step();
    room.step([message(0, 'start')]);
    expect(round.phase).toBe(PHASE_WAITING);
    room.step([message(1, 'start')]);
    expect(round.phase).toBe(PHASE_LIVE);
  });
});
