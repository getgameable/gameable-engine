/**
 * `InPageAuthority` — Play Solo: the game's authority runs in the page, as
 * our own `Room` over a wasm guest, and the page's client joins it through a
 * `LoopbackConnection`. No server, no socket, no Colyseus.
 */
import type { PhysicsOptions, PhysicsService } from '@gameable/physics-jolt';
import { DEFAULT_ROOM_SEATS, roomSeats, roomSendHz, type GameDefinition } from '@gameable/sdk';

import { createLoopbackConnection, type LoopbackConnection } from '../client/LoopbackConnection.js';
import { createEngineRoomGame, type WasmGuest } from '../server/room/createEngineRoomGame.js';
import type { EngineRoomGame } from '../server/room/EngineRoomGame.js';
import { createRoom, type Room } from '../server/room/Room.js';
import { MemoryStore } from '../server/store/MemoryStore.js';
import { SoloPorts } from './SoloPorts.js';

/** The room ticks at the simulation rate, as the page steps: 60 Hz. */
const STEP_MS = 1000 / 60;

/**
 * What {@link createInPageAuthority} takes.
 *
 * @example
 * ```ts
 * import type { InPageAuthorityOptions } from 'gameable/net/solo';
 *
 * const options: InPageAuthorityOptions = { guest, definition, manifest, physicsOptions: { gravity: [0, -9.81, 0] } };
 * ```
 */
export interface InPageAuthorityOptions {
  /**
   * The game built to wasm. Always wasm: the page's own client guest may be
   * a direct guest, and two direct guests in one realm share the SDK's
   * component arrays (the SDK refuses that).
   */
  guest: WasmGuest;
  /** The game's definition, read for its seats and send rate (features do not cross the wasm boundary). */
  definition: GameDefinition;
  /** The asset manifest: a URL or a parsed document. */
  manifest?: string | object;
  /** The authority's Jolt options: the page's own, from one shared module. Pass `wasmUrl` in a browser. */
  physicsOptions?: PhysicsOptions;
  /** Called with the authority's physics world before the guest's `init`: the level's static colliders. */
  prepareWorld?: (physics: PhysicsService) => void | Promise<void>;
  /** The run seed. */
  seed?: number;
  /** The room's code, as the page shows it. Default `SOLO`. */
  code?: string;
  /** Where the room's log lines go. Default: dropped. */
  log?: (event: string, detail?: object) => void;
}

/** One run, from `start` to `stop`. */
interface SoloRun {
  game: EngineRoomGame;
  room: Room;
  ports: SoloPorts;
  connection: LoopbackConnection;
  /** Fixed steps the run has been given. */
  steps: number;
}

/** The engine `drive` hooks: any engine's frame event, which carries the frame's fixed steps. */
interface FrameSource {
  events: { on(event: 'engine:frame', fn: (frame: { substeps: number }) => void): () => void };
}

/** Play Solo's authority. Construct it through {@link createInPageAuthority}. */
export class InPageAuthority {
  private run: SoloRun | null = null;
  private starting: Promise<void> | null = null;
  /** Play Solo's player store: in memory, kept across `stop()` and `start()`, one document per seat. */
  private readonly store = new MemoryStore();

  /** @param options The game and how its room runs. */
  constructor(private readonly options: InPageAuthorityOptions) {}

  /** @returns The current run's connection; each `start` makes a fresh one (a closed connection stays closed). */
  get connection(): LoopbackConnection {
    if (this.run === null) throw new Error('InPageAuthority: no connection before start()');
    return this.run.connection;
  }

  /** @returns The running room's game, or null when stopped (or when the room closed itself). */
  get game(): EngineRoomGame | null {
    return this.run?.game ?? null;
  }

  /** @returns The running room, or null. */
  get room(): Room | null {
    return this.run?.room ?? null;
  }

