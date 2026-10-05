/// <reference types="node" />
/**
 * The predict path allocates nothing per step: record a step, decode a rows
 * frame's trailer, compare it, and snap and replay ten steps every other
 * trailer. The physics world is a stand-in that integrates by hand, so the
 * window measures this package's code and not Jolt's glue.
 */
import type { PhysicsService } from '@gameable/physics-jolt';
import type { Command } from '@gameable/sdk';
import { describe, expect, it } from 'vitest';

import { RowsCodec } from '../protocol/RowsCodec.js';
import type { PlayerRow, RowSink } from '../protocol/types.js';
import type { ClientLoopAdapter } from './ClientLoopAdapter.js';
import { LocalIds } from './LocalIds.js';
import type { NetService } from './NetService.js';
import { Predictor } from './Predictor.js';
import { WALKER_BODY } from './predictTesting.js';

/** @returns Bytes of JS heap in use, after a full GC when the runner exposes one. */
function heapUsed(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed;
}

const DT = 1 / 60;

/** A one-body world: position integrates the desired velocity. */
function fakeWorld(): PhysicsService & { at: Float64Array; desired: Float64Array } {
  const at = new Float64Array(3);
  const desired = new Float64Array(3);
  return {
    at,
    desired,
    readBodyPose: (_id: number, out: Float32Array, offset: number) => {
      out[offset] = at[0];
      out[offset + 1] = at[1];
      out[offset + 2] = at[2];
      out[offset + 6] = 1;
      return true;
    },
    setTransform: (_id: number, p: ArrayLike<number>) => {
      at[0] = p[0];
      at[1] = p[1];
      at[2] = p[2];
    },
    setVelocity: () => undefined,
    step: () => {
      for (let i = 0; i < 3; i += 1) at[i] += desired[i] * DT;
      return 0;
    },
  } as unknown as PhysicsService & { at: Float64Array; desired: Float64Array };
}

describe('Predictor: allocation', () => {
  it('records, decodes trailers, corrects and replays with a flat heap', () => {
    const world = fakeWorld();
    const adapter = {
      addBody: () => undefined,
      removeBody: () => undefined,
      moveCharacter: (_body: number, v: { x: number; y: number; z: number }) => {
        world.desired[0] = v.x;
        world.desired[1] = v.y;
        world.desired[2] = v.z;
      },
      setTransformFromHost: () => undefined,
    } as unknown as ClientLoopAdapter;
    const net = { localEntity: 9, stats: { corrections: 0 } } as unknown as NetService;
    const predictor = new Predictor(adapter, net, world, DT);
    const ids = new LocalIds(4096);
    predictor.command({ tag: 'add-body', val: WALKER_BODY(1, 1) }, ids);
    const move: Command = {
      tag: 'move-character',
      val: {
        body: 1,
        desiredVelocity: { x: 0, y: 0, z: -4 },
        jump: false,
        crouch: false,
        maxSlopeDeg: 45,
      },
    };
    // The trailer travels as a real rows frame, decoded into a reused sink.
    const codec = new RowsCodec();
    const trailer = {
      entity: 9,
      position: new Float32Array(3),
      velocity: new Float32Array([0, 0, -4]),
      flags: 0,
    };
    const source = {
      count: 0,
      entity: () => 0,
      flags: () => 0,
      position: () => [],
      rotation: () => [],
      scale: () => [],
      player: trailer,
    };
    const out = new DataView(new ArrayBuffer(codec.frameBytes(source)));
    const bytes = new Uint8Array(out.buffer);
    const sink: RowSink = {
      position: new Float32Array(3),
      rotation: new Float32Array(4),
      scale: new Float32Array(3),
      row: () => undefined,
      player: (row: PlayerRow) => {
        predictor.trailer(row);
      },
    };
    const history = new Float64Array(1 << 16);
    let seq = 0;
    const step = (): void => {
      predictor.reconcile();
      seq += 1;
      predictor.open(seq);
      predictor.command(move, ids);
      world.step(DT);
      predictor.stepped();
      history[seq & 0xffff] = world.at[2];
      if (seq % 5 === 0 && seq > 10) {
        const answered = seq - 10;
        trailer.position[2] = history[answered & 0xffff] + (seq % 10 === 0 ? 0.5 : 0);
        codec.encode(out, seq, answered, source);
        codec.decode(bytes, sink);
      }
    };
    for (let i = 0; i < 2_000; i += 1) step();
    const growth: number[] = [];
    for (let w = 0; w < 5; w += 1) {
      const before = heapUsed();
      for (let i = 0; i < 20_000; i += 1) step();
      growth.push(heapUsed() - before);
    }
    growth.sort((a, b) => a - b);
    // A fresh array per step would be ~32 bytes x 20,000, about 640 KB a window.
    expect(growth[2]).toBeLessThan(100_000);
    // The offsets really were corrected: every other trailer, from the first window on.
    expect(net.stats.corrections).toBeGreaterThan(10_000);
  });
});
