import { describe, expect, it, vi } from 'vitest';

vi.mock('./characters', () => ({
  createCharacterBridge: vi.fn((o: unknown) => ({ bridge: true, o })),
}));

import { createHeadlessEngine, FeatureError } from '@gameable/core';

import { clientFeatures } from './features';

describe('clientFeatures', () => {
  it('lists characters and multiplayer', () => {
    expect(Object.keys(clientFeatures())).toEqual(['characters', 'multiplayer']);
  });
  it('multiplayer: no page address and no url (Node), a clear FeatureError', async () => {
    const loading = clientFeatures().multiplayer({ maxPlayers: 6 });
    await expect(loading).rejects.toThrow(FeatureError);
    await expect(clientFeatures().multiplayer({})).rejects.toThrow(/no room server\. Pass \{ url \}/);
  });
  it('multiplayer: by default a ColyseusConnection to <page origin>/services/rooms/', async () => {
    const { ColyseusConnection } = await import('@gameable/rooms/client');
    const loaded = await clientFeatures({
      multiplayer: { location: { href: 'https://play.example/m/?room=KQTX' }, game: 'party' },
    }).multiplayer({ maxPlayers: 6 });
    const net = (await loaded.bind!({} as never)) as { connection: unknown };
    expect(net.connection).toBeInstanceOf(ColyseusConnection);
    const options = (net.connection as { options: { url: string; game: string } }).options;
    expect(options).toMatchObject({ url: 'wss://play.example/services/rooms/', game: 'party' });
  });
  it("multiplayer: the page's connection and name ride along; the game's seats come from its options", async () => {
    const { createLoopbackConnection } = await import('@gameable/net/client');
    const { loopbackPair } = await import('@gameable/net/testing');
    const connection = createLoopbackConnection({ connect: () => loopbackPair()[0] });
    const loaded = await clientFeatures({ multiplayer: { connection, name: 'Ana' } }).multiplayer({
      maxPlayers: 6,
    });
    expect(loaded.name).toBe('multiplayer');
    expect(loaded.modules.map((m) => m.id)).toEqual(['net']);
    const net = (await loaded.bind!({} as never)) as { maxPlayers: number };
    expect(net.maxPlayers).toBe(6);
  });
  it('characters: no modules, a bind that builds the bridge from the engine', async () => {
    const loaded = await clientFeatures().characters({});
    expect(loaded.modules).toEqual([]);
    const engine = { renderer: 'R', scene: 'S' } as never;
    const bound = (await loaded.bind!(engine)) as { bridge: boolean; o: { renderer: string } };
    expect(bound.bridge).toBe(true);
    expect(bound.o.renderer).toBe('R');
  });
  it("characters: the page's own bridge options ride along, the engine is never overridden", async () => {
    const warn = (): void => undefined;
    const loaded = await clientFeatures({ characters: { warn, headOffset: [0, 1, 0] } }).characters(
      {},
    );
    const engine = { renderer: 'R', scene: 'S' } as never;
    const bound = (await loaded.bind!(engine)) as {
      o: { warn: unknown; headOffset: number[]; engine: unknown };
    };
    expect(bound.o.warn).toBe(warn);
    expect(bound.o.headOffset).toEqual([0, 1, 0]);
    expect(bound.o.engine).toBe(engine);
  });
  it('characters: binding to a headless engine throws a FeatureError', async () => {
    const loaded = await clientFeatures().characters({});
    const engine = await createHeadlessEngine();
    await expect(loaded.bind!(engine)).rejects.toThrow(FeatureError);
    await expect(loaded.bind!(engine)).rejects.toThrow(/cannot run headless/);
    await engine.dispose();
  });
});
