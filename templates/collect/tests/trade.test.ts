/**
 * Trades: `offer`, then `accept`, then ONE `ctx.data.exchange` in the room's
 * memory store (`tests/room.ts`). What is refused, what goes stale, what a
 * failed exchange leaves, and what a rejoin finds.
 */
import { describe, expect, it } from 'vitest';

import type { CollectDoc } from '../src/pets';
import { bootRoom, GAME, sends, type RoomRun, type TestRoom } from './room';

const QUIET = { coinRange: -1 };
const CAT = { id: 'cat1', kind: 'cat', tier: 1 };
const DOG = { id: 'dog1', kind: 'dog', tier: 2 };

/**
 * A room with ann (seat 0: a cat, 10 bucks) and bob (seat 1: a dog, 50 bucks).
 *
 * @returns The room.
 */
async function annAndBob(): Promise<TestRoom> {
  const room = bootRoom(QUIET);
  const docs: Record<string, CollectDoc> = {
    ann: { bucks: 10, pets: [CAT], eggs: [] },
    bob: { bucks: 50, pets: [DOG], eggs: [] },
  };
  for (const [key, doc] of Object.entries(docs)) {
    await room.store.save(GAME, key, JSON.stringify(doc), 0);
  }
  await room.join(0, 'ann');
  await room.join(1, 'bob');
  room.run(1);
  return room;
}

/**
 * @param room The room.
 * @param from Who sends it.
 * @param payload The offer.
 * @returns The run.
 */
function offer(room: TestRoom, from: number, payload: unknown): RoomRun {
  return room.run(1, (_frame, tape) => {
    tape.message(from, 'offer', JSON.stringify(payload));
  });
}

/**
 * @param room The room.
 * @param by Who accepts.
 * @param offerId Which offer.
 * @returns The run.
 */
function accept(room: TestRoom, by: number, offerId: number): RoomRun {
  return room.run(1, (_frame, tape) => {
    tape.message(by, 'accept', JSON.stringify({ offerId }));
  });
}

/** @returns The offer id `bob` was told about last, from these runs. */
function offerIdIn(r: RoomRun): number {
  const told = sends(r, 'offered').at(-1)?.payload as { offerId: number } | undefined;
  return told?.offerId ?? -1;
}

/** @returns How many `exchange` commands the guest emitted. */
function exchanges(r: RoomRun): number {
  return r.commands.flat().filter((c) => c.tag === 'exchange').length;
}