  /**
   * Boot the authority: the wasm guest on a headless engine with its own
   * Jolt world (Jolt's module is the page's, through `loadJolt`'s singleton),
   * `prepareWorld` before the guest's `init`, then the room. Nothing ticks
   * until the page steps it.
   *
   * @returns Resolves once `connection` can be joined.
   * @throws {Error} When already running or starting, or when the guest or `prepareWorld` fails.
   */
  start(): Promise<void> {
    if (this.run !== null || this.starting !== null) {
      return Promise.reject(new Error('InPageAuthority.start: already running; stop() it first'));
    }
    const starting = this.boot().finally(() => {
      this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  /**
   * End the run: every connection gets `error: ended` and closes, and the
   * authority's engine, guest and Jolt world are disposed. Waits for a
   * `start()` still in flight and ends the run it makes. Safe to call twice.
   *
   * @returns Resolves once the authority's engine is disposed.
   */
  async stop(): Promise<void> {
    if (this.starting !== null) await this.starting.catch(() => undefined);
    const run = this.run;
    if (run === null) return;
    this.run = null;
    run.room.close('ended');
    await run.game.disposed;
  }

  /**
   * Run `substeps` room ticks: one per fixed step the page ran. The room's
   * clock moves by exactly that many 1/60 s steps, so the authority runs as
   * many steps as the page, and one per INPUT the page sends. A room that
   * closed itself (its guest died) is dropped.
   *
   * @param substeps The page's fixed steps this frame. Default 1.
   */
  step(substeps = 1): void {
    const run = this.run;
    if (run === null || substeps <= 0) return;
    run.steps += substeps;
    run.ports.advanceTo(run.steps * STEP_MS);
    if (run.game.ended !== null) this.run = null;
  }

  /**
   * Step on every frame of the page's engine, after its step, by that
   * frame's `substeps`. The page's `maxSubsteps` therefore caps the
   * authority too, and a hidden tab (no frames) pauses it. The listener
   * outlives `stop()`: it is a no-op until the next `start()`, whose run it
   * then drives.
   *
   * @param engine The page's engine.
   * @returns A function that stops the driving.
   */
  drive(engine: FrameSource): () => void {
    return engine.events.on('engine:frame', (frame) => {
      this.step(frame.substeps);
    });
  }

  /** Build one run. */
  private async boot(): Promise<void> {
    const { definition, guest } = this.options;
    const sendHz = roomSendHz(definition);
    const game = await createEngineRoomGame({
      guest,
      manifest: this.options.manifest,
      physicsOptions: this.options.physicsOptions,
      prepareWorld: this.options.prepareWorld,
      maxPlayers: roomSeats(definition) ?? DEFAULT_ROOM_SEATS,
      seed: this.options.seed,
      data: { store: this.store, game: 'solo' },
    });
    const code = this.options.code ?? 'SOLO';
    const ports = new SoloPorts(this.options.log);
    const room = createRoom({ code, game, ports, sendHz, tickHz: 1000 / STEP_MS });
    const connection = createLoopbackConnection({ connect: () => ports.open(room), room: code });
    this.run = { game, room, ports, connection, steps: 0 };
  }
}

/**
 * Play Solo: the authority in the page. `start()` boots the wasm guest on a
 * headless engine with the page's physics options and opens our own room on
 * it; `connection` is what the page's `multiplayer` feature joins; the page's
 * fixed steps drive it (`drive(engine)`, or `step(n)` by hand); `stop()`
 * disposes it all.
 *
 * @param options The wasm guest, the definition, the manifest and physics.
 * @returns The authority, not started.
 *
 * @example
 * ```ts
 * import { createInPageAuthority } from 'gameable/net/solo';
 * import { clientFeatures } from 'gameable/host/features';
 *
 * const solo = createInPageAuthority({ guest, definition, manifest, physicsOptions });
 * await solo.start();
 * const table = clientFeatures({ multiplayer: { connection: solo.connection, name: 'You' } });
 * // ...boot the page's engine with the features, then:
 * solo.drive(engine);
 * ```
 */
export function createInPageAuthority(options: InPageAuthorityOptions): InPageAuthority {
  return new InPageAuthority(options);
}
