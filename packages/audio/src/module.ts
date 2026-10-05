/**
 * The `'audio'` `EngineModule`: owns an {@link AudioEngine}, pumps it once per
 * rendered frame, and unlocks the WebAudio context on the first user gesture.
 */
import type { EngineModule, HostContext } from '@gameable/core';

import type { AudioEngine, AudioEngineOptions } from './engine';
import { createAudioEngine } from './engine';

/**
 * The asset registry, as the engine context hands it over.
 *
 * Audio reads exactly one method off it — `get` — and `get` returns `unknown`,
 * so {@link audio} checks the bytes at the call site.
 */
type EngineAssets = HostContext['assets'];

/** Options for {@link audio}. */
export interface AudioModuleOptions extends AudioEngineOptions {
  /**
   * Where the one-time unlock listener is installed. Defaults to the global
   * object; pass the canvas to scope it, or a stub in tests.
   */
  unlockTarget?: EventTarget;
  /** Position in the module order. Lower runs first. Defaults to 30. */
  order?: number;
}

/** The `'audio'` module. Its service is the {@link AudioEngine} it owns. */
export interface AudioModule extends EngineModule {
  /**
   * The audio engine this module owns, or `null` before `init` and after
   * `dispose`.
   *
   * The engine is built by `init`, not by {@link audio}: constructing an
   * `AudioContext` is a side effect on the page — browsers count them, and an
   * unlocked one logs a warning — so a module that is never registered must
   * never make one. `init` returns the engine, so the registry publishes it
   * under `'audio'` and `engine.get('audio')` hands back this same object.
   */
  readonly service: AudioEngine | null;
  /**
   * Build the engine and publish it as the `'audio'` service.
   *
   * @param ctx The host surface; only `ctx.assets` is read.
   * @returns The audio engine.
   */
  init(ctx: HostContext): AudioEngine;
  /**
   * Pump the engine: retire finished voices and fill `service.ended`. A no-op
   * before `init`.
   *
   * Always present on this module, so callers need no optional call.
   *
   * @param dt Wall-clock seconds since the previous frame; unused, because the
   *   engine times voices on the audio context's own clock.
   * @param alpha Interpolation factor; unused by audio.
   */
  update(dt: number, alpha: number): void;
  /**
   * Decode the bytes behind an asset id or handle, memoised.
   *
   * This is the bridge from a `play-sound` command — which carries an asset
   * handle, never a URL — to the `AudioBuffer` {@link AudioEngine.play} wants.
   * The asset must already be loaded; `type: 'audio'` entries load as an
   * `ArrayBuffer`.
   *
   * @param idOrHandle Manifest asset id, or the handle the guest minted for it.
   * @returns The decoded buffer; rejects when the asset is missing or not audio.
   */
  decodeAsset(idOrHandle: string | number): Promise<AudioBuffer>;
  /**
   * The already-decoded buffer for an asset, without awaiting anything.
   *
   * This is what lets the host play a repeated sound — a footstep, a shot —
   * inside the frame that asked for it instead of a microtask later. A miss
   * means "not decoded yet"; fall back to {@link AudioModule.decodeAsset}.
   *
   * Handles and ids share one cache entry: a handle is normalised through the
   * asset registry first, so `decodedAsset(7)` and `decodedAsset('sfx.shot')`
   * hit the same buffer.
   *
   * @param idOrHandle Manifest asset id, or the handle the guest minted for it.
   * @returns The decoded buffer, or `undefined` when no decode has finished.
   */
  decodedAsset(idOrHandle: string | number): AudioBuffer | undefined;
}

/** Default module order: after input, before the renderer-side modules. */
const DEFAULT_ORDER = 30;

/**
 * The unlock target, or `undefined` when nothing in this environment listens.
 *
 * @param explicit An override from the module options.
 * @returns An event target, or `undefined` under plain node.
 */
function resolveUnlockTarget(explicit: EventTarget | undefined): EventTarget | undefined {
  if (explicit) return explicit;
  const maybe: Partial<EventTarget> = globalThis;
  return typeof maybe.addEventListener === 'function' ? globalThis : undefined;
}

/**
 * The decode cache key for an asset id or handle.
 *
 * A handle is resolved back to its manifest id, so the id and the handle the
 * guest minted for it share one cache entry and one decode. A registry that
 * cannot resolve the handle — a stub in a test, a handle from another
 * manifest — falls back to a `#`-prefixed key, which cannot collide with an id.
 *
 * @param assets The asset registry, for `idOf`.
 * @param idOrHandle Asset id or handle.
 * @returns A string key for the decode cache.
 */