describe('a trade', () => {
  it('is an offer then an accept, which becomes ONE exchange that swaps both documents', async () => {
    const room = await annAndBob();
    const offered = offer(room, 0, {
      to: 1,
      give: { pets: ['cat1'] },
      take: { pets: ['dog1'], bucks: 5 },
    });
    expect(sends(offered, 'offered')).toEqual([
      {
        to: 1,
        payload: { offerId: 1, from: 0, text: 'ann offers cat 1 for your 5 bucks + dog 2' },
      },
    ]);
    const accepted = accept(room, 1, offerIdIn(offered));
    expect(exchanges(accepted)).toBe(1);
    await room.settle();
    const done = room.run(1);
    expect(sends(done, 'trade')).toEqual([
      { to: 0, payload: { ok: true, reason: '' } },
      { to: 1, payload: { ok: true, reason: '' } },
    ]);
    expect(await room.stored('ann')).toEqual({ bucks: 15, pets: [DOG], eggs: [] });
    expect(await room.stored('bob')).toEqual({ bucks: 45, pets: [CAT], eggs: [] });
  });

  it('refuses an offer of a pet the sender does not own, or asks for one the other lacks', async () => {
    const room = await annAndBob();
    const theirs = offer(room, 0, { to: 1, give: { pets: ['dog1'] }, take: {} });
    expect(sends(theirs, 'refused')).toEqual([
      { to: 0, payload: { what: 'offer', reason: 'not-yours' } },
    ]);
    const missing = offer(room, 0, { to: 1, give: { pets: ['cat1'] }, take: { pets: ['cat1'] } });
    expect(sends(missing, 'refused')).toEqual([
      { to: 0, payload: { what: 'offer', reason: 'not-theirs' } },
    ]);
    const short = offer(room, 0, { to: 1, give: { bucks: 11 }, take: {} });
    expect(sends(short, 'refused')).toEqual([
      { to: 0, payload: { what: 'offer', reason: 'short' } },
    ]);
    expect(sends(theirs, 'offered')).toEqual([]);
  });

  it('refuses a stale accept: a replaced offer, one already taken, one the documents moved past', async () => {
    const room = await annAndBob();
    const first = offerIdIn(offer(room, 0, { to: 1, give: { bucks: 1 }, take: {} }));
    const second = offerIdIn(offer(room, 0, { to: 1, give: { bucks: 2 }, take: {} }));
    const replaced = accept(room, 1, first);
    expect(sends(replaced, 'refused')).toEqual([
      { to: 1, payload: { what: 'accept', reason: 'stale' } },
    ]);
    expect(exchanges(replaced)).toBe(0);

    // Only its addressee can take it.
    const wrong = accept(room, 0, second);
    expect(sends(wrong, 'refused')).toEqual([
      { to: 0, payload: { what: 'accept', reason: 'stale' } },
    ]);

    expect(exchanges(accept(room, 1, second))).toBe(1);
    await room.settle();
    room.run(1);
    const again = accept(room, 1, second);
    expect(sends(again, 'refused')).toEqual([
      { to: 1, payload: { what: 'accept', reason: 'stale' } },
    ]);

    // Offered the cat, then sold it to someone else: the old offer no longer matches.
    const cat = offerIdIn(offer(room, 0, { to: 1, give: { pets: ['cat1'] }, take: {} }));
    await room.join(2, 'cy');
    room.run(1);
    const toCy = offerIdIn(offer(room, 0, { to: 2, give: { pets: ['cat1'] }, take: {} }));
    accept(room, 2, toCy);
    await room.settle();
    room.run(1);
    const gone = accept(room, 1, cat);
    expect(sends(gone, 'refused')).toEqual([
      { to: 1, payload: { what: 'accept', reason: 'stale' } },
    ]);
    expect(exchanges(gone)).toBe(0);
    expect((await room.stored('cy'))?.pets).toEqual([CAT]);
  });

  it('a failed exchange leaves both inventories as they were', async () => {
    const room = await annAndBob();
    const id = offerIdIn(
      offer(room, 0, { to: 1, give: { pets: ['cat1'] }, take: { pets: ['dog1'] } }),
    );
    // Someone else wrote bob's document behind this room's back: the store refuses as stale.
    await room.settle();
    const live = await room.store.load(GAME, 'bob');
    await room.store.save(GAME, 'bob', live?.data ?? '{}', live?.version ?? 0);
    expect(exchanges(accept(room, 1, id))).toBe(1);
    await room.settle();
    const failed = room.run(1);
    expect(sends(failed, 'trade')).toEqual([
      { to: 0, payload: { ok: false, reason: 'stale' } },
      { to: 1, payload: { ok: false, reason: 'stale' } },
    ]);
    expect(await room.stored('ann')).toEqual({ bucks: 10, pets: [CAT], eggs: [] });
    expect(await room.stored('bob')).toEqual({ bucks: 50, pets: [DOG], eggs: [] });
    // And the room's own view did not move either: the same offer can be made again.
    const again = offer(room, 0, { to: 1, give: { pets: ['cat1'] }, take: { pets: ['dog1'] } });
    expect(sends(again, 'offered')).toHaveLength(1);
  });

  it('survives leaving and rejoining: the traded pets are in the documents a new room loads', async () => {
    const room = await annAndBob();
    const id = offerIdIn(
      offer(room, 0, { to: 1, give: { pets: ['cat1'] }, take: { pets: ['dog1'] } }),
    );
    accept(room, 1, id);
    await room.settle();
    room.run(1);
    await room.leave(0);
    await room.leave(1);
    // Back in, the other way round: the documents follow the players, not the seats.
    await room.join(0, 'bob');
    await room.join(1, 'ann');
    room.run(1);
    expect(await room.stored('ann')).toEqual({ bucks: 10, pets: [DOG], eggs: [] });
    expect(await room.stored('bob')).toEqual({ bucks: 50, pets: [CAT], eggs: [] });
    // And this room trades from them.
    const back = offer(room, 1, { to: 0, give: { pets: ['dog1'] }, take: { pets: ['cat1'] } });
    expect(sends(back, 'offered')).toHaveLength(1);
  });

  it('drops an open offer when its sender leaves', async () => {
    const room = await annAndBob();
    const id = offerIdIn(offer(room, 0, { to: 1, give: { bucks: 1 }, take: {} }));
    await room.leave(0);
    const r = accept(room, 1, id);
    expect(sends(r, 'refused')).toEqual([{ to: 1, payload: { what: 'accept', reason: 'stale' } }]);
  });
});
