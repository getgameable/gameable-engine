/**
 * The latency rig: the game as a real room's authority (our `Room`, direct
 * guest, Jolt), and pages that join it over a slowed link, each a headless
 * engine with the client loop, its own Jolt world and the game's own client
 * guest, predicting. The clock is the test's: `tick` moves the room, the
 * link and every page by one 60 Hz step.
 *
 * Each side imports its own copy of the SDK and the game (`vi.resetModules`
 * between them), as a room server and a browser tab do: two direct guests in
 * one module graph would share the SDK's component arrays. The floor is a
 * flat box on both sides, the same one.
 */
import type { Room, RoomPorts } from 'gameable/net/server';
import type { Transport } from 'gameable/net';
import type { PhysicsService } from 'gameable/physics';
import { vi } from 'vitest';

/** One 60 Hz step, milliseconds. */
export const STEP_MS = 1000 / 60;

/** `staticGeometry` is bit 1 of the WIT `collision-layers` flags. */
const STATIC = 1 << 1;

/**
 * The arena floor: a flat box whose top is y = 0.
 *
 * @param world A physics world.
 * @param id Its body id, outside the guest's range.
 */
function addFloor(world: PhysicsService, id: number): void {
  world.addBody({
    id,
    shape: 'box',
    dims: [12, 0.5, 12],
    position: [0, -0.5, 0],
    rotation: [0, 0, 0, 1],
    mass: 0,
    kind: 'static',
    layer: STATIC,
    mask: 0xffff,
    friction: 0.8,
    restitution: 0,
  });
}

/** A room clock and its timers, moved by the test. */
class Ports implements RoomPorts {
  t = 0;
  readonly ends = new Map<string, Transport>();
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  private seed = 1;

  now(): number {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }
  random(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }
  send(conn: string, data: string | Uint8Array): void {
    this.ends.get(conn)?.send(typeof data === 'string' ? data : data.slice());
  }
  drop(conn: string, reason: string): void {
    this.ends.get(conn)?.close(reason);
    this.ends.delete(conn);
  }
  log(): void {}

  /** @param ms How far to move the clock, firing every timer that comes due. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }
}

/** The room's authority, as the test reads it. */
export interface Authority {
  room: Room;
  ports: Ports;
  /** @returns A new socket to the room, slowed by `ms` each way. */
  connect(): Transport;
  /** The entity a seat controls on the authority. */
  entityOf(seat: number): number;
  /** Where the authority has an entity, metres. */
  position(entity: number): { x: number; y: number; z: number };
  close(): Promise<void>;
}

/**
 * The game as a room's authority, reached over `latencyPair({ ms })`.
 *
 * @param ms Link latency each way, milliseconds.
 * @returns The authority.
 */
export async function startAuthority(ms: number): Promise<Authority> {
  vi.resetModules();
  const { createEngineRoomGame, createRoom } = await import('gameable/net/server');
  const { latencyPair } = await import('gameable/net/testing');
  const { Transform } = await import('gameable');
  const definition = (await import('../src/game')).default;
  const manifest = (await import('../src/assets.json')).default;
  const { PHYSICS_OPTIONS } = await import('../src/physicsOptions');
  const game = await createEngineRoomGame({
    definition,
    // The game's ids, without the arena's collider file: the floor is `prepareWorld`'s.
    manifest: {
      version: 1,
      assets: manifest.assets.map((asset) => ({ ...asset, collider: undefined })),
    },
    physicsOptions: { gravity: [...PHYSICS_OPTIONS.gravity], maxBodies: 64 },
    prepareWorld: (world) => {
      addFloor(world, 900);
    },
    seed: 7,
  });
  const ports = new Ports();
  const room = createRoom({ code: 'BRWL', game, ports, sendHz: 20 });
  let conns = 0;
  return {
    room,
    ports,
    connect: () => {
      const [client, server] = latencyPair({ ms });
      conns += 1;
      const conn = `c${String(conns)}`;
      ports.ends.set(conn, server);
      server.onMessage((data) => {
        room.handle(conn, data);
      });
      server.onClose(() => {
        room.disconnect(conn);
      });
      return client;
    },
    entityOf: (seat) => game.entityOf(seat),
    position: (entity) => ({
      x: Transform.x[entity],
      y: Transform.y[entity],
      z: Transform.z[entity],
    }),
    close: async () => {
      room.close('ended');
      await game.disposed;
    },
  };
}
