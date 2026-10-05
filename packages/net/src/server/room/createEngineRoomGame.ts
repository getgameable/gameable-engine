/**
 * `createEngineRoomGame` — boot a game as a room's authority.
 */
import { createHeadlessEngine, type HeadlessEngine } from '@gameable/core/headless';
import { physics, type PhysicsOptions, type PhysicsService } from '@gameable/physics-jolt';
import { DEFAULT_ROOM_SEATS, roomSeats, type GameDefinition, type GameEvent } from '@gameable/sdk';
import {
  createDirectSandbox,
  createGameSlot,
  createSandbox,
  createServerAdapter,
  createServerHost,
  createServerLoop,
} from '@gameable/wasm-host/server';

import { RoomData, type RoomDataOptions } from './data/index.js';
import { EngineRoomGame } from './EngineRoomGame.js';
import {
  addLevelColliders,
  type ReadAsset,
  resolveRoomManifest,
  staticColliders,
} from './levelColliders.js';
import { RoomInputs } from './RoomInputs.js';

type GameSlot = ReturnType<typeof createGameSlot>;

/**
 * A guest built to wasm: the transpiled module and its core modules.
 *
 * @example
 * ```ts
 * import type { WasmGuest } from 'gameable/net/server';
 *
 * const guest: WasmGuest = {
 *   guestModuleUrl: new URL('./guest/game.js', import.meta.url),
 *   getCoreModule: (path) => fetch(new URL(path, base)).then((r) => WebAssembly.compileStreaming(r)),
 * };
 * ```
 */
export interface WasmGuest {
  /** URL of the `jco transpile`d `game.js`. */
  guestModuleUrl: string | URL;
  /** Compile one of its core wasm files by relative path. */
  getCoreModule: (path: string) => Promise<WebAssembly.Module>;
}

/**
 * What {@link createEngineRoomGame} takes: the game, by definition (direct
 * mode, the game's TypeScript in this process) or by guest (wasm).
 *
 * @example
 * ```ts
 * import type { EngineRoomGameOptions } from 'gameable/net/server';
 *
 * const options: EngineRoomGameOptions = { definition: game, manifest, seed: 7 };
 * ```
 */
export interface EngineRoomGameOptions {
  /** The game's `defineGame` result, run in direct mode. */
  definition?: GameDefinition;
  /** The game built to wasm. Exactly one of `definition` and `guest`. */
  guest?: WasmGuest;
  /**
   * The asset manifest: a URL or a parsed document. Every static `collider`
   * it declares is built into the room's world before the guest's `init`.
   */
  manifest?: string | object;
  /**
   * Reads a collider's `src`, resolved against the manifest's `baseUrl`.
   * Default `fetch`; a Node server passes a file reader.
   */
  readAsset?: ReadAsset;
  /**
   * Jolt's options: gravity and the guest's capacity. `maxBodies` (default
   * 4096) is the guest's id range; the level's colliders take the ids just
   * above it, and the Jolt world is made for both.
   */
  physicsOptions?: PhysicsOptions;
  /**
   * The room's seats, ids `0..maxPlayers - 1`. Leave it out: it is the
   * game's `features.multiplayer.maxPlayers` (sdk `roomSeats`), the number
   * the guest reads too. Required with a `guest`: features do not cross the
   * WIT boundary, so the host reads them by importing the game's definition
   * and passes `roomSeats(definition)` here; leaving it out throws rather
   * than guess. With a `definition` it is only for a game that declares no
   * seats (default `DEFAULT_ROOM_SEATS`, 8); one that disagrees with the
   * declared seats throws.
   */
  maxPlayers?: number;
  /** The run seed. */
  seed?: number;
  /** Replication cull distance in metres; default none. */
  cullDistance?: number;
  /** `game-config.dev-mode`. Default false. */
  devMode?: boolean;
  /**
   * Called with the room's physics world after the manifest's colliders are
   * in and before the guest's `init`: for procedural extras the manifest
   * cannot declare. A throw disposes the engine and rejects the build.
   */
  prepareWorld?: (physics: PhysicsService) => void | Promise<void>;
  /**
   * The player store and the game's name in it: joins load each player's
   * document, and the guest's `ctx.data` saves and trades through it. Leave
   * it out for a room that keeps nothing (data commands are dropped, warned once).
   */
  data?: RoomDataOptions;
}

/** The guest's body ids when `physicsOptions.maxBodies` is not given. */
const GUEST_BODIES = 4096;

/**
 * Build a room game: headless engine with `[physics(physicsOptions), slot]`,
 * the manifest's static colliders, server adapter, server host, sandbox
 * (direct from `definition`, or wasm from `guest`) and server loop.
 *
 * @param options The game, its manifest, physics, seats, seed and culling.
 * @returns The game, booted: the guest's `init` and its first step have run.
 * @throws {TypeError} When neither or both of `definition` and `guest` are given, or a `guest` comes without `maxPlayers`.
 * @throws {RangeError} When `maxPlayers` disagrees with the game's declared seats.
 * @throws {Error} When the guest dies during its first (warm-up) step, or a level collider cannot be built.
 *
 * @example
 * ```ts
 * import { createEngineRoomGame } from 'gameable/net/server';
 * import game from './game';
 *
 * const roomGame = await createEngineRoomGame({ definition: game, manifest: '/assets.json', seed: 7 });
 * roomGame.maxPlayers; // the game's features.multiplayer.maxPlayers
 * ```
 */
