/**
 * Task 4.2, end to end on our own Room: a real SDK guest (the filters game)
 * through `createEngineRoomGame`, every frame read off the ports as a client
 * would. A `send` with `to: 2` reaches player 2 only; a spawn inside
 * `ctx.net.local` reaches nobody; player 1's HUD never reaches anyone else,
 * in a view or in a welcome. The Replicator's unit tests pin the same rules
 * on hand-built output; this pins them on what a guest really emits.
 */
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../../protocol/constants.js';
import type { ServerText } from '../../protocol/types.js';
import { createEngineRoomGame } from './createEngineRoomGame.js';
import { filtersGame, HUD_ONE, MARKER } from './filtersTesting.js';
import { createRoom } from './Room.js';
import { FakePorts } from './roomTesting.js';
import type { WelcomeSnapshot } from './welcomeSnapshot.js';

const hello = (name: string): string =>
  JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'ABCD', name });
const POKE = '{"t":"msg","name":"poke","payload":{}}';

/**
 * @param ports The room's ports.
 * @param conn A connection.
 * @returns Each named message it was sent, as `name n`.
 */
function messages(ports: FakePorts, conn: string): string[] {
  return ports
    .texts(conn)
    .flatMap((t) => (t.t === 'msg' ? [`${t.name} ${String((t.payload as { n: number }).n)}`] : []));
}

/**
 * @param ports The room's ports.
 * @param conn A connection.
 * @returns Every command it was sent in `cmd` frames.
 */
function commands(ports: FakePorts, conn: string): Extract<ServerText, { t: 'cmd' }>['commands'] {
  return ports.texts(conn).flatMap((t) => (t.t === 'cmd' ? t.commands : []));
}

/**
 * @param ports The room's ports.
 * @param conn A connection.
 * @returns The welcome snapshot it was sent.
 */
function welcome(ports: FakePorts, conn: string): WelcomeSnapshot {
  const frame = ports.texts(conn).find((t) => t.t === 'welcome');
  if (frame?.t !== 'welcome') throw new Error(`no welcome for ${conn}`);
  return frame.snapshot as WelcomeSnapshot;
}

describe('Room over a real guest: the local and to filters end to end', () => {
  it('to: 2 reaches 2 only, a local spawn reaches nobody, 1’s HUD reaches only 1', async () => {
    const game = await createEngineRoomGame({ definition: filtersGame(), maxPlayers: 3, seed: 1 });
    const ports = new FakePorts();
    const room = createRoom({ code: 'ABCD', game, ports, sendHz: 20 });
    const steps = (n: number): void => {
      for (let i = 0; i < n; i += 1) ports.advance(1000 / 60);
    };
    room.handle('p0', hello('Ana'));
    room.handle('p1', hello('Ben'));
    steps(3);
    room.handle('p0', POKE); // player 2 is not here yet: its message goes nowhere
    steps(3);
    room.handle('p2', hello('Cid')); // joins after the HUD and the marker exist
    steps(3);
    room.handle('p0', POKE);
    steps(3);

    // The guest did emit all of it: two markers in the authority's own world.
    const markers = [...game.adapter.world.entities.values()].filter((e) => e.name === MARKER);
    expect(markers).toHaveLength(2);

    // to: 2 reaches player 2 only; the broadcast reaches whoever was seated.
    expect(messages(ports, 'p0')).toEqual(['all 1', 'all 2']);
    expect(messages(ports, 'p1')).toEqual(['all 1', 'all 2']);
    expect(messages(ports, 'p2')).toEqual(['for-two 2', 'all 2']);

    for (const conn of ['p0', 'p1', 'p2']) {
      // The local spawn reaches nobody: no cmd and no welcome names a marker.
      expect(commands(ports, conn).some((c) => c.tag === 'spawn' && c.val.name === MARKER)).toBe(
        false,
      );
      expect(welcome(ports, conn).entities.some((e) => e.name === MARKER)).toBe(false);
    }

    // Player 1's HUD reaches player 1 (the positive control) and nobody else.
    const huds = (conn: string): unknown[] =>
      commands(ports, conn).filter((c) => c.tag === 'set-player-hud');
    expect(huds('p1')).toEqual([{ tag: 'set-player-hud', val: { player: 1, hud: HUD_ONE } }]);
    expect(huds('p0')).toEqual([]);
    expect(huds('p2')).toEqual([]);
    expect(welcome(ports, 'p2').hud).toBeUndefined(); // set before 2 joined, still not in 2's welcome
    expect(ports.texts('p2').some((t) => JSON.stringify(t).includes('mine'))).toBe(false);

    room.close('ended');
    await game.disposed;
  }, 60_000);
});
