/**
 * Body id allocation: the lowest free id first, the counter only when none is free.
 *
 * A freed id goes on a free list (a min-heap), and the next body takes the
 * lowest free id. So the ids a game uses stay under its live body count, which
 * is what the host's fixed body tables (`maxBodies`) hold; a game that spawns
 * and despawns projectiles all session never runs past them. The same code runs
 * in direct and wasm mode, so both hand out the same ids.
 *
 * The list is derived state. The runtime keeps only `nextBody` (saved in
 * snapshots) and the body index (rebuilt on restore). `init` and `restore` call
 * `resetBodyIds`, and the next allocation rebuilds the list from the ids below
 * `nextBody` that no live entity holds, so a restored guest hands out the same
 * ids as the one that took the snapshot and never a live one.
 */
import type { RuntimeState } from './state';

/** One runtime's free ids. */
interface BodyIdPool {
  /** `rt.nextBody` as the pool last left it. */
  next: number;
  /** Free ids below `next`, as a min-heap. */
  readonly heap: number[];
}

const pools = new WeakMap<RuntimeState, BodyIdPool>();

/**
 * @param rt The runtime.
 * @returns Its pool, rebuilt when `nextBody` moved behind its back.
 */
function poolOf(rt: RuntimeState): BodyIdPool {
  let pool = pools.get(rt);
  if (pool === undefined) {
    pool = { next: -1, heap: [] };
    pools.set(rt, pool);
  }
  if (pool.next !== rt.nextBody) rebuild(rt, pool);
  return pool;
}

/**
 * Forget the free list: the next allocation rebuilds it from the live bodies.
 * `init` and `restore` call this once the body index is rebuilt.
 *
 * @param rt The runtime.
 */
export function resetBodyIds(rt: RuntimeState): void {
  pools.delete(rt);
}

/**
 * @param rt The runtime.
 * @param pool Its pool: every id below `nextBody` that no live entity holds is free.
 */
function rebuild(rt: RuntimeState, pool: BodyIdPool): void {
  pool.heap.length = 0;
  const bound = rt.bodyIndex.bodyToEntity;
  // An id past the index cannot be told free from live; it stays out of the list.
  const end = Math.min(rt.nextBody, bound.length);
  for (let id = 1; id < end; id += 1) if (bound[id] === 0) pool.heap.push(id); // ascending: a heap
  pool.next = rt.nextBody;
}

/**
 * @param heap A min-heap.
 * @param value The value to add.
 */
function push(heap: number[], value: number): void {
  let i = heap.length;
  heap.push(value);
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent] <= value) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = value;
}

/**
 * @param heap A non-empty min-heap.
 * @returns Its lowest value, removed.
 */
function pop(heap: number[]): number {
  const top = heap[0];
  const last = heap.pop() as number;
  const n = heap.length;
  if (n === 0) return top;
  let i = 0;
  for (;;) {
    const left = 2 * i + 1;
    if (left >= n) break;
    const right = left + 1;
    const child = right < n && heap[right] < heap[left] ? right : left;
    if (heap[child] >= last) break;
    heap[i] = heap[child];
    i = child;
  }
  heap[i] = last;
  return top;
}

/**
 * The id for a new body: the lowest free one, else `nextBody` (which then moves on).
 *
 * @param rt The runtime.
 * @returns A body id, from 1.
 */
export function allocateBody(rt: RuntimeState): number {
  const pool = poolOf(rt);
  const bound = rt.bodyIndex.bodyToEntity;
  while (pool.heap.length > 0) {
    const free = pop(pool.heap);
    if (free >= bound.length || bound[free] === 0) return free; // a belt: never a live id
  }
  const id = rt.nextBody;
  rt.nextBody += 1;
  pool.next = rt.nextBody;
  return id;
}

/**
 * Free a body id for reuse. Call it while the id is still bound in the body
 * index (before `unbind`), so a rebuild in this call does not list it twice.
 *
 * @param rt The runtime.
 * @param body The id of a body being removed.
 */
export function releaseBody(rt: RuntimeState, body: number): void {
  if (body <= 0 || body >= rt.nextBody) return;
  push(poolOf(rt).heap, body);
}
