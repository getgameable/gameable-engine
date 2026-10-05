/**
 * The three rules the README says to change first: `roundSeconds`, `its` and
 * `tagRadius`, each changed the way a player would, in the game's `rules`.
 */
import { describe, expect, it } from 'vitest';

import { PHASE_LIVE, PHASE_OVER, PHASE_VOTE, round } from '../src/round';
import { AUTHORITY, boot, huds, joined, left, message, sends, spread, touch } from './room';
import { seats, vote } from './rounds';

/**
 * A room of `n` with these rules, dealt by the host, spread out and past the grace period.
 *
 * @param n Players.
 * @param rules The changed rules.
 * @returns The room, the deal's sends and HUDs (read at once: a step's output is reused), the "it"s and the crew.
 */
function dealtWith(n: number, rules: Record<string, unknown>) {
  const room = boot(AUTHORITY, 0x5eed, rules);
  room.step(seats(n).map(joined));
  const out = room.step([message(0, 'start')]);
  const deal = { round: sends(out.commands, 'round'), huds: huds(out.commands) };
  spread(room, seats(n));
  for (let i = 0; i < 60 * 4; i += 1) room.step();
  const its = seats(n).filter((id) => round.isIt(id));
  const crew = seats(n).filter((id) => !round.isIt(id));
  return { room, deal, its, crew };
}

describe('rules.its', () => {
  it('deals that many, tells each the others, and the crew nobody', () => {
    const { deal, its } = dealtWith(5, { its: 2 });
    expect(its).toHaveLength(2);
    expect(deal.round).toEqual([{ to: undefined, payload: { players: 5, its: 2 } }]);
    expect(deal.huds).toHaveLength(5);
    for (const h of deal.huds) {
      if (its.includes(h.player)) {
        expect(h.model.text?.role).toBe('it');
        const other = its.find((id) => id !== h.player) ?? -1;
        expect(h.model.text?.with).toContain(`#${String(other + 1)}`);
      } else {
        expect(h.model.text?.role).toBe('crew');
        expect(h.model.text?.with).toBeUndefined();
        expect(h.model.message).toBe('2 of you are it. run');
      }
    }
  });

  it('always leaves one crew member to tag', () => {
    const { its } = dealtWith(3, { its: 5 });
    expect(its).toHaveLength(2);
  });

  it('two "it"s cannot tag each other', () => {
    const { room, its } = dealtWith(5, { its: 2 });
    touch(room, its[0], its[1]);
    expect(sends(room.step().commands, 'tagged')).toHaveLength(0);
    expect(round.phase).toBe(PHASE_LIVE);
  });

  it('voting one "it" out goes on; the crew wins once none is left', () => {
    const { room, its, crew } = dealtWith(5, { its: 2 });
    touch(room, its[0], crew[0]);
    room.step();
    expect(round.phase).toBe(PHASE_VOTE);
    // Four still in: three votes put the first "it" out.
    const out = room.step([vote(crew[1], its[0]), vote(crew[2], its[0]), vote(its[1], its[0])]);
    expect(sends(out.commands, 'vote-over')).toEqual([
      { to: undefined, payload: { out: its[0], alive: 3 } },
    ]);
    expect(round.phase).toBe(PHASE_LIVE);
    const ended = room.step([left(its[1])]);
    expect(round.phase).toBe(PHASE_OVER);
    expect(sends(ended.commands, 'round-over')).toEqual([
      { to: undefined, payload: { its, winner: 'crew' } },
    ]);
  });
});

describe('rules.roundSeconds', () => {
  it('the clock runs down on every HUD, and running out gives the round to the crew', () => {
    const { room } = dealtWith(3, { roundSeconds: 10 });
    expect(round.phase).toBe(PHASE_LIVE);
    const clocks = new Set<string>();
    for (let i = 0; i < 120; i += 1) {
      for (const h of huds(room.step().commands)) clocks.add(h.model.text?.time ?? '');
    }
    // Two seconds: two redraws, one per whole second, and nothing in between.
    expect([...clocks]).toHaveLength(2);
    for (const clock of clocks) expect(clock).toMatch(/^\d+s$/);
    let ended = room.step();
    for (let i = 0; i < 60 * 6 && round.phase === PHASE_LIVE; i += 1) ended = room.step();
    expect(round.phase).toBe(PHASE_OVER);
    expect(sends(ended.commands, 'round-over')).toEqual([
      { to: undefined, payload: { its: [round.it], winner: 'crew' } },
    ]);
    for (const h of huds(ended.commands)) expect(h.model.message).toContain('time is up');
  });
});

describe('rules.tagRadius', () => {
  it('a wider radius tags from further away', () => {
    for (const [radius, tagged] of [
      [0.9, 0],
      [3, 1],
    ] as const) {
      const { room, its, crew } = dealtWith(3, { tagRadius: radius });
      const target = room.entities.get(crew[0]) ?? 0;
      // Well clear of the others, who stand 6 m apart from x = -6.
      room.place(room.entities.get(its[0]) ?? 0, 20, 0);
      room.place(target, 22, 0);
      expect(sends(room.step().commands, 'tagged')).toHaveLength(tagged);
    }
  });
});
