/**
 * The adventure with friends (`features.multiplayer`): on a room's authority,
 * Play Solo's included, every player opens chests, takes the key, opens the
 * door and talks, from their own input and their own hero. The world is
 * shared (an opened chest is open for everyone); the dialogue line, the
 * pocket and the HUD are each player's own.
 */
import { press, release } from 'gameable/test';
import { describe, expect, it } from 'vitest';

import { arenaSpawns } from '../src/arena';
import { interactables } from '../src/prefabs';
import { bootRoom, type RoomHarness } from './roomHarness';

/** The hero's centre height on the arena floor, as `game.test.ts` places it. */
const FLOOR = 1.15;

/**
 * Stand a player just in front of a spawn point, facing it (yaw 0 looks down -Z).
 *
 * @param room The harness.
 * @param player A player id.
 * @param at The spawn point's position.
 */
function standBefore(room: RoomHarness, player: number, at: readonly number[]): void {
  room.place(player, at[0] ?? 0, FLOOR, (at[2] ?? 0) + 1.4);
}

/**
 * @param room The harness.
 * @param player A player id.
 * @returns That player's HUD text rows.
 */
const rows = (room: RoomHarness, player: number): Record<string, string> =>
  room.hudOf(player)?.text ?? {};

describe('the template in a room: interacting per player', () => {
  it('two players each open a different chest; the key goes to the one who takes it', () => {
    const room = bootRoom(2);
    standBefore(room, 0, arenaSpawns.chests[0].position);
    standBefore(room, 1, arenaSpawns.chests[1].position);
    expect(rows(room, 0).prompt).toBe('E: open chest');
    expect(rows(room, 1).prompt).toBe('E: open chest');

    room.tap(0, 'E');
    room.tap(1, 'E');
    expect(rows(room, 0).notice).toContain('A key');
    expect(rows(room, 1).notice).toContain('Empty');

    // The key is in front of player 0 only.
    expect(rows(room, 0).prompt).toBe('E: take key');
    room.tap(0, 'E');
    expect(rows(room, 0).keys).toBe('1');
    expect(rows(room, 1).keys).toBe('0');
  });

  it('an opened chest is open for everyone: the next player sees no prompt', () => {
    const room = bootRoom(2);
    standBefore(room, 0, arenaSpawns.chests[1].position);
    room.tap(0, 'E');
    standBefore(room, 1, arenaSpawns.chests[1].position);
    expect(rows(room, 1).prompt).toBeUndefined();
    let used = 0;
    for (let e = 1; e < 64; e += 1) used += interactables.used[e] === 1 ? 1 : 0;
    expect(used).toBe(1);
  });

  it('one player talks while the other walks', () => {
    const room = bootRoom(2);
    const guide = arenaSpawns.npcs[0].position;
    room.place(0, guide[0], FLOOR, guide[2] + 1.2);
    expect(rows(room, 0).prompt).toBe('E: talk');
    room.tap(0, 'E');
    expect(rows(room, 0).speaker).toBe('Guide');
    expect(rows(room, 1).speaker).toBeUndefined();

    press(room.inputs[0], 'W');
    press(room.inputs[1], 'W');
    room.step(20);
    expect(room.velocityOf(0).z).toBeCloseTo(0, 5);
    expect(room.velocityOf(1).z).toBeLessThan(-1);
    release(room.inputs[0], 'W');
    release(room.inputs[1], 'W');

    // Player 0's E walks their own lines; player 1's E does nothing to them.
    const first = rows(room, 0).say;
    room.tap(1, 'E');
    expect(rows(room, 0).say).toBe(first);
    room.tap(0, 'E');
    expect(rows(room, 0).say).not.toBe(first);
  });

  it('the player with the key opens the door, and everyone escapes', () => {
    const room = bootRoom(2);
    standBefore(room, 0, arenaSpawns.chests[0].position);
    room.tap(0, 'E');
    room.tap(0, 'E');
    standBefore(room, 1, arenaSpawns.door.position);
    room.tap(1, 'E');
    expect(rows(room, 1).notice).toContain('Locked');
    standBefore(room, 0, arenaSpawns.door.position);
    room.tap(0, 'E');
    room.step(120);
    expect(room.hudOf(0)?.message).toBe('You escaped');
    expect(room.hudOf(1)?.message).toBe('You escaped');
  });

  it('Play Solo (one seat on an in-page authority) plays the whole adventure', () => {
    const room = bootRoom(1);
    standBefore(room, 0, arenaSpawns.chests[0].position);
    room.tap(0, 'E');
    room.tap(0, 'E');
    expect(rows(room, 0).keys).toBe('1');
    standBefore(room, 0, arenaSpawns.door.position);
    expect(rows(room, 0).prompt).toBe('E: open door');
    room.tap(0, 'E');
    room.step(120);
    expect(room.hudOf(0)?.message).toBe('You escaped');
  });

  it("paints each player's hero", () => {
    const room = bootRoom(2);
    const painted = new Set(
      room.commands.filter((c) => c.tag === 'set-material-param').map((c) => c.val.entity),
    );
    expect(painted.has(room.entityOf(0))).toBe(true);
    expect(painted.has(room.entityOf(1))).toBe(true);
  });
});
