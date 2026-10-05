/**
 * What `gameable()` contributes, as plain data: the sandbox mode and the
 * configuration, pure functions of the options and the Vite command, so they
 * are testable without starting a dev server.
 */

/** Which sandbox the app should build. */
export type GameableMode = 'direct' | 'wasm';

/** Options accepted by {@link gameable}. */
export interface GameableOptions {
  /**
   * Force a sandbox mode instead of deriving one.
   *
   * The derivation, in order: this option, then Vite's own `--mode` when it
   * is `direct` or `wasm`, then `GAMEABLE_MODE` in the environment, then
   * `GAMEABLE_WASM=1`, then `wasm` for `vite build` and `direct` for `vite dev`.
   */
  mode?: GameableMode;
  /**
   * Directory holding the `jco transpile` output, relative to the Vite root.
   * Defaults to `build/guest`, which is where `scripts/build-guest.mjs` writes.
   */
  guestDir?: string;
  /**
   * Path the guest is served from, relative to the app base. Defaults to
   * `guest/`; the transpiled entry is then `guest/game.js`.
   */
  guestBase?: string;
  /**
   * What the guest is built from, relative to the Vite root, for the dev
   * server's stale-guest answer. Defaults to `src/`,
   * `scripts/build-guest.mjs` and the SDK's sources (`guestSources`).
   */
  guestSources?: readonly string[];
  /** Alias bare `three` onto `three/webgpu`. Defaults to true. */
  three?: boolean;
  /**
   * Add the `gameable-source` resolve condition, so the engine's packages resolve to their
   * sources in this repository. Defaults to true.
   */
  source?: boolean;
  /** The old name of {@link source}, from when the condition was `development`. */
  development?: boolean;
  /**
   * Extra package names kept out of the dependency pre-bundle. The wasm
   * runtimes `jolt-physics` and `onnxruntime-web` are always excluded.
   */
  exclude?: readonly string[];
}

/**
 * Extensions never inlined as a `data:` URI.
 *
 * A wasm module inlined as base64 cannot be streamed, and an engine asset
 * inlined into the entry chunk is downloaded before the first frame instead of
 * alongside it.
 */
export const NEVER_INLINED: readonly string[] = [
  '.wasm',
  '.spz',
  '.ply',
  '.splat',
  '.ksplat',
  '.bin',
  '.aosrig',
];

/** Packages whose emscripten glue must not be pre-bundled by esbuild. */
export const ALWAYS_EXCLUDED: readonly string[] = ['jolt-physics', 'onnxruntime-web'];

/** The environment `resolveGameableConfig` reads. */
export interface GameableEnv {
  /** Vite's command: `serve` for dev and preview, `build` for a production build. */
  command: 'serve' | 'build';
  /**
   * Vite's own `--mode`. `direct` and `wasm` select the sandbox, which is how
   * `vite build --mode direct` produces a build that needs no guest component.
   */
  viteMode?: string;
  /** Process environment, for `GAMEABLE_MODE` and `GAMEABLE_WASM`. */
  env?: Record<string, string | undefined>;
  /** The app's public base path, as Vite resolved it. Defaults to `/`. */
  base?: string;
}

/** The configuration `gameable()` contributes, as a plain object. */
export interface GameableConfig {
  /** The sandbox mode the app was built for. */
  mode: GameableMode;
  /** Resolve conditions to add. */
  conditions: string[];
  /** Alias entries to add, in Vite's array form. */
  alias: { find: RegExp; replacement: string }[];
  /** Packages to keep out of the dependency pre-bundle. */
  exclude: string[];
  /** `define` entries, including `import.meta.env.GAMEABLE_MODE`. */
  define: Record<string, string>;
  /** Path the guest is served from, with a leading and trailing slash. */
  guestBase: string;
  /**
   * Where the guest lands inside the build output, relative to `outDir`, with
   * a trailing slash and no leading one. This is `guestBase` minus the app
   * base: an emitted file is named relative to `outDir`, and the base is what
   * the server puts in front of `outDir`, so baking it into the file name
   * would serve the guest from `<base><base>guest/`.
   */
  guestOutDir: string;
  /** URL of the transpiled guest entry, as the app should fetch it. */
  guestUrl: string;
}

/**
 * Decide which sandbox the app is being built for.
 *
 * @param options The plugin options.
 * @param env The Vite command and process environment.
 * @returns The mode.
 *
 * @example
 * ```ts
 * import { resolveGameableMode } from 'gameable/vite';
 *
 * console.log(resolveGameableMode({}, { command: 'serve' })); // 'direct'
 * console.log(resolveGameableMode({}, { command: 'build' })); // 'wasm'
 * ```
 */
export function resolveGameableMode(options: GameableOptions, env: GameableEnv): GameableMode {
  if (options.mode) return options.mode;
  if (env.viteMode === 'direct' || env.viteMode === 'wasm') return env.viteMode;
  const source = env.env ?? {};
  const explicit = source.GAMEABLE_MODE;
  if (explicit === 'direct' || explicit === 'wasm') return explicit;
  if (source.GAMEABLE_WASM === '1') return 'wasm';
  return env.command === 'build' ? 'wasm' : 'direct';
}

/**
 * Normalise a served path into `/thing/` form.
 *
 * @param base The app base.
 * @param guestBase The guest sub-path.
 * @returns A path with one leading and one trailing slash.
 */
function joinBase(base: string, guestBase: string): string {
  const left = base.endsWith('/') ? base : `${base}/`;
  const right = guestBase.replace(/^\/+/, '').replace(/\/*$/, '/');
  return `${left}${right}`;
}

/**
 * Compute everything the plugin contributes, with no Vite involved.
 *
 * @param options The plugin options.
 * @param env The Vite command, process environment and app base.
 * @returns The configuration contribution.
 *
 * @example
 * ```ts
 * import { resolveGameableConfig } from 'gameable/vite';
 *
 * const config = resolveGameableConfig({}, { command: 'serve' });
 * console.log(config.conditions); // ['gameable-source']
 * console.log(config.define['import.meta.env.GAMEABLE_MODE']); // '"direct"'
 * ```
 */
export function resolveGameableConfig(options: GameableOptions, env: GameableEnv): GameableConfig {
  const mode = resolveGameableMode(options, env);
  const guestOutDir = joinBase('/', options.guestBase ?? 'guest/').slice(1);
  const guestBase = joinBase(env.base ?? '/', guestOutDir);
  const guestUrl = `${guestBase}game.js`;
  return {
    mode,
    conditions: (options.source ?? options.development) === false ? [] : ['gameable-source'],
    alias:
      options.three === false
        ? []
        : // Bare `three` must never resolve to `three.module.js`: three's own
          // addons import it, and two copies of `Vector3` break `instanceof`.
          [{ find: /^three$/, replacement: 'three/webgpu' }],
    exclude: [...ALWAYS_EXCLUDED, ...(options.exclude ?? [])],
    define: {
      'import.meta.env.GAMEABLE_MODE': JSON.stringify(mode),
      'import.meta.env.GAMEABLE_GUEST_URL': JSON.stringify(guestUrl),
    },
    guestBase,
    guestOutDir,
    guestUrl,
  };
}
