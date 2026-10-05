/**
 * The audio facade.
 *
 * Sounds are fire-and-forget commands. The guest mints the handle so it can
 * stop or track a sound without waiting for the host to hand one back; the
 * same handle comes back in a `sound-ended` event.
 */
import { assetId } from './assets';
import { requireRuntime } from './state';
import type { AudioBus, Quat, SoundId, Vec3 } from './types';

/** Options for `audio.play`. */
export interface PlayOptions {
  /** Attach to an entity for positional audio that follows it. */
  entity?: number;
  /** Linear gain in 0..1. Default 1. */
  volume?: number;
  /** Playback-rate multiplier. Default 1. */
  pitch?: number;
  /** Loop until stopped. Default false. */
  looping?: boolean;
  /** Mixer bus. Default `'sfx'`. */
  bus?: AudioBus;
}

/**
 * The audio facade.
 *
 * @example
 * ```ts
 * import { audio } from 'gameable';
 *
 * const id = audio.play('shot', { entity: player, volume: 0.8 });
 * audio.stop(id, 50);
 * ```
 */
export const audio = {
  /**
   * Start a sound.
   *
   * @param asset Manifest string id or asset handle.
   * @param options Attachment, gain, pitch, looping and bus.
   * @returns The guest-minted sound handle, or 0 when the asset is unknown.
   */
  play(asset: string | number, options?: PlayOptions): SoundId {
    const rt = requireRuntime();
    const id = typeof asset === 'string' ? assetId(asset) : asset;
    if (id === 0) return 0;
    const sound = rt.nextSound;
    rt.nextSound += 1;
    rt.commands.playSound(
      sound,
      id,
      options?.entity,
      options?.volume ?? 1,
      options?.pitch ?? 1,
      options?.looping ?? false,
      options?.bus ?? 'sfx',
    );
    return sound;
  },

  /**
   * Stop a playing sound.
   *
   * @param sound A handle from `play`.
   * @param fadeMs Fade-out in milliseconds; 0 stops immediately.
   * @returns Nothing.
   */
  stop(sound: SoundId, fadeMs = 0): void {
    if (sound === 0) return;
    requireRuntime().commands.stopSound(sound, fadeMs);
  },

  /**
   * Place the audio listener.
   *
   * @param position Listener position.
   * @param rotation Listener rotation, xyzw.
   * @returns Nothing.
   */
  listener(position: Vec3, rotation: Quat): void {
    requireRuntime().commands.setListener(
      position.x,
      position.y,
      position.z,
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    );
  },
};
