/**
 * The `gameable()` Vite plugin.
 *
 * An gameable app needs half a dozen unrelated pieces of Vite configuration
 * before it renders anything, and every one of them fails in a way that looks
 * like something else:
 *
 * | Setting | What goes wrong without it |
 * | --- | --- |
 * | `resolve.conditions: ['gameable-source']` | Workspace packages resolve to an unbuilt `dist/` |
 * | bare `three` aliased to `three/webgpu` | Two three singletons; `instanceof Vector3` is false |
 * | `optimizeDeps.exclude` for the wasm runtimes | esbuild rewrites the emscripten glue and the module never instantiates |
 * | `.wasm` never inlined, served as `application/wasm` | `WebAssembly.instantiateStreaming` refuses the response |
 * | `import.meta.env.GAMEABLE_MODE` | The app cannot tell which sandbox to build |
 * | `dist/guest/**` | The shipped build has no game module |
 *
 * The plugin is deliberately declarative: {@link resolveGameableConfig} is a pure
 * function of the options and the Vite command, and the plugin object is a
 * thin wrapper around it. That is what makes the behaviour testable without
 * starting a dev server.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, posix, resolve as resolvePath } from 'node:path';

import { defaultClientConditions } from 'vite';

import {
  ALWAYS_EXCLUDED,
  NEVER_INLINED,
  resolveGameableConfig,
  resolveGameableMode,
  type GameableConfig,
  type GameableEnv,
  type GameableMode,
  type GameableOptions,
} from './config';
import { guestSources, guestStatusMiddleware } from './guestStatus';

export { ALWAYS_EXCLUDED, NEVER_INLINED, resolveGameableConfig, resolveGameableMode };
export type { GameableConfig, GameableEnv, GameableMode, GameableOptions };

/**
 * Every file under a directory, as paths relative to it, forward-slashed.
 *
 * @param dir Absolute directory.
 * @param prefix Accumulated relative prefix.
 * @returns Relative paths, sorted for a deterministic bundle.
 */
function walk(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Content types the dev middleware sets explicitly. */
const MIME: Readonly<Record<string, string>> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.ts': 'text/javascript',
};

/**
 * The shape of the Vite plugin object this package produces.
 *
 * Typed structurally rather than as Vite's `Plugin` so the package carries no
 * runtime or type dependency on a particular Vite major; a real Vite accepts
 * it because every member matches.
 */
export interface GameableVitePlugin {
  /** Plugin name, as it appears in Vite's logs. */
  name: string;
  /** Run before Vite's own resolution, so the alias and conditions win. */
  enforce?: 'pre' | 'post';
  /**
   * Contribute configuration.
   *
   * @param config The user's configuration so far.
   * @param env Vite's command and mode.
   * @returns A partial configuration Vite deep-merges.
   */
  config?(
    config: Record<string, unknown>,
    env: { command: 'serve' | 'build'; mode?: string },
  ): unknown;
  /**
   * Record the base Vite resolved, so the guest URL is right under a sub-path.
   *
   * @param config The resolved configuration.
   */
  configResolved?(config: { base?: string; root?: string }): void;
  /**
   * Install the dev middlewares.
   *
   * @param server The dev server.
   */
  configureServer?(server: { middlewares: { use: (fn: DevMiddleware) => void } }): void;
  /**
   * Emit the transpiled guest into the build.
   *
   * @param this The Rollup plugin context, for `emitFile`.
   */
  generateBundle?(this: EmitContext): void;
}

/** The slice of a connect middleware the plugin uses. */
export type DevMiddleware = (
  req: { url?: string },
  res: {
    setHeader(name: string, value: string): void;
    statusCode: number;
    end(chunk?: unknown): void;
  },
  next: () => void,
) => void;

/** The slice of the Rollup plugin context the plugin uses. */
export interface EmitContext {
  /**
   * Emit one asset into the build.
   *
   * @param asset The asset descriptor.
   */
  emitFile(asset: { type: 'asset'; fileName: string; source: Uint8Array | string }): void;
  /**
   * Report a build-time warning.
   *
   * @param message What to say.
   */
  warn(message: string): void;
}

