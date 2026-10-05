/**
 * The asset registry: string ids in, loaded objects out.
 *
 * Ids are the guest/host contract, so the registry is the only place that knows
 * a URL. Handles are stable, 1-based `u32`s assigned in manifest order, which is
 * what crosses the wasm boundary; `0` means "no asset".
 */
import type { AssetEntry, AssetManifest } from './manifest.js';
import { resolveAssetUrl } from './manifest.js';

/** Everything a loader is given besides the URL. */
export interface AssetLoaderContext {
  /** The manifest the entry came from. */
  readonly manifest: AssetManifest;
  /** The registry doing the loading, for loaders that need sibling assets. */
  readonly registry: AssetRegistry;
  /** Abort signal, when the caller supplied one. */
  readonly signal?: AbortSignal;
}

/**
 * Turns one asset entry into a loaded object.
 *
 * One loader is registered per {@link AssetEntry.type}. What it resolves to is
 * the loader's business: `gltf` yields a `GLTF`, `audio` an `ArrayBuffer`,
 * `splat` and `character` whatever their packages define.
 */
export type AssetLoader = (
  url: string,
  entry: AssetEntry,
  ctx: AssetLoaderContext,
) => Promise<unknown>;

/** Loaders keyed by asset type. */
export type AssetLoaderMap = Readonly<Record<string, AssetLoader>>;

/** One step of a {@link AssetRegistry.preload} run. */
export interface AssetProgress {
  /** Id that just finished. */
  readonly id: string;
  /** Entries finished so far, including failures. */
  readonly loaded: number;
  /** Entries in this run. */
  readonly total: number;
  /** Whether the entry loaded successfully. */
  readonly ok: boolean;
  /** The failure, when `ok` is false. */
  readonly error?: unknown;
}

/** Options accepted by {@link createAssetRegistry}. */
export interface CreateAssetRegistryOptions {
  /** The validated manifest. */
  readonly manifest: AssetManifest;
  /** Loaders by asset type. More can be added later with `registerLoader`. */
  readonly loaders?: AssetLoaderMap;
  /** Abort signal handed to every loader. */
  readonly signal?: AbortSignal;
}

/** Resolves ids to handles, entries, URLs and loaded objects. */
export interface AssetRegistry {
  /** The manifest this registry was built from. */
  readonly manifest: AssetManifest;
  /** Every declared id, in manifest order. */
  readonly ids: readonly string[];

  /**
   * The stable handle for an id.
   *
   * @param id Asset id.
   * @returns A 1-based handle, or `0` when the id is not declared.
   */
  resolve(id: string): number;

  /**
   * The id behind a handle.
   *
   * @param handle Handle from `resolve`.
   * @returns The id, or `undefined` for `0` and out-of-range handles.
   */
  idOf(handle: number): string | undefined;

  /**
   * The manifest entry for an id or a handle.
   *
   * @param idOrHandle Asset id or handle.
   * @returns The entry, or `undefined` when unknown.
   */
  entry(idOrHandle: string | number): AssetEntry | undefined;

  /**
   * The resolved URL for an id or a handle.
   *
   * @param idOrHandle Asset id or handle.
   * @returns The URL, or `undefined` when unknown.
   */
  url(idOrHandle: string | number): string | undefined;

  /**
   * Load an asset, or return the promise for one already loading or loaded.
   *
   * Repeat calls for the same id share one promise — the in-flight one while
   * it is loading, then the resolved one forever after — so a hot path may
   * call this every frame without allocating. An unknown id rejects with a
   * shared {@link AssetError}, which is deliberately the same error object
   * every time.
   *
   * @param idOrHandle Asset id or handle.
   * @returns The loaded object.
   */
  load(idOrHandle: string | number): Promise<unknown>;

  /**
   * The already-loaded object for an id.
   *
   * @param idOrHandle Asset id or handle.
   * @returns The object, or `undefined` when it is not loaded yet.
   */
  get(idOrHandle: string | number): unknown;

