/**
 * `isRenderEngine` — tell an engine with a renderer from a headless one.
 *
 * Type-only imports: the guard loads no three.js, so server code can call it.
 */
import type { Engine } from '../engine.js';
import type { HeadlessEngine } from '../headless.js';

/**
 * Whether an engine has a renderer (it came from `createEngine`, not `createHeadlessEngine`).
 *
 * @param engine Either kind of engine.
 * @returns `true` for an engine with a scene, camera and renderer.
 *
 * @example
 * ```ts
 * import { createHeadlessEngine, isRenderEngine } from 'gameable/core';
 *
 * const engine = await createHeadlessEngine();
 * console.log(isRenderEngine(engine)); // false
 * await engine.dispose();
 * ```
 */
export function isRenderEngine(engine: Engine | HeadlessEngine): engine is Engine {
  return 'renderer' in engine;
}
