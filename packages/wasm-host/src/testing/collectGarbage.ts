/**
 * Heap readings for the steady-state allocation tests. Test-only: nothing in
 * the package imports this, and no build entry reaches it.
 *
 * @module
 */

/** The slice of node this file reaches without the node type definitions. */
interface NodeBuiltins {
  getBuiltinModule(id: 'v8'): { setFlagsFromString(flags: string): void };
  getBuiltinModule(id: 'vm'): { runInNewContext(code: string): unknown };
}

/**
 * Force a garbage collection, so a heap reading measures retained bytes rather
 * than whatever V8 has not swept yet.
 *
 * `--expose-gc` is not on in the default vitest run, so `globalThis.gc` is
 * undefined there and the flag is turned on just long enough to pull `gc` out
 * of a fresh context, as `Animator.test.ts` does. Without it a heap delta
 * reads uncollected garbage, which on a laptop crossed even a 6 MB bound.
 * The modules come from `process.getBuiltinModule` because this package is
 * typed for the browser and has no `node:` imports.
 *
 * @throws {Error} When no collector can be obtained.
 */
export function collectGarbage(): void {
  const exposed = (globalThis as { gc?: () => void }).gc;
  if (typeof exposed === 'function') {
    exposed();
    return;
  }
  const proc = (globalThis as { process?: Partial<NodeBuiltins> }).process;
  if (proc?.getBuiltinModule === undefined) throw new Error('heap readings need node');
  const v8 = proc.getBuiltinModule('v8');
  v8.setFlagsFromString('--expose-gc');
  const fn = proc.getBuiltinModule('vm').runInNewContext('gc');
  v8.setFlagsFromString('--no-expose-gc');
  // A heap delta without a collection is the noise this exists to remove.
  if (typeof fn !== 'function') throw new Error('could not obtain gc for a heap reading');
  (fn as () => void)();
}

/**
 * Bytes of live JS heap after a full collection.
 *
 * @returns `heapUsed` once everything unreachable has been swept.
 */
export function retainedHeap(): number {
  collectGarbage();
  const proc = (globalThis as { process?: { memoryUsage(): { heapUsed: number } } }).process;
  if (proc === undefined) throw new Error('heap readings need node');
  return proc.memoryUsage().heapUsed;
}
