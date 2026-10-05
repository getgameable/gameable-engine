/**
 * Internal test support.
 *
 * `gameable/test` is the package games and engine code use; the SDK
 * cannot import it without a workspace cycle, so its own unit tests build the
 * few objects they need here.
 *
 * Not exported from `src/index.ts`: this is not public API.
 */
import { KEY_WORDS, keyIndex, writeKeyBit } from './keycodes';
import type { AssetDesc, FrameInput, GameConfig, HostApi, InputState, RayHit, Vec3 } from './types';

/** A stub host plus the recordings a test asserts on. */
export interface StubHost extends HostApi {
  /** Every log line, as `"level: message"`. */
  readonly lines: string[];
  /** How many `raycast` calls the guest made. */
  rayCount: number;
  /** What `raycast` returns. */
  hit: RayHit | null;
}

/**
 * A host that resolves any asset name to a stable handle and never hits.
 *
 * @param seed The value `env.seed()` returns.
 * @returns The stub host.
 */
export function createStubHost(seed = 12345): StubHost {
  const lines: string[] = [];
  const ids = new Map<string, number>();
  const descs = new Map<number, AssetDesc>();
  let next = 1;

  const host: StubHost = {
    lines,
    rayCount: 0,
    hit: null,
    log: (level, msg) => {
      lines.push(`${level}: ${msg}`);
    },
    seed: () => seed,
    nowMs: () => 0,
    raycast: () => {
      host.rayCount += 1;
      return host.hit;
    },
    raycastBatch: (rays) => {
      host.rayCount += rays.length;
      return rays.map(() => host.hit);
    },
    overlapSphere: () => [],
    resolveId: (name) => {
      let id = ids.get(name);
      if (id === undefined) {
        id = next;
        next += 1;
        ids.set(name, id);
        descs.set(id, {
          id,
          name,
          kind: 'data',
          tags: [],
          ready: true,
          hasCollider: false,
          rig: undefined,
        });
      }
      return id;
    },
    describe: (id) => descs.get(id),
  };
  return host;
}

/** A mutable input state with real typed arrays. */
export interface StubInput extends InputState {
  keys: { down: Uint32Array; pressed: Uint32Array; released: Uint32Array };
}

/**
 * A neutral input state: nothing held, pointer locked, canvas focused.
 *
 * @returns A fresh input state.
 */
export function stubInput(): StubInput {
  return {
    keys: {
      down: new Uint32Array(KEY_WORDS),
      pressed: new Uint32Array(KEY_WORDS),
      released: new Uint32Array(KEY_WORDS),
    },
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: {
      x: 0,
      y: 0,
      dx: 0,
      dy: 0,
      wheel: 0,
      buttons: 0,
      pressed: 0,
      released: 0,
      locked: true,
    },
    gamepads: [],
    focused: true,
  };
}

/**
 * Hold a key down and record the press edge.
 *
 * @param input The state to mutate.
 * @param key A key name.
 * @returns Nothing.
 */
export function hold(input: StubInput, key: string): void {
  const index = keyIndex(key);
  writeKeyBit(input.keys.down, index, true);
  writeKeyBit(input.keys.pressed, index, true);
}

/**
 * Build one frame input.
 *
 * @param frame Fixed-step counter.
 * @param input Input state; a neutral one is built when absent.
 * @param bodies Packed body rows, stride 15.
 * @returns A frame input in guest-side shapes.
 */
export function stubFrame(frame: number, input?: StubInput, bodies?: Float32Array): FrameInput {
  return {
    frame,
    dt: Math.fround(1 / 60),
    elapsed: Math.fround(frame / 60),
    input: input ?? stubInput(),
    bodies: bodies ?? new Float32Array(0),
    contacts: [],
    events: [],
    players: [],
  };
}

/**
 * Build one `init` config.
 *
 * @param overrides Anything to change from the defaults.
 * @returns A game config in guest-side shapes.
 */
export function stubConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    seed: overrides.seed ?? 12345,
    fixedHz: overrides.fixedHz ?? 60,
    viewportWidth: overrides.viewportWidth ?? 1280,
    viewportHeight: overrides.viewportHeight ?? 720,
    devMode: overrides.devMode ?? true,
    options: overrides.options,
  };
}

/** A hit at 5 metres on body 9 / entity 9. */
export const STUB_HIT: RayHit = {
  body: 9,
  entity: 9,
  point: { x: 0, y: 0, z: -5 },
  normal: { x: 0, y: 0, z: 1 },
  distance: 5,
};

/**
 * A vector literal, for readable test code.
 *
 * @param x X.
 * @param y Y.
 * @param z Z.
 * @returns A fresh vector.
 */
export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}
