/**
 * A guest sets the room's phase with `ctx.net.setPhase`: on our own Room
 * (and Play Solo, which runs it in the page), the reserved `aos:phase` send
 * becomes `RoomGame.phase` and never reaches a client; a client's own
 * `aos:phase` changes nothing and never reaches the guest.
 */
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../../protocol/constants.js';
import { createEngineRoomGame } from './createEngineRoomGame.js';
import { phaseGame } from './phaseTesting.js';
import { createRoom } from './Room.js';
import { FakePorts } from './roomTesting.js';

const hello = (name: string): string =>
  JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'ABCD', name });
const ask = (word: string): string => JSON.stringify({ t: 'msg', name: 'phase', payload: word });

describe('Room over a real guest: ctx.net.setPhase', () => {
  it('lists the phase the guest sets, and no client ever receives aos:phase', async () => {
    const game = await createEngineRoomGame({ definition: phaseGame(), maxPlayers: 2, seed: 1 });
    const ports = new FakePorts();
    const room = createRoom({ code: 'ABCD', game, ports, sendHz: 20 });
    const steps = (n: number): void => {
      for (let i = 0; i < n; i += 1) ports.advance(1000 / 60);
    };
    room.handle('p0', hello('Ana'));
    room.handle('p1', hello('Ben'));
    steps(3);
    expect(game.phase).toBeNull();

    room.handle('p0', ask('voting'));
    steps(3);
    expect(game.phase).toBe('voting');

    // A client cannot set it: its aos:phase is dropped before the guest.
    room.handle('p1', JSON.stringify({ t: 'msg', name: 'aos:phase', payload: 'forged' }));
    steps(3);
    expect(game.phase).toBe('voting');

    room.handle('p0', ask('lobby'));
    steps(3);
    expect(game.phase).toBe('lobby');

    for (const conn of ['p0', 'p1']) {
      const names = ports.texts(conn).flatMap((t) => (t.t === 'msg' ? [t.name] : []));
      expect(names).toEqual(['all', 'all']); // the positive control, and nothing else
    }

    room.close('ended');
    await game.disposed;
  }, 60_000);
});