  /**
   * Load every asset, or every asset carrying `tag`.
   *
   * @param tag Optional tag filter.
   * @returns Resolves once the whole set has settled.
   */
  preload(tag?: string): Promise<void>;

  /**
   * Subscribe to preload progress.
   *
   * @param cb Called once per finished entry.
   * @returns An unsubscribe function.
   */
  onProgress(cb: (progress: AssetProgress) => void): () => void;

  /**
   * Register (or replace) the loader for an asset type.
   *
   * This is how `gameable/splat` and `gameable/character` add the `splat`
   * and `character` types without core depending on them.
   *
   * @param type Asset type the loader handles.
   * @param loader The loader.
   * @returns Nothing.
   */
  registerLoader(type: string, loader: AssetLoader): void;

  /**
   * Whether a loader is registered for a type.
   *
   * @param type Asset type.
   * @returns True when a loader exists.
   */
  hasLoader(type: string): boolean;

  /**
   * Drop every cached object and in-flight promise.
   *
   * @returns Nothing.
   */
  dispose(): void;
}

/** An asset operation that could not be completed. */
export class AssetError extends Error {
  /** The id involved, when there is one. */
  readonly assetId: string;

  /**
   * Build an asset error.
   *
   * @param assetId Asset id involved.
   * @param message What went wrong.
   * @param options Standard `Error` options, used to keep the cause.
   */
  constructor(assetId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AssetError';
    this.assetId = assetId;
  }
}

/**
 * Build an asset registry over a validated manifest.
 *
 * @param options Manifest, loaders and an optional abort signal.
 * @returns The registry.
 *
 * @example
 * ```ts
 * import { createAssetRegistry, parseManifest } from 'gameable/assets';
 *
 * const manifest = parseManifest({
 *   version: 1,
 *   baseUrl: '/assets/',
 *   assets: [{ id: 'shot', type: 'audio', src: 'sfx/shot.ogg', tags: ['sfx'] }],
 * });
 * const assets = createAssetRegistry({ manifest, loaders: {} });
 * console.log(assets.resolve('shot')); // 1
 * console.log(assets.resolve('nope')); // 0
 * ```
 */
