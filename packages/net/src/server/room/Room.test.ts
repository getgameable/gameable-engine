import { keyIndex, readKeyBit, writeKeyBit } from '@gameable/sdk/keycodes';
import { describe, expect, it } from 'vitest';

import { AUTHORITY_SENDER, FrameKind, PROTOCOL_VERSION } from '../../protocol/constants.js';
import { decodeRows } from '../../protocol/rowsFunctions.js';
import type { RowSink } from '../../protocol/types.js';
import { AdmittingGame, blankInput, flush, inputFrame, roomSetup as setup } from './roomTesting.js';

const W = keyIndex('W');
const hello = (name: string, seat?: { id: number; secret: string }): string =>
  JSON.stringify({
    t: 'hello',
    v: PROTOCOL_VERSION,
    room: 'ABCD',
    name,
    ...(seat ? { seat } : {}),
  });

describe('Room: seats', () => {
  it('seats a hello: join on the game, then a welcome with a secret and the snapshot', () => {
    const { room, game, ports } = setup();
    room.handle('c1', hello('Ana'));
    expect(game.calls).toContain('join 0 Ana null');
    const [welcome] = ports.texts('c1');
    expect(welcome).toMatchObject({
      t: 'welcome',
      player: 0,
      frame: 0,
      snapshot: { for: 0, entities: [] },
      players: [{ id: 0, name: 'Ana', connected: true }],
    });
    const secret = welcome.t === 'welcome' ? welcome.secret : '';
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(room.players.map((p) => [p.id, p.name, p.connected])).toEqual([[0, 'Ana', true]]);
  });

  it('gives the lowest free id and keeps the seats ascending', () => {
    const { room, ports } = setup();
    room.handle('a', hello('A'));
    room.handle('b', hello('B'));
    room.handle('c', hello('C'));
    expect(room.players.map((p) => p.id)).toEqual([0, 1, 2]);
    // B's seat is freed by a timeout; the next newcomer takes id 1.
    room.disconnect('b');
    ports.advance(600_001);
    room.handle('d', hello('D'));
    expect(room.players.map((p) => [p.id, p.name])).toEqual([
      [0, 'A'],
      [1, 'D'],
      [2, 'C'],
    ]);
  });

  it("answers a refusal from the game's admit with error: room and seats nobody", async () => {
    const game = new AdmittingGame();
    game.refusal = 'full moon only';
    const { room, ports } = setup({ game });
    room.handle('c1', hello('Ana'));
    await flush();
    expect(ports.texts('c1')).toEqual([{ t: 'error', code: 'room', detail: 'full moon only' }]);
    expect(ports.dropped).toEqual([['c1', 'room']]);
    expect(room.players).toEqual([]);
    expect(game.calls.some((c) => c.startsWith('join'))).toBe(false);
  });

  it('seats a newcomer the admit hook lets in', async () => {
    const game = new AdmittingGame();
    const { room, ports } = setup({ game });
    room.handle('c1', hello('Ana'));
    await flush();
    expect(ports.texts('c1')[0]?.t).toBe('welcome');
    expect(room.players).toHaveLength(1);
  });

  it('refuses the third player of a two-seat room with error: full', () => {
    const { room, ports } = setup({ maxPlayers: 2 });
    room.handle('a', hello('A'));
    room.handle('b', hello('B'));
    room.handle('c', hello('C'));
    expect(ports.texts('c')).toEqual([{ t: 'error', code: 'full' }]);
    expect(ports.dropped).toEqual([['c', 'full']]);
    expect(room.players).toHaveLength(2);
  });

  it('refuses another protocol version', () => {
    const { room, ports } = setup();
    room.handle('a', JSON.stringify({ t: 'hello', v: 0, room: 'ABCD', name: 'A' }));
    expect(ports.texts('a')[0]).toMatchObject({ t: 'error', code: 'version' });
    expect(room.players).toEqual([]);
  });

  it('tells the others when someone joins', () => {
    const { room, ports } = setup();
    room.handle('a', hello('A'));
    room.handle('b', hello('B'));
    expect(ports.texts('a').at(-1)).toEqual({
      t: 'players',
      players: [
        { id: 0, name: 'A', connected: true },
        { id: 1, name: 'B', connected: true },
      ],
    });
  });
});

