/**
 * The round, driven headlessly as the room's authority: the deal, the secret,
 * tagging, the grace period and the seed. Leaving and rejoining are in
 * `leaving.test.ts`; the test room itself is `room.ts`.
 */
import { createFrameInput } from 'gameable/test';
import { describe, expect, it } from 'vitest';

import { PHASE_LIVE, PHASE_OVER, PHASE_VOTE, round } from '../src/round';
import { AUTHORITY, boot, huds, joined, message, sends, spread, touch, type Room } from './room';
import { vote } from './rounds';

/**
 * Check one room step for leaks: the shared frame HUD stays empty, no
 * broadcast names "it", and only "it" is told `role: it`.
 *
 * @param out The step's output.
 */
function expectSecret(out: ReturnType<Room['step']>): void {
  expect(out.hud).toBeUndefined();
  for (const c of out.commands) {
    if (c.tag !== 'send' || c.val.name === 'round-over') continue;
    const payload = JSON.parse(c.val.payload) as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain('it');
    expect(Object.keys(payload)).not.toContain('role');
    if (c.val.name === 'tagged') expect(payload.player).not.toBe(round.it);
    if (c.val.name === 'vote-over') expect(payload.out).not.toBe(round.it);
  }
  for (const h of huds(out.commands)) {
    if (h.player === round.it) continue;
    expect(h.model.text?.role).not.toBe('it');
    expect(h.model.message ?? '').not.toContain('you are it');
    if (round.phase !== PHASE_OVER) expect(h.model.message ?? '').not.toContain('was it');
  }
}

describe('mystery on the authority', () => {
  it('tells only "it", keeps the secret until the round ends, and tags by touch', () => {
    const room = boot(AUTHORITY);
    expectSecret(room.step([joined(0), joined(1), joined(2)]));
    expect(room.entities.size).toBe(3);

    const started = room.step([message(0, 'start')]);
    const its = huds(started.commands).filter((h) => h.model.text?.role === 'it');
    expect(its).toHaveLength(1);
    expect(its[0].player).toBe(round.it);
    expectSecret(started);

    spread(room, [0, 1, 2]);
    for (let i = 0; i < 60 * 4; i += 1) {
      const quiet = room.step();
      expectSecret(quiet);
      expect(sends(quiet.commands, 'tagged')).toHaveLength(0);
    }

    const [victim, last] = [0, 1, 2].filter((id) => id !== round.it);
    touch(room, round.it, victim);
    const touched = room.step();
    expectSecret(touched);
    expect(sends(touched.commands, 'tagged')).toEqual([
      { to: undefined, payload: { player: victim, alive: 2 } },
    ]);

    // Two left can split the vote; it runs out, and a new grace period follows.
    expect(round.phase).toBe(PHASE_VOTE);
    room.step([vote(round.it, last), vote(last, round.it)]);
    for (let i = 0; i < 60 * 34; i += 1) expectSecret(room.step());
    expect(round.phase).toBe(PHASE_LIVE);

    // The last one caught ends the round, for everyone.
    touch(room, round.it, last);
    const ended = room.step();
    expect(sends(ended.commands, 'round-over')).toEqual([
      { to: undefined, payload: { its: [round.it], winner: 'it' } },
    ]);
  });

  it('ignores Start from anyone but the host', () => {
    const room = boot(AUTHORITY);
    room.step([joined(0), joined(1), joined(2)]);
    const started = room.step([message(2, 'start')]);
    expect(huds(started.commands).filter((h) => h.model.text?.role === 'it')).toHaveLength(0);
    expect(round.it).toBe(-1);
  });

  it('refuses to deal with only two players, and keeps waiting', () => {
    const room = boot(AUTHORITY);
    room.step([joined(0), joined(1)]);
    const started = room.step([message(0, 'start')]);
    expect(huds(started.commands).filter((h) => h.model.text?.role === 'it')).toHaveLength(0);
    expect(sends(started.commands, 'round')).toHaveLength(0);
    expect(round.it).toBe(-1);
    const lobby = huds(room.step([joined(2)]).commands);
    expect(lobby.find((h) => h.player === 0)?.model.message).toBe(
      'press R when ready · G starts now',
    );
  });

  it('lets nobody be tagged for the whole grace period', () => {
    const room = boot(AUTHORITY);
    room.step([joined(0), joined(1), joined(2)]);
    room.step([message(0, 'start')]); // the deal, at frame 1
    // Everyone still stands on the spawn point, touching "it", from the deal on.
    let first = -1;
    for (let frame = 2; frame < 400 && first < 0; frame += 1) {
      if (sends(room.step().commands, 'tagged').length > 0) first = frame;
    }
    // graceSeconds 3 at 60 Hz: the first tag is 180 steps after the deal.
    expect(first).toBe(181);
  });

  it('picks with ctx.rng: the same seed deals the same player, other seeds others', () => {
    const pick = (seed: number): number => {
      const room = boot(AUTHORITY, seed);
      room.step([joined(0), joined(1), joined(2), joined(3)]);
      room.step([message(0, 'start')]);
      return round.it;
    };
    expect(pick(0x5eed)).toBe(pick(0x5eed));
    const picked = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(pick));
    expect(picked.size).toBeGreaterThan(1);
  });
});

describe('the secret, through every phase', () => {
  it('holds through the lobby, chat, two votes and the end', () => {
    const room = boot(AUTHORITY);
    const step = (events: Parameters<Room['step']>[0] = []): ReturnType<Room['step']> => {
      const out = room.step(events);
      expectSecret(out);
      return out;
    };
    const all = [0, 1, 2, 3, 4];
    step(all.map(joined));
    step([message(0, 'chat', { text: 'who is it?' })]);
    step(all.map((id) => message(id, 'ready')));
    expect(round.phase).toBe(PHASE_LIVE);
    spread(room, all);
    for (let i = 0; i < 60 * 4; i += 1) step();

    const crew = all.filter((id) => id !== round.it);
    touch(room, round.it, crew[0]);
    step();
    expect(round.phase).toBe(PHASE_VOTE);
    step([message(crew[1], 'chat', { text: 'not me' })]);
    // Three of the four still in pick crew[1]: wrong, and the round goes on.
    step([vote(crew[2], crew[1]), vote(crew[3], crew[1]), vote(round.it, crew[1])]);
    expect(round.phase).toBe(PHASE_LIVE);
    expect(round.alive(crew[1])).toBe(false);
    for (let i = 0; i < 60 * 4; i += 1) step();

    touch(room, round.it, crew[2]);
    step();
    expect(round.phase).toBe(PHASE_VOTE);
    const ended = step([vote(crew[3], round.it), vote(round.it, round.it)]);
    expect(round.phase).toBe(PHASE_OVER);
    expect(sends(ended.commands, 'round-over')).toHaveLength(1);
  });
});

describe('mystery alone', () => {
  it('waits for players in solo and never crashes', () => {
    const room = boot();
    let hud: string | undefined;
    for (let frame = 0; frame < 120; frame += 1) {
      const out = room.guest.tick(
        createFrameInput({
          frame,
          events:
            frame === 5
              ? [
                  message(0, 'start'),
                  message(0, 'ready'),
                  message(0, 'vote', { for: 0 }),
                  message(0, 'chat', { text: 'anyone?' }),
                ]
              : [],
        }),
      );
      hud = out.hud ?? hud;
    }
    expect(hud).toContain('waiting for players');
    expect(round.it).toBe(-1);
    expect(room.host.log_.filter((l) => l.level === 'error')).toEqual([]);
  });
});