export async function createEngineRoomGame(
  options: EngineRoomGameOptions,
): Promise<EngineRoomGame> {
  const { definition, guest } = options;
  if ((definition === undefined) === (guest === undefined)) {
    throw new TypeError('createEngineRoomGame: give exactly one of definition and guest');
  }
  if (guest !== undefined && options.maxPlayers === undefined) {
    throw new TypeError(
      'createEngineRoomGame: a wasm guest needs maxPlayers: the seats are not readable through the ' +
        "guest, so pass roomSeats(definition) from the game's imported definition",
    );
  }
  const seats = seatsFor(definition, options.maxPlayers);
  const manifest = await resolveRoomManifest(options.manifest);
  const level = staticColliders(manifest);
  const guestBodies = options.physicsOptions?.maxBodies ?? GUEST_BODIES;
  const slot = createGameSlot();
  const engine = await createHeadlessEngine({
    manifest,
    // The level's bodies count toward Jolt's limit, so the guest keeps all of its ids.
    modules: [physics({ ...options.physicsOptions, maxBodies: guestBodies + level.length }), slot.module],
  });
  // Everything after the engine exists can throw (a guest that fails to load
  // or to start); the engine and its Jolt world go with the failed build, or
  // about ten failures leave a process that can build no room at all.
  try {
    await addLevelColliders(engine.modules.get('physics'), manifest, level, guestBodies + 1, {
      readAsset: options.readAsset,
      physics: options.physicsOptions,
    });
    return await boot(engine, slot, options, seats, guestBodies);
  } catch (error) {
    await engine.dispose().catch((cause: unknown) => {
      console.error('createEngineRoomGame: disposing the engine of a failed build threw', cause);
    });
    throw error;
  }
}

/**
 * The build after the engine: adapter, host, sandbox, loop, the warm-up step.
 *
 * @param engine The headless engine, physics and the slot registered.
 * @param slot The game slot.
 * @param options The build's options.
 * @param seats The room's seats.
 * @param guestBodies The guest's body ids, 1 to this.
 * @returns The game.
 * @throws {Error} When the guest dies during its first step; the caller disposes the engine.
 */
async function boot(
  engine: HeadlessEngine,
  slot: GameSlot,
  options: EngineRoomGameOptions,
  seats: number,
  guestBodies: number,
): Promise<EngineRoomGame> {
  const { definition, guest } = options;
  const world = engine.modules.get('physics');
  // A throw here reaches the caller, which disposes the engine.
  await options.prepareWorld?.(world);
  // RoomData pushes its events (loaded joins, exchange results) into the adapter's list.
  let target: GameEvent[] | null = null;
  const data =
    options.data === undefined
      ? null
      : new RoomData({ ...options.data, push: (e) => target?.push(e) });
  // The body table is the guest's range: an id past it is refused, never grown into (the level is above it).
  const adapter = createServerAdapter(world, {
    maxBodies: guestBodies,
    ...(data === null ? {} : { dataSink: data }),
  });
  target = adapter.events;
  await data?.start();
  const host = createServerHost(world, engine.assets, adapter, { seed: options.seed });
  const sandbox =
    definition !== undefined
      ? createDirectSandbox({ mode: 'direct', game: definition, host })
      : await createSandbox({ mode: 'wasm', ...(guest as WasmGuest), host });
  const inputs = new RoomInputs();
  let game: EngineRoomGame | null = null;
  const loop = createServerLoop(engine, sandbox, adapter, inputs, {
    seed: options.seed,
    devMode: options.devMode,
    onDead: (error) => {
      game?.guestDied(error);
    },
    // net.maxPlayers is the highest seat id the guest makes a slot for.
    options: JSON.stringify({ net: { role: 'authority', maxPlayers: seats - 1 } }),
  });
  await slot.attach(loop, engine.ctx);
  // The warm-up step: the guest's init output (the level's spawns) is applied
  // with its first tick, so run it now, before anyone joins: a welcome then
  // carries the level.
  const stepMs = 1000 / engine.ctx.config.fixedHz;
  engine.step(0);
  engine.step(stepMs);
  if (sandbox.dead) {
    // A guest that traps on its first tick would otherwise reach no one: the
    // room would tick a dead guest. Fail the build of the room instead.
    const reason = sandbox.error?.message ?? 'unknown error';
    throw new Error(`createEngineRoomGame: the guest died during its first step: ${reason}`);
  }
  game = new EngineRoomGame(
    engine,
    adapter,
    sandbox,
    inputs,
    options.cullDistance,
    stepMs,
    seats,
    data,
  );
  return game;
}

/**
 * @param definition The game, when it runs in this process.
 * @param maxPlayers The option, if given.
 * @returns The room's seats: declared by the game, else the option, else the default.
 * @throws {RangeError} When the option disagrees with the declared seats, or is not a whole number of at least 1.
 */
function seatsFor(definition: GameDefinition | undefined, maxPlayers: number | undefined): number {
  const declared = definition === undefined ? undefined : roomSeats(definition);
  if (maxPlayers !== undefined && (!Number.isInteger(maxPlayers) || maxPlayers < 1)) {
    throw new RangeError(
      `createEngineRoomGame: maxPlayers must be a whole number of at least 1, got ${String(maxPlayers)}`,
    );
  }
  if (declared !== undefined && maxPlayers !== undefined && maxPlayers !== declared) {
    throw new RangeError(
      `createEngineRoomGame: maxPlayers ${String(maxPlayers)} disagrees with the game's ` +
        `features.multiplayer.maxPlayers ${String(declared)}; leave the option out`,
    );
  }
  return declared ?? maxPlayers ?? DEFAULT_ROOM_SEATS;
}