describe('Room: input intake', () => {
  it('coalesces a press and a release between two ticks: both edges kept, down clear', () => {
    const { room, game, ports } = setup();
    room.handle('a', hello('A'));
    ports.advance(1000 / 60); // the first tick: no input yet
    const press = blankInput();
    writeKeyBit(press.down, W, true);
    writeKeyBit(press.pressed, W, true);
    press.mouse.dx = 3;
    press.mouse.wheel = 1;
    press.mouse.buttons = 1;
    press.mouse.pressed = 1;
    const release = blankInput();
    writeKeyBit(release.released, W, true);
    release.mouse.dx = 4;
    release.mouse.wheel = 1;
    room.handle('a', inputFrame(7, press));
    room.handle('a', inputFrame(8, release));
    ports.advance(1000 / 60);
    expect(game.inputs).toHaveLength(1);
    const got = game.inputs[0];
    expect(got.player).toBe(0);
    expect(got.seq).toBe(8);
    expect(readKeyBit(got.pressed, W)).toBe(true);
    expect(readKeyBit(got.released, W)).toBe(true);
    expect(readKeyBit(got.down, W)).toBe(false);
    expect(got.dx).toBe(7); // summed
    expect(got.wheel).toBe(2); // summed
    expect(got.buttons).toBe(0); // latest
    expect(got.mousePressed).toBe(1); // OR-ed
  });

  it('hands over held keys without the last tick edges, and only when a frame came', () => {
    const { room, game, ports } = setup();
    room.handle('a', hello('A'));
    const hold = blankInput();
    writeKeyBit(hold.down, W, true);
    writeKeyBit(hold.pressed, W, true);
    room.handle('a', inputFrame(1, hold));
    ports.advance(1000 / 60);
    ports.advance(1000 / 60); // no frame: no input call
    const still = blankInput();
    writeKeyBit(still.down, W, true);
    room.handle('a', inputFrame(2, still));
    ports.advance(1000 / 60);
    expect(
      game.inputs.map((i) => [i.seq, readKeyBit(i.down, W), readKeyBit(i.pressed, W)]),
    ).toEqual([
      [1, true, true],
      [2, true, false],
    ]);
  });

  it('forwards a msg to the game as JSON and answers a ping', () => {
    const { room, game, ports } = setup();
    room.handle('a', hello('A'));
    room.handle('a', '{"t":"msg","name":"chat","payload":{"text":"hi"}}');
    room.handle('a', '{"t":"ping","at":12}');
    expect(game.calls).toContain('message 0 chat {"text":"hi"}');
    expect(ports.texts('a').at(-1)).toEqual({ t: 'pong', at: 12, server: 0 });
  });

  it('ignores input and messages from a connection with no seat', () => {
    const { room, game } = setup();
    room.handle('x', inputFrame(1, blankInput()));
    room.handle('x', '{"t":"msg","name":"chat","payload":1}');
    expect(game.inputs).toEqual([]);
    expect(game.calls.some((c) => c.startsWith('message'))).toBe(false);
  });
});

