/**
 * The vote after a tag-out: the players still in name who they think is "it".
 */
import { describe, expect, it } from 'vitest';

import { PHASE_LIVE, PHASE_OVER, PHASE_VOTE, round } from '../src/round';
import { huds, joined, left, sends, touch } from './room';
import { dealt, vote, voting } from './rounds';

describe('the vote', () => {
  it('opens after a tag-out, without saying who "it" is', () => {
    const { room, crew } = dealt(4);
    // `voting` does the same tag; this one keeps the step's output.
    const victim = crew[0];
    touch(room, round.it, victim);
    const out = room.step();
    expect(sends(out.commands, 'tagged')).toHaveLength(1);
    expect(round.phase).toBe(PHASE_VOTE);
    expect(sends(out.commands, 'vote-open')).toEqual([{ to: undefined, payload: { alive: 3 } }]);
    for (const h of huds(out.commands)) {
      if (h.player === victim) expect(h.model.message).toBe('tagged out · they are voting');
      else expect(h.model.message).toBe('who is it? press 1-6 to vote');
    }
  });

  it('rejects a vote from a player not in the round, and counts it', () => {
    const { room, tagged, crew } = voting(4);
    room.step([joined(4)]); // a newcomer: watching, not playing
    room.step([vote(4, crew[0]), vote(tagged, crew[0])]);
    expect(round.ballot.rejected).toBe(2);
    expect(round.ballot.count(crew[0])).toBe(0);
    expect(round.phase).toBe(PHASE_VOTE);
  });

  it('rejects a vote for someone who is not still in', () => {
    const { room, tagged, crew } = voting(4);
    room.step([vote(crew[0], tagged), vote(crew[1], 9)]);
    expect(round.ballot.rejected).toBe(2);
    expect(round.ballot.count(tagged)).toBe(0);
  });

  it('a majority puts that player out and the round goes on', () => {
    const { room, crew } = voting(4);
    const [picked, other] = crew;
    room.step([vote(round.it, picked)]);
    expect(round.phase).toBe(PHASE_VOTE);
    const out = room.step([vote(other, picked)]);
    expect(round.phase).toBe(PHASE_LIVE);
    expect(round.alive(picked)).toBe(false);
    expect(round.aliveCount()).toBe(2);
    expect(sends(out.commands, 'vote-over')).toEqual([
      { to: undefined, payload: { out: picked, alive: 2 } },
    ]);
    expect(huds(out.commands).find((h) => h.player === picked)?.model.message).toBe('voted out');
  });

  it('voting "it" out ends the round: the crew wins', () => {
    const { room, crew } = voting(4);
    const it = round.it;
    const out = room.step([vote(crew[0], it), vote(crew[1], it)]);
    expect(round.phase).toBe(PHASE_OVER);
    expect(sends(out.commands, 'vote-over')).toHaveLength(0);
    expect(sends(out.commands, 'round-over')).toEqual([
      { to: undefined, payload: { its: [it], winner: 'crew' } },
    ]);
    for (const h of huds(out.commands)) expect(h.model.message).toContain('voted out');
  });

  it('counts a changed vote once, for the new pick', () => {
    const { room, crew } = voting(4);
    room.step([vote(crew[0], crew[1])]);
    room.step([vote(crew[0], round.it)]);
    expect(round.ballot.count(crew[1])).toBe(0);
    expect(round.ballot.count(round.it)).toBe(1);
    expect(round.phase).toBe(PHASE_VOTE);
  });

  it('goes back to the round with nobody out when there is no majority in time', () => {
    const { room, crew } = voting(4);
    room.step([vote(crew[0], crew[1])]);
    let over: ReturnType<typeof room.step> | undefined;
    for (let i = 0; i < 60 * 31 && round.phase === PHASE_VOTE; i += 1) over = room.step();
    expect(round.phase).toBe(PHASE_LIVE);
    expect(round.aliveCount()).toBe(3);
    expect(sends(over?.commands ?? [], 'vote-over')).toEqual([
      { to: undefined, payload: { out: -1, alive: 3 } },
    ]);
  });

  it('a voter who leaves takes their vote with them', () => {
    const { room, crew } = voting(5);
    const [a, b, c] = crew; // 4 still in: "it", a, b, c. A majority is 3.
    room.step([vote(a, b), vote(c, b)]);
    room.step([left(a)]); // 3 still in; b has c's vote only
    expect(round.ballot.count(b)).toBe(1);
    expect(round.phase).toBe(PHASE_VOTE);
    room.step([vote(round.it, b)]); // 2 of 3
    expect(round.alive(b)).toBe(false);
    expect(round.phase).toBe(PHASE_LIVE);
  });

  it('a leave that leaves a majority behind decides the vote', () => {
    const { room, crew } = voting(5);
    const [a, b, c] = crew; // 4 still in: a majority is 3
    room.step([vote(a, b), vote(round.it, b)]);
    expect(round.phase).toBe(PHASE_VOTE);
    room.step([left(c)]); // 3 still in: 2 is a majority
    expect(round.alive(b)).toBe(false);
    expect(round.phase).toBe(PHASE_LIVE);
  });

  it('a player voted for who leaves takes the votes for them along', () => {
    const { room, crew } = voting(5);
    const [a, b, c] = crew;
    room.step([vote(a, b), vote(c, b)]);
    room.step([left(b)]);
    expect(round.ballot.count(b)).toBe(0);
    expect(round.phase).toBe(PHASE_VOTE);
    expect(round.aliveCount()).toBe(3);
  });

  it('"it" leaving mid-vote gives the round to the crew', () => {
    const { room } = voting(4);
    const it = round.it;
    const out = room.step([left(it)]);
    expect(round.phase).toBe(PHASE_OVER);
    expect(sends(out.commands, 'round-over')).toEqual([
      { to: undefined, payload: { its: [it], winner: 'crew' } },
    ]);
  });

  it('pauses tagging while the vote is open', () => {
    const { room, crew } = voting(4);
    room.place(room.entities.get(crew[0]) ?? 0, 0, 0);
    room.place(room.entities.get(round.it) ?? 0, 0.3, 0);
    for (let i = 0; i < 30; i += 1) expect(sends(room.step().commands, 'tagged')).toHaveLength(0);
    expect(round.alive(crew[0])).toBe(true);
  });
});
