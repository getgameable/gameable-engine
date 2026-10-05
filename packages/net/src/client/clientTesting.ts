/**
 * Test doubles for the client: a real `Room` over the tiny game, reached
 * through loopback transports, and an adapter that records what it is told.
 * Not exported from the package.
 */
import type {
  CameraState,
  FrameOutput,
  GameDefinition,
  GameEvent,
  HostFrameInput,
  HostApi,
  HostGameConfig,
} from '@gameable/sdk';
import { NullEngineAdapter, type NullAdapter, type Sandbox } from '@gameable/wasm-host';

import type { ClientText } from '../protocol/types.js';
import { parseClientText } from '../protocol/textFrameFunctions.js';
import { createEngineRoomGame } from '../server/room/createEngineRoomGame.js';
import type { EngineRoomGame } from '../server/room/EngineRoomGame.js';
import { createRoom, type Room } from '../server/room/Room.js';
import { FakePorts } from '../server/room/roomTesting.js';
import { loopbackPair } from '../transport/LoopbackTransport.js';
import type { Transport } from '../transport/Transport.js';

/** The tiny game's manifest, as the room tests use it. */
export const TINY_MANIFEST = {
  version: 1,
  assets: [
    { id: 'arena', type: 'splat', src: 'a.spz' },
    { id: 'enemy-capsule', type: 'gltf', src: 'e.glb' },
    { id: 'shot', type: 'audio', src: 's.wav' },
  ],
};

/** @returns The tiny-game fixture's definition, loaded by URL. */
export async function loadTinyGame(): Promise<GameDefinition> {
  const url = new URL('../../../../fixtures/tiny-game/src/game.ts', import.meta.url);
  return ((await import(url.href)) as { default: GameDefinition }).default;
}

/**
 * @param ms How long the macrotask waits.
 * @returns A promise that settles after pending microtasks and one macrotask.
 */
export function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Room ports whose `send` and `drop` reach a loopback transport per connection. */
class LoopbackPorts extends FakePorts {
  readonly ends = new Map<string, Transport>();

  override send(conn: string, data: string | Uint8Array): void {
    this.ends.get(conn)?.send(data);
  }

  override drop(conn: string, reason: string): void {
    super.drop(conn, reason);
    const end = this.ends.get(conn);
    this.ends.delete(conn);
    end?.close(reason);
  }
}

/** What one connection sent the room. */
export interface Inbound {
  /** Text frames, parsed. */
  texts: ClientText[];
  /** INPUT frames, in order. */
  inputs: Uint8Array[];
}

/**
 * A real room over the tiny game, on a clock the test moves, reached through
 * `connect()`: each call is one new socket.
 */
export class LoopbackRoomServer {
  /** What each connection sent, by connection id (`c1`, `c2`, ...). */
  readonly inbound = new Map<string, Inbound>();
  /** Makes each socket's two ends; set `latencyPair`'s to slow the link down. */
  pair: () => [Transport, Transport] = loopbackPair;
  private next = 0;

  /**
   * @param room The room.
   * @param game Its game.
   * @param ports The ports the room was built on.
   */
  constructor(
    readonly room: Room,
    readonly game: EngineRoomGame,
    readonly ports: LoopbackPorts,
  ) {}

  /** @returns A fresh client transport to the room (pass it as a connection's `connect`). */
  readonly connect = (): Transport => {
    const [client, server] = this.pair();
    this.next += 1;
    const conn = `c${String(this.next)}`;
    const inbound: Inbound = { texts: [], inputs: [] };
    this.inbound.set(conn, inbound);
    this.ports.ends.set(conn, server);
    server.onMessage((data) => {
      if (typeof data === 'string') {
        const parsed = parseClientText(data);
        if (parsed !== null) inbound.texts.push(parsed);
      } else {
        inbound.inputs.push(data);
      }
      this.room.handle(conn, data);
    });
    server.onClose(() => {
      this.room.disconnect(conn);
    });
    return client;
  };

  /** @returns The id of the newest connection. */
  get lastConn(): string {
    return `c${String(this.next)}`;
  }

  /** Advance the room's clock by one 60 Hz tick. */
  step(): void {
    this.ports.advance(1000 / 60);
  }

  /**
   * Cut a connection the way a lost network does: the room sees a disconnect
   * and holds the seat.
   *
   * @param conn The connection id.
   */
  cut(conn: string): void {
    const end = this.ports.ends.get(conn);
    this.ports.ends.delete(conn);
    end?.close('lost');
  }

  /** Close the room and dispose its game. */
  async close(): Promise<void> {
    this.room.close('ended');
    await this.game.disposed;
  }
}

