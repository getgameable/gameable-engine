/**
 * `ColyseusConnection` resuming: in place after a dropped link, by token after
 * a reload, and never into a seat another live tab holds. A real
 * `createRoomServer` on port 0 runs the tiny game's two-seat wasm guest.
 */
import { Client } from '@colyseus/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { killSocket, localRoom } from '../server/testing/testServer.js';
import { createColyseusConnection } from './ColyseusConnection.js';
import { MemorySeatLocks } from './SeatLocks.js';
import {
  closePages,
  holdingW,
  inputFrame,
  joined,
  linkedPage,
  sdkRoomOf,
} from './testing/pages.js';
import {
  MemoryStorage,
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

/**
 * @param storage A tab's storage.
 * @returns A copy, as a browser makes when the tab is duplicated.
 */
function duplicate(storage: MemoryStorage): MemoryStorage {
  const copy = new MemoryStorage();
  for (const [key, value] of storage.items) copy.setItem(key, value);
  return copy;
}

describe('ColyseusConnection: resuming', () => {
  it('a socket killed within 5 s of joining resumes in place (minUptime 0 by default): same seat and entity; sends while away are dropped', async () => {
    const a = await linkedPage(rooms, { create: true }, 'Ana');
    await joined(a);
    await waitFor(() => a.net.localEntity !== 0, 'the entity');
    const { localPlayer, localEntity } = a.net;
    const sdkRoom = sdkRoomOf(a);
    expect(sdkRoom.reconnection.maxEnqueuedMessages).toBe(0);
    expect(sdkRoom.reconnection.minUptime).toBe(0);
    const sends = vi.spyOn(sdkRoom, 'sendBytes');

    killSocket(sdkRoom.roomId, sdkRoom.sessionId);
    await waitFor(() => a.link.state === 'reconnecting', 'the drop');
    a.link.sendInput(new Uint8Array(64).fill(7));
    a.link.sendText('{"t":"ping","at":1}');
    expect(a.net.sendInput(77, holdingW())).toBe(false);
    expect(sends).not.toHaveBeenCalled();
    expect(sdkRoom.reconnection.enqueuedMessages).toEqual([]);

    await joined(a);
    expect(a.net.welcomes).toBe(2);
    expect([a.net.localPlayer, a.net.localEntity]).toEqual([localPlayer, localEntity]);
    expect(a.link.colyseusRoom).toBe(sdkRoom); // the SDK's own resume, on the same Room
    const frames = a.net.stats.commandFrames;
    await waitFor(() => a.net.stats.commandFrames > frames + 10, 'frames after the resume');
    expect(a.net.ack).toBe(0); // nothing sent while away reached the room

    const bytes = inputFrame(5);
    a.link.sendInput(bytes);
    bytes.fill(0); // the caller reuses its buffer at once; the room must still see seq 5
    await waitFor(() => a.net.ack === 5, 'the ack of seq 5');
  });

  it('reconnect() drops the link and resumes the same seat, with a fresh welcome', async () => {
    const a = await linkedPage(rooms, { create: true }, 'Ana');
    await joined(a);
    await waitFor(() => a.net.localEntity !== 0, 'the entity');
    const { localPlayer, localEntity } = a.net;
    const sdkRoom = sdkRoomOf(a);
    const states: string[] = [];
    a.net.onChange(() => states.push(a.net.state));
    a.link.reconnect('silent');
    expect(a.link.state).toBe('reconnecting');
    await joined(a);
    expect(a.net.welcomes).toBe(2);
    expect([a.net.localPlayer, a.net.localEntity]).toEqual([localPlayer, localEntity]);
    expect(a.link.colyseusRoom).toBe(sdkRoom); // the SDK's own resume, on the same Room
    expect(states).toEqual(['reconnecting', 'joined']);
    a.link.reconnect('again'); // ignored unless open: here it is open, so it drops once more
    await joined(a);
    expect(a.net.welcomes).toBe(3);
  });

  it('reports open only after each welcome, the first and the one after a resume', async () => {
    const log: string[] = [];
    const link = createColyseusConnection({
      url: rooms.url,
      game: 'tiny',
      create: true,
      headers: { origin: 'http://game.test' },
      storage: null,
    });
    link.join(
      { name: 'Ana' },
      {
        onText: (text) => {
          if (text.startsWith('{"t":"welcome"')) log.push('welcome');
        },
        onRows: () => undefined,
        onState: (state) => log.push(state),
      },
    );
    await waitFor(() => link.state === 'open', 'the welcome');
    const sdkRoom = link.colyseusRoom;
    if (sdkRoom === null) throw new Error('no room');
    killSocket(sdkRoom.roomId, sdkRoom.sessionId);
    await waitFor(() => log.length === 6, 'the resume');
    expect(log).toEqual(['connecting', 'welcome', 'open', 'reconnecting', 'welcome', 'open']);
    link.leave();
    expect(link.state).toBe('closed');
  });

  it('after a resume in place the saved token is the new one, so a later reload keeps the seat', async () => {
    const storage = new MemoryStorage();
    const a = await linkedPage(rooms, { create: true, storage }, 'Ana');
    await joined(a);
    await waitFor(() => a.net.localEntity !== 0, 'the entity');
    const { localPlayer, localEntity } = a.net;
    const code = a.net.room ?? '';
    const key = `gameable.rooms|${rooms.url}|tiny|${code}`;
    const sdkRoom = sdkRoomOf(a);
    killSocket(sdkRoom.roomId, sdkRoom.sessionId);
    await waitFor(() => a.net.welcomes === 2, 'the resume');
    expect(storage.getItem(key)).toBe(`${sdkRoom.sessionId} ${sdkRoom.reconnectionToken}`);

    sdkRoom.reconnection.enabled = false; // the tab goes: no resume in place this time
    killSocket(sdkRoom.roomId, sdkRoom.sessionId);
    await waitFor(() => a.net.state === 'closed', 'the close');
    const reloaded = await linkedPage(rooms, { storage }, 'Ana', code);
    await joined(reloaded);
    expect([reloaded.net.localPlayer, reloaded.net.localEntity]).toEqual([
      localPlayer,
      localEntity,
    ]);
  });

  it('a drop inside minUptimeMs closes; a reload in the same tab resumes the held seat by its token', async () => {
    const storage = new MemoryStorage();
    const a = await linkedPage(rooms, { create: true, minUptimeMs: 60_000, storage }, 'Ana');
    await joined(a);
    await waitFor(() => a.net.localEntity !== 0, 'the entity');
    const { localPlayer, localEntity } = a.net;
    const code = a.net.room ?? '';
    expect([...storage.items.keys()]).toEqual([`gameable.rooms|${rooms.url}|tiny|${code}`]);
    const sdkRoom = sdkRoomOf(a);
    killSocket(sdkRoom.roomId, sdkRoom.sessionId);
    await waitFor(() => a.net.state === 'closed', 'the close');
    expect(a.net.closeReason).toBe('lost');

    const reloaded = await linkedPage(rooms, { storage }, 'Ana', code);
    await joined(reloaded);
    expect([reloaded.net.localPlayer, reloaded.net.localEntity]).toEqual([
      localPlayer,
      localEntity,
    ]);
    expect(reloaded.net.room).toBe(code);
    const other = await linkedPage(rooms, {}, 'Ben', code); // another tab: another player
    await joined(other);
    expect(other.net.localPlayer).not.toBe(localPlayer);

    reloaded.module.dispose(); // a consented leave forgets the token
    await waitFor(() => storage.items.size === 0, 'the token to go');
  });

  it.each([
    ['the seat lock is busy, so the copy never presents the token', new MemorySeatLocks()],
    ['no locks: the server refuses the live seat token', null],
  ])('a duplicated tab gets its own seat and the original keeps its own: %s', async (_, locks) => {
    const storage = new MemoryStorage();
    const a = await linkedPage(rooms, { create: true, storage, locks }, 'Ana');
    await joined(a);
    await waitFor(() => a.net.localEntity !== 0, 'the entity');
    const { localPlayer, localEntity } = a.net;
    const code = a.net.room ?? '';
    const reconnects = vi.spyOn(Client.prototype, 'reconnect');
    const copy = await linkedPage(rooms, { storage: duplicate(storage), locks }, 'Ana-dup', code);
    await joined(copy);
    // With a lock the copy never presents the token; without one it does, and the server says no.
    expect(reconnects).toHaveBeenCalledTimes(locks === null ? 1 : 0);
    if (locks === null)
      await expect(reconnects.mock.results[0]?.value).rejects.toThrow(/invalid or expired/);
    reconnects.mockRestore();
    expect(copy.net.localPlayer).not.toBe(localPlayer);
    await waitFor(() => a.net.players.length === 2, 'both players');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(a.net.state).toBe('joined');
    expect(a.link.state).toBe('open');
    expect([a.net.localPlayer, a.net.localEntity]).toEqual([localPlayer, localEntity]);
    expect(localRoom(code).players).toBe(2);
    expect(a.net.players.every((p) => p.connected)).toBe(true);
  });
});
