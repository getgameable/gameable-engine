import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { gameNameOf } from './gameName.js';
import { resolveServeOptions, roomSeeds } from './options.js';

describe('resolveServeOptions', () => {
  it('defaults: built mode, port 8790, localhost and 127.0.0.1 origins, no proxy, 8 rooms', () => {
    expect(resolveServeOptions([], '/game', {})).toEqual({
      mode: 'built',
      gameDir: '/game',
      gamesDir: undefined,
      port: 8790,
      host: '127.0.0.1',
      origins: ['http://localhost:*', 'http://127.0.0.1:*'],
      trustProxy: 0,
      maxRooms: 8,
      seed: undefined,
    });
  });

  it('--direct is one room', () => {
    expect(resolveServeOptions(['--direct'], '/game', {}).maxRooms).toBe(1);
    expect(resolveServeOptions(['--direct', '--max-rooms', '1'], '/game', {}).maxRooms).toBe(1);
  });

  it('reads every flag, and the container environment under the flags', () => {
    const env = { PORT: '9000', HOST: '0.0.0.0', TRUST_PROXY: '2', ORIGINS: 'https://a.example, https://b.example' };
    expect(resolveServeOptions([], '/g', env)).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      trustProxy: 2,
      origins: ['https://a.example', 'https://b.example'],
    });
    const argv = ['--port', '0', '--host', '::', '--trust-proxy', '1', '--origins', 'https://c.example', '--games', '/srv/games', '--max-rooms', '4', '--seed', '7'];
    const flagged = resolveServeOptions(argv, '/g', env);
    expect(flagged).toMatchObject({
      port: 0,
      host: '::',
      trustProxy: 1,
      origins: ['https://c.example'],
      maxRooms: 4,
      seed: 7,
    });
    expect(flagged.gamesDir).toMatch(/\/srv\/games$/);
  });

  it('refuses bad numbers, an unknown flag, and --direct with --games', () => {
    expect(() => resolveServeOptions(['--port', 'x'], '/g', {})).toThrow(/--port/);
    expect(() => resolveServeOptions(['--port', '70000'], '/g', {})).toThrow(/--port/);
    expect(() => resolveServeOptions(['--max-rooms', '0'], '/g', {})).toThrow(/--max-rooms/);
    expect(() => resolveServeOptions(['--trust-proxy', '-1'], '/g', {})).toThrow(/--trust-proxy/);
    expect(() => resolveServeOptions([], '/g', { PORT: 'abc' })).toThrow(/PORT/);
    expect(() => resolveServeOptions(['--wat'], '/g', {})).toThrow(/--wat/);
    expect(() => resolveServeOptions(['--direct', '--games', '/x'], '/g', {})).toThrow(/--games/);
  });
});

describe('roomSeeds', () => {
  it('rolls a fresh 32-bit seed per room, or repeats a pinned one', () => {
    const roll = roomSeeds(undefined);
    const seeds = new Set(Array.from({ length: 16 }, () => roll()));
    expect(seeds.size).toBeGreaterThan(14);
    for (const s of seeds) expect(Number.isInteger(s) && s >= 0 && s < 2 ** 32).toBe(true);
    const pinned = roomSeeds(7);
    expect([pinned(), pinned()]).toEqual([7, 7]);
  });
});

describe('gameNameOf', () => {
  it("is the package name without its npm scope (the coordinator's ruling, net/page's catalogName)", () => {
    expect(gameNameOf(fileURLToPath(new URL('../../../../templates/mystery', import.meta.url)))).toBe('example-mystery');
    expect(gameNameOf(fileURLToPath(new URL('../../../../templates/third-person', import.meta.url)))).toBe(
      'template-third-person',
    );
  });
});