export function createAssetRegistry(options: CreateAssetRegistryOptions): AssetRegistry {
  const { manifest } = options;
  // Handles are 1-based positions in this array, so everything a handle needs —
  // the entry, the id, the URL — is one index away and nothing is searched.
  const entries: readonly AssetEntry[] = manifest.assets;
  const ids: string[] = entries.map((e) => e.id);
  const urls: string[] = entries.map((e) => resolveAssetUrl(manifest, e));
  const handles = new Map<string, number>();
  for (const [i, id] of ids.entries()) handles.set(id, i + 1);

  const loaders = new Map<string, AssetLoader>(Object.entries(options.loaders ?? {}));
  const cache = new Map<string, unknown>();
  const inFlight = new Map<string, Promise<unknown>>();
  /** One resolved promise per loaded id, so a cache hit allocates nothing. */
  const settled = new Map<string, Promise<unknown>>();
  /** One rejected promise per unknown id, so a miss allocates nothing either. */
  const unknown = new Map<string, Promise<never>>();
  const progressListeners = new Set<(progress: AssetProgress) => void>();

  /**
   * Normalise an id-or-handle argument to a handle.
   *
   * @param idOrHandle Asset id or handle.
   * @returns The 1-based handle, or `0` when the argument names nothing.
   */
  function toHandle(idOrHandle: string | number): number {
    if (typeof idOrHandle === 'number') {
      return idOrHandle >= 1 && idOrHandle <= entries.length ? idOrHandle : 0;
    }
    return handles.get(idOrHandle) ?? 0;
  }

  /**
   * The cached rejection for an id that is not in the manifest.
   *
   * A game that asks for a missing sound asks for it on every shot, and
   * building an `AssetError` — with its stack — sixty times a second is a
   * measurable cost for a call that does nothing. One error and one rejected
   * promise per distinct name is enough; a sink is attached at construction so
   * a caller that never awaits it cannot trip an unhandled-rejection warning.
   *
   * @param idOrHandle Whatever the caller passed.
   * @returns The shared rejected promise for that name.
   */
  function rejectUnknown(idOrHandle: string | number): Promise<never> {
    const key = String(idOrHandle);
    const hit = unknown.get(key);
    if (hit !== undefined) return hit;
    const rejected: Promise<never> = Promise.reject(
      new AssetError(key, `unknown asset "${key}"; add it to assets.json`),
    );
    rejected.catch(() => undefined);
    unknown.set(key, rejected);
    return rejected;
  }

  const registry: AssetRegistry = {
    manifest,
    ids,

    resolve(id) {
      return handles.get(id) ?? 0;
    },

    idOf(handle) {
      return handle >= 1 ? ids[handle - 1] : undefined;
    },

    entry(idOrHandle) {
      const handle = toHandle(idOrHandle);
      return handle === 0 ? undefined : entries[handle - 1];
    },

    url(idOrHandle) {
      const handle = toHandle(idOrHandle);
      return handle === 0 ? undefined : urls[handle - 1];
    },

    get(idOrHandle) {
      const handle = toHandle(idOrHandle);
      return handle === 0 ? undefined : cache.get(ids[handle - 1]);
    },

    load(idOrHandle) {
      const handle = toHandle(idOrHandle);
      if (handle === 0) return rejectUnknown(idOrHandle);
      const id = ids[handle - 1];
      const done = settled.get(id);
      if (done !== undefined) return done;
      const running = inFlight.get(id);
      if (running !== undefined) return running;

      const entry = entries[handle - 1];
      const loader = loaders.get(entry.type);
      if (loader === undefined) {
        return Promise.reject(
          new AssetError(
            id,
            `no loader registered for type "${entry.type}"; call registry.registerLoader('${entry.type}', …) ` +
              'from the package that owns it',
          ),
        );
      }

      const ctx: AssetLoaderContext = options.signal
        ? { manifest, registry, signal: options.signal }
        : { manifest, registry };

      const promise: Promise<unknown> = loader(urls[handle - 1], entry, ctx)
        .then((value) => {
          cache.set(id, value);
          inFlight.delete(id);
          // Hand the same resolved promise back on every later call: a cache
          // hit is then a map lookup, not a new promise per call.
          settled.set(id, promise);
          return value;
        })
        .catch((cause: unknown) => {
          inFlight.delete(id);
          throw new AssetError(id, `failed to load "${id}" (${entry.type})`, { cause });
        });
      inFlight.set(id, promise);
      return promise;
    },

    async preload(tag) {
      const wanted = manifest.assets.filter(
        (e) => tag === undefined || (e.tags?.includes(tag) ?? false),
      );
      const total = wanted.length;
      let loaded = 0;
      const failures: unknown[] = [];

      await Promise.all(
        wanted.map(async (entry) => {
          let ok = true;
          let error: unknown;
          try {
            await registry.load(entry.id);
          } catch (err) {
            ok = false;
            error = err;
            failures.push(err);
          }
          loaded += 1;
          const progress: AssetProgress = ok
            ? { id: entry.id, loaded, total, ok }
            : { id: entry.id, loaded, total, ok, error };
          for (const cb of progressListeners) cb(progress);
        }),
      );

      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `preload failed for ${String(failures.length)} of ${String(total)} assets`,
        );
      }
    },

    onProgress(cb) {
      progressListeners.add(cb);
      return () => {
        progressListeners.delete(cb);
      };
    },

    registerLoader(type, loader) {
      loaders.set(type, loader);
    },

    hasLoader(type) {
      return loaders.has(type);
    },

    dispose() {
      cache.clear();
      inFlight.clear();
      settled.clear();
      unknown.clear();
      progressListeners.clear();
    },
  };

  return registry;
}
