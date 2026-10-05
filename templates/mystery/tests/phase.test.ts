/**
 * The room list's phase: the authority says `lobby`, `playing` or `voting`
 * through `ctx.net.setPhase`, once per change.
 */
import { describe, expect, it } from 'vitest';

import { round } from '../src/round';
import { AUTHORITY, boot, joined, left, message, spread, touch, type Room } from './room';
import { seats } from './rounds';

/**
 * @param room The room.
 * @param events This step's events.
 * @returns The phase words the step sent, in order.
 */
function said(room: Room, events: Parameters<Room['step']>[0] = []): string[] {
  const out: string[] = [];
  for (const c of room.step(events).commands) {
    if (c.tag === 'send' && c.val.name === 'aos:phase')
      out.push(JSON.parse(c.val.payload) as string);
  }
  return out;
}

describe('the phase the room list shows', () => {
  it('is lobby, playing at the deal, voting at a tag-out, and lobby once the round is over', () => {
    const room = boot(AUTHORITY);
    expect(said(room, seats(4).map(joined))).toEqual(['lobby']);
    expect(said(room)).toEqual([]); // the same phase again: nothing sent

    expect(said(room, [message(0, 'start')])).toEqual(['playing']);
    spread(room, seats(4));
    for (let i = 0; i < 60 * 4; i += 1) expect(said(room)).toEqual([]);

    const crew = seats(4).filter((id) => id !== round.it);
    touch(room, round.it, crew[0]);
    expect(said(room)).toEqual(['voting']);

    expect(said(room, [left(round.it)])).toEqual(['lobby']);
  });
});
