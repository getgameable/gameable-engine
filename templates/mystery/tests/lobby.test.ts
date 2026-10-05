/**
 * The lobby: `ready` from everyone connected starts a round of three or more,
 * and the host can start one early.
 */
import { describe, expect, it } from 'vitest';

import { PHASE_LIVE, PHASE_OVER, PHASE_WAITING, round } from '../src/round';
import { huds, joined, left, message, sends } from './room';
import { dealt, lobby } from './rounds';

/**
 * @param player The sender.
 * @returns A `ready` message.
 */
const ready = (player: number): ReturnType<typeof message> => message(player, 'ready');

describe('the lobby', () => {
  it('waits while two of three are ready, and the third ready deals', () => {
    const room = lobby(3);
    const two = room.step([ready(0), ready(1)]);
    expect(round.phase).toBe(PHASE_WAITING);
    expect(sends(two.commands, 'round')).toHaveLength(0);
    expect(huds(two.commands).find((h) => h.player === 2)?.model.text?.ready).toBe('2/3');

    const third = room.step([ready(2)]);
    expect(round.phase).toBe(PHASE_LIVE);
    expect(sends(third.commands, 'round')).toEqual([
      { to: undefined, payload: { players: 3, its: 1 } },
    ]);
    expect(huds(third.commands).filter((h) => h.model.text?.role === 'it')).toHaveLength(1);
  });

  it('never deals with fewer than three, even when everyone is ready', () => {
    const room = lobby(2);
    const out = room.step([ready(0), ready(1)]);
    expect(round.phase).toBe(PHASE_WAITING);
    expect(huds(out.commands).find((h) => h.player === 0)?.model.message).toBe(
      'waiting for players (2/3)',
    );
  });

  it('takes a ready back on a second press', () => {
    const room = lobby(3);
    room.step([ready(0)]);
    room.step([ready(0)]);
    room.step([ready(1), ready(2)]);
    expect(round.phase).toBe(PHASE_WAITING);
    room.step([ready(0)]);
    expect(round.phase).toBe(PHASE_LIVE);
  });

  it('tells each player whether they are ready, and the host that they can start now', () => {
    const room = lobby(3);
    const out = room.step([ready(1)]);
    const line = (id: number): string | undefined =>
      huds(out.commands).find((h) => h.player === id)?.model.message;
    expect(line(0)).toBe('press R when ready · G starts now');
    expect(line(1)).toBe('ready · waiting for the others');
    expect(line(2)).toBe('press R when ready');
  });

  it('lets the host start early with three, ready or not, and nobody else', () => {
    const room = lobby(3);
    room.step([message(1, 'start'), message(2, 'start')]);
    expect(round.phase).toBe(PHASE_WAITING);
    room.step([message(0, 'start')]);
    expect(round.phase).toBe(PHASE_LIVE);
  });

  it("does not hand a leaver's ready to whoever takes their seat", () => {
    const room = lobby(4);
    room.step([ready(0), ready(1), ready(2)]);
    room.step([left(2)]);
    room.step([joined(2)]);
    room.step([ready(3)]);
    expect(round.phase).toBe(PHASE_WAITING);
    room.step([ready(2)]);
    expect(round.phase).toBe(PHASE_LIVE);
  });

  it('starts when the one player not ready leaves', () => {
    const room = lobby(4);
    room.step([ready(0), ready(1), ready(2)]);
    expect(round.phase).toBe(PHASE_WAITING);
    room.step([left(3)]);
    expect(round.phase).toBe(PHASE_LIVE);
  });

  it('comes back after a round: everyone ready again deals the next one', () => {
    const { room } = dealt(4);
    const it = round.it;
    room.step([left(it)]);
    expect(round.phase).toBe(PHASE_OVER);
    const stay = [0, 1, 2, 3].filter((id) => id !== it);
    room.step(stay.slice(0, 2).map(ready));
    expect(round.phase).toBe(PHASE_OVER);
    room.step([ready(stay[2])]);
    expect(round.phase).toBe(PHASE_LIVE);
  });

  it('ignores ready once a round is running', () => {
    const { room } = dealt(3);
    const before = round.startedAt;
    room.step([ready(0), ready(1), ready(2)]);
    expect(round.phase).toBe(PHASE_LIVE);
    expect(round.startedAt).toBe(before);
  });
});