/**
 * @param maxPlayers The room's seats.
 * @returns A room over the tiny game, gravity on, seed 7.
 */
export async function tinyRoomServer(maxPlayers = 4): Promise<LoopbackRoomServer> {
  const game = await createEngineRoomGame({
    definition: await loadTinyGame(),
    manifest: TINY_MANIFEST,
    maxPlayers,
    seed: 7,
  });
  const ports = new LoopbackPorts();
  const room = createRoom({ code: 'SOLO', game, ports, maxPlayers, sendHz: 20 });
  return new LoopbackRoomServer(room, game, ports);
}

/** One row the client loop wrote. */
export interface HostRow {
  entity: number;
  flags: number;
  position: number[];
  /** How many fixed steps had begun when it was written. */
  step: number;
}

/** A recording adapter with the client loop's extra members. */
export interface TestClientAdapter extends NullAdapter {
  readonly events: never[];
  /** `begin`, then each applied command's method name, in call order. */
  readonly log: string[];
  readonly rows: HostRow[];
  bodyRows: number;
  cameras: CameraState[];
  beginFixedStep(): void;
  applyBodyRows(rows: Float32Array, count: number): void;
  setTransformFromHost(
    entity: number,
    flags: number,
    position: ArrayLike<number>,
    rotation: ArrayLike<number>,
    scale: ArrayLike<number>,
  ): void;
  update(dt: number, alpha: number): void;
  dispose(): void;
}

/** @returns A recording adapter for `createClientLoop`. */
export function testClientAdapter(): TestClientAdapter {
  const base = NullEngineAdapter() as TestClientAdapter;
  const log: string[] = [];
  let steps = 0;
  const spawn = base.spawn.bind(base);
  const despawn = base.despawn.bind(base);
  const setCamera = base.setCamera.bind(base);
  return Object.assign(base, {
    events: [],
    log,
    rows: [] as HostRow[],
    bodyRows: 0,
    cameras: [] as CameraState[],
    spawn: (...args: Parameters<NullAdapter['spawn']>) => {
      log.push('spawn');
      spawn(...args);
    },
    despawn: (entity: number) => {
      log.push('despawn');
      despawn(entity);
    },
    setCamera: (camera: CameraState) => {
      base.cameras.push(camera);
      setCamera(camera);
    },
    beginFixedStep: () => {
      log.push('begin');
      steps += 1;
    },
    applyBodyRows: () => {
      base.bodyRows += 1;
    },
    setTransformFromHost: (entity: number, flags: number, position: ArrayLike<number>) => {
      log.push('row');
      base.rows.push({ entity, flags, position: Array.from(position), step: steps });
    },
    update: () => undefined,
    dispose: () => undefined,
  });
}

/** The client guest's own frame camera in the stub: fov 33, so a test can tell it apart. */
export const GUEST_CAMERA: CameraState = {
  mode: 'free',
  projection: 'perspective',
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  fovYDeg: 33,
  near: 0.1,
  far: 100,
  armLength: 0,
  offset: { x: 0, y: 0, z: 0 },
};

/** A sandbox that records what it is given and returns a scripted frame. */
export class StubSandbox implements Sandbox {
  readonly mode = 'direct';
  readonly inits: HostGameConfig[] = [];
  readonly inputs: HostFrameInput[] = [];
  /** Each tick's events, copied (the loop reuses its event list). */
  readonly events: GameEvent[][] = [];
  dead = false;
  error: Error | null = null;
  /** Set to make the next `init` throw. */
  failInit: Error | null = null;
  /** What `tick` returns. */
  output: FrameOutput = {
    transforms: new Float32Array(0),
    commands: [],
    localCommands: [],
    camera: GUEST_CAMERA,
    hud: undefined,
  };

  init(config: HostGameConfig): void {
    if (this.failInit !== null) throw this.failInit;
    this.inits.push(config);
  }
  tick(input: HostFrameInput): FrameOutput {
    this.inputs.push(input);
    this.events.push([...input.events]);
    return this.output;
  }
  shutdown(): void {}
  snapshot(): Uint8Array {
    return new Uint8Array(0);
  }
  restore(): void {}
}

/** @returns A `HostApi` with nothing behind it: a client guest asks the authority, not the host. */
export function stubHost(): HostApi {
  return {
    log: () => undefined,
    seed: () => 7,
    nowMs: () => 0,
    raycast: () => null,
    raycastBatch: () => [],
    overlapSphere: () => [],
    resolveId: () => null,
    describe: () => null,
  };
}
