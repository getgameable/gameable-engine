/**
 * `listen()` on a port that is taken (M2): it rejects with the bind's error,
 * promptly, and takes its gate and process handlers away again, so
 * `gameable serve` on a busy port fails instead of hanging.
 */
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';

import { matchMaker } from '@colyseus/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubGame } from '../testing/StubGame.js';
import { createRoomServer } from './createRoomServer.js';

let squatter: Server;
let port: number;

beforeAll(async () => {
  squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  port = (squatter.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    squatter.close(() => {
      resolve();
    });
  });
});

const handlers = (): number[] => [
  process.listenerCount('unhandledRejection'),
  process.listenerCount('uncaughtException'),
];

describe('RoomServer.listen on a busy port', () => {
  it('rejects with EADDRINUSE and removes its gate and process handlers', async () => {
    const baseline = handlers();
    const invoke = matchMaker.controller.invokeMethod;
    const server = createRoomServer({ port, origins: ['http://game.test'], games: { stub: stubGame() } });
    const started = performance.now();
    await expect(server.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(performance.now() - started).toBeLessThan(3000); // settled, not pending forever
    expect(handlers()).toEqual(baseline);
    expect(matchMaker.controller.invokeMethod).toBe(invoke); // the gate is off again
    expect(server.health().ok).toBe(false);
  });

  it("prints nothing itself: the bind's error is the caller's to report (no raw stack from the transport)", async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const server = createRoomServer({ port, origins: ['http://game.test'], games: { stub: stubGame() } });
      await expect(server.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(printed.mock.calls.map((c) => String(c[0]))).toEqual([]);
    } finally {
      printed.mockRestore();
    }
  });
});
