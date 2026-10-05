/**
 * Task 4.2 on our own Room (Play Solo, tests): a `msg` over the payload cap
 * is dropped and counted per player; a player out of text budget is told
 * `error: budget` once and keeps the seat; one who keeps on going for
 * `closeAfter` refusals in a row loses it.
 */
import { describe, expect, it } from 'vitest';

import { MAX_PAYLOAD_BYTES, PROTOCOL_VERSION } from '../../protocol/constants.js';
import { createRoom } from './Room.js';
import { FakeGame, FakePorts } from './roomTesting.js';

const hello = (name: string): string =>
  JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'ABCD', name });
const msg = (n: number): string => `{"t":"msg","name":"chat","payload":${String(n)}}`;
const big = `{"t":"msg","name":"chat","payload":"${'a'.repeat(MAX_PAYLOAD_BYTES)}"}`;

function setup(text = { burst: 3, refill: 1, everyMs: 1000, closeAfter: 5 }): {
  room: ReturnType<typeof createRoom>;
  game: FakeGame;
  ports: FakePorts;
} {
  const game = new FakeGame();
  const ports = new FakePorts();
  const room = createRoom({ code: 'ABCD', game, ports, maxPlayers: 4, sendHz: 20, text });
  room.handle('a', hello('Ana'));
  room.handle('b', hello('Ben'));
  return { room, game, ports };
}

const messages = (game: FakeGame): string[] => game.calls.filter((c) => c.startsWith('message'));
const errors = (ports: FakePorts, conn: string): unknown[] =>
  ports.texts(conn).filter((t) => t.t === 'error');

describe('Room: text limits', () => {
  it('drops a msg over MAX_PAYLOAD_BYTES and counts it against that player only', () => {
    const { room, game } = setup();
    room.handle('a', big);
    room.handle('a', msg(1));
    expect(messages(game)).toEqual(['message 0 chat 1']);
    expect(room.textCounts(0)).toMatchObject({ oversize: 1, spent: 2 });
    expect(room.textCounts(1)).toMatchObject({ oversize: 0, spent: 0 });
  });

  it('tells a player out of text budget once, drops the rest, and keeps the seat', () => {
    const { room, game, ports } = setup();
    for (let i = 0; i < 7; i += 1) room.handle('a', msg(i)); // 3 pass, 4 refused
    expect(messages(game)).toEqual(['message 0 chat 0', 'message 0 chat 1', 'message 0 chat 2']);
    expect(errors(ports, 'a')).toEqual([{ t: 'error', code: 'budget' }]);
    expect(errors(ports, 'b')).toEqual([]);
    expect(ports.dropped).toEqual([]);
    expect(room.textCounts(0)).toMatchObject({ overBudget: 4 });
    room.handle('b', msg(9)); // Ben's budget is his own
    expect(messages(game)).toContain('message 1 chat 9');
    ports.advance(1000); // a token back: Ana is heard again
    room.handle('a', msg(5));
    expect(messages(game)).toContain('message 0 chat 5');
    expect(room.players.map((p) => p.id)).toEqual([0, 1]);
  });

  it('spends the budget on pings too, and a refused frame still costs', () => {
    const { room, game, ports } = setup();
    room.handle('a', '{"t":"ping","at":1}');
    room.handle('a', 'garbage');
    room.handle('a', msg(1));
    room.handle('a', msg(2));
    expect(messages(game)).toEqual(['message 0 chat 1']);
    expect(errors(ports, 'a')).toHaveLength(1);
    expect(room.textCounts(0)).toMatchObject({ spent: 3, bad: 1, overBudget: 1 });
  });

  it('closes a player who keeps sending for closeAfter refusals in a row, and frees the seat', () => {
    const { room, game, ports } = setup();
    for (let i = 0; i < 3 + 5; i += 1) room.handle('a', msg(i));
    expect(ports.dropped).toEqual([['a', 'budget']]);
    expect(errors(ports, 'a')).toEqual([{ t: 'error', code: 'budget' }]); // told once, not twice
    expect(game.calls).toContain('leave 0 budget');
    expect(room.players.map((p) => p.id)).toEqual([1]);
    const last = ports
      .texts('b')
      .filter((t) => t.t === 'players')
      .at(-1);
    expect(last).toEqual({ t: 'players', players: [{ id: 1, name: 'Ben', connected: true }] });
    room.handle('a', msg(99)); // the connection is forgotten
    expect(messages(game)).not.toContain('message 0 chat 99');
  });

  it('does not budget a hello from a connection with no seat', () => {
    const { room, ports } = setup({ burst: 1, refill: 1, everyMs: 1000, closeAfter: 2 });
    room.handle('c', hello('Cid'));
    expect(ports.texts('c')[0]).toMatchObject({ t: 'welcome', player: 2 });
  });
});
