// @vitest-environment jsdom
/**
 * `attachRoomClient`: the one wiring both multiplayer pages share. The
 * client loop goes into the slot (which starts the join), Play Solo's
 * authority is driven by the page's frames, and the badge follows `net`.
 */
import { createHeadlessEngine } from '@gameable/core/headless';
import { createGameSlot } from '@gameable/wasm-host';
import { afterEach, describe, expect, it } from 'vitest';

import { roomMode } from '../page/roomMode.js';
import { attachRoomClient } from './attachRoomClient.js';
import { testClientAdapter } from './clientTesting.js';
import { FakeConnection, ScriptedNet } from './scriptedNet.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('attachRoomClient', () => {
  it('attaches the client loop, starts the join, drives Play Solo and shows the badge', async () => {
    const net = new ScriptedNet();
    const slot = createGameSlot();
    const engine = await createHeadlessEngine({ modules: [slot.module], fixedHz: 60 });
    const driven: unknown[] = [];
    const solo = {
      connection: new FakeConnection(),
      drive: (e: unknown) => {
        driven.push(e);
        return () => undefined;
      },
    };
    const client = await attachRoomClient({
      engine,
      net,
      adapter: testClientAdapter(),
      sandbox: null,
      slot,
      room: { mode: roomMode(''), solo },
      badge: { probe: () => Promise.resolve(false) },
      onDead: () => undefined,
    });
    expect(net.starts).toBe(1);
    expect(driven).toEqual([engine]);
    expect(document.querySelector('[data-part="status"]')?.textContent).toMatch(/connecting/i);
    expect(client.loop).toBeDefined();
    client.dispose();
    expect(document.querySelector('[data-part="status"]')).toBeNull();
    await engine.dispose();
  });

  it('joins a room on the room server the same way, with nothing to drive', async () => {
    const net = new ScriptedNet();
    const slot = createGameSlot();
    const engine = await createHeadlessEngine({ modules: [slot.module], fixedHz: 60 });
    await attachRoomClient({
      engine,
      net,
      adapter: testClientAdapter(),
      sandbox: null,
      slot,
      room: { mode: roomMode('?room=KQTX'), solo: null },
      onDead: () => undefined,
    });
    expect(net.starts).toBe(1);
    await engine.dispose();
  });
});
