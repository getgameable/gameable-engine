/*
 * `gameable/audio` — WebAudio buses, pooled one-shot playback, positional
 * emitters and a quaternion-driven listener, packaged as an `EngineModule`.
 */

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/audio';
 *
 * console.log(PACKAGE); // 'gameable/audio'
 * ```
 */
export const PACKAGE = '@gameable/audio' as const;

/**
 * `createAudioEngine(options)` builds the WebAudio graph: a `master` bus over
 * `sfx`, `music` and `voice`, pooled voices, an id-keyed decode cache and an
 * `ended` pool the host drains into `sound-ended` events.
 *
 * @example
 * ```ts
 * import { createAudioEngine } from 'gameable/audio';
 *
 * const engine = createAudioEngine({ masterVolume: 0.8 });
 * const buffer = await engine.decode('pistol', bytes);
 *
 * engine.play({ id: 1, buffer, pos: [3, 0, -4], bus: 'sfx' });
 * engine.setListener([0, 1.7, 0], [0, 0, 0, 1]);
 * engine.update();
 * engine.ended.length = 0; // consumed
 * ```
 */
export { createAudioEngine } from './engine';

/**
 * The engine's types: {@link AudioEngine} is the module's service,
 * {@link PlayArgs} mirrors the `play-sound` command, and `Vec3` / `Quat` are
 * plain arrays so nothing here depends on three.
 *
 * @example
 * ```ts
 * import type { AudioEngine, BusName, PlayArgs, Quat, Vec3 } from 'gameable/audio';
 *
 * const bus: BusName = 'music';
 * const at: Vec3 = [0, 0, -4];
 * const facing: Quat = [0, 0, 0, 1];
 * const shot = (engine: AudioEngine, args: PlayArgs): void => { engine.play(args); };
 * ```
 */
import type { AudioEngine } from './engine';

export type {
  AudioBuses,
  AudioEngine,
  AudioEngineOptions,
  BusName,
  PlayArgs,
  Quat,
  Vec3,
} from './engine';

/**
 * `audio(options)` is the `'audio'` `EngineModule`. Its `init` returns the
 * engine — so the registry publishes it as the `'audio'` service — and installs
 * the one-time pointerdown/keydown listener that unlocks the context. Its
 * `update` pumps the engine.
 *
 * @example
 * ```ts
 * import { audio } from 'gameable/audio';
 *
 * const mod = audio({ masterVolume: 0.8 });
 * console.log(mod.service); // null: init builds the engine
 *
 * const engine = mod.init(ctx);
 * const buffer = await mod.decodeAsset('pistol');
 * engine.play({ id: 1, buffer, pos: [0, 1, -3] });
 * mod.update(1 / 60, 0);
 * ```
 */
export { audio } from './module';

/**
 * The module's types. {@link AudioModule} adds `service` and `decodeAsset` to
 * the bare `EngineModule` contract.
 *
 * @example
 * ```ts
 * import { audio } from 'gameable/audio';
 * import type { AudioModule, AudioModuleOptions } from 'gameable/audio';
 *
 * const options: AudioModuleOptions = { masterVolume: 0.5, order: 30 };
 * const mod: AudioModule = audio(options);
 * ```
 */
export type { AudioModule, AudioModuleOptions } from './module';

/*
 * Merge the audio service into the engine's typed service table, so
 * `engine.get('audio')` is an `AudioEngine` with no cast at the call site.
 * Importing this package is enough: the merge is global.
 */
declare module '@gameable/core' {
  interface EngineServices {
    /** The audio service, published by the `'audio'` module. */
    audio: AudioEngine;
  }
}
