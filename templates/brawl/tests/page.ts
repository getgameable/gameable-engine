/**
 * One player's page for the latency rig (`tests/room.ts`): a headless engine
 * with an input module the test presses keys on, a Jolt world holding the
 * floor and the page's own body, the client loop with `predict: true`, and
 * the game's own client guest, direct, in a module graph of its own.
 */
import type { EngineModule } from 'gameable/core';
import type { Transport } from 'gameable/net';
import type { HostApi } from 'gameable';
import { vi } from 'vitest';

/** A page, as the test drives and reads it. */
export interface Page {
  /** This page's seat, once welcomed (-1 before). */
  readonly seat: number;
  /** The entity this page's player controls (0 before the welcome). */
  readonly entity: number;
  /** Hold a key down, or let it go with `false`. */
  hold(key: string, down?: boolean): void;
  /** Press a key for the next step only (a `pressed` edge). */
  tap(key: string): void;
  /** One rendered frame of `ms` milliseconds. */
  frame(ms: number): void;
  /** Where this page last drew an entity, or null. */
  drawn(entity: number): { x: number; y: number; z: number } | null;
  /** Confirmed hits this page's client guest heard, as attacker or victim. */
  hits(): number;
  /** Errors the client loop died of. */
  readonly deaths: unknown[];
  close(): Promise<void>;
}

/**
 * @param resolve The client guest's asset names, in manifest order.
 * @returns A host for a client guest: asset ids resolve, queries find nothing.
 */
function clientHost(resolve: readonly string[]): HostApi {
  return {
    log: () => undefined,
    seed: () => 7,
    nowMs: () => 0,
    raycast: () => null,
    raycastBatch: () => [],
    overlapSphere: () => [],
    resolveId: (name) => {
      const index = resolve.indexOf(name);
      return index < 0 ? null : index + 1;
    },
    describe: () => null,
  };
}

/**
 * Open a page and start its join.
 *
 * @param connect Makes the page's socket to the room.
 * @param name The player's name.
 * @returns The page.
 */
export async function openPage(connect: () => Transport, name: string): Promise<Page> {
  vi.resetModules();
  const { createHeadlessEngine } = await import('gameable/core/headless');
  const { createClientLoop, createLoopbackConnection, createNetClient } =
    await import('gameable/net/client');
  const { physics } = await import('gameable/physics');
  const { keyIndex } = await import('gameable/sdk/keycodes');
  const { createGameSlot, createSandbox, NullEngineAdapter } = await import('gameable/host');
  const { createServerAdapter } = await import('gameable/host/server');
  const game = (await import('../src/game')).default;
  const { heard } = await import('../src/systems/controls');
  const { PHYSICS_OPTIONS } = await import('../src/physicsOptions');

  const state = {
    keysDown: new Uint32Array(8),
    keysPressed: new Uint32Array(8),
    keysReleased: new Uint32Array(8),
    mods: 0,
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
  const inputModule: EngineModule = {
    id: 'input',
    order: -100,
    init: () => ({ state }),
    dispose: () => undefined,
  };
  const setBit = (words: Uint32Array, key: string, on: boolean): void => {
    const bit = keyIndex(key);
    const mask = 1 << (bit & 31);
    words[bit >> 5] = on ? words[bit >> 5] | mask : words[bit >> 5] & ~mask;
  };

  const slot = createGameSlot();
  const engine = await createHeadlessEngine({
    modules: [inputModule, physics({ ...PHYSICS_OPTIONS, maxBodies: 64 }), slot.module],
    fixedHz: 60,
  });
  const world = engine.get('physics');
  world.addBody({
    id: 900,
    shape: 'box',
    dims: [12, 0.5, 12],
    position: [0, -0.5, 0],
    rotation: [0, 0, 0, 1],
    mass: 0,
    kind: 'static',
    layer: 1 << 1,
    mask: 0xffff,
    friction: 0.8,
    restitution: 0,
  });
  // The page's own body commands reach its Jolt world, the way the page adapter forwards them.
  const bodies = createServerAdapter(world, { warn: () => undefined });
  const latest = new Map<number, { x: number; y: number; z: number }>();
  const adapter = Object.assign(NullEngineAdapter(), {
    events: [] as never[],
    addBody: bodies.addBody.bind(bodies),
    removeBody: bodies.removeBody.bind(bodies),
    moveCharacter: bodies.moveCharacter.bind(bodies),
    beginFixedStep: () => undefined,
    applyBodyRows: () => undefined,
    setTransformFromHost: (entity: number, flags: number, position: ArrayLike<number>) => {
      if ((flags & 1) === 0) return; // RowFlag.POSITION
      latest.set(entity, { x: position[0], y: position[1], z: position[2] });
    },
    update: () => undefined,
    dispose: () => undefined,
  });
  const sandbox = await createSandbox({
    mode: 'direct',
    game,
    host: clientHost(['env.arena', 'char.fighter', 'sfx.hit']),
  });
  const net = createNetClient(createLoopbackConnection({ connect, backoff: { baseMs: 5 } }), {
    name,
    maxPlayers: 4,
  });
  const deaths: unknown[] = [];
  const loop = createClientLoop(engine, adapter, net, sandbox, {
    predict: true,
    onDead: (error) => deaths.push(error),
  });
  await slot.attach(loop, engine.ctx);
  net.start();
  engine.step(0);
  let t = 0;
  let tapped: string | null = null;

  return {
    get seat() {
      return net.localPlayer;
    },
    get entity() {
      return net.localEntity;
    },
    hold: (key, down = true) => {
      setBit(state.keysDown, key, down);
    },
    tap: (key) => {
      setBit(state.keysDown, key, true);
      setBit(state.keysPressed, key, true);
      tapped = key;
    },
    frame: (ms) => {
      t += ms;
      engine.step(t);
      if (tapped !== null) {
        setBit(state.keysDown, tapped, false);
        setBit(state.keysPressed, tapped, false);
        tapped = null;
      }
    },
    drawn: (entity) => latest.get(entity) ?? null,
    hits: () => heard.hits,
    deaths,
    close: async () => {
      net.leave('done');
      await engine.dispose();
    },
  };
}
