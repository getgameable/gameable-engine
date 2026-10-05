/**
 * Players leaving and seats being reused while a round is live. A seat is in
 * the round only while it holds the entity it was dealt; anyone else in it is
 * a spectator until the next deal.
 */
import { describe, expect, it } from 'vitest';

import { PHASE_OVER, round } from '../src/round';
import {
  AUTHORITY,
  boot,
  huds,
  joined,
  left,
  message,
  sends,
  spread,
  touch,
  type Room,
} from './room';

/**
 * A room of three, dealt, spread out, and past the grace period.
 *
 * @returns The room and the two crew ids.
 */
function dealt(): { room: Room; crew: number[] } {
  const room = boot(AUTHORITY);
  room.step([joined(0), joined(1), joined(2)]);
  room.step([message(0, 'start')]);
  spread(room, [0, 1, 2]);
  for (let i = 0; i < 60 * 4; i += 1) room.step();
  return { room, crew: [0, 1, 2].filter((id) => id !== round.it) };
}

describe('leaving mid-round', () => {
  it('counts a crew member who leaves as out, so the round can still end', () => {
    const { room, crew } = dealt();
    room.step([left(crew[0])]);
    expect(round.aliveCount()).toBe(2);
    touch(room, round.it, crew[1]);
    expect(sends(room.step().commands, 'round-over')).toHaveLength(1);
  });

  it('gives the round to the crew when "it" leaves', () => {
    const { room } = dealt();
    const it = round.it;
    const out = room.step([left(it)]);
    expect(sends(out.commands, 'round-over')).toEqual([
      { to: undefined, payload: { its: [it], winner: 'crew' } },
    ]);
    expect(round.phase).toBe(PHASE_OVER);
    const lines = huds(out.commands).map((h) => h.model.message);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toContain('the crew wins');
  });

  it('names "it" by seat and cleaned name in the result line, not by the raw room name', () => {
    const room = boot(AUTHORITY);
    const names = ['You', 'You', 'You‮'];
    room.step(names.map((name, player) => ({ tag: 'player-joined', val: { player, name } })));
    room.step([message(0, 'start')]);
    const it = round.it;
    const out = room.step([left(it)]);
    const line = huds(out.commands).find((h) => h.player !== it)?.model.message ?? '';
    expect(line.startsWith(`#${String(it + 1)} You was it and left`)).toBe(true);
  });

  it('seats a newcomer in a freed seat as a spectator, not as tagged out', () => {
    const { room, crew } = dealt();
    room.step([left(crew[0])]);
    const out = room.step([joined(crew[0])]);
    const hud = huds(out.commands).find((h) => h.player === crew[0]);
    expect(hud?.model.message).toBe('watching: next round soon');
    expect(hud?.model.text?.role).toBeUndefined();
  });

  it('does not stall when a seat is left and taken again in the same frame', () => {
    const { room, crew } = dealt();
    room.step([left(crew[0]), joined(crew[0])]);
    expect(round.aliveCount()).toBe(2);
    touch(room, round.it, crew[1]);
    expect(sends(room.step().commands, 'round-over')).toHaveLength(1);
  });
});
