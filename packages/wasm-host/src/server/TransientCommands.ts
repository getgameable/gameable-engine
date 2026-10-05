/**
 * `TransientCommands` — this tick's one-shot commands, copied into a pool.
 *
 * Lines, sounds, the listener and asset preloads change no entity's lasting
 * state, so the world record does not keep them; the replicator forwards them
 * for the tick they were sent on. Material parameters, expressions, look-at
 * and clip weights do last, and live on the record's `visual` instead. The
 * guest reuses its command objects between ticks, so every field is copied
 * into a pooled object rather than referenced.
 */
import type { AssetId, AudioBus, Command, Entity, Quat, SoundId, Vec3 } from '@gameable/sdk';

import { copyQuat, copyVec } from './copies';
import { Slab } from './Slab';
import * as slots from './transientSlots';

/**
 * The pool and the ordered list of this tick's transient commands.
 *
 * @example
 * ```ts
 * import { TransientCommands } from 'gameable/host/server';
 *
 * const transient = new TransientCommands();
 * transient.say(5, 'hello', undefined, undefined);
 * console.log(transient.list[0].tag); // 'say'
 * transient.rewind();
 * ```
 */
export class TransientCommands {
  /** This tick's copies, in the order the guest sent them. */
  readonly list: Command[] = [];

  private readonly says = new Slab(slots.say);
  private readonly sounds = new Slab(slots.playSound);
  private readonly stops = new Slab(slots.stopSound);
  private readonly listeners = new Slab(slots.setListener);
  private readonly loads = new Slab(slots.loadAsset);

  /** Empty the list and make every pooled copy free again. */
  rewind(): void {
    this.list.length = 0;
    this.says.rewind();
    this.sounds.rewind();
    this.stops.rewind();
    this.listeners.rewind();
    this.loads.rewind();
  }

  /**
   * Copy a `say`.
   *
   * @param entity Speaker.
   * @param text Line.
   * @param audio Clip.
   * @param visemes Track.
   */
  say(entity: Entity, text: string, audio: AssetId | undefined, visemes: string | undefined): void {
    const c = this.says.take();
    c.val.entity = entity;
    c.val.text = text;
    c.val.audio = audio;
    c.val.visemes = visemes;
    this.list.push(c);
  }

  /**
   * Copy a `play-sound`.
   *
   * @param sound Sound handle.
   * @param asset Audio asset.
   * @param entity Emitter, or `undefined`.
   * @param position World position, or `undefined`.
   * @param volume Gain.
   * @param pitch Playback rate.
   * @param looping Whether it loops.
   * @param bus Mixer bus.
   */
  playSound(
    sound: SoundId,
    asset: AssetId,
    entity: Entity | undefined,
    position: Vec3 | undefined,
    volume: number,
    pitch: number,
    looping: boolean,
    bus: AudioBus,
  ): void {
    const slot = this.sounds.take();
    const v = slot.cmd.val;
    v.sound = sound;
    v.asset = asset;
    v.entity = entity;
    v.position = position === undefined ? undefined : copyVec(slot.vec, position);
    v.volume = volume;
    v.pitch = pitch;
    v.looping = looping;
    v.bus = bus;
    this.list.push(slot.cmd);
  }

  /**
   * Copy a `stop-sound`.
   *
   * @param sound Sound handle.
   * @param fadeMs Fade-out.
   */
  stopSound(sound: SoundId, fadeMs: number): void {
    const c = this.stops.take();
    c.val.sound = sound;
    c.val.fadeMs = fadeMs;
    this.list.push(c);
  }

  /**
   * Copy a `set-listener`.
   *
   * @param position Where.
   * @param rotation Facing.
   * @param velocity Doppler.
   */
  setListener(position: Vec3, rotation: Quat, velocity: Vec3): void {
    const c = this.listeners.take();
    copyVec(c.val.position, position);
    copyQuat(c.val.rotation, rotation);
    copyVec(c.val.velocity, velocity);
    this.list.push(c);
  }

  /**
   * Copy a `load-asset`.
   *
   * @param asset Asset handle.
   * @param priority Load priority.
   */
  loadAsset(asset: AssetId, priority: number): void {
    const c = this.loads.take();
    c.val.asset = asset;
    c.val.priority = priority;
    this.list.push(c);
  }
}
