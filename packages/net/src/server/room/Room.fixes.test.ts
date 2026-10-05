/**
 * Fix round 1 of task 3.6b: seats from 0, close with admissions pending, a
 * crashed game, and an ack that names only applied input.
 */
import { describe, expect, it } from 'vitest';

import { AUTHORITY_SENDER, PROTOCOL_VERSION } from '../../protocol/constants.js';
import { AckingGame, AdmittingGame, blankInput, flush, inputFrame, roomSetup as setup } from './roomTesting.js';

const hello = (name: string): string =>
  JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'ABCD', name });

describe('Room: the first joiner is player 0 (I4)', () => {
  it('seats ids from 0 upward, lowest free first', () => {
    const { room, game } = setup();
    room.handle('a', hello('A'));
    room.handle('b', hello('B'));
    expect(room.players.map((p) => p.id)).toEqual([0, 1]);
    expect(game.calls).toContain('join 0 A null');
  });

  it("names the authority as the sender of its messages, not player 0", () => {
    const { room, game, ports } = setup();
    room.handle('a', hello('A'));
    game.messages = [{ name: 'pong', payload: '1' }];
    ports.advance(1000 / 60);
    const msg = ports.texts('a').find((t) => t.t === 'msg');
    expect(msg).toEqual({ t: 'msg', from: AUTHORITY_SENDER, name: 'pong', payload: 1 });
    expect(AUTHORITY_SENDER).not.toBe(0);
  });
});

describe('Room: close and crash', () => {
  it('close() tells and drops a connection still waiting on admit', async () => {
    const game = new AdmittingGame();
    const { room, ports } = setup({ game });
    room.handle('a', hello('A'));
    room.close('ended');
    expect(ports.texts('a')).toEqual([{ t: 'error', code: 'ended' }]);
    expect(ports.dropped).toEqual([['a', 'ended']]);
    await flush();
    expect(room.players).toEqual([]);
    expect(ports.texts('a')).toHaveLength(1);
  });

  it("a game that ends itself closes the room with its reason, and the players are told", () => {
    const { room, game, ports } = setup();
    room.handle('a', hello('A'));
    ports.advance(1000 / 60);
    game.crash();
    ports.advance(1000 / 60);
    expect(ports.texts('a').at(-1)).toEqual({ t: 'error', code: 'ended', detail: 'crashed' });
    expect(ports.dropped).toEqual([['a', 'ended']]);
    expect(game.disposed).toBe(true);
  });
});

describe('Room: the ack names applied input only (M2)', () => {
  it("acks what the game says a step applied, not what was handed over", () => {
    const game = new AckingGame();
    game.applied = 3;
    const { room, ports } = setup({ game });
    room.handle('a', hello('A'));
    room.handle('a', inputFrame(9, blankInput()));
    ports.advance(1000 / 60);
    const cmd = ports.texts('a').find((t) => t.t === 'cmd');
    expect(cmd).toMatchObject({ ack: 3 });
  });
});

describe('Room: each player is told which entity is theirs (round 2)', () => {
  it("the welcome and every cmd carry that player's entity", () => {
    const { room, game, ports } = setup();
    game.entities.set(0, 41);
    game.entities.set(1, 42);
    room.handle('a', hello('A'));
    room.handle('b', hello('B'));
    expect(ports.texts('a')[0]).toMatchObject({ t: 'welcome', player: 0, entity: 41 });
    expect(ports.texts('b')[0]).toMatchObject({ t: 'welcome', player: 1, entity: 42 });
    game.entities.set(0, 43);
    ports.advance(1000 / 60);
    expect(ports.texts('a').find((t) => t.t === 'cmd')).toMatchObject({ entity: 43 });
    expect(ports.texts('b').find((t) => t.t === 'cmd')).toMatchObject({ entity: 42 });
  });
});
