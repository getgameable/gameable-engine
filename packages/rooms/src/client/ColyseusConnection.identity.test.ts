/**
 * Task 5.3 on the page: a `ColyseusConnection` keeps the device token the
 * room hands it in `localStorage` (one per browser, not per tab), sends it
 * on every join, and passes a Gameable session token when the page has one.
 * Seat tokens stay in each tab's `sessionStorage`. A bare Colyseus server
 * with the stub game, and real connections.
 */
import type { ConnectionState, RoomConnectionEvents } from '@gameable/net/client';
import { createIdentities, deviceIdentity, portalIdentity } from '@gameable/net/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { stubEntry } from '../server/testing/StubGame.js';
import {
  localRoom,
  startTestServer,
  type TestServer,
  waitFor,
} from '../server/testing/testServer.js';
import { type ColyseusConnection, createColyseusConnection } from './ColyseusConnection.js';
import { MemorySeatLocks } from './SeatLocks.js';
import type { SeatStorage } from './SeatTokens.js';

/** A Web Storage stand-in: one per tab (`sessionStorage`) or per browser (`localStorage`). */
class Memory implements SeatStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const authMe = (_url: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(
    new Headers(init?.headers).get('cookie') === 'avataros_session=good'
      ? new Response(JSON.stringify({ id: 'user-ana', email: 'ana@gameable.test' }), {
          status: 200,
        })
      : new Response('{}', { status: 401 }),
  );

let server: TestServer;
const locks = new MemorySeatLocks();

beforeAll(async () => {
  const identities = createIdentities({
    device: deviceIdentity('a-test-secret-that-is-32-bytes-ok'),
    portal: portalIdentity({ authUrl: 'https://auth.test', fetch: authMe }),
  });
  server = await startTestServer({ alpha: stubEntry({ maxPlayers: 4 }) }, { identities });
});

afterAll(async () => {
  await server.close();
});

/** One tab: its own sessionStorage, the browser's localStorage. */
interface Tab {
  readonly connection: ColyseusConnection;
  readonly state: () => ConnectionState;
}

/**
 * @param device The browser's `localStorage`.
 * @param options The join.
 * @param options.create Make a fresh room.
 * @param options.portalToken The page's Gameable session token.
 * @returns A tab, open.
 */
async function openTab(
  device: Memory,
  options: { create?: boolean; portalToken?: () => string | null } = {},
): Promise<Tab> {
  const connection = createColyseusConnection({
    url: server.endpoint,
    game: 'alpha',
    create: options.create,
    storage: new Memory(),
    deviceStorage: device,
    locks,
    ...(options.portalToken === undefined ? {} : { portalToken: options.portalToken }),
  });
  let state: ConnectionState = 'idle';
  const events: RoomConnectionEvents = {
    onText: () => undefined,
    onRows: () => undefined,
    onState: (next) => {
      state = next;
    },
  };
  connection.join({ name: 'Tab' }, events);
  await waitFor(() => state === 'open', 'the welcome');
  return { connection, state: () => state };
}

/**
 * @param tab An open tab.
 * @returns Its seat on the server.
 */
function seatOf(tab: Tab) {
  const room = tab.connection.colyseusRoom;
  if (room === null) throw new Error('not joined');
  const seat = localRoom(room.roomId).seats.get(room.sessionId);
  if (seat === undefined) throw new Error('no seat');
  return seat;
}

const KEY = (endpoint: string): string => `aos.identity.${endpoint.replace(/^ws/, 'http')}`;

describe('ColyseusConnection: the device token', () => {
  it('mints on first contact, keeps it in localStorage, and a reload is the same id', async () => {
    const device = new Memory();
    const first = await openTab(device, { create: true });
    await waitFor(() => device.items.has(KEY(server.endpoint)), 'the device token saved');
    expect(device.items.get(KEY(server.endpoint))).toMatch(/^device\./);
    expect([...device.items.keys()]).toEqual([KEY(server.endpoint)]); // seat tokens are not here
    const id = seatOf(first).identity?.id;
    expect(id).toMatch(/^device:/);
    first.connection.leave();
    const reload = await openTab(device, { create: true });
    expect(seatOf(reload).identity?.id).toBe(id);
    reload.connection.leave();
  });

  it('two tabs of one browser: the same device id, two seats', async () => {
    const device = new Memory();
    const a = await openTab(device, { create: true });
    await waitFor(() => device.items.has(KEY(server.endpoint)), 'the device token saved');
    const b = await openTab(device); // a quick match: the bare server's ids are not room codes
    expect(b.connection.colyseusRoom?.roomId).toBe(a.connection.colyseusRoom?.roomId);
    expect(seatOf(b).identity?.id).toBe(seatOf(a).identity?.id);
    expect(seatOf(b).player.id).not.toBe(seatOf(a).player.id);
    b.connection.leave();
    a.connection.leave();
  });

  it("passes the page's Gameable session token; the portal's name wins", async () => {
    const tab = await openTab(new Memory(), { create: true, portalToken: () => 'good' });
    expect(seatOf(tab).identity).toEqual({ id: 'user-ana', name: 'ana', kind: 'portal' });
    expect(seatOf(tab).player.name).toBe('ana');
    tab.connection.leave();
  });
});