describe('Room: the tick', () => {
  it('sends cmd every tick and rows only every 1000 / sendHz ms', () => {
    const { room, game, ports } = setup({ sendHz: 20 });
    room.handle('a', hello('A'));
    for (let i = 0; i < 60; i += 1) ports.advance(1000 / 60);
    expect(game.calls.filter((c) => c === 'tick')).toHaveLength(60);
    const cmds = ports.texts('a').filter((t) => t.t === 'cmd');
    expect(cmds).toHaveLength(60);
    const rows = ports.binaries('a');
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r[0] === FrameKind.ROWS)).toBe(true);
  });

  it('calls tick before taking the views, and takes every seat view each tick', () => {
    const { room, game, ports } = setup();
    room.handle('a', hello('A'));
    room.handle('b', hello('B'));
    room.disconnect('b');
    game.calls.length = 0;
    ports.advance(1000 / 60);
    expect(game.calls).toEqual(['tick', 'view 0', 'view 1']);
    expect(ports.texts('b').filter((t) => t.t === 'cmd')).toEqual([]);
  });

  it('acks the last input seq applied, in cmd and in rows', () => {
    const { room, game, ports } = setup();
    room.handle('a', hello('A'));
    game.commands = [{ tag: 'despawn', val: 9 }];
    room.handle('a', inputFrame(41, blankInput()));
    room.handle('a', inputFrame(42, blankInput()));
    ports.advance(1000 / 60);
    const cmd = ports.texts('a').filter((t) => t.t === 'cmd')[0];
    expect(cmd).toEqual({
      t: 'cmd',
      frame: 1,
      ack: 42,
      entity: 0,
      commands: [{ tag: 'despawn', val: 9 }],
    });
    const sink: RowSink = {
      position: new Float32Array(3),
      rotation: new Float32Array(4),
      scale: new Float32Array(3),
      row: () => undefined,
    };
    expect(decodeRows(ports.binaries('a')[0], sink)).toEqual({
      frame: 1,
      ack: 42,
      count: 1,
      player: null,
    });
  });

  it("sends the view's messages as msg frames from the authority", () => {
    const { room, game, ports } = setup();
    room.handle('a', hello('A'));
    game.messages = [{ name: 'pong', payload: '{"frame":3}' }];
    ports.advance(1000 / 60);
    expect(ports.texts('a').filter((t) => t.t === 'msg')).toEqual([
      { t: 'msg', from: AUTHORITY_SENDER, name: 'pong', payload: { frame: 3 } },
    ]);
  });
});

describe('Room: leaving and coming back', () => {
  it('keeps the seat on disconnect and resumes it with the seat secret', () => {
    const { room, game, ports } = setup();
    room.handle('a', hello('Ana'));
    const welcome = ports.texts('a')[0];
    const secret = welcome.t === 'welcome' ? welcome.secret : '';
    room.disconnect('a');
    expect(room.players.map((p) => [p.id, p.connected])).toEqual([[0, false]]);
    expect(game.calls.some((c) => c.startsWith('leave'))).toBe(false);
    room.handle('a2', hello('Ana', { id: 0, secret }));
    expect(room.players.map((p) => [p.id, p.connected])).toEqual([[0, true]]);
    expect(ports.texts('a2')[0]).toMatchObject({ t: 'welcome', player: 0, secret });
    expect(game.calls.filter((c) => c.startsWith('join'))).toHaveLength(1);
  });

  it('refuses a resume with the wrong secret and keeps the seat as it was', () => {
    const { room, ports } = setup();
    room.handle('a', hello('Ana'));
    room.disconnect('a');
    room.handle('x', hello('Ana', { id: 0, secret: 'nope' }));
    expect(ports.texts('x')).toEqual([{ t: 'error', code: 'seat' }]);
    expect(ports.dropped).toEqual([['x', 'seat']]);
    expect(room.players.map((p) => [p.id, p.connected])).toEqual([[0, false]]);
  });

  it('frees a seat held for leaveAfterMs with leave(player, timeout)', () => {
    const { room, game, ports } = setup();
    room.handle('a', hello('Ana'));
    room.disconnect('a');
    ports.advance(599_000);
    expect(game.calls.some((c) => c.startsWith('leave'))).toBe(false);
    ports.advance(2_000);
    expect(game.calls).toContain('leave 0 timeout');
    expect(room.players).toEqual([]);
  });

  it("close('ended') tells everyone error: ended, drops them and disposes the game", () => {
    const { room, game, ports } = setup();
    room.handle('a', hello('A'));
    room.handle('b', hello('B'));
    room.close('ended');
    expect(ports.texts('a').at(-1)).toEqual({ t: 'error', code: 'ended' });
    expect(ports.texts('b').at(-1)).toEqual({ t: 'error', code: 'ended' });
    expect(ports.dropped).toEqual([
      ['a', 'ended'],
      ['b', 'ended'],
    ]);
    expect(game.disposed).toBe(true);
    const ticks = game.calls.filter((c) => c === 'tick').length;
    ports.advance(1000);
    expect(game.calls.filter((c) => c === 'tick').length).toBe(ticks);
  });

  it('closes with a reason as error: ended with that detail', () => {
    const { room, ports } = setup();
    room.handle('a', hello('A'));
    room.close('crash');
    expect(ports.texts('a').at(-1)).toEqual({ t: 'error', code: 'ended', detail: 'crash' });
  });
});
