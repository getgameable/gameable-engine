import { describe, expect, it } from 'vitest';
import type { Command, FrameOutput } from '@gameable/sdk';
import { applyOutput, type ServerAdapter } from '@gameable/wasm-host/server';

import { RowsCodec } from '../../protocol/RowsCodec.js';
import {
  CAMERA,
  move,
  possess,
  rowsOf,
  spawn,
  tags,
  transforms,
  world,
  type Row,
} from './replicatorTesting.js';
import { SendBuffer } from './SendBuffer.js';

describe('Replicator: per-player output', () => {
  it("a player's HUD and camera reach only that player", () => {
    const { replicator, step } = world();
    replicator.add(1);
    replicator.add(2);
    step([
      { tag: 'set-player-hud', val: { player: 2, hud: '{"hp":3}' } },
      { tag: 'set-player-camera', val: { player: 2, camera: { ...CAMERA, fovYDeg: 50 } } },
    ]);
    expect(replicator.viewFor(1).commands).toEqual([]);
    const two = replicator.viewFor(2).commands;
    expect(tags(two)).toEqual(['set-player-camera', 'set-player-hud']);
    expect(two[0]).toMatchObject({ val: { player: 2, camera: { fovYDeg: 50 } } });
    expect(two[1]).toEqual({ tag: 'set-player-hud', val: { player: 2, hud: '{"hp":3}' } });
    // The same HUD again is no change.
    step([{ tag: 'set-player-hud', val: { player: 2, hud: '{"hp":3}' } }]);
    expect(replicator.viewFor(2).commands).toEqual([]);
  });

  it('a send to 2 reaches 2 only; a broadcast reaches everyone; both as messages', () => {
    const { replicator, step } = world();
    replicator.add(1);
    replicator.add(2);
    step([
      { tag: 'send', val: { to: 2, name: 'pong', payload: '{"n":1}', reliable: true } },
      { tag: 'send', val: { name: 'round', payload: '{"r":2}', reliable: true } },
    ]);
    const one = replicator.viewFor(1);
    const two = replicator.viewFor(2);
    expect(one.messages).toEqual([{ name: 'round', payload: '{"r":2}' }]);
    expect(two.messages).toEqual([
      { name: 'pong', payload: '{"n":1}' },
      { name: 'round', payload: '{"r":2}' },
    ]);
    expect(tags(one.commands)).not.toContain('send');
    expect(tags(two.commands)).not.toContain('send');
  });

  it('one-shots go to players who know the entity, or to all when unattached', () => {
    const { replicator, step } = world({ cullDistance: 10 });
    replicator.add(1);
    replicator.add(2);
    step([spawn(20), spawn(30, { x: 50 })]);
    step([possess(1, 20), possess(2, 30)]);
    replicator.viewFor(1);
    replicator.viewFor(2);
    step([
      { tag: 'say', val: { entity: 30, text: 'far away' } },
      { tag: 'stop-sound', val: { sound: 1, fadeMs: 0 } },
    ]);
    expect(tags(replicator.viewFor(1).commands)).toEqual(['stop-sound']);
    expect(tags(replicator.viewFor(2).commands)).toEqual(['say', 'stop-sound']);
  });
});

