/**
 * The guest's `init`: reset the runtime, read the room options, resolve the
 * systems for this role, seed, then make the level and run the game's own
 * `init`.
 */
import { assetId } from '../assets';
import { resetBodyIds } from '../bodyIds';
import { configureEcs, createWorld } from '../ecs';
import { parseNetOptions, resetMessageNames, resolveSystems, roomSeats } from '../net';
import { spawn } from '../prefab';
import { setLogSink, setRandomSource } from '../prelude';
import { claimRealm, setActiveRuntime } from '../state';
import type { SpawnSpec } from '../defineGame';
import type { RuntimeState } from '../state';
import type { GameConfig, GameError, Quat, Vec3 } from '../types';
import type { GuestParts } from './parts';

/** The level spawns a client runs: none. */
const NO_SPAWNS: readonly SpawnSpec[] = Object.freeze([]);

/** Shared empty list, so a game without `systems` resolves to none. */
const EMPTY_SYSTEMS = Object.freeze([]);

/** Reused spawn position, so the declarative spawns allocate nothing extra. */
const posScratch: Vec3 = { x: 0, y: 0, z: 0 };
const rotScratch: Quat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * @param message Why init failed.
 * @returns WIT `result<_, game-error>`'s error arm: jco lowers a thrown
 *   *record* into it, where a thrown Error would surface as a trap.
 */
const initFailed = (message: string): GameError => ({ code: 'init-failed', message });

/**
 * Zero the per-run counters and buffers a new run starts from.
 *
 * @param rt The runtime.
 */
function resetRun(rt: RuntimeState): void {
  rt.assetIds.clear();
  rt.assetDescs.clear();
  rt.frame = 0;
  rt.elapsed = 0;
  rt.nextBody = 1;
  resetBodyIds(rt);
  rt.nextSound = 1;
  rt.player = 0;
  rt.carryCommands = false;
  rt.dead = false;
  rt.failures = 0;
  rt.hud.last = null;
  rt.hud.pending = undefined;
  rt.look.yaw = 0;
  rt.look.pitch = 0;
}

/**
 * The definition's declarative spawns. A client never makes a shared entity:
 * the authority's world arrives replicated, and a client's own spawns are
 * local presentation.
 *
 * @param parts The guest.
 */
function spawnLevel({ rt, definition }: GuestParts): void {
  for (const entry of rt.net.role === 'client' ? NO_SPAWNS : (definition.spawns ?? [])) {
    posScratch.x = entry.position[0] ?? 0;
    posScratch.y = entry.position[1] ?? 0;
    posScratch.z = entry.position[2] ?? 0;
    rotScratch.x = entry.rotation?.[0] ?? 0;
    rotScratch.y = entry.rotation?.[1] ?? 0;
    rotScratch.z = entry.rotation?.[2] ?? 0;
    rotScratch.w = entry.rotation?.[3] ?? 1;
    spawn(entry.prefab, posScratch, rotScratch);
  }
}

/**
 * The guest's WIT `init`.
 *
 * @param parts The guest.
 * @param config The host's `game-config`.
 * @throws {GameError} `init-failed` for bad room options or a throwing `definition.init`.
 */
export function initGuest(parts: GuestParts, config: GameConfig): void {
  const { rt, host, definition, net } = parts;
  const previous = setActiveRuntime(rt);
  try {
    setLogSink((level, msg) => {
      host.log(level, msg);
    });

    rt.config = {
      seed: Number(config.seed),
      fixedHz: config.fixedHz,
      viewportWidth: config.viewportWidth,
      viewportHeight: config.viewportHeight,
      devMode: config.devMode,
      options: config.options ?? undefined,
    };
    rt.dt = 1 / Math.max(1, config.fixedHz);

    claimRealm(rt);

    // `configureEcs` already zeroes every lane — it either replaces the
    // arrays or resets them — so there is no second pass here.
    configureEcs(parts.maxEntities);
    rt.world = createWorld();
    parts.builtins.forgetQuery();
    rt.packer.clear();
    rt.bodyIndex.clear();
    rt.commands.reset();
    rt.localCommands.reset();
    try {
      rt.net = parseNetOptions(rt.config.options, roomSeats(definition));
    } catch (err) {
      // A thrown record is WIT's error arm, as for a failing `definition.init`.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw initFailed(err instanceof Error ? err.message : String(err));
    }
    rt.players.configure(rt.net.maxPlayers, rt.look.sensitivity);
    rt.inputLanes =
      rt.net.role === 'client' ? (rt.players.handle(rt.net.localPlayer)?.lanes ?? rt) : rt;
    net.reset();
    parts.data.reset();
    resetMessageNames();
    resolveSystems(
      definition.systems ?? EMPTY_SYSTEMS,
      parts.multiplayer,
      rt.net.role,
      parts.systems,
      parts.systemLabels,
    );
    resetRun(rt);

    // Rule 9: seed here, never at module scope. Wizer froze module scope.
    const seedValue = host.seed() >>> 0;
    rt.rng.seed(seedValue);
    setRandomSource(() => rt.rng.float());

    for (const name of definition.assets ?? []) assetId(name);

    // Solo is seat 0. In a room the authority spawns one per joined player instead.
    if (rt.net.role === 'solo') rt.player = parts.spawner.spawn(0);

    spawnLevel(parts);

    if (definition.init) {
      try {
        definition.init(parts.ctx);
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw initFailed(err instanceof Error ? err.message : String(err));
      }
    }

    rt.initialised = true;
    // Everything `init` queued - the declarative spawns and whatever the
    // game's own `init` did - belongs to frame 0, so the first tick must not
    // reset the buffer out from under it.
    rt.carryCommands = rt.commands.list.length > 0 || rt.localCommands.list.length > 0;
  } finally {
    setActiveRuntime(previous);
  }
}
