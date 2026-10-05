/**
 * A room over the real engine game: hello, ticks, and what one client is sent.
 *
 * Heap, measured as a one-off with `npx vitest run <file> --execArgv=--expose-gc`
 * on 2026-10-02, two seated players sending input every tick, rows at 20 Hz:
 * 10,000 room ticks grew the retained heap by 450,816 and 406,632 bytes (two
 * runs). Four blocks of 10,000 measured 460,336 / 466,560 / 471,440 / 473,304
 * bytes after each: the first block's growth is warm-up (JIT, pools filling),
 * after which it is flat (13 KB over 30,000 ticks).
 */
import type { GameDefinition } from '@gameable/sdk';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../../protocol/constants.js';
import { decodeRows } from '../../protocol/rowsFunctions.js';
import type { RowSink } from '../../protocol/types.js';
import { createEngineRoomGame } from './createEngineRoomGame.js';
import { createRoom } from './Room.js';
import { blankInput, FakePorts, inputFrame } from './roomTesting.js';

const MANIFEST = {
  version: 1,
  assets: [
    { id: 'arena', type: 'splat', src: 'a.spz' },
    { id: 'enemy-capsule', type: 'gltf', src: 'e.glb' },
    { id: 'shot', type: 'audio', src: 's.wav' },
  ],
};

/** @returns The tiny-game fixture's definition, loaded by URL. */
async function loadTinyGame(): Promise<GameDefinition> {
  const url = new URL('../../../../../fixtures/tiny-game/src/game.ts', import.meta.url);
  return ((await import(url.href)) as { default: GameDefinition }).default;
}

const hello = (name: string): string =>
  JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'ABCD', name });

/** A rows sink that only counts. */
const sink: RowSink = {
  position: new Float32Array(3),
  rotation: new Float32Array(4),
  scale: new Float32Array(3),
  row: () => undefined,
};

describe('Room over EngineRoomGame', () => {
  it('welcomes two players and streams them commands, rows and pongs', async () => {
    const game = await createEngineRoomGame({ definition: await loadTinyGame(), manifest: MANIFEST, maxPlayers: 4, seed: 7 });
    const ports = new FakePorts();
    const room = createRoom({ code: 'ABCD', game, ports, maxPlayers: 4, sendHz: 20 });
    room.handle('a', hello('Ana'));
    room.handle('b', hello('Ben'));
    const welcome = ports.texts('a')[0];
    expect(welcome.t).toBe('welcome');
    const snapshot = (welcome as { snapshot: { entities: { name?: string }[] } }).snapshot;
    expect(snapshot.entities.filter((e) => e.name === 'enemy')).toHaveLength(3);
    // Nobody has an entity before the guest's first step after the join.
    expect(welcome).toMatchObject({ entity: 0 });
    room.handle('a', '{"t":"msg","name":"ping","payload":{}}');
    for (let i = 0; i < 30; i += 1) ports.advance(1000 / 60);
    const texts = ports.texts('b');
    const names: (string | undefined)[] = [];
    for (const t of texts) {
      if (t.t !== 'cmd') continue;
      for (const c of t.commands) if (c.tag === 'spawn') names.push(c.val.name);
    }
    // Ben is told which entity is his: a player prefab, not Ana's.
    const lastCmd = texts.filter((t) => t.t === 'cmd').at(-1);
    const bens = lastCmd?.t === 'cmd' ? lastCmd.entity : 0;
    expect(bens).toBe(game.entityOf(1));
    expect(game.adapter.world.get(bens)?.name).toBe('player');
    // Both players' entities reach Ben, and nothing else is spawned (the enemies were in the welcome).
    expect(names).toEqual(['player', 'player']);
    expect(ports.texts('a').some((t) => t.t === 'msg' && t.name === 'pong')).toBe(true);
    expect(ports.texts('b').some((t) => t.t === 'msg' && t.name === 'pong')).toBe(false);
    const rows = ports.binaries('b');
    expect(rows.length).toBeGreaterThan(5);
    expect(decodeRows(rows[rows.length - 1], sink)).not.toBeNull();
    room.close('ended');
    await game.disposed;
  }, 60_000);

  it('a steady room of two walking players keeps the retained heap flat', async () => {
    const game = await createEngineRoomGame({ definition: await loadTinyGame(), manifest: MANIFEST, maxPlayers: 4, seed: 7 });
    const ports = new FakePorts();
    const room = createRoom({ code: 'ABCD', game, ports, maxPlayers: 4, sendHz: 20 });
    room.handle('a', hello('Ana'));
    room.handle('b', hello('Ben'));
    const frame = inputFrame(1, blankInput());
    const tick = (): void => {
      room.handle('a', frame);
      room.handle('b', frame);
      ports.advance(1000 / 60);
      ports.sent.clear();
    };
    for (let i = 0; i < 1_000; i += 1) tick();
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 3_000; i += 1) tick();
    gc?.();
    const growth = process.memoryUsage().heapUsed - before;
    // The cmd frames' JSON is per-tick garbage (accepted); without --expose-gc
    // V8 collects when it likes, so the bound is the server loop test's 6 MB.
    expect(growth).toBeLessThan(gc === undefined ? 6 * 1024 * 1024 : 1024 * 1024);
    room.close('ended');
    await game.disposed;
  }, 120_000);
});
