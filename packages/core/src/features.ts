/**
 * Feature modules: a game declares what it needs, the host loads exactly that.
 *
 * A feature is a name in `defineGame({ features })`. The host owns a table
 * from name to loader; each loader is an `await import(...)` behind a factory
 * call, so a feature nobody declared is never downloaded (ADR 0017).
 */
import type { Engine } from './engine.js';
import type { HeadlessEngine } from './headless.js';
import type { EngineModule } from './module.js';

/**
 * Declared features: name to options. Mirrors `FeatureOptions` in `gameable`.
 *
 * @example
 * ```ts
 * import type { FeatureOptions } from 'gameable/core';
 *
 * const declared: FeatureOptions = { characters: {}, multiplayer: { maxPlayers: 6 } };
 * console.log(Object.keys(declared)); // ['characters', 'multiplayer']
 * ```
 */
export type FeatureOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * What a loader hands back.
 *
 * @example
 * ```ts
 * import type { LoadedFeature } from 'gameable/core';
 *
 * const feature: LoadedFeature = {
 *   name: 'characters',
 *   modules: [],
 *   bind: () => Promise.resolve('ready'),
 * };
 * console.log(feature.name); // 'characters'
 * ```
 */
export interface LoadedFeature {
  /** The feature's name, as declared. */
  readonly name: string;
  /** Modules to register with `createEngine`. May be empty. */
  readonly modules: readonly EngineModule[];
  /**
   * Work that needs the booted engine (a bridge that wants the renderer, say).
   *
   * A feature that needs a renderer narrows with `isRenderEngine` and throws a
   * `FeatureError` when it is bound to a headless engine.
   *
   * @param engine The booted engine, with or without a renderer.
   * @returns Whatever the feature wants the application to hold, keyed by name in `bindFeatures`.
   */
  bind?(engine: Engine | HeadlessEngine): Promise<unknown>;
}

/**
 * Loads one feature.
 *
 * @example
 * ```ts
 * import type { FeatureLoader } from 'gameable/core';
 *
 * const characters: FeatureLoader = () => Promise.resolve({ name: 'characters', modules: [] });
 * console.log(typeof characters); // 'function'
 * ```
 */
export type FeatureLoader = (options: Readonly<Record<string, unknown>>) => Promise<LoadedFeature>;

/**
 * Name to loader. One table per side (page, server).
 *
 * @example
 * ```ts
 * import type { FeatureTable } from 'gameable/core';
 *
 * const table: FeatureTable = {
 *   characters: () => Promise.resolve({ name: 'characters', modules: [] }),
 * };
 * console.log(Object.keys(table)); // ['characters']
 * ```
 */
export type FeatureTable = Readonly<Record<string, FeatureLoader>>;

/**
 * Thrown for an unknown feature name.
 *
 * @example
 * ```ts
 * import { FeatureError, resolveFeatures } from 'gameable/core';
 *
 * try {
 *   await resolveFeatures({ nope: {} }, {});
 * } catch (err) {
 *   if (err instanceof FeatureError) console.log(err.message); // unknown feature "nope"; known: (none)
 * }
 * ```
 */
export class FeatureError extends Error {
  override readonly name = 'FeatureError';
}

/**
 * Load the declared features from a table.
 *
 * @param features The game's declared features (`featuresOf(definition)`).
 * @param table Known features for this side.
 * @returns The loaded features, in declaration order.
 *
 * @example
 * ```ts
 * import { resolveFeatures } from 'gameable/core';
 *
 * const loaded = await resolveFeatures({ characters: {} }, {
 *   characters: async () => ({ name: 'characters', modules: [] }),
 * });
 * console.log(loaded.map((f) => f.name)); // ['characters']
 * ```
 */
export async function resolveFeatures(features: FeatureOptions, table: FeatureTable): Promise<LoadedFeature[]> {
  const out: LoadedFeature[] = [];
  for (const [name, options] of Object.entries(features)) {
    const loader = Object.hasOwn(table, name) ? table[name] : undefined;
    if (loader === undefined) {
      const known = Object.keys(table).sort().join(', ') || '(none)';
      throw new FeatureError(`unknown feature "${name}"; known: ${known}`);
    }
    out.push(await loader(options));
  }
  return out;
}

/**
 * Run every feature's `bind` against the booted engine.
 *
 * @param loaded Features from `resolveFeatures`.
 * @param engine The booted engine, with or without a renderer.
 * @returns Bind results keyed by feature name; features without `bind` are absent.
 *
 * @example
 * ```ts
 * import { bindFeatures, createEngine, resolveFeatures } from 'gameable/core';
 *
 * const loaded = await resolveFeatures({ characters: {} }, {
 *   characters: () => Promise.resolve({ name: 'characters', modules: [], bind: () => Promise.resolve('ready') }),
 * });
 * const engine = await createEngine({
 *   canvas: document.querySelector('canvas')!,
 *   modules: loaded.flatMap((f) => f.modules),
 * });
 * const bound = await bindFeatures(loaded, engine);
 * const characters = bound.get('characters');
 * ```
 */
export async function bindFeatures(
  loaded: readonly LoadedFeature[],
  engine: Engine | HeadlessEngine,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const feature of loaded) {
    if (feature.bind) out.set(feature.name, await feature.bind(engine));
  }
  return out;
}
