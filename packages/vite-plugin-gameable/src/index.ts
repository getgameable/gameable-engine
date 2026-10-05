/**
 * `gameable/vite` — the one plugin every gameable app adds.
 *
 * It sets the `gameable-source` resolve condition, collapses bare `three` onto
 * `three/webgpu`, keeps the wasm runtimes out of the dependency pre-bundle,
 * serves `.wasm` as `application/wasm`, publishes `import.meta.env.GAMEABLE_MODE`
 * and `import.meta.env.GAMEABLE_GUEST_URL`, and copies the transpiled guest into
 * the production build (in direct mode too, for a multiplayer game's Play
 * Solo). Under `npm run dev` it answers whether the built guest is stale.
 *
 * @example
 * ```ts
 * import { gameable } from 'gameable/vite';
 * import { defineConfig } from 'vite';
 *
 * export default defineConfig({ plugins: [gameable()] });
 * ```
 */

export {
  ALWAYS_EXCLUDED,
  gameable,
  NEVER_INLINED,
  resolveGameableConfig,
  resolveGameableMode,
} from './plugin';
export { GUEST_STATUS_PATH, guestFreshness, guestSources, type GuestStatus } from './guestStatus';
export type {
  GameableConfig,
  GameableEnv,
  GameableMode,
  GameableOptions,
  GameableVitePlugin,
  DevMiddleware,
  EmitContext,
} from './plugin';

/**
 * Package identity marker for `gameable/vite`.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/vite';
 *
 * console.log(PACKAGE); // 'gameable/vite'
 * ```
 */
export const PACKAGE = 'gameable/vite' as const;
