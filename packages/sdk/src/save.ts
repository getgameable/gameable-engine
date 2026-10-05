/**
 * `snapshot` and `restore`: the guest's whole state as an opaque byte string.
 *
 * Used by dev HMR, save games and the determinism test. The format is
 * versioned and little-endian (every platform gameable runs on is), and it
 * carries no `TextEncoder` dependency beyond the prelude polyfill.
 *
 * The `throw` statements here look wrong and are not: WIT `result<_, E>` is
 * lowered by jco from a thrown *record*, so `restore` must throw a
 * `game-error` rather than an `Error`.
 *
 * ```text
 * offset  size      field
 * 0       4         magic 'AOSS'
 * 4       4         u32 version
 * 8       4         u32 maxEntities
 * 12      4         u32 jsonByteLength
 * 16      json      UTF-8 header: counters, RNG state, asset cache, user state
 * ...     n*2       u16 per entity: bit i = has BUILTIN_COMPONENTS[i], bit 15 = alive
 * ...     raw       every component lane, in BUILTIN_COMPONENTS order
 * ```
 *
 * Only built-in components are covered. A game with its own components should
 * return them from `defineGame({ snapshot })` and read them back in
 * `defineGame({ restore })`; that object is JSON-encoded into the header.
 */
import { resetBodyIds } from './bodyIds';
import { utf8Decode, utf8Encode } from './prelude';
import {
  BUILTIN_COMPONENTS,
  Character,
  Health,
  Renderable,
  RigidBody,
  Transform,
  Velocity,
  addComponent,
  addEntity,
  entityExists,
  getMaxEntities,
  hasComponent,
  removeEntity,
  resetBuiltinStores,
  resetWorld,
} from './ecs';
import type { PlayerRecord } from './net';
import type { RuntimeState } from './state';

/** Bumped whenever the byte layout changes. Mismatches refuse to restore. */
export const SNAPSHOT_VERSION = 3;

/** Version 2 lacks `players`; it still restores, every seat empty. */
const READABLE_VERSIONS: readonly number[] = [2, SNAPSHOT_VERSION];

const MAGIC = 0x41_4f_53_53; // 'AOSS'
const HEADER_BYTES = 16;
/** Bit 15 of the per-entity mask: the entity exists. */
const ALIVE_BIT = 1 << 15;

/** What the JSON header carries. */
interface SnapshotHeader {
  frame: number;
  elapsed: number;
  nextBody: number;
  nextSound: number;
  player: number;
  /** The room's taken seats (version 3). */
  players?: PlayerRecord[];
  /** The host's seat; absent in older snapshots and with nobody joined. */
  host?: number;
  maxEid: number;
  rng: { s0: number; s1: number; s2: number; s3: number };
  look: { yaw: number; pitch: number; sensitivity: number };
  hud: Record<string, unknown> | null;
  assets: [string, number][];
  user?: unknown;
}

/** Every component lane, in the fixed order the body section stores them. */
function lanes(): (Float32Array | Uint32Array | Uint8Array)[] {
  return [
    Transform.x,
    Transform.y,
    Transform.z,
    Transform.qx,
    Transform.qy,
    Transform.qz,
    Transform.qw,
    Transform.sx,
    Transform.sy,
    Transform.sz,
    Renderable.asset,
    Renderable.flags,
    Renderable.dirty,
    RigidBody.groundState,
    RigidBody.handle,
    RigidBody.kind,
    RigidBody.shape,
    RigidBody.dirty,
    Character.bundle,
    Character.dirty,
    Velocity.x,
    Velocity.y,
    Velocity.z,
    Velocity.ax,
    Velocity.ay,
    Velocity.az,
    Health.current,
    Health.max,
  ];
}

/**
 * Serialise the whole guest state.
 *
 * @param rt The runtime to serialise.
 * @param userState Extra state from `defineGame({ snapshot })`.
 * @returns A freshly allocated byte string. Opaque to the host.
 */
export function writeSnapshot(rt: RuntimeState, userState?: unknown): Uint8Array {
  const maxEntities = getMaxEntities();
  const world = rt.world as never;

  let maxEid = 0;
  for (let e = 1; e < maxEntities; e += 1) if (entityExists(world, e)) maxEid = e;

  const masks = new Uint16Array(maxEntities);
  for (let e = 1; e <= maxEid; e += 1) {
    if (!entityExists(world, e)) continue;
    let m = ALIVE_BIT;
    for (let i = 0; i < BUILTIN_COMPONENTS.length; i += 1) {
      if (hasComponent(world, e, BUILTIN_COMPONENTS[i])) m |= 1 << i;
    }
    masks[e] = m;
  }

  const header: SnapshotHeader = {
    frame: rt.frame,
    elapsed: rt.elapsed,
    nextBody: rt.nextBody,
    nextSound: rt.nextSound,
    player: rt.player,
    players: rt.players.save(),
    host: rt.players.hostSeat,
    maxEid,
    rng: rt.rng.save(),
    look: { yaw: rt.look.yaw, pitch: rt.look.pitch, sensitivity: rt.look.sensitivity },
    hud: rt.hud.last,
    assets: [...rt.assetIds.entries()],
    user: userState,
  };

  const json = utf8Encode(JSON.stringify(header));
  const maskBytes = masks.byteLength;
  const laneList = lanes();
  let bodyBytes = 0;
  for (const lane of laneList) bodyBytes += lane.byteLength;

  const total = HEADER_BYTES + json.length + maskBytes + bodyBytes;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, false);
  view.setUint32(4, SNAPSHOT_VERSION, true);
  view.setUint32(8, maxEntities, true);
  view.setUint32(12, json.length, true);

  let off = HEADER_BYTES;
  out.set(json, off);
  off += json.length;
  out.set(new Uint8Array(masks.buffer, masks.byteOffset, maskBytes), off);
  off += maskBytes;
  for (const lane of laneList) {
    out.set(new Uint8Array(lane.buffer, lane.byteOffset, lane.byteLength), off);
    off += lane.byteLength;
  }
  return out;
}

