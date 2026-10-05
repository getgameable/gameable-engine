/**
 * The "Browse rooms" bundle guarantee: a page holding `listPublicRooms`
 * loads `gameable/rooms/client` (and so the Colyseus SDK) only when the
 * panel calls it.
 */
import { describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ rooms: 0 }));
vi.mock('@gameable/rooms/client', () => {
  loads.rooms += 1;
  return {
    listRooms: (game: string, options: { url: string }) =>
      Promise.resolve({ game, url: options.url, rooms: [] }),
  };
});

describe('listPublicRooms', () => {
  it('loads the rooms client only when called, then lists the game at that endpoint', async () => {
    const { listPublicRooms } = await import('./features');
    expect(typeof listPublicRooms).toBe('function');
    expect(loads.rooms).toBe(0);
    const list = await listPublicRooms('my-game', 'wss://play.example/services/rooms/');
    expect(loads.rooms).toBe(1);
    expect(list).toMatchObject({ game: 'my-game', url: 'wss://play.example/services/rooms/' });
  });
});
