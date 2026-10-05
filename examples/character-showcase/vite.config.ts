import { gameable } from 'gameable/vite';
import { defineConfig } from 'vite';

/**
 * The showcase runs on the `gameable()` plugin rather than the hand-written alias block the
 * splat viewer carries, because this app needs everything the plugin already knows:
 *
 * - bare `three` aliased to `three/webgpu` (three's own addons import bare `three`, and
 *   two copies of the core classes make `instanceof Vector3` false);
 * - the `gameable-source` resolve condition, so the workspace packages resolve to `src/`;
 * - `.aosrig` kept out of the asset inliner — a 7.8 MB pack turned into a base64 `data:`
 *   URI is loaded before the first frame instead of alongside it, and `parseAosRig`'s
 *   byte-length check would then be measuring the wrong thing;
 * - `onnxruntime-web` out of the dependency pre-bundle, which matters the moment this
 *   example grows a real decoder path.
 *
 * There is no `assets.json` and no wasm guest here: the character runtime is driven
 * directly, because the thing being proved is the rig -> GPU -> splat chain and a game
 * boundary in the middle would only be one more thing to rule out.
 */
export default defineConfig({
  plugins: [gameable({ mode: 'direct' })],
  server: { port: 5179 },
  preview: { port: 4180 },
  build: {
    // Top-level await in the engine bootstrap; WebGPU is evergreen-only anyway.
    target: 'esnext',
    chunkSizeWarningLimit: 2000,
  },
});
