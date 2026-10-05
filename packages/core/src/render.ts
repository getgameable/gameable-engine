/**
 * `gameable/core/render`: the sRGB splat pass on its own, for an app that draws with its own
 * three.js loop and wants nothing else from the engine (no asset loaders, no wasm decoders).
 *
 * @example
 * ```ts
 * import { attachSrgbPass } from 'gameable/core/render';
 * attachSrgbPass(renderer, scene); // then renderer.render(scene, camera) as usual
 * ```
 */
export { attachSrgbPass, isSrgbPassMember, SRGB_PASS_LAYER } from './render/srgbPass.js';
export type { SrgbPass, SrgbPassMember, SrgbPassOptions } from './render/srgbPass.js';
