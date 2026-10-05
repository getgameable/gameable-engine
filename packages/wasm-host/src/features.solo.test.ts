/**
 * The Play Solo bundle guarantee: a page that brings its own connection (the
 * room in the page) never loads `gameable/rooms/client`, so it never
 * downloads the Colyseus SDK.
 */
import { describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ rooms: 0 }));
vi.mock('@gameable/rooms/client', () => {
  loads.rooms += 1;
  throw new Error('@gameable/rooms/client was loaded');
});

describe('clientFeatures: multiplayer with a page connection', () => {
  it('loads @gameable/net/client only', async () => {
    const { clientFeatures } = await import('./features');
    const { createLoopbackConnection } = await import('@gameable/net/client');
    const { loopbackPair } = await import('@gameable/net/testing');
    const connection = createLoopbackConnection({ connect: () => loopbackPair()[0] });
    const loaded = await clientFeatures({ multiplayer: { connection } }).multiplayer({
      maxPlayers: 4,
    });
    expect(loaded.modules.map((m) => m.id)).toEqual(['net']);
    expect(loads.rooms).toBe(0);
  });

  it('the guard is live: without a connection the rooms client is what loads (positive control)', async () => {
    const { clientFeatures } = await import('./features');
    await expect(clientFeatures().multiplayer({})).rejects.toThrow();
    expect(loads.rooms).toBe(1);
  });
});
