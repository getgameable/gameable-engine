/**
 * Fixtures for the `WorldRecord` change tests (`WorldRecord.changes`, `.visual`
 * and `.log`). Tests only; not exported from the package.
 */
import { WorldRecord } from './WorldRecord';

export const origin = { x: 1, y: 2, z: 3 };
export const identity = { x: 0, y: 0, z: 0, w: 1 };
export const unit = { x: 1, y: 1, z: 1 };

/**
 * @param value Any JSON value.
 * @returns How deeply its objects and arrays nest; a scalar is 0.
 */
export function depth(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  let deepest = 0;
  for (const child of children) deepest = Math.max(deepest, depth(child));
  return deepest + 1;
}

/**
 * @returns A world on tick 1 holding entity 5, spawned on tick 1, then moved to tick 2.
 */
export function worldWithFive(): { world: WorldRecord; serial: () => number } {
  const world = new WorldRecord();
  world.advance();
  world.spawn(5, 7, origin, identity, unit, { visible: true });
  world.advance();
  return { world, serial: () => world.get(5)?.serial ?? -1 };
}

/** @returns Bytes of live JS heap, as node reports them; 0 outside node. */
export function heapUsed(): number {
  const proc = (globalThis as { process?: { memoryUsage: () => { heapUsed: number } } }).process;
  return proc === undefined ? 0 : proc.memoryUsage().heapUsed;
}
