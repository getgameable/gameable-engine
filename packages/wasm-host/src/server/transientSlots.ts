/**
 * The pooled objects `TransientCommands` copies into, one factory per command.
 *
 * A slot is a command object plus whatever it owns for its optional or list
 * fields, so a copy never has to allocate once the slot exists.
 */
import type { Command, PlaySoundCmd, Quat, SayCmd, Vec3 } from '@gameable/sdk';

/** The command variant with tag `T`. */
type Cmd<T extends Command['tag']> = Extract<Command, { tag: T }>;

/** A pooled command with the vector it owns for an optional field. */
export interface WithVec<C> {
  /** The command handed out. */
  readonly cmd: C;
  /** The owned vector its optional field points at when present. */
  readonly vec: Vec3;
}

const vec = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const quat = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

/** @returns A fresh `say` slot. */
export const say = (): { tag: 'say'; val: SayCmd } => ({
  tag: 'say',
  val: { entity: 0, text: '', audio: undefined, visemes: undefined },
});

/** @returns A fresh `play-sound` slot. */
export const playSound = (): WithVec<{ tag: 'play-sound'; val: PlaySoundCmd }> => ({
  cmd: {
    tag: 'play-sound',
    val: { sound: 0, asset: 0, volume: 1, pitch: 1, looping: false, bus: 'sfx' },
  },
  vec: vec(),
});

/** @returns A fresh `stop-sound` slot. */
export const stopSound = (): Cmd<'stop-sound'> => ({
  tag: 'stop-sound',
  val: { sound: 0, fadeMs: 0 },
});

/** @returns A fresh `set-listener` slot. */
export const setListener = (): Cmd<'set-listener'> => ({
  tag: 'set-listener',
  val: { position: vec(), rotation: quat(), velocity: vec() },
});

/** @returns A fresh `load-asset` slot. */
export const loadAsset = (): Cmd<'load-asset'> => ({
  tag: 'load-asset',
  val: { asset: 0, priority: 0 },
});
