/**
 * Helpers for the replicator's tests: a real server adapter over a physics
 * stand-in, stepped with `applyOutput` the way a server loop steps it.
 * Not exported from the package.
 */
import type { PhysicsService } from '@gameable/physics-jolt';
import { TRANSFORM_FLAGS } from '@gameable/sdk';
import type { CameraState, Command, FrameOutput } from '@gameable/sdk';
import { applyOutput, createServerAdapter, type ServerAdapter } from '@gameable/wasm-host/server';

import type { RowSource } from '../../protocol/types.js';
import { Replicator } from './Replicator.js';

/** @returns A physics stand-in that accepts every call. */
export function fakePhysics(): PhysicsService {
  const nothing = (): void => undefined;
  return {
    addBody: nothing,
    removeBody: nothing,
    setTransform: nothing,
    setVelocity: nothing,
    applyImpulse: nothing,
    setEnabled: nothing,
    moveCharacter: nothing,
    groundState: () => 'on-ground',
  } as never;
}

export const CAMERA: CameraState = {
  mode: 'first-person',
  projection: 'perspective',
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  target: undefined,
  fovYDeg: 75,
  near: 0.1,
  far: 1000,
  follow: undefined,
  armLength: 0,
  offset: { x: 0, y: 0, z: 0 },
};

export interface Row {
  entity: number;
  flags: number;
  at?: [number, number, number];
}

/**
 * @param rows The rows to pack.
 * @returns Stride-12 transform rows.
 */
export function transforms(rows: Row[]): Float32Array {
  const out = new Float32Array(Math.max(1, rows.length) * 12);
  rows.forEach((row, i) => {
    const o = i * 12;
    out[o] = row.entity;
    out[o + 1] = row.flags;
    const at = row.at ?? [0, 0, 0];
    out.set(at, o + 2);
    out.set([0, 0, 0, 1], o + 5);
    out.set([1, 1, 1], o + 9);
  });
  return out;
}

export const spawn = (
  entity: number,
  options: { x?: number; parent?: number; visible?: boolean; asset?: number } = {},
): Command => ({
  tag: 'spawn',
  val: {
    entity,
    asset: options.asset ?? 7,
    position: { x: options.x ?? 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    visible: options.visible ?? true,
  },
});

/**
 * @param player The player.
 * @param entity The entity they now control.
 * @returns The guest's `set-player-entity` for it.
 */
export const possess = (player: number, entity: number): Command => ({
  tag: 'set-player-entity',
  val: { player, entity },
});

export const move = (entity: number, x: number): Row => ({
  entity,
  flags: TRANSFORM_FLAGS.POSITION,
  at: [x, 0, 0],
});

/**
 * @param options Relevancy for the replicator.
 * @param options.cullDistance Metres, or none.
 * @returns A server adapter, a replicator over it, and `step`: one tick applied, then collected.
 */
export function world(options: { cullDistance?: number } = {}): {
  adapter: ServerAdapter;
  replicator: Replicator;
  step: (commands?: Command[], rows?: Row[], local?: Command[]) => void;
} {
  const adapter = createServerAdapter(fakePhysics(), { warn: () => undefined });
  const replicator = new Replicator(adapter, options);
  const step = (commands: Command[] = [], rows: Row[] = [], local: Command[] = []): void => {
    adapter.beginTick();
    const out: FrameOutput = {
      transforms: transforms(rows),
      localCommands: local,
      commands,
      camera: CAMERA,
      hud: undefined,
    };
    applyOutput(adapter, out);
    replicator.collect();
  };
  return { adapter, replicator, step };
}

/**
 * @param rows A row source.
 * @returns The rows as `[entity, flags]` pairs.
 */
export function rowsOf(rows: RowSource): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < rows.count; i += 1) out.push([rows.entity(i), rows.flags(i)]);
  return out;
}

export const tags = (commands: readonly Command[]): string[] => commands.map((c) => c.tag);