describe('Replicator: relevancy', () => {
  it('cullDistance 10: an entity 50 m away is not in the view, and comes and goes with range', () => {
    const { replicator, step } = world({ cullDistance: 10 });
    step([spawn(20), spawn(30, { x: 50 })]);
    replicator.add(2);
    step([possess(2, 20)]);
    const first = replicator.viewFor(2);
    expect(first.commands.map((c) => c.tag === 'spawn' && c.val.entity)).toEqual([20]);
    expect(rowsOf(first.takeRows()).map(([e]) => e)).not.toContain(30);
    step([], [move(30, 5)]);
    const near = replicator.viewFor(2);
    expect(tags(near.commands)).toEqual(['spawn']);
    expect(near.commands[0]).toMatchObject({ val: { entity: 30, position: { x: 5 } } });
    step([], [move(30, 60)]);
    expect(replicator.viewFor(2).commands).toEqual([{ tag: 'despawn', val: 30 }]);
    step([], [move(30, 61)]);
    expect(replicator.viewFor(2).commands).toEqual([]);
    expect(rowsOf(replicator.viewFor(2).takeRows()).map(([e]) => e)).not.toContain(30);
  });

  it('a child goes with its root ancestor', () => {
    const { replicator, step } = world({ cullDistance: 10 });
    step([spawn(20), spawn(30, { x: 50 }), spawn(31, { parent: 30 })]);
    replicator.add(2);
    step([possess(2, 20)]);
    expect(replicator.viewFor(2).commands.map((c) => c.tag === 'spawn' && c.val.entity)).toEqual([20]);
  });
});

describe('Replicator: the welcome snapshot', () => {
  it('holds the relevant entities, parents first, and the camera and HUD of that player', () => {
    const { replicator, step } = world({ cullDistance: 10 });
    replicator.add(2);
    step([spawn(11), spawn(12), spawn(20), spawn(30, { x: 50 })]);
    step([
      { tag: 'set-parent', val: { entity: 11, parent: 12, keepWorldTransform: false } },
      { tag: 'set-player-hud', val: { player: 2, hud: '{"hp":3}' } },
      possess(2, 20),
    ]);
    const snapshot = JSON.parse(replicator.snapshotFor(2)) as {
      frame: number;
      entities: { entity: number; parent?: number }[];
      hud?: string;
    };
    expect(snapshot.entities.map((e) => e.entity)).toEqual([12, 11, 20]);
    expect(snapshot.entities[1].parent).toBe(12);
    expect(snapshot.hud).toBe('{"hp":3}');
    expect(snapshot.frame).toBe(2);
    // The view now starts from the snapshot: nothing is introduced twice.
    step();
    expect(replicator.viewFor(2).commands).toEqual([]);
  });
});

describe('Replicator: allocation', () => {
  it('the rows path (collect, take rows, encode into the send buffer) keeps the heap flat', () => {
    const { replicator, step } = world();
    replicator.add(1);
    replicator.add(2);
    const spawns: Command[] = [];
    for (let e = 1; e <= 32; e += 1) spawns.push(spawn(e));
    step(spawns);
    replicator.viewFor(1);
    replicator.viewFor(2);
    const rows: Row[] = [];
    for (let e = 1; e <= 32; e += 1) rows.push(move(e, 0));
    const buffer = transforms(rows);
    const adapter = (replicator as unknown as { adapter: ServerAdapter }).adapter;
    const out: FrameOutput = { transforms: buffer, localCommands: [], commands: [], camera: CAMERA, hud: undefined };
    const codec = new RowsCodec();
    const send = new SendBuffer();
    let sum = 0;
    const tick = (i: number): void => {
      for (let r = 0; r < 32; r += 1) buffer[r * 12 + 2] = (i % 100) * 0.01 + r;
      adapter.beginTick();
      applyOutput(adapter, out);
      replicator.collect();
      for (let player = 1; player <= 2; player += 1) {
        const view = replicator.viewFor(player);
        const source = view.takeRows();
        const bytes = codec.encode(send.reserve(codec.frameBytes(source)), view.frame, 0, source);
        sum += send.bytes(bytes).length;
      }
    };
    for (let i = 0; i < 2_000; i += 1) tick(i);
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 20_000; i += 1) tick(i);
    gc?.();
    const growth = process.memoryUsage().heapUsed - before;
    expect(sum).toBeGreaterThan(0);
    // Without --expose-gc V8 collects when it likes and the young generation alone
    // swings by ~5 MB (observed 4.8 MB once), so the bound is loose; with it, 256 KB.
    expect(growth).toBeLessThan(gc === undefined ? 8 * 1024 * 1024 : 256 * 1024);
  });
});