/**
 * The gameable Vite plugin.
 *
 * Add it to `plugins` and the app resolves workspace packages from source,
 * gets exactly one `three`, keeps the wasm runtimes out of the pre-bundle,
 * serves `.wasm` correctly, and learns which sandbox to build through
 * `import.meta.env.GAMEABLE_MODE`.
 *
 * @param options Mode override, guest directory and the opt-outs.
 * @returns A Vite plugin.
 *
 * @example
 * ```ts
 * import { gameable } from 'gameable/vite';
 * import { defineConfig } from 'vite';
 *
 * export default defineConfig({ plugins: [gameable()] });
 * ```
 */
export function gameable(options: GameableOptions = {}): GameableVitePlugin {
  let root = process.cwd();
  let mode: GameableMode | undefined;
  let resolved = resolveGameableConfig(options, { command: 'serve', env: process.env });

  /**
   * Absolute path of the transpiled guest directory.
   *
   * @returns The directory, which may not exist yet.
   */
  function guestDir(): string {
    return resolvePath(root, options.guestDir ?? 'build/guest');
  }

  return {
    name: 'gameable',
    // Before Vite's own resolve plugin, or the `three` alias never applies.
    enforce: 'pre',

    config(config, env) {
      resolved = resolveGameableConfig(options, {
        command: env.command,
        viteMode: env.mode,
        env: process.env,
        base: typeof config.base === 'string' ? config.base : '/',
      });
      mode = resolved.mode;
      return {
        resolve: {
          // A plugin's `resolve.conditions` replaces Vite's defaults (Vite 6+),
          // so keep them: without `browser`, a dependency with a browser build
          // (`ws`, under `@colyseus/sdk`) resolves to its Node build in the page.
          conditions: [...resolved.conditions, ...defaultClientConditions],
          alias: resolved.alias,
        },
        optimizeDeps: { exclude: resolved.exclude },
        define: resolved.define,
        build: {
          // Top-level await in the engine bootstrap; WebGPU is evergreen anyway.
          target: 'esnext',
          // A wasm module inlined as a base64 data URI cannot be streamed, and
          // an engine asset inlined into the entry chunk delays the first frame.
          assetsInlineLimit: (filePath: string): boolean | undefined =>
            NEVER_INLINED.some((extension) => filePath.endsWith(extension)) ? false : undefined,
        },
      };
    },

    configResolved(config) {
      if (typeof config.root === 'string') root = config.root;
      // Keep whatever `config` decided: `configResolved` has no `command`, and
      // re-deriving here would turn every build back into a dev build.
      resolved = resolveGameableConfig(
        { ...options, mode: mode ?? resolved.mode },
        { command: 'serve', env: process.env, base: config.base ?? '/' },
      );
    },

    configureServer(server) {
      const dir = guestDir();
      const base = resolved.guestBase;
      // Play Solo's authority runs the built guest even in dev: say when it is stale.
      server.middlewares.use(
        guestStatusMiddleware(() => ({
          guestEntry: join(guestDir(), 'game.js'),
          sources:
            options.guestSources?.map((path) => resolvePath(root, path)) ?? guestSources(root),
        })),
      );

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        const path = url.split('?')[0];

        // 1. The transpiled guest, straight off disk. It is a build output, so
        //    Vite's module graph must not try to transform it.
        if (path.startsWith(base)) {
          const relative = path.slice(base.length);
          const file = resolvePath(dir, relative);
          // Refuse to escape the guest directory.
          if (file.startsWith(dir) && existsSync(file) && statSync(file).isFile()) {
            res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(readFileSync(file));
            return;
          }
        }

        // 2. Anything else ending in .wasm gets the right type, whatever
        //    served it. `instantiateStreaming` rejects every other type.
        if (path.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
        next();
      });
    },

    generateBundle() {
      // Direct builds ship the guest too when there is one: a multiplayer
      // game's Play Solo runs its authority as the wasm guest in every mode.
      const dir = guestDir();
      const files = walk(dir);
      if (files.length === 0) {
        this.warn(
          resolved.mode === 'wasm'
            ? `gameable: no transpiled guest in ${dir}. Run \`npm run build:guest\` before ` +
                '`vite build`, or build in direct mode with GAMEABLE_MODE=direct.'
            : `gameable: no transpiled guest in ${dir}, so this direct build has none. A ` +
                "multiplayer game's Play Solo needs it: run `npm run build:guest` first. A " +
                'single-player game can ignore this.',
        );
        return;
      }
      for (const file of files) {
        this.emitFile({
          type: 'asset',
          fileName: posix.join(resolved.guestOutDir, file),
          source: readFileSync(join(dir, file)),
        });
      }
    },
  };
}
