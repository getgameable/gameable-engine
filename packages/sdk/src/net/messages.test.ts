import { describe, expect, it } from 'vitest';

import { defineMessage, hasKeys, isRecord, MessageDef } from './messages';
import { message, payloads, rig, roomFrame } from './netTesting';
import { MAX_PAYLOAD_BYTES } from '../wire';
import type { GameContext } from '../defineGame';
import type { SendCmd } from '../types';

const AUTHORITY = '{"net":{"role":"authority"}}';

interface Vote {
  for: number;
}

const hasFor = hasKeys('for');

/**
 * @param maxBytes The cap, or the default.
 * @returns A fresh `vote` definition; every test runs after an `init`, which resets the names.
 */
const defineVote = (maxBytes?: number) =>
  defineMessage(
    'vote',
    (p): p is Vote => hasFor(p) && typeof p.for === 'number',
    maxBytes === undefined ? undefined : { maxBytes },
  );

/**
 * Boot an authority whose one system reads `def` every tick.
 *
 * @param read What the system does with the context.
 * @returns The rig.
 */
const authority = (read: (ctx: GameContext) => void) =>
  rig({ systems: [{ on: 'authority', run: read }] }, AUTHORITY);

describe('defineMessage', () => {
  it('delivers a valid payload with its player and counts it received', () => {
    rig({});
    const Vote = defineVote();
    const seen: [number, number][] = [];
    let received = -1;
    const { guest } = authority((ctx) => {
      for (const m of ctx.net.messages(Vote)) seen.push([m.player, m.payload.for]);
      received = ctx.net.stats.received;
    });
    guest.tick(roomFrame(0, [message(3, 'vote', '{"for":1}'), message(4, 'chat', '"hi"')]));
    expect(seen).toEqual([[3, 1]]);
    expect(received).toBe(1);
  });

  it('drops a payload that fails the check and counts it', () => {
    rig({});
    const Vote = defineVote();
    let count = -1;
    let dropped = -1;
    const { guest } = authority((ctx) => {
      count = ctx.net.messages(Vote).length;
      count = ctx.net.messages(Vote).length; // a second read counts nothing twice
      dropped = ctx.net.stats.dropped;
    });
    guest.tick(
      roomFrame(0, [
        message(1, 'vote', '{"for":"two"}'),
        message(2, 'vote', '[1]'),
        message(3, 'vote', '{nope'),
        message(4, 'vote', '{"for":2}'),
      ]),
    );
    expect(count).toBe(1);
    expect(dropped).toBe(3);
  });

  it('drops a payload over maxBytes without calling the check', () => {
    rig({});
    let calls = 0;
    const Small = defineMessage(
      'small',
      (p): p is string => {
        calls += 1;
        return typeof p === 'string';
      },
      { maxBytes: 8 },
    );
    let count = -1;
    let dropped = -1;
    const { guest } = authority((ctx) => {
      count = ctx.net.messages(Small).length;
      dropped = ctx.net.stats.dropped;
    });
    guest.tick(roomFrame(0, [message(1, 'small', '"123456"'), message(1, 'small', '"1234567"')]));
    expect(count).toBe(1);
    expect(dropped).toBe(1);
    expect(calls).toBe(1);
  });

  it('caps a payload at the wire cap by default', () => {
    rig({});
    const Any = defineMessage('any', (p): p is string => typeof p === 'string');
    expect(Any.maxBytes).toBe(MAX_PAYLOAD_BYTES);
    let dropped = -1;
    const { guest } = authority((ctx) => {
      ctx.net.messages(Any);
      dropped = ctx.net.stats.dropped;
    });
    const big = JSON.stringify('x'.repeat(MAX_PAYLOAD_BYTES));
    guest.tick(roomFrame(0, [message(1, 'any', big)]));
    expect(dropped).toBe(1);
  });

  it('drops a payload whose check throws, never throwing at the system', () => {
    rig({});
    const Boom = defineMessage('boom', (p): p is number => {
      if (p === 1) throw new Error('bad check');
      return true;
    });
    let count = -1;
    const { guest, host } = authority((ctx) => {
      count = ctx.net.messages(Boom).length;
    });
    guest.tick(roomFrame(0, [message(1, 'boom', '1'), message(1, 'boom', '2')]));
    expect(count).toBe(1);
    expect(host.lines.filter((l) => l.startsWith('error'))).toEqual([]);
  });

  it('throws on a second definition with the same name in one game; init starts the names afresh', () => {
    rig({});
    defineVote();
    expect(() => defineVote()).toThrow(/vote/);
    rig({});
    expect(() => defineVote()).not.toThrow();
  });

  it('rejects a maxBytes outside 1 to the wire cap', () => {
    rig({});
    expect(() => defineMessage('a', isRecord, { maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => defineMessage('b', isRecord, { maxBytes: MAX_PAYLOAD_BYTES + 1 })).toThrow(
      /maxBytes/,
    );
    expect(() => defineMessage('c', isRecord, { maxBytes: 1.5 })).toThrow(/maxBytes/);
  });

  it("validates the old by-name read too once the name's definition has been read", () => {
    rig({});
    const Vote = defineVote();
    let byName = -1;
    const { guest } = authority((ctx) => {
      ctx.net.messages(Vote);
      byName = ctx.net.messages<Vote>('vote').length;
    });
    guest.tick(roomFrame(0, [message(1, 'vote', '{"for":"x"}'), message(2, 'vote', '{"for":1}')]));
    expect(byName).toBe(1);
  });
});

describe('mixed reads of one name', () => {
  it('count each message once when a bare read and a definition read meet in one tick', () => {
    rig({});
    const Vote = defineVote();
    const counts: string[] = [];
    const { guest } = authority((ctx) => {
      const bare = ctx.net.messages('vote').length;
      const typed = ctx.net.messages(Vote).length;
      counts.push(`${String(bare)} ${String(typed)} ${JSON.stringify(ctx.net.stats)}`);
    });
    const tick = (f: number) =>
      guest.tick(
        roomFrame(f, [message(1, 'vote', '{"for":1}'), message(2, 'vote', '{"for":"x"}')]),
      );
    tick(0);
    tick(1);
    expect(counts).toEqual([
      '2 1 {"dropped":1,"received":1,"unsent":0}',
      '1 1 {"dropped":2,"received":2,"unsent":0}',
    ]);
  });

  it('keep the first definition of a name: a second object never re-reads and re-counts', () => {
    rig({});
    const Vote = defineVote();
    const Twin = new MessageDef(Vote.name, Vote.check, Vote.maxBytes);
    let stats = '';
    const { guest } = authority((ctx) => {
      ctx.net.messages(Vote);
      ctx.net.messages(Twin);
      ctx.net.messages(Vote);
      stats = JSON.stringify(ctx.net.stats);
    });
    guest.tick(roomFrame(0, [message(1, 'vote', '{"for":1}')]));
    guest.tick(roomFrame(1, [message(1, 'vote', '{"for":1}')]));
    expect(stats).toBe('{"dropped":0,"received":2,"unsent":0}');
  });
});

describe('ctx.net.send with a definition', () => {
  it('sends under the definition name, with the options', () => {
    rig({});
    const Vote = defineVote();
    const { guest } = authority((ctx) => {
      ctx.net.send(Vote, { for: 2 }, { to: 1 });
    });
    const out = guest.tick(roomFrame(0));
    expect(payloads<SendCmd>(out.commands, 'send')).toEqual([
      { to: 1, name: 'vote', payload: '{"for":2}', reliable: true },
    ]);
  });

  it('drops a payload that fails the check, is over maxBytes or will not serialise, counting it, never throwing at the system', () => {
    // A throw here would fail the tick, and eight in a row kill the guest:
    // one player's odd chat line must never freeze the room (phase 4 review I1).
    rig({});
    const Vote = defineVote(10);
    let threw = 0;
    let unsent = -1;
    const { guest } = authority((ctx) => {
      try {
        ctx.net.send(Vote, { for: 'x' } as unknown as Vote);
        ctx.net.send(Vote, { for: 123456789 });
        ctx.net.send('raw', () => 1);
        ctx.net.send('raw', 'x'.repeat(3000));
      } catch {
        threw += 1;
      }
      unsent = ctx.net.stats.unsent;
    });
    const out = guest.tick(roomFrame(0));
    expect(threw).toBe(0);
    expect(unsent).toBe(4);
    expect(payloads(out.commands, 'send')).toEqual([]);
  });
});

describe('isRecord and hasKeys', () => {
  it('accept a plain object and refuse null, arrays and primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('hasKeys needs every key as an own property of a record', () => {
    const ab = hasKeys('a', 'b');
    expect(ab({ a: 1, b: undefined })).toBe(true);
    expect(ab({ a: 1, b: 2, c: 3 })).toBe(true);
    expect(ab({ a: 1 })).toBe(false);
    expect(hasKeys('a')(Object.create({ a: 1 }) as unknown)).toBe(false);
    expect(hasKeys('0')([1])).toBe(false);
    expect(hasKeys()({})).toBe(true);
  });
});
