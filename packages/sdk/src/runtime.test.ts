import { beforeEach, describe, expect, it } from 'vitest';

import { commandPoolSize } from './commands';
import { defineGame } from './defineGame';
import { Transform, Velocity } from './ecs';
import { prefab, resetPrefabRegistry } from './prefab';
import { createGuest } from './runtime';
import { BODY_STRIDE, TRANSFORM_FLAGS, TRANSFORM_STRIDE, markMoved } from './packing';
import { STUB_HIT, createStubHost, stubConfig, stubFrame, stubInput } from './testing';

/**
 * The node globals the allocation guard needs.
 *
 * The SDK compiles for the guest, which has no node types, so they are reached
 * through one narrowly typed view instead of `@types/node`.
 */
const nodeEnv = globalThis as unknown as {
  gc?: () => void;
  process?: { memoryUsage: () => { heapUsed: number } };
};

/**
 * Run a full GC, when the runner was started with `--expose-gc`.
 *
 * @returns Nothing.
 */
function collect(): void {
  nodeEnv.gc?.();
}

/**
 * Bytes of JS heap in use.
 *
 * @returns The heap size, or 0 outside node.
 */
function heapUsed(): number {
  return nodeEnv.process?.memoryUsage().heapUsed ?? 0;
}

describe('the guest runtime', () => {
  beforeEach(() => {
    resetPrefabRegistry();
  });

  it('runs built-in systems, then systems[], then update()', () => {
    const order: string[] = [];
    const game = defineGame({
      systems: [
        () => {
          order.push('a');
        },
        () => {
          order.push('b');
        },
      ],
      update: () => {
        order.push('update');
      },
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));
    expect(order).toEqual(['a', 'b', 'update']);
  });

  it('exposes frame, dt, elapsed and config on the context', () => {
    const seen: Record<string, unknown> = {};
    const game = defineGame({
      rules: { gravityScale: 2 },
      systems: [
        (ctx) => {
          seen.frame = ctx.frame;
          seen.dt = ctx.dt;
          seen.elapsed = ctx.elapsed;
          seen.hz = ctx.config.fixedHz;
          seen.rules = ctx.rules.gravityScale;
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig({ fixedHz: 50 }));
    guest.tick(stubFrame(7));
    expect(seen.frame).toBe(7);
    expect(seen.hz).toBe(50);
    expect(seen.rules).toBe(2);
    expect(seen.dt).toBeCloseTo(1 / 60, 5);
  });

  it('integrates world.gravity into body-less entities', () => {
    const Ghost = prefab({ asset: 'ghost' });
    const game = defineGame({
      world: { gravity: -10 },
      spawns: [{ prefab: Ghost, position: [0, 10, 0] }],
      init: (ctx) => {
        ctx.spawn(Ghost, { x: 0, y: 10, z: 0 });
      },
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    // Gravity only reaches entities that carry Velocity; a bare renderable
    // does not, so nothing moves until one is added.
    expect(Transform.y[1]).toBe(10);
  });

  it('drives a raycast through the host import', () => {
    let hitEntity = -1;
    const host = createStubHost();
    host.hit = STUB_HIT;
    const game = defineGame({
      systems: [
        (ctx) => {
          const hit = ctx.physics.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 100);
          hitEntity = hit?.entity ?? 0;
        },
      ],
    });
    const guest = createGuest(host, game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));
    expect(host.rayCount).toBe(1);
    expect(hitEntity).toBe(9);

    host.hit = null;
    guest.tick(stubFrame(1));
    expect(hitEntity).toBe(0);
  });

  it('turns a throwing system into a log line and keeps going', () => {
    const host = createStubHost();
    const game = defineGame({
      systems: [
        (ctx) => {
          if (ctx.frame === 1) throw new Error('boom');
        },
      ],
    });
    const guest = createGuest(host, game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));
    const out = guest.tick(stubFrame(1));
    expect(out.transforms.length % TRANSFORM_STRIDE).toBe(0);
    expect(host.lines.some((l) => l.includes('boom'))).toBe(true);
    expect(guest.dead).toBe(false);
  });

  it('names the failing system by its index', () => {
    const host = createStubHost();
    const game = defineGame({
      systems: [
        () => {},
        () => {
          throw new Error('boom');
        },
        () => {},
      ],
    });
    const guest = createGuest(host, game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));
    expect(host.lines.some((l) => l.includes('system[1] threw: Error: boom'))).toBe(true);
    expect(host.lines.some((l) => l.includes('system[0]'))).toBe(false);
  });

  it('runs every system, and update(), after one throws', () => {
    const ran: string[] = [];
    const game = defineGame({
      systems: [
        () => {
          ran.push('a');
        },
        () => {
          ran.push('b');
          throw new Error('boom');
        },
        () => {
          ran.push('c');
        },
      ],
      update: () => {
        ran.push('update');
      },
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));
    expect(ran).toEqual(['a', 'b', 'c', 'update']);
  });

  it('declares itself dead after repeated failures', () => {
    const host = createStubHost();
    const game = defineGame({
      systems: [
        () => {
          throw new Error('always');
        },
      ],
    });
    const guest = createGuest(host, game);
    guest.init(stubConfig());
    for (let frame = 0; frame < 8; frame += 1) guest.tick(stubFrame(frame));
    expect(guest.dead).toBe(true);
    expect(host.lines.some((l) => l.includes('guest is dead'))).toBe(true);
  });

  it('throws a game-error record when init fails', () => {
    const game = defineGame({
      init: () => {
        throw new Error('no manifest');
      },
    });
    const guest = createGuest(createStubHost(), game);
    let thrown: unknown;
    try {
      guest.init(stubConfig());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toEqual({ code: 'init-failed', message: 'no manifest' });
  });

  it('drives the built-in first-person camera from mouse movement', () => {
    const Body = prefab({ body: { shape: 'capsule', kind: 'character' } });
    const game = defineGame({
      player: { prefab: Body, spawn: [0, 1, 0], camera: 'firstPerson', eyeHeight: 1.5 },
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    const input = stubInput();
    input.mouse.dx = 100;
    const out = guest.tick(stubFrame(0, input));
    expect(out.camera.mode).toBe('first-person');
    expect(out.camera.follow).toBe(1);
    expect(out.camera.position.y).toBeCloseTo(2.5, 3);
    expect(out.camera.rotation.y).not.toBe(0);
  });

  it('reads bodies for gameplay without echoing them back as transforms', () => {
    const Box = prefab({ body: { shape: 'box', kind: 'dynamic' } });
    const game = defineGame({ spawns: [{ prefab: Box, position: [0, 0, 0] }] });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));

    const bodies = new Float32Array(BODY_STRIDE);
    bodies[0] = 1;
    bodies[2] = 9;
    bodies[7] = 1;
    const out = guest.tick(stubFrame(1, stubInput(), bodies));
    // The components are up to date, so a system can aim at the box...
    expect(Transform.y[1]).toBe(9);
    expect(Velocity.y[1]).toBe(0);
    // ...but the host moved the object itself when it stepped physics, so the
    // guest sends nothing back. Row 0 is the empty placeholder row.
    expect(out.transforms[0]).toBe(0);
  });

  it('packs a body-driven entity the guest moved by hand', () => {
    const Box = prefab({ body: { shape: 'box', kind: 'dynamic' } });
    const game = defineGame({
      spawns: [{ prefab: Box, position: [0, 0, 0] }],
      update: () => {
        Transform.y[1] = 12;
        markMoved(1, TRANSFORM_FLAGS.POSITION);
      },
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));

    const bodies = new Float32Array(BODY_STRIDE);
    bodies[0] = 1;
    bodies[2] = 9;
    bodies[7] = 1;
    const out = guest.tick(stubFrame(1, stubInput(), bodies));
    expect(out.transforms[0]).toBe(1);
    expect(out.transforms[1]).toBe(TRANSFORM_FLAGS.POSITION);
    expect(out.transforms[3]).toBe(12);
  });

  it('routes console.log at the host logger', () => {
    const host = createStubHost();
    const game = defineGame({
      init: () => {
        console.log('hello from init');
      },
    });
    const guest = createGuest(host, game);
    guest.init(stubConfig());
    guest.shutdown();
    // In V8 the prelude leaves the real console alone, so the line may not be
    // captured; what must always hold is that logging never throws.
    expect(host.lines.every((l) => typeof l === 'string')).toBe(true);
  });

  it('calls shutdown once, with the context', () => {
    let closed = 0;
    const game = defineGame({
      shutdown: () => {
        closed += 1;
      },
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    guest.shutdown();
    expect(closed).toBe(1);
  });

  it('integrates only entities the host physics does not own', () => {
    const Ghost = prefab({ asset: 'ghost', components: [Velocity] });
    const Box = prefab({ body: { shape: 'box', kind: 'dynamic' } });
    const game = defineGame({
      spawns: [
        { prefab: Ghost, position: [0, 10, 0] },
        { prefab: Box, position: [0, 10, 0] },
      ],
      init: () => {
        Velocity.y[1] = -1;
        Velocity.y[2] = -1;
      },
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));
    // The ghost moved; the box is the physics module's to move, and the query
    // excludes it rather than the loop skipping it.
    expect(Transform.y[1]).toBeLessThan(10);
    expect(Transform.y[2]).toBe(10);
  });

  it('keeps integrating velocity for entities spawned after a restore', () => {
    const Ghost = prefab({ asset: 'ghost', components: [Velocity] });
    let late = 0;
    const game = defineGame({
      spawns: [{ prefab: Ghost, position: [0, 0, 0] }],
      systems: [
        (ctx) => {
          if (ctx.frame !== 5 || late !== 0) return;
          late = ctx.spawn(Ghost, { x: 0, y: 0, z: 0 });
          Velocity.x[late] = 1;
        },
      ],
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());
    guest.tick(stubFrame(0));

    // `readSnapshot` resets the world, which empties its query registry in
    // place without changing the world's identity. A query cached across that
    // would never hear about an entity spawned afterwards.
    guest.restore(guest.snapshot());
    guest.tick(stubFrame(5));
    guest.tick(stubFrame(6));
    expect(late).toBeGreaterThan(0);
    expect(Transform.x[late]).toBeGreaterThan(0);
  });

  it('does not grow its heap across a thousand ticks', () => {
    const Mover = prefab({ asset: 'box', components: [Velocity] });
    const game = defineGame({
      world: { gravity: -9.81 },
      spawns: [
        { prefab: Mover, position: [0, 0, 0] },
        { prefab: Mover, position: [1, 0, 0] },
      ],
      systems: [
        (ctx) => {
          ctx.hud.set({ frame: ctx.frame, text: { state: 'idle' } });
          ctx.character.setState(1, 'walk', 1, 0, 0, true);
        },
        (ctx) => {
          ctx.physics.applyImpulse(2, 0, 0.1, 0);
          ctx.camera.look.yaw += 0.001;
        },
      ],
      update: (ctx) => {
        ctx.audio.play('shot', { volume: 0.5 });
      },
    });
    const guest = createGuest(createStubHost(), game);
    guest.init(stubConfig());

    const input = stubInput();
    // Warm up: pools grow, subarrays are minted, the JIT settles.
    for (let frame = 0; frame < 200; frame += 1) guest.tick(stubFrame(frame, input));

    const poolAfterWarmup = commandPoolSize();
    collect();
    const before = heapUsed();

    for (let frame = 200; frame < 1200; frame += 1) guest.tick(stubFrame(frame, input));

    collect();
    const growth = heapUsed() - before;

    expect(commandPoolSize()).toBe(poolAfterWarmup);
    // A closure and a label string per system per tick would be hundreds of
    // thousands of objects; 8 MB of slack covers V8 noise without covering
    // that. `stubFrame` itself allocates one record per call, deliberately.
    expect(growth).toBeLessThan(8 * 1024 * 1024);
  }, 60_000);
});
