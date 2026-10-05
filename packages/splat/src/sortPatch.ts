/**
 * One compute pass per splat sort, for three's own `GaussianSplat` and for the fork alike.
 *
 * three r186's `CountingSort#compute` calls `renderer.compute` once per pass — reset,
 * histogram, prefix, scatter — and `WebGPUBackend.beginCompute`/`finishCompute` build one
 * command encoder and one compute pass per call and `submit` at the end of each. So every
 * sort costs four encoders and four queue submissions, per splat, per frame it sorts.
 * `Renderer.compute` has accepted an array for a long time (`Array.isArray( computeNodes )`,
 * `Renderer.js:2916`) and runs every node inside one pass, and dispatches inside one WebGPU
 * compute pass are ordered with memory visibility between them, so batching the four keeps
 * every dependency the sort had.
 *
 * Upstream exposes no batched entry point, and the static arena splat is three's own class,
 * not the fork — so the fix is a prototype patch, applied once, exactly like
 * `initWebGPUPatches()` in `gameable/core`. It is additive and defensive: if any of the
 * four private nodes is missing (a three upgrade, `setBinNode` never called) the original
 * four-call `compute` runs instead, so the sort can degrade but never silently skip.
 */
import { CountingSort } from 'three/addons/gpgpu/CountingSort.js';

/** Marker kept on the patched prototype, so the patch is applied at most once. */
const PATCH_STATE = Symbol.for('gameable.splat.countingSortPatch');

/** The private pass nodes the patch reads off a sort instance. */
interface SortWithNodes {
  _resetNode?: object | null;
  _histogramNode?: object | null;
  _prefixNode?: object | null;
  _scatterNode?: object | null;
}

/** The slice of the renderer the patch calls. */
interface ComputeRenderer {
  compute(nodes: object | object[]): unknown;
}

/** The prototype surface the patch wraps. */
interface PatchablePrototype {
  compute(this: SortWithNodes, renderer: ComputeRenderer): void;
  [PATCH_STATE]?: (this: SortWithNodes, renderer: ComputeRenderer) => void;
}

/**
 * Patch `CountingSort.prototype.compute` so a sort is one `renderer.compute([...])` call.
 *
 * Idempotent. `gameable/splat` applies it from the `splat()` module's `init`, from
 * `createSplatObject` and from `createAnimatedSplat`, so a game never has to; it is exported
 * for hosts that build splats some other way.
 *
 * @param target Prototype to patch. Tests pass a fake; production never sets it.
 * @returns True when the prototype carries the patch after the call.
 *
 * @example
 * ```ts
 * import { initCountingSortPatch } from 'gameable/splat';
 *
 * initCountingSortPatch(); // before the first frame that sorts a splat
 * ```
 */
export function initCountingSortPatch(target?: object): boolean {
  const proto = (target ?? CountingSort.prototype) as PatchablePrototype;
  if (proto[PATCH_STATE] !== undefined) return true;
  // Deliberately unbound: the patch re-invokes it with `.call(this)` so each sort keeps its
  // own `this`. That is what a prototype patch is.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = proto.compute;
  if (typeof original !== 'function') return false;

  proto.compute = function batchedCompute(this: SortWithNodes, renderer: ComputeRenderer) {
    const reset = this._resetNode;
    const histogram = this._histogramNode;
    const prefix = this._prefixNode;
    const scatter = this._scatterNode;
    if (!reset || !histogram || !prefix || !scatter) {
      original.call(this, renderer);
      return;
    }
    renderer.compute([reset, histogram, prefix, scatter]);
  };
  Object.defineProperty(proto, PATCH_STATE, {
    value: original,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return true;
}

/**
 * Whether a prototype already carries the counting-sort patch.
 *
 * @param target Prototype to check. Defaults to `CountingSort.prototype`.
 * @returns True when {@link initCountingSortPatch} has run against it.
 *
 * @example
 * ```ts
 * import { initCountingSortPatch, isCountingSortPatched } from 'gameable/splat';
 *
 * initCountingSortPatch();
 * console.log(isCountingSortPatched()); // true
 * ```
 */
export function isCountingSortPatched(target?: object): boolean {
  const proto = (target ?? CountingSort.prototype) as PatchablePrototype;
  return proto[PATCH_STATE] !== undefined;
}