/**
 * Copy `state` into a fresh `Uint8Array`.
 *
 * jco hands the guest a `Uint8Array` for `list<u8>`, but direct mode and tests
 * may pass any `ArrayLike<number>`; normalising once keeps the reader simple.
 *
 * @param state The incoming bytes.
 * @returns A contiguous copy.
 */
function normalise(state: ArrayLike<number>): Uint8Array {
  if (state instanceof Uint8Array) return state;
  const out = new Uint8Array(state.length);
  for (let i = 0; i < state.length; i += 1) out[i] = state[i] ?? 0;
  return out;
}

/**
 * Restore a state previously produced by `writeSnapshot` from the same build.
 *
 * @param rt The runtime to overwrite.
 * @returns The user state from `defineGame({ snapshot })`, if any.
 * @throws A `GameError`-shaped object when the magic or version does not match.
 * @param state The bytes.
 */
export function readSnapshot(rt: RuntimeState, state: ArrayLike<number>): unknown {
  const bytes = normalise(state);
  if (bytes.length < HEADER_BYTES) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw { code: 'snapshot-version-mismatch', message: 'snapshot is truncated' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== MAGIC) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw { code: 'snapshot-version-mismatch', message: 'not an gameable snapshot' };
  }
  const version = view.getUint32(4, true);
  if (!READABLE_VERSIONS.includes(version)) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw {
      code: 'snapshot-version-mismatch',
      message: `snapshot version ${String(version)}, this build reads ${String(SNAPSHOT_VERSION)}`,
    };
  }
  const maxEntities = view.getUint32(8, true);
  if (maxEntities !== getMaxEntities()) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw {
      code: 'snapshot-version-mismatch',
      message: `snapshot holds ${String(maxEntities)} entities, this build is configured for ${String(getMaxEntities())}`,
    };
  }
  const jsonLen = view.getUint32(12, true);
  const header = JSON.parse(
    utf8Decode(bytes, HEADER_BYTES, HEADER_BYTES + jsonLen),
  ) as SnapshotHeader;

  let off = HEADER_BYTES + jsonLen;
  const masks = new Uint16Array(maxEntities);
  new Uint8Array(masks.buffer).set(bytes.subarray(off, off + masks.byteLength));
  off += masks.byteLength;

  resetBuiltinStores();
  for (const lane of lanes()) {
    const target = new Uint8Array(lane.buffer, lane.byteOffset, lane.byteLength);
    target.set(bytes.subarray(off, off + lane.byteLength));
    off += lane.byteLength;
  }

  // Rebuild the entity id space exactly: allocate 1..maxEid in order, then
  // free the holes from the top down so the free list pops back in ascending
  // order and future ids match the original run.
  const world = resetWorld(rt.world);
  rt.world = world;
  const maxEid = header.maxEid;
  for (let e = 1; e <= maxEid; e += 1) addEntity(world);
  for (let e = maxEid; e >= 1; e -= 1) {
    if (((masks[e] ?? 0) & ALIVE_BIT) === 0) removeEntity(world, e);
  }
  for (let e = 1; e <= maxEid; e += 1) {
    const m = masks[e] ?? 0;
    if ((m & ALIVE_BIT) === 0) continue;
    for (let i = 0; i < BUILTIN_COMPONENTS.length; i += 1) {
      if ((m & (1 << i)) === 0) continue;
      addComponent(world, e, BUILTIN_COMPONENTS[i]);
    }
  }

  rt.frame = header.frame;
  rt.elapsed = header.elapsed;
  rt.nextBody = header.nextBody;
  rt.nextSound = header.nextSound;
  rt.player = header.player;
  rt.players.load(header.players, header.host);
  rt.rng.load(header.rng);
  rt.look.yaw = header.look.yaw;
  rt.look.pitch = header.look.pitch;
  rt.look.sensitivity = header.look.sensitivity;
  rt.hud.last = header.hud;
  rt.hud.pending = undefined;
  rt.assetIds.clear();
  rt.assetDescs.clear();
  for (const [name, id] of header.assets) rt.assetIds.set(name, id);

  rt.bodyIndex.clear();
  rt.packer.clear();
  for (let e = 1; e <= maxEid; e += 1) {
    if (((masks[e] ?? 0) & ALIVE_BIT) === 0) continue;
    const body = RigidBody.handle[e] ?? 0;
    if (body !== 0) rt.bodyIndex.bind(body, e);
  }
  resetBodyIds(rt); // the free list is rebuilt from these live bodies on the next spawn

  return header.user;
}
