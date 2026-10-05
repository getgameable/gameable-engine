/**
 * `ColyseusConnection` joining, against a real `createRoomServer` on port 0
 * whose rooms run the tiny game's two-seat wasm guest, with real
 * `multiplayer()` pages on the client side. Resuming is in
 * `ColyseusConnection.resume.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { isRoomCode } from '../server/host/codes.js';
import { localRoom } from '../server/testing/testServer.js';
import { createColyseusConnection } from './ColyseusConnection.js';
import {
  Applied,
  closePages,
  holdingW,
  inputFrame,
  joined,
  linkedPage,
  opened,
} from './testing/pages.js';
import {
  MemoryStorage,
  ORIGIN,
  openPage,
  startWasmRooms,
  waitFor,
  type WasmRooms,
} from './testing/wasmRoomServer.js';

let rooms: WasmRooms;

beforeAll(async () => {
  rooms = await startWasmRooms();
}, 120_000);

afterEach(closePages);

afterAll(async () => {
  await rooms.server.close();
});

describe('ColyseusConnection: joining a real room server', () => {
  it('joins two pages into one room by its code; each applies the spawn and rows of the other', async () => {
    const a = await linkedPage(rooms, { create: true }, 'Ana');
    await joined(a);
    const code = a.net.room ?? '';
    expect(isRoomCode(code)).toBe(true); // the server's code, from the welcome
    expect(a.link.room).toBe(code);
    // The second page joins by code through the default connection: `?room=` and `?rooms=` on a local page.
    const href = `http://127.0.0.1/play?room=${code}&rooms=${encodeURIComponent(rooms.url)}`;
    const b = await openPage(rooms, { url: undefined, location: { href }, name: 'Ben' });
    opened.push(b);
    await joined(b);
    expect(b.net.room).toBe(code);
    expect([a.net.localPlayer, b.net.localPlayer]).toEqual([0, 1]);
    await waitFor(() => a.net.players.length === 2, 'the players list');

    const seenByA = new Applied();
    const seenByB = new Applied();
    const w = holdingW();
    let seq = 0;
    const walk = setInterval(() => {
      seq += 1;
      a.net.sendInput(seq, w);
      b.net.sendInput(seq, w);
      seenByA.drain(a);
      seenByB.drain(b);
    }, 1000 / 60);
    await waitFor(
      () => seenByA.rowsFor.has(b.net.localEntity) && seenByB.rowsFor.has(a.net.localEntity),
      'rows for the other page',
    ).finally(() => {
      clearInterval(walk);
    });
    expect(a.net.localEntity).not.toBe(b.net.localEntity);
    expect(seenByA.spawned.has(b.net.localEntity)).toBe(true);
    expect(seenByB.spawned.has(a.net.localEntity)).toBe(true);
    expect(a.net.ack).toBeGreaterThan(0);
  });

  it('quick match: with no code the first page makes a room and the next one lands in it', async () => {
    const q = await linkedPage(rooms, {}, 'Quin');
    await joined(q);
    expect(isRoomCode(q.net.room ?? '')).toBe(true);
    expect(q.net.localPlayer).toBe(0);
    const r = await linkedPage(rooms, {}, 'Rae');
    await joined(r);
    expect(r.net.room).toBe(q.net.room);
    expect(r.net.localPlayer).toBe(1);
  });

  it('refuses a third page into the full room (forgetting its stale token), and a page from a bad origin', async () => {
    const a = await linkedPage(rooms, { create: true }, 'Ana');
    await joined(a);
    const code = a.net.room ?? '';
    const b = await linkedPage(rooms, {}, 'Ben', code);
    await joined(b);
    const stale = new MemoryStorage();
    const key = `gameable.rooms|${rooms.url}|tiny|${code}`;
    stale.setItem(key, `gone ${code}:not-a-token`);
    const c = await linkedPage(rooms, { storage: stale }, 'Cy', code);
    await waitFor(() => c.net.state === 'closed', 'the refusal');
    expect(c.net.closeReason).toBe('full'); // the resume failed, then the fresh join
    expect(stale.getItem(key)).toBeNull(); // a failed resume forgets the token
    const evil = await linkedPage(rooms, { headers: { origin: 'https://evil.example' } }, 'Eve');
    await waitFor(() => evil.net.state === 'closed', 'the refusal');
    expect(evil.net.closeReason).toBe('origin');
    expect(evil.link.state).toBe('closed');
  });

  it("closes with 'budget', not 'error', when the room drops an input flood", async () => {
    const link = createColyseusConnection({
      url: rooms.url,
      game: 'tiny',
      create: true,
      headers: { origin: ORIGIN },
      storage: new MemoryStorage(),
    });
    const closed: string[] = [];
    link.join(
      { name: 'Flo' },
      {
        onState: (state, reason) => {
          if (state === 'closed') closed.push(reason);
        },
        onText: () => undefined,
        onRows: () => undefined,
      },
    );
    await waitFor(() => link.state === 'open', 'the welcome');
    for (let seq = 1; seq <= 400; seq += 1) link.sendInput(inputFrame(seq)); // over the 120-frame budget
    await waitFor(() => closed.length > 0, 'the drop');
    expect(closed).toEqual(['budget']);
  });

    it('a page that leaves while its join is in flight leaves the room once the join lands', async () => {
    const a = await linkedPage(rooms, { create: true }, 'Ana');
    await joined(a);
    const code = a.net.room ?? '';
    const b = await linkedPage(rooms, {}, 'Ben', code);
    expect(b.link.state).toBe('connecting');
    b.link.leave('gone');
    expect(b.link.state).toBe('closed');
    const room = localRoom(code);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(room.players).toBe(1); // only Ana: no connected ghost
    expect(b.link.colyseusRoom).toBeNull();
  });
});
