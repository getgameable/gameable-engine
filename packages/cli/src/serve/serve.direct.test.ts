/**
 * `gameable serve --direct`: the game's TypeScript, loaded through Vite, in
 * one room on a real Colyseus server on port 0. One server per file: the
 * matchmaker is a process singleton.
 */
import { createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';

import { TestPlayer } from '@gameable/rooms/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { serveCommand } from '../commands/serve.js';
import { resolveServeOptions } from './options.js';
import { type ServeHandle, startServe } from './startServe.js';

const TEMPLATE = fileURLToPath(new URL('../../../../templates/third-person', import.meta.url));
const ORIGIN = { origin: 'http://localhost:5181' };

/**
 * @param check Polled until true.
 * @param ms Give up after this long.
 */
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('gameable serve --direct', () => {
  let serve: ServeHandle;

  beforeAll(async () => {
    serve = await startServe(resolveServeOptions(['--direct', '--port', '0'], TEMPLATE));
  }, 60_000);

  afterAll(async () => {
    await serve.close();
  });

  it("boots the template's room server under its package name, and /health answers", async () => {
    expect(serve.names).toEqual(['template-third-person']);
    const health = (await (await fetch(`http://127.0.0.1:${String(serve.port)}/health`)).json()) as {
      ok: boolean;
      rooms: number;
    };
    expect(health).toMatchObject({ ok: true, rooms: 0 });
  });

  it("a Colyseus client joins, and its welcome carries the level's entities", async () => {
    const endpoint = `ws://127.0.0.1:${String(serve.port)}`;
    const player = await TestPlayer.create(endpoint, 'template-third-person', { name: 'A' }, ORIGIN);
    try {
      await until(() => player.replica.welcomes > 0);
      const snapshot = player.replica.snapshot as { entities: unknown[] };
      // The level's five props; the player's own spawn may land a tick after the welcome.
      expect(snapshot.entities.length).toBeGreaterThanOrEqual(5);
      await until(() => player.replica.entity > 0); // the player's own entity, from a cmd frame
    } finally {
      await player.leave();
    }
  }, 30_000);

  it('refuses a page origin outside the default localhost list', async () => {
    const endpoint = `ws://127.0.0.1:${String(serve.port)}`;
    await expect(
      TestPlayer.create(endpoint, 'template-third-person', { name: 'B' }, { origin: 'https://evil.example' }),
    ).rejects.toThrow();
  });
});

describe('gameable serve: refusals', () => {
  it('refuses --direct with more than one room, before loading anything', () => {
    expect(() => resolveServeOptions(['--direct', '--max-rooms', '2'], TEMPLATE)).toThrow(/--max-rooms 1/);
  });

  it('exits 1 with a clear message when the port is taken', async () => {
    const busy: Server = createServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const port = (busy.address() as { port: number }).port;
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      expect(await serveCommand(['--direct', '--port', String(port)], TEMPLATE)).toBe(1);
      // One clean line, and no raw Node stack printed above it.
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(new RegExp(`port ${String(port)} is already in use`));
      expect(errors.join('\n')).not.toMatch(/\n\s+at |setupListenHandle/);
    } finally {
      spy.mockRestore();
      await new Promise((resolve) => busy.close(resolve));
    }
  }, 60_000);
});
