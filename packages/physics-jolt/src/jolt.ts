import initJolt from 'jolt-physics/wasm';

/**
 * The initialised Jolt wasm module: every Jolt class, enum constant and helper
 * (`destroy`, `wrapPointer`, ...) hangs off this object.
 *
 * It mirrors the Jolt C++ API one to one, so the
 * [C++ reference](https://jrouwe.github.io/JoltPhysics/) is the documentation.
 */
export type JoltModule = Awaited<ReturnType<typeof initJolt>>;

/** Instance type of a Jolt class, e.g. `JoltInstance<'Vec3'>`. */
export type JoltInstance<K extends keyof JoltModule> = JoltModule[K] extends abstract new (
  ...args: never[]
) => infer R
  ? R
  : never;

/** A reference-counted Jolt collision shape. */
export type JoltShape = JoltInstance<'Shape'>;

/** Options for {@link loadJolt}. */
export interface LoadJoltOptions {
  /**
   * Where `jolt-physics.wasm.wasm` is served from.
   *
   * Omit it and the loader asks the host for
   * `jolt-physics/jolt-physics.wasm.wasm` via `import.meta.resolve`, which is
   * correct under node and under any bundler that keeps an import map. In a
   * plain browser build, pass the URL your bundler minted for the asset:
   *
   * ```ts
   * import wasmUrl from 'jolt-physics/jolt-physics.wasm.wasm?url';
   * ```
   */
  wasmUrl?: string;
}

/** The single in-flight or resolved init, so a second call never re-instantiates. */
let pending: Promise<JoltModule> | null = null;

/** The URL the singleton was initialised with, for the double-init guard. */
let pendingUrl: string | null = null;

/**
 * Best-effort default location of the Jolt wasm binary.
 *
 * @returns A URL for `jolt-physics.wasm.wasm`.
 */
function defaultWasmUrl(): string {
  try {
    return import.meta.resolve('jolt-physics/jolt-physics.wasm.wasm');
  } catch {
    // No import map (a plain browser page). Assume the asset sits next to the
    // document; callers who bundle should pass `wasmUrl` explicitly.
    return 'jolt-physics.wasm.wasm';
  }
}

/**
 * Instantiate the Jolt wasm module, once per page.
 *
 * The module is a process-wide singleton: every call returns the same promise,
 * so registering two physics worlds costs one wasm instantiation. Passing a
 * different `wasmUrl` after the singleton exists is a bug and throws rather
 * than silently loading a second copy of the engine.
 *
 * @param options Where to fetch the wasm binary from.
 * @returns The initialised Jolt module.
 * @throws {Error} When called again with a different `wasmUrl`.
 *
 * @example
 * ```ts
 * import { loadJolt } from 'gameable/physics';
 *
 * const jolt = await loadJolt();
 * const up = new jolt.Vec3(0, 1, 0);
 * jolt.destroy(up); // Jolt never frees anything for you.
 * ```
 */
export function loadJolt(options: LoadJoltOptions = {}): Promise<JoltModule> {
  const url = options.wasmUrl ?? defaultWasmUrl();
  if (pending !== null) {
    if (pendingUrl !== url) {
      throw new Error(
        `loadJolt() was already initialised with ${String(pendingUrl)}; ` +
          `refusing to load a second Jolt module from ${url}`,
      );
    }
    return pending;
  }
  pendingUrl = url;
  pending = initJolt({ locateFile: () => url });
  return pending;
}

/**
 * Whether {@link loadJolt} has been called in this process.
 *
 * @returns True once the singleton exists, in flight or resolved.
 *
 * @example
 * ```ts
 * import { isJoltLoaded, loadJolt } from 'gameable/physics';
 *
 * if (!isJoltLoaded()) await loadJolt();
 * ```
 */
export function isJoltLoaded(): boolean {
  return pending !== null;
}