function cacheKey(assets: EngineAssets | undefined, idOrHandle: string | number): string {
  if (typeof idOrHandle === 'string') return idOrHandle;
  const resolver: { idOf?: (handle: number) => string | undefined } | undefined = assets;
  return resolver?.idOf?.(idOrHandle) ?? `#${String(idOrHandle)}`;
}

/**
 * Create the audio module.
 *
 * Register it in the engine's module list. `init` builds the
 * {@link AudioEngine} and returns it, so it becomes the `'audio'` service: the
 * host maps `play-sound` / `stop-sound` / `set-listener` straight onto its
 * methods and drains `ended` into `sound-ended` events each frame. Until then
 * {@link AudioModule.service} is `null` and no `AudioContext` exists.
 *
 * Browsers keep an `AudioContext` suspended until the page sees a user
 * gesture, so `init` installs a single `pointerdown` + `keydown` listener that
 * calls `resume()` once and then removes itself.
 *
 * @param options Engine options, plus the unlock target and module order.
 * @returns The module, ready to register.
 *
 * @example
 * ```ts
 * import { audio } from 'gameable/audio';
 *
 * const mod = audio({ masterVolume: 0.8 });
 * const engine = mod.init(ctx);
 *
 * const buffer = await mod.decodeAsset('pistol');
 * engine.play({ id: 1, buffer, pos: [0, 1, -3] });
 * mod.update(1 / 60, 0);
 *
 * // The next shot needs no await: the decode has already settled.
 * const again = mod.decodedAsset('pistol');
 * if (again) engine.play({ id: 2, buffer: again });
 * ```
 */
export function audio(options: AudioModuleOptions = {}): AudioModule {
  const order = options.order ?? DEFAULT_ORDER;

  let engine: AudioEngine | null = null;
  let assets: EngineAssets | undefined;
  let target: EventTarget | undefined;
  let unlock: (() => void) | undefined;
  /** Buffers whose decode has already settled, by normalised asset id. */
  const settled = new Map<string, AudioBuffer>();

  /** Drop the unlock listener, whether or not it has fired. */
  function removeUnlock(): void {
    if (!target || !unlock) return;
    target.removeEventListener('pointerdown', unlock);
    target.removeEventListener('keydown', unlock);
    unlock = undefined;
  }

  return {
    id: 'audio',
    order,

    get service(): AudioEngine | null {
      return engine;
    },

    init(ctx: HostContext): AudioEngine {
      // First touch of the page's audio hardware: nothing before this line has
      // constructed an `AudioContext`.
      const live = engine ?? createAudioEngine(options);
      engine = live;
      assets = ctx.assets;
      target = resolveUnlockTarget(options.unlockTarget);
      if (target) {
        unlock = (): void => {
          removeUnlock();
          void live.resume();
        };
        target.addEventListener('pointerdown', unlock);
        target.addEventListener('keydown', unlock);
      }
      return live;
    },

    update(): void {
      engine?.update();
    },

    decodeAsset(idOrHandle: string | number): Promise<AudioBuffer> {
      const live = engine;
      if (!live || !assets) {
        return Promise.reject(new Error('audio: decodeAsset called before init'));
      }
      const data: unknown = assets.get(idOrHandle);
      if (!(data instanceof ArrayBuffer)) {
        return Promise.reject(
          new Error(
            `audio: asset ${String(idOrHandle)} is not a loaded audio buffer; load it before playing it`,
          ),
        );
      }
      const key = cacheKey(assets, idOrHandle);
      const pending = live.decode(key, data);
      // Remember the settled buffer so `decodedAsset` can answer synchronously
      // on every repeat of this sound.
      void pending.then(
        (buffer) => settled.set(key, buffer),
        () => undefined,
      );
      return pending;
    },

    decodedAsset(idOrHandle: string | number): AudioBuffer | undefined {
      if (!engine) return undefined;
      return settled.get(cacheKey(assets, idOrHandle));
    },

    dispose(): void {
      removeUnlock();
      target = undefined;
      assets = undefined;
      settled.clear();
      // `dispose` before `init` is a no-op: there is nothing to tear down, and
      // building a context here to close it would be absurd.
      engine?.dispose();
      engine = null;
    },
  };
}
