import { describe, expect, it } from 'vitest';

import { stubInput } from '../testing';
import { joined, left, rig, roomFrame } from './netTesting';

const AUTHORITY = '{"net":{"role":"authority"}}';

describe('ctx.players.host', () => {
  it('is the first joiner, and passes to the lowest joined seat only when the host leaves', () => {
    const { guest, ctx } = rig({}, AUTHORITY);
    guest.tick(roomFrame(0));
    expect(ctx().players.host).toBeUndefined();

    guest.tick(roomFrame(1, [joined(0), joined(1), joined(2)]));
    expect(ctx().players.host).toBe(0);
    expect(ctx().players.get(0)?.isHost).toBe(true);
    expect(ctx().players.get(1)?.isHost).toBe(false);

    guest.tick(roomFrame(2, [left(0)]));
    expect(ctx().players.host).toBe(1);
    expect(ctx().players.get(1)?.isHost).toBe(true);

    guest.tick(roomFrame(3, [left(1), left(2)]));
    expect(ctx().players.host).toBeUndefined();
  });

  it('stays with seat 1 when seat 0 leaves and a newcomer takes seat 0', () => {
    const { guest, ctx } = rig({}, AUTHORITY);
    guest.tick(roomFrame(0, [joined(0, 'ana'), joined(1, 'ben'), joined(2, 'cy')]));
    guest.tick(roomFrame(1, [left(0)]));
    expect(ctx().players.host).toBe(1);

    guest.tick(roomFrame(2, [joined(0, 'dee')]));
    expect(ctx().players.host).toBe(1);
    expect(ctx().players.get(1)?.isHost).toBe(true);
    expect(ctx().players.get(0)?.isHost).toBe(false);
  });

  it('keeps the host across a snapshot and restore', () => {
    const { guest, ctx } = rig({}, AUTHORITY);
    guest.tick(roomFrame(0, [joined(0), joined(1)]));
    guest.tick(roomFrame(1, [left(0)]));
    guest.tick(roomFrame(2, [joined(0)]));
    expect(ctx().players.host).toBe(1);
    const saved = guest.snapshot();

    guest.tick(roomFrame(3, [left(1)]));
    expect(ctx().players.host).toBe(0);

    guest.restore(saved);
    guest.tick(roomFrame(4));
    expect(ctx().players.host).toBe(1);
    expect(ctx().players.get(1)?.isHost).toBe(true);
    expect(ctx().players.get(0)?.isHost).toBe(false);
  });

  it('ignores a seat whose input arrived but which never joined', () => {
    const { guest, ctx } = rig({}, AUTHORITY);
    guest.tick(roomFrame(0, [joined(4)], [{ player: 1, seq: 0, input: stubInput() }]));
    expect(ctx().players.has(1)).toBe(true);
    expect(ctx().players.host).toBe(4);
    expect(ctx().players.get(1)?.isHost).toBe(false);
  });

  it('moves off a held host to the lowest listed seat, and stays there when the old host returns', () => {
    const { guest, ctx } = rig({}, AUTHORITY);
    const seat = (player: number) => ({ player, seq: 0, input: stubInput() });
    guest.tick(roomFrame(0, [joined(0), joined(1), joined(2)], [seat(0), seat(1), seat(2)]));
    expect(ctx().players.host).toBe(0);

    // Seat 0 dropped: the room holds it (no player-left) and leaves it out of the players list.
    guest.tick(roomFrame(1, [], [seat(1), seat(2)]));
    expect(ctx().players.host).toBe(1);
    expect(ctx().players.get(0)?.connected).toBe(true); // still joined: held, not left
    expect(ctx().players.get(0)?.isHost).toBe(false);

    // Seat 0 is back: the host is sticky, it stays with seat 1.
    guest.tick(roomFrame(2, [], [seat(0), seat(1), seat(2)]));
    expect(ctx().players.host).toBe(1);
    expect(ctx().players.get(1)?.isHost).toBe(true);
  });

  it('keeps a held host when no other seat is listed', () => {
    const { guest, ctx } = rig({}, AUTHORITY);
    guest.tick(roomFrame(0, [joined(0), joined(1)], [{ player: 0, seq: 0, input: stubInput() }]));
    expect(ctx().players.host).toBe(0);
    guest.tick(roomFrame(1, [], [{ player: 9, seq: 0, input: stubInput() }])); // nobody joined is listed
    expect(ctx().players.host).toBe(0);
  });

  it('is undefined in a single-player game', () => {
    const { guest, ctx } = rig({});
    guest.tick(roomFrame(0));
    expect(ctx().players.host).toBeUndefined();
  });
});
