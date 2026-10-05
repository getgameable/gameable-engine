import v8 from 'node:v8';
import vm from 'node:vm';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadJolt, type JoltModule } from './jolt.js';
import { convexHullFromPoints, meshShapeFromGeometry } from './mesh.js';
import {
  BODY_STRIDE,
  RAY_HIT_STRIDE,
  RAY_STRIDE,
  createContactRecord,
  createPhysicsWorld,
  type BodyArgs,
  type ContactRecord,
  type PhysicsWorld,
} from './world.js';

/** Layer bits used across the suite. */
const L_WORLD = 0b0001;
const L_PROP = 0b0010;
const L_PLAYER = 0b0100;
const ALL = 0xffff;

let jolt: JoltModule;

/** Worlds created by a test, torn down afterwards. */
const live: PhysicsWorld[] = [];

beforeAll(async () => {
  jolt = await loadJolt();
}, 60_000);

afterEach(() => {
  while (live.length > 0) live.pop()?.dispose();
});

/**
 * Create a world that is disposed when the test ends.
 *
 * @returns A fresh world.
 */
function makeWorld(): PhysicsWorld {
  const world = createPhysicsWorld(jolt, { gravity: [0, -9.81, 0], maxBodies: 256 });
  live.push(world);
  return world;
}

/**
 * Body args with the boring fields filled in.
 *
 * @param overrides Fields to set.
 * @returns Complete body args.
 */
function body(overrides: Partial<BodyArgs> & Pick<BodyArgs, 'id'>): BodyArgs {
  return {
    shape: 'box',
    dims: [0.5, 0.5, 0.5],
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    mass: 1,
    kind: 'dynamic',
    layer: L_PROP,
    mask: ALL,
    friction: 0.5,
    restitution: 0,
    ...overrides,
  };
}

/**
 * Add a 20x1x20 static floor with its top face at y = 0.
 *
 * @param world The world.
 * @param id Body id to use.
 */
function addFloor(world: PhysicsWorld, id = 1): void {
  world.addBody(
    body({
      id,
      shape: 'box',
      dims: [10, 0.5, 10],
      position: [0, -0.5, 0],
      mass: 0,
      kind: 'static',
      layer: L_WORLD,
    }),
  );
}

/**
 * Force a garbage collection, so a heap reading measures retained bytes rather
 * than whatever V8 has not swept yet.
 *
 * `--expose-gc` is not on in the default vitest run, so `globalThis.gc` is
 * undefined there and the flag is turned on just long enough to pull `gc` out
 * of a fresh context. Without it a heap delta reads the ~7.5 MB of garbage a
 * thousand frames leave behind, minus whatever a scavenge happened to sweep.
 *
 * @throws {Error} When no collector can be obtained.
 */
function collectGarbage(): void {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    return;
  }
  v8.setFlagsFromString('--expose-gc');
  const fn: unknown = vm.runInNewContext('gc');
  v8.setFlagsFromString('--no-expose-gc');
  // A heap delta without a collection is the noise this exists to remove.
  if (typeof fn !== 'function') throw new Error('could not obtain gc for a heap reading');
  (fn as () => void)();
}

describe('loadJolt', () => {
  it('loads the wasm module in node and hands back the Jolt namespace', () => {
    expect(typeof jolt.JoltInterface).toBe('function');
    expect(typeof jolt.destroy).toBe('function');
  });

  it('is a singleton: a second call returns the same module', async () => {
    expect(await loadJolt()).toBe(jolt);
  });

  it('refuses a second, different wasm url', () => {
    expect(() => loadJolt({ wasmUrl: 'https://example.invalid/jolt.wasm' })).toThrow(
      /refusing to load a second Jolt module/,
    );
  });
});

describe('simulation', () => {
  it('drops a box onto a static floor and lets it come to rest', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(body({ id: 2, position: [0, 5, 0] }));

    const out = new Float32Array(4 * BODY_STRIDE);
    for (let i = 0; i < 300; i += 1) world.step(1 / 60);
    const rows = world.readBodies(out);

    expect(rows).toBe(1);
    const y = out[2];
    // Half extent 0.5 with the floor top at y = 0, minus Jolt's penetration slop.
    expect(y).toBeGreaterThan(0.45);
    expect(y).toBeLessThan(0.52);
    expect(Math.abs(out[9])).toBeLessThan(0.01);
  });

  it('never lets a body fall through the floor over a long run', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(body({ id: 2, shape: 'sphere', dims: [0.4], position: [0, 3, 0] }));
    const out = new Float32Array(BODY_STRIDE);
    for (let i = 0; i < 600; i += 1) {
      world.step(1 / 60);
      world.readBodies(out);
      expect(out[2]).toBeGreaterThan(0);
    }
  });
});

describe('readBodies', () => {
  it('writes stride-15 rows, ascending by id, skipping static bodies', () => {
    const world = makeWorld();
    addFloor(world, 10);
    world.addBody(body({ id: 7, position: [1, 2, 3] }));
    world.addBody(body({ id: 3, position: [-1, 4, 0], kind: 'kinematic' }));

    const out = new Float32Array(8 * BODY_STRIDE);
    const rows = world.readBodies(out);

    expect(rows).toBe(2);
    expect(out[0]).toBe(3);
    expect(out[BODY_STRIDE]).toBe(7);
    // Row 1 is body 7 at (1, 2, 3) with an identity quaternion.
    expect(out[BODY_STRIDE + 1]).toBeCloseTo(1, 5);
    expect(out[BODY_STRIDE + 2]).toBeCloseTo(2, 5);
    expect(out[BODY_STRIDE + 3]).toBeCloseTo(3, 5);
    expect(out[BODY_STRIDE + 4]).toBeCloseTo(0, 5);
    expect(out[BODY_STRIDE + 7]).toBeCloseTo(1, 5);
    // Velocity lanes exist and start at rest.
    for (let i = 8; i < 14; i += 1) expect(out[BODY_STRIDE + i]).toBeCloseTo(0, 5);
  });

  it('reports the rows it wanted when the buffer is too small', () => {
    const world = makeWorld();
    for (let i = 0; i < 5; i += 1) world.addBody(body({ id: i + 1, position: [i, 1, 0] }));

    const small = new Float32Array(2 * BODY_STRIDE);
    expect(world.readBodies(small)).toBe(5);
    expect(small[0]).toBe(1);
    expect(small[BODY_STRIDE]).toBe(2);

    const grown = new Float32Array(5 * BODY_STRIDE);
    expect(world.readBodies(grown)).toBe(5);
    expect(grown[4 * BODY_STRIDE]).toBe(5);
  });

  it('drops disabled bodies and brings them back', () => {
    const world = makeWorld();
    world.addBody(body({ id: 1, position: [0, 1, 0] }));
    world.addBody(body({ id: 2, position: [0, 2, 0] }));
    const out = new Float32Array(4 * BODY_STRIDE);

    expect(world.readBodies(out)).toBe(2);
    world.setEnabled(1, false);
    expect(world.readBodies(out)).toBe(1);
    expect(out[0]).toBe(2);
    world.setEnabled(1, true);
    expect(world.readBodies(out)).toBe(2);
    expect(out[0]).toBe(1);
  });
});

describe('readBodies row mirror', () => {
  /**
   * Count calls to one `BodyInterface` method for the duration of `run`.
   *
   * The wrapper class's prototype is the only place a wasm crossing can be
   * observed from the outside, so this is how "did it cross?" gets asserted.
   *
   * @param method Method name on `BodyInterface`.
   * @param run What to measure.
   * @returns How many times the method was called.
   */
  function countCrossings(method: string, run: () => void): number {
    const proto = jolt.BodyInterface.prototype as unknown as Record<string, unknown>;
    const original = proto[method] as (...args: unknown[]) => unknown;
    let calls = 0;
    proto[method] = function counted(this: unknown, ...args: unknown[]): unknown {
      calls += 1;
      return original.apply(this, args);
    };
    try {
      run();
    } finally {
      proto[method] = original;
    }
    return calls;
  }

  it('replays a sleeping body instead of crossing for it, and wakes on a setter', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(body({ id: 2, position: [0, 1, 0] }));
    const out = new Float32Array(4 * BODY_STRIDE);
    // Long enough for the box to land and for Jolt to put it to sleep.
    for (let i = 0; i < 400; i += 1) {
      world.step(1 / 60);
      world.readBodies(out);
    }
    const restY = out[2];

    const asleep = countCrossings('GetPositionAndRotation', () => {
      for (let i = 0; i < 60; i += 1) {
        world.step(1 / 60);
        world.readBodies(out);
      }
    });
    expect(asleep).toBe(0);
    // The replayed row is the real one, not a zeroed one.
    expect(out[0]).toBe(2);
    expect(out[2]).toBeCloseTo(restY, 6);

    // Every setter drops the mirror, so a teleported sleeper reads true at once.
    const moved = countCrossings('GetPositionAndRotation', () => {
      world.setTransform(2, [3, 4, 5], [0, 0, 0, 1]);
      world.readBodies(out);
    });
    expect(moved).toBeGreaterThan(0);
    expect(out[1]).toBeCloseTo(3, 4);
    expect(out[2]).toBeCloseTo(4, 4);
  });

  it('keys the mirror by body id, not by row index', () => {
    const world = makeWorld();
    addFloor(world, 10);
    world.addBody(body({ id: 1, position: [-3, 1, 0] }));
    world.addBody(body({ id: 2, position: [3, 1, 0] }));
    const out = new Float32Array(4 * BODY_STRIDE);
    for (let i = 0; i < 400; i += 1) {
      world.step(1 / 60);
      world.readBodies(out);
    }

    // Disabling body 1 shifts body 2 from row 1 to row 0. A mirror indexed by
    // row would hand back body 1's cached position here.
    world.setEnabled(1, false);
    expect(world.readBodies(out)).toBe(1);
    expect(out[0]).toBe(2);
    expect(out[1]).toBeCloseTo(3, 2);
  });

  it('reads a body that has never been stepped', () => {
    const world = makeWorld();
    world.addBody(body({ id: 2, position: [7, 8, 9] }));
    const out = new Float32Array(BODY_STRIDE);
    expect(world.readBodies(out)).toBe(1);
    expect(out[1]).toBeCloseTo(7, 4);
    expect(out[2]).toBeCloseTo(8, 4);
    expect(out[3]).toBeCloseTo(9, 4);
  });
});

describe('queries', () => {
  it('raycasts onto a box and reports body, point and normal', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(body({ id: 2, position: [0, 1, 0], kind: 'static', layer: L_PROP }));

    const hit = world.raycast([0, 5, 0], [0, -1, 0], 10, ALL);
    expect(hit).not.toBeNull();
    if (hit === null) return;
    expect(hit.body).toBe(2);
    expect(hit.py).toBeCloseTo(1.5, 2);
    expect(hit.distance).toBeCloseTo(3.5, 2);
    expect(hit.ny).toBeCloseTo(1, 2);
  });

  it('honours the layer mask', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(body({ id: 2, position: [0, 1, 0], kind: 'static', layer: L_PROP }));

    expect(world.raycast([0, 5, 0], [0, -1, 0], 10, L_PROP)?.body).toBe(2);
    expect(world.raycast([0, 5, 0], [0, -1, 0], 10, L_WORLD)?.body).toBe(1);
    expect(world.raycast([0, 5, 0], [0, -1, 0], 10, L_PLAYER)).toBeNull();
  });

  it('misses when nothing is in range', () => {
    const world = makeWorld();
    addFloor(world);
    expect(world.raycast([0, 5, 0], [0, -1, 0], 1, ALL)).toBeNull();
    expect(world.raycast([0, 5, 0], [0, 1, 0], 100, ALL)).toBeNull();
  });

  it('batches rays and agrees with the single-ray path', () => {
    const world = makeWorld();
    addFloor(world);
    for (let i = 0; i < 4; i += 1) {
      world.addBody(body({ id: 10 + i, position: [i * 2, 1, 0], kind: 'static', layer: L_PROP }));
    }

    const count = 6;
    const rays = new Float32Array(count * RAY_STRIDE);
    for (let i = 0; i < count; i += 1) {
      rays.set([i * 2, 5, 0, 0, -1, 0, 20], i * RAY_STRIDE);
    }
    const out = new Float32Array(count * RAY_HIT_STRIDE);
    expect(world.raycastBatch(rays, ALL, out)).toBe(count);

    for (let i = 0; i < count; i += 1) {
      const single = world.raycast([i * 2, 5, 0], [0, -1, 0], 20, ALL);
      const o = i * RAY_HIT_STRIDE;
      expect(out[o]).toBe(1);
      expect(single).not.toBeNull();
      if (single === null) continue;
      expect(out[o + 1]).toBe(single.body);
      expect(out[o + 2]).toBeCloseTo(single.px, 4);
      expect(out[o + 3]).toBeCloseTo(single.py, 4);
      expect(out[o + 4]).toBeCloseTo(single.pz, 4);
      expect(out[o + 5]).toBeCloseTo(single.nx, 4);
      expect(out[o + 6]).toBeCloseTo(single.ny, 4);
      expect(out[o + 7]).toBeCloseTo(single.nz, 4);
      expect(out[o + 8]).toBeCloseTo(single.distance, 4);
    }
  });

  it('zeroes the batch row for a miss', () => {
    const world = makeWorld();
    const rays = new Float32Array([0, 5, 0, 0, -1, 0, 2]);
    const out = new Float32Array(RAY_HIT_STRIDE).fill(7);
    world.raycastBatch(rays, ALL, out);
    expect([...out]).toEqual(new Array<number>(RAY_HIT_STRIDE).fill(0));
  });

  it('finds overlapping bodies nearest first', () => {
    const world = makeWorld();
    world.addBody(body({ id: 1, position: [3, 0, 0], kind: 'static', layer: L_PROP }));
    world.addBody(body({ id: 2, position: [1, 0, 0], kind: 'static', layer: L_PROP }));
    world.addBody(body({ id: 3, position: [30, 0, 0], kind: 'static', layer: L_PROP }));
    world.addBody(body({ id: 4, position: [2, 0, 0], kind: 'static', layer: L_WORLD }));

    expect(world.overlapSphere([0, 0, 0], 5, L_PROP)).toEqual([2, 1]);
    expect(world.overlapSphere([0, 0, 0], 5, ALL)).toEqual([2, 4, 1]);
    expect(world.overlapSphere([0, 0, 0], 0.1, ALL)).toEqual([]);

    const ids = new Uint32Array(2);
    expect(world.overlapSphereInto([0, 0, 0], 5, ALL, ids)).toBe(3);
    expect([...ids]).toEqual([2, 4]);
  });
});

describe('characters', () => {
  /**
   * A capsule character standing on the floor at the origin.
   *
   * @param world The world.
   */
  function addCharacter(world: PhysicsWorld): void {
    world.addBody(
      body({
        id: 100,
        shape: 'capsule',
        dims: [0.3, 0.6],
        position: [0, 0.95, 0],
        mass: 70,
        kind: 'character',
        layer: L_PLAYER,
      }),
    );
  }

  it('walks along the desired velocity and stops at a wall', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(
      body({
        id: 2,
        shape: 'box',
        dims: [0.5, 2, 10],
        position: [3, 2, 0],
        mass: 0,
        kind: 'static',
        layer: L_WORLD,
      }),
    );
    addCharacter(world);

    const out = new Float32Array(BODY_STRIDE);
    world.moveCharacter(100, [2, 0, 0]);
    for (let i = 0; i < 30; i += 1) world.step(1 / 60);
    world.readBodies(out);
    // Half a second at 2 m/s, give or take the first grounded step.
    expect(out[1]).toBeGreaterThan(0.8);
    expect(out[1]).toBeLessThan(1.2);
    expect(world.groundState(100)).toBe('on-ground');

    for (let i = 0; i < 240; i += 1) world.step(1 / 60);
    world.readBodies(out);
    // The wall's near face is at x = 2.5; the capsule radius keeps it short of it.
    expect(out[1]).toBeGreaterThan(2);
    expect(out[1]).toBeLessThan(2.5);
    // And it stays there rather than creeping through.
    const stuckAt = out[1];
    for (let i = 0; i < 120; i += 1) world.step(1 / 60);
    world.readBodies(out);
    expect(out[1]).toBeCloseTo(stuckAt, 2);
  });

  it('falls under gravity and lands on the floor', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(
      body({
        id: 100,
        shape: 'capsule',
        dims: [0.3, 0.6],
        position: [0, 4, 0],
        mass: 70,
        kind: 'character',
        layer: L_PLAYER,
      }),
    );
    expect(world.groundState(100)).not.toBe('on-ground');

    const out = new Float32Array(BODY_STRIDE);
    for (let i = 0; i < 180; i += 1) world.step(1 / 60);
    world.readBodies(out);
    expect(out[2]).toBeCloseTo(0.9, 1);
    expect(world.groundState(100)).toBe('on-ground');
    expect(out[14]).toBe(1);
  });

  it('is not standing on a wall it is merely touching', () => {
    const world = makeWorld();
    // No floor: two walls with just enough gap for the capsule, and a
    // character falling between them. Contacts around the capsule's waist are
    // not the floor, whatever their slope, and the supporting volume is what
    // says so.
    for (const x of [-0.62, 0.62]) {
      world.addBody(
        body({
          id: x < 0 ? 1 : 2,
          shape: 'box',
          dims: [0.3, 3, 3],
          position: [x, 0, 0],
          mass: 0,
          kind: 'static',
          layer: L_WORLD,
        }),
      );
    }
    addCharacter(world);
    for (let i = 0; i < 30; i += 1) world.step(1 / 60);
    expect(world.groundState(100)).not.toBe('on-ground');
  });

  it('consumes a jump once rather than re-launching on every landing', () => {
    const world = makeWorld();
    addFloor(world);
    addCharacter(world);
    const out = new Float32Array(BODY_STRIDE);

    for (let i = 0; i < 10; i += 1) world.step(1 / 60);
    world.moveCharacter(100, [0, 6, 0]);
    // One jump, and then nobody says anything else about the vertical axis.
    let peaks = 0;
    let airborne = false;
    for (let i = 0; i < 400; i += 1) {
      world.step(1 / 60);
      world.readBodies(out);
      const high = out[2] > 1.4;
      if (high && !airborne) peaks += 1;
      airborne = high;
    }
    expect(peaks).toBe(1);
    world.readBodies(out);
    expect(out[2]).toBeCloseTo(0.9, 1);
  });

  it('stops stepping a disabled character without destroying its inner body', () => {
    const world = makeWorld();
    addFloor(world);
    addCharacter(world);
    const out = new Float32Array(2 * BODY_STRIDE);

    world.moveCharacter(100, [2, 0, 0]);
    for (let i = 0; i < 30; i += 1) world.step(1 / 60);
    world.readBodies(out);
    const parked = out[1];
    expect(parked).toBeGreaterThan(0.5);

    world.setEnabled(100, false);
    expect(world.movingBodyCount).toBe(0);
    for (let i = 0; i < 60; i += 1) world.step(1 / 60);

    // Back on, still the same controller, still where it was, still walking.
    world.setEnabled(100, true);
    expect(world.readBodies(out)).toBe(1);
    expect(out[1]).toBeCloseTo(parked, 2);
    world.moveCharacter(100, [2, 0, 0]);
    for (let i = 0; i < 30; i += 1) world.step(1 / 60);
    world.readBodies(out);
    expect(out[1]).toBeGreaterThan(parked + 0.5);
    expect(world.groundState(100)).toBe('on-ground');
  });

  it('jumps when the desired velocity points up, then lands again', () => {
    const world = makeWorld();
    addFloor(world);
    addCharacter(world);
    const out = new Float32Array(BODY_STRIDE);

    for (let i = 0; i < 10; i += 1) world.step(1 / 60);
    world.moveCharacter(100, [0, 5, 0]);
    for (let i = 0; i < 20; i += 1) world.step(1 / 60);
    world.readBodies(out);
    expect(out[2]).toBeGreaterThan(1.4);

    world.moveCharacter(100, [0, 0, 0]);
    for (let i = 0; i < 180; i += 1) world.step(1 / 60);
    world.readBodies(out);
    expect(out[2]).toBeCloseTo(0.9, 1);
    expect(world.groundState(100)).toBe('on-ground');
  });
});

describe('contacts', () => {
  it('fires begin and end around a collision, and stay only when asked', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(
      body({
        id: 2,
        position: [0, 1.2, 0],
        flags: { reportContacts: true, reportStay: true, noSleep: true },
      }),
    );

    const pool: ContactRecord[] = [];
    let begins = 0;
    let stays = 0;
    for (let i = 0; i < 120; i += 1) {
      world.step(1 / 60);
      const n = world.drainContacts(pool);
      for (let k = 0; k < n; k += 1) {
        const c = pool[k];
        expect(new Set([c.a, c.b])).toEqual(new Set([1, 2]));
        if (c.phase === 'begin') {
          begins += 1;
          expect(Math.abs(c.ny)).toBeCloseTo(1, 1);
          expect(c.py).toBeCloseTo(0, 1);
        }
        if (c.phase === 'stay') stays += 1;
      }
    }
    expect(begins).toBeGreaterThanOrEqual(1);
    expect(stays).toBeGreaterThan(10);

    // Yank the floor away and the contact ends.
    let ends = 0;
    world.removeBody(1);
    for (let i = 0; i < 30; i += 1) {
      world.step(1 / 60);
      const n = world.drainContacts(pool);
      for (let k = 0; k < n; k += 1) if (pool[k].phase === 'end') ends += 1;
    }
    expect(ends).toBeGreaterThanOrEqual(1);
  });

  it('keeps `stay` off while `reportContacts` is on', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(
      body({ id: 2, position: [0, 1.2, 0], flags: { reportContacts: true, noSleep: true } }),
    );

    const pool: ContactRecord[] = [];
    let begins = 0;
    let stays = 0;
    for (let i = 0; i < 200; i += 1) {
      world.step(1 / 60);
      const n = world.drainContacts(pool);
      for (let k = 0; k < n; k += 1) {
        if (pool[k].phase === 'begin') begins += 1;
        if (pool[k].phase === 'stay') stays += 1;
      }
    }
    // The edges still arrive; the per-step manifold of a resting box does not.
    expect(begins).toBeGreaterThanOrEqual(1);
    expect(stays).toBe(0);
  });

  it('says nothing at all for bodies that did not opt in', () => {
    const world = makeWorld();
    addFloor(world);
    // No `flags` whatsoever: reporting is off by default.
    world.addBody(body({ id: 2, position: [0, 1.2, 0], flags: { noSleep: true } }));

    const pool: ContactRecord[] = [];
    let total = 0;
    for (let i = 0; i < 120; i += 1) {
      world.step(1 / 60);
      total += world.drainContacts(pool);
    }
    expect(total).toBe(0);

    // And removing the floor under it stays quiet too.
    world.removeBody(1);
    for (let i = 0; i < 30; i += 1) {
      world.step(1 / 60);
      total += world.drainContacts(pool);
    }
    expect(total).toBe(0);
  });

  it('needs only one flagged side of a pair', () => {
    const world = makeWorld();
    // The floor says nothing; the crate asks.
    addFloor(world);
    world.addBody(
      body({ id: 2, position: [0, 1.2, 0], flags: { reportContacts: true, noSleep: true } }),
    );

    const pool: ContactRecord[] = [];
    let begins = 0;
    for (let i = 0; i < 120; i += 1) {
      world.step(1 / 60);
      const n = world.drainContacts(pool);
      for (let k = 0; k < n; k += 1) if (pool[k].phase === 'begin') begins += 1;
    }
    expect(begins).toBeGreaterThanOrEqual(1);
  });

  it('pools records rather than allocating one per event', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(
      body({
        id: 2,
        position: [0, 1.2, 0],
        flags: { reportContacts: true, reportStay: true, noSleep: true },
      }),
    );

    const pool: ContactRecord[] = [createContactRecord()];
    const seen = new Set<ContactRecord>();
    for (let i = 0; i < 200; i += 1) {
      world.step(1 / 60);
      const n = world.drainContacts(pool);
      for (let k = 0; k < n; k += 1) seen.add(pool[k]);
    }
    // The pool only ever grows to the busiest single frame.
    expect(seen.size).toBe(pool.length);
    expect(pool.length).toBeLessThan(16);
  });

  it('drops the surplus when a step overflows maxContactsPerStep', () => {
    const world = createPhysicsWorld(jolt, {
      gravity: [0, -9.81, 0],
      maxBodies: 256,
      maxContactsPerStep: 2,
    });
    live.push(world);
    addFloor(world);
    for (let i = 0; i < 8; i += 1) {
      world.addBody(
        body({
          id: i + 2,
          position: [i * 1.5 - 5, 1.2, 0],
          flags: { reportContacts: true, reportStay: true, noSleep: true },
        }),
      );
    }

    const pool: ContactRecord[] = [];
    let busiest = 0;
    for (let i = 0; i < 120; i += 1) {
      world.step(1 / 60);
      busiest = Math.max(busiest, world.drainContacts(pool));
    }
    // Eight boxes on a floor make more than two contacts a step; the pool is
    // the ceiling and it never grew.
    expect(busiest).toBe(2);
    expect(pool.length).toBe(2);
  });
});

describe('commands', () => {
  it('teleports, sets velocity and applies impulses', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(body({ id: 2, position: [0, 1, 0] }));
    const out = new Float32Array(BODY_STRIDE);

    world.setTransform(2, [4, 3, -2], [0, 0, 0, 1]);
    world.readBodies(out);
    expect(out[1]).toBeCloseTo(4, 4);
    expect(out[2]).toBeCloseTo(3, 4);
    expect(out[3]).toBeCloseTo(-2, 4);

    world.setVelocity(2, [1, 0, 0], [0, 2, 0]);
    world.readBodies(out);
    expect(out[8]).toBeCloseTo(1, 4);
    expect(out[12]).toBeCloseTo(2, 4);

    world.setVelocity(2, [0, 0, 0], [0, 0, 0]);
    world.applyImpulse(2, [10, 0, 0]);
    world.readBodies(out);
    // 10 Ns on a 1 kg body.
    expect(out[8]).toBeCloseTo(10, 3);
  });

  it('leaves a moved body its velocity, and a teleported body none', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(body({ id: 2, position: [0, 1, 0] }));
    const out = new Float32Array(BODY_STRIDE);

    world.setVelocity(2, [3, 0, 0], [0, 4, 0]);
    world.setTransform(2, [0, 2, 0], [0, 0, 0, 1]);
    world.readBodies(out);
    // A plain move is a nudge: the body carries on at the speed it had.
    expect(out[8]).toBeCloseTo(3, 4);
    expect(out[12]).toBeCloseTo(4, 4);

    world.setTransform(2, [0, 3, 0], [0, 0, 0, 1], true);
    world.readBodies(out);
    expect(out[2]).toBeCloseTo(3, 4);
    expect(out[8]).toBeCloseTo(0, 5);
    expect(out[9]).toBeCloseTo(0, 5);
    expect(out[10]).toBeCloseTo(0, 5);
    expect(out[11]).toBeCloseTo(0, 5);
    expect(out[12]).toBeCloseTo(0, 5);
    expect(out[13]).toBeCloseTo(0, 5);
  });

  it('teleporting a character drops the velocity it was asked for', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(
      body({
        id: 2,
        shape: 'capsule',
        dims: [0.3, 0.6],
        position: [0, 1, 0],
        kind: 'character',
        layer: L_PLAYER,
      }),
    );
    world.moveCharacter(2, [5, 0, 0]);
    world.setTransform(2, [0, 1, -8], [0, 0, 0, 1], true);
    world.step(1 / 60);

    const out = new Float32Array(BODY_STRIDE * 2);
    const rows = world.readBodies(out);
    let x = 0;
    for (let i = 0; i < rows; i += 1) {
      if (out[i * BODY_STRIDE] === 2) x = out[i * BODY_STRIDE + 1];
    }
    // It arrives at rest rather than sprinting on from where it landed.
    expect(x).toBeCloseTo(0, 3);
  });

  it('reports how many rows readBodies will fill', () => {
    const world = makeWorld();
    addFloor(world);
    expect(world.movingBodyCount).toBe(0);
    world.addBody(body({ id: 2, position: [0, 1, 0] }));
    world.addBody(body({ id: 3, position: [2, 1, 0] }));
    expect(world.movingBodyCount).toBe(2);

    const out = new Float32Array(world.movingBodyCount * BODY_STRIDE);
    expect(world.readBodies(out)).toBe(2);

    world.setEnabled(3, false);
    expect(world.movingBodyCount).toBe(1);
    world.removeBody(2);
    expect(world.movingBodyCount).toBe(0);
  });

  it('removes bodies and ignores unknown ids', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(body({ id: 2, position: [0, 1, 0] }));
    expect(world.bodyCount).toBe(2);
    world.removeBody(2);
    expect(world.bodyCount).toBe(1);
    expect(() => {
      world.removeBody(999);
      world.setTransform(999, [0, 0, 0], [0, 0, 0, 1]);
      world.moveCharacter(999, [0, 0, 0]);
    }).not.toThrow();
    expect(world.raycast([0, 5, 0], [0, -1, 0], 10, ALL)?.body).toBe(1);
  });

  it('keeps the mapping when a re-added body lands on the same Jolt key', () => {
    const world = makeWorld();
    let id = 2;
    world.addBody(body({ id, position: [0, 1, 0], kind: 'static', layer: L_PROP }));
    world.step(1 / 60);

    // A Jolt body id is an index plus an 8-bit sequence number, and the index
    // free list is last-in-first-out: churn one slot enough times and the
    // sequence wraps back onto a key a removed body was using. The removal is
    // unmapped after the step, so it has to check that the mapping still
    // belongs to it.
    let misses = 0;
    for (let i = 0; i < 400; i += 1) {
      world.removeBody(id);
      id += 1;
      world.addBody(body({ id, position: [0, 1, 0], kind: 'static', layer: L_PROP }));
      world.step(1 / 60);
      if (world.raycast([0, 5, 0], [0, -1, 0], 10, ALL)?.body !== id) misses += 1;
    }
    expect(misses).toBe(0);
  });

  it('releases the shape when there is no layer slot left for the body', () => {
    // 2 object layers: one static slot, one moving slot, and the first body of
    // each kind mints it. Every later `(layer, mask)` pair has nowhere to go.
    const world = createPhysicsWorld(jolt, { maxBodies: 64, layers: { maxObjectLayers: 2 } });
    live.push(world);
    addFloor(world, 1);

    // A mesh big enough that leaking twenty of them would show up: the BVH is
    // tens of kilobytes, and Jolt's allocator reports exactly what is out.
    const side = 40;
    const positions = new Float32Array(side * side * 3);
    for (let z = 0; z < side; z += 1) {
      for (let x = 0; x < side; x += 1) {
        const v = (z * side + x) * 3;
        positions[v] = x * 0.25;
        positions[v + 1] = ((x * 7 + z * 13) % 5) * 0.05;
        positions[v + 2] = z * 0.25;
      }
    }
    const quads = (side - 1) * (side - 1);
    const indices = new Uint32Array(quads * 6);
    let t = 0;
    for (let z = 0; z < side - 1; z += 1) {
      for (let x = 0; x < side - 1; x += 1) {
        const a = z * side + x;
        indices[t] = a;
        indices[t + 1] = a + side;
        indices[t + 2] = a + 1;
        indices[t + 3] = a + 1;
        indices[t + 4] = a + side;
        indices[t + 5] = a + side + 1;
        t += 6;
      }
    }

    const before = jolt.JoltInterface.prototype.sGetFreeMemory();
    for (let i = 0; i < 20; i += 1) {
      const shape = meshShapeFromGeometry(jolt, positions, indices);
      expect(() => {
        world.addBody(
          body({
            id: 100 + i,
            shape: 'mesh',
            dims: [],
            mass: 0,
            kind: 'static',
            // A pair the floor did not mint, so the slot table has to refuse.
            layer: 1 << (i + 2),
            mask: 1 << (i + 3),
            geometry: shape,
          }),
        );
      }).toThrow(/out of static object layers/);
      // The caller's own reference. The world took one too and must have given
      // it back, or this drops the count to one and the mesh lives forever.
      shape.Release();
    }
    const after = jolt.JoltInterface.prototype.sGetFreeMemory();
    // Twenty leaked BVHs are hundreds of kilobytes; allocator bookkeeping is not.
    expect(before - after).toBeLessThan(64 * 1024);
  }, 60_000);

  it('rejects a duplicate body id', () => {
    const world = makeWorld();
    world.addBody(body({ id: 1 }));
    expect(() => {
      world.addBody(body({ id: 1 }));
    }).toThrow(/already exists/);
  });

  it('bumps the revision on every structural change', () => {
    const world = makeWorld();
    const start = world.revision;
    world.addBody(body({ id: 1 }));
    world.setEnabled(1, false);
    world.removeBody(1);
    expect(world.revision).toBe(start + 3);
    for (let i = 0; i < 10; i += 1) world.step(1 / 60);
    expect(world.revision).toBe(start + 3);
  });
});

describe('masks', () => {
  it('lets a body pass through one it does not mask', () => {
    const world = makeWorld();
    // A floor the player ignores entirely.
    world.addBody(
      body({
        id: 1,
        shape: 'box',
        dims: [10, 0.5, 10],
        position: [0, -0.5, 0],
        mass: 0,
        kind: 'static',
        layer: L_WORLD,
        mask: L_PROP,
      }),
    );
    world.addBody(body({ id: 2, position: [0, 2, 0], layer: L_PLAYER, mask: L_PROP }));

    const out = new Float32Array(BODY_STRIDE);
    for (let i = 0; i < 120; i += 1) world.step(1 / 60);
    world.readBodies(out);
    expect(out[2]).toBeLessThan(-5);
  });

  it('collides when both masks agree', () => {
    const world = makeWorld();
    addFloor(world);
    world.addBody(body({ id: 2, position: [0, 2, 0], layer: L_PLAYER, mask: L_WORLD }));
    const out = new Float32Array(BODY_STRIDE);
    for (let i = 0; i < 180; i += 1) world.step(1 / 60);
    world.readBodies(out);
    expect(out[2]).toBeGreaterThan(0.4);
  });
});

describe('mesh shapes', () => {
  it('builds a static mesh collider a ray can hit', () => {
    const world = makeWorld();
    // Two triangles making a 4x4 quad in the y = 0 plane.
    // Wound so the front face points up: Jolt ignores mesh back faces.
    const positions = new Float32Array([-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2]);
    const indices = new Uint32Array([0, 2, 1, 0, 3, 2]);
    const shape = meshShapeFromGeometry(jolt, positions, indices);
    world.addBody(
      body({
        id: 1,
        shape: 'mesh',
        dims: [],
        mass: 0,
        kind: 'static',
        layer: L_WORLD,
        geometry: shape,
      }),
    );
    shape.Release();

    const hit = world.raycast([0, 3, 0], [0, -1, 0], 10, ALL);
    expect(hit?.body).toBe(1);
    expect(hit?.py).toBeCloseTo(0, 4);
  });

  it('builds a convex hull that a dynamic body can use', () => {
    const world = makeWorld();
    addFloor(world);
    const cube = new Float32Array([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5,
      -0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
    ]);
    const hull = convexHullFromPoints(jolt, cube);
    world.addBody(body({ id: 2, shape: 'convex', dims: [], position: [0, 4, 0], geometry: hull }));
    hull.Release();

    const out = new Float32Array(BODY_STRIDE);
    for (let i = 0; i < 300; i += 1) world.step(1 / 60);
    world.readBodies(out);
    expect(out[2]).toBeGreaterThan(0.4);
    expect(out[2]).toBeLessThan(0.6);
  });

  it('rejects malformed geometry', () => {
    expect(() => meshShapeFromGeometry(jolt, new Float32Array(4), new Uint32Array(3))).toThrow(
      /multiple of 3/,
    );
    expect(() =>
      meshShapeFromGeometry(jolt, new Float32Array(9), new Uint32Array([0, 1, 9])),
    ).toThrow(/indexes past/);
    expect(() => convexHullFromPoints(jolt, new Float32Array(9))).toThrow(/at least 4 points/);
  });

  it('demands geometry for mesh and convex bodies', () => {
    const world = makeWorld();
    expect(() => {
      world.addBody(body({ id: 1, shape: 'mesh', dims: [], mass: 0, kind: 'static' }));
    }).toThrow(/has no geometry/);
  });
});

describe('steady state', () => {
  it('does not grow its heap across a thousand steps', () => {
    const world = makeWorld();
    addFloor(world);
    for (let i = 0; i < 16; i += 1) {
      world.addBody(
        body({
          id: i + 2,
          position: [(i % 4) * 1.5 - 2, 2 + Math.floor(i / 4) * 1.5, 0],
          flags: { reportContacts: true, noSleep: true },
        }),
      );
    }
    world.addBody(
      body({
        id: 100,
        shape: 'capsule',
        dims: [0.3, 0.6],
        position: [6, 0.95, 0],
        mass: 70,
        kind: 'character',
        layer: L_PLAYER,
      }),
    );

    const bodies = new Float32Array(64 * BODY_STRIDE);
    const rays = new Float32Array(8 * RAY_STRIDE);
    for (let i = 0; i < 8; i += 1) rays.set([i - 4, 6, 0, 0, -1, 0, 20], i * RAY_STRIDE);
    const hits = new Float32Array(8 * RAY_HIT_STRIDE);
    const contacts: ContactRecord[] = [];
    const ids = new Uint32Array(32);

    /**
     * One representative frame: step, read, query, drain.
     */
    function frame(): void {
      world.moveCharacter(100, [1, 0, 0]);
      world.step(1 / 60);
      world.readBodies(bodies);
      world.drainContacts(contacts);
      world.raycastBatch(rays, ALL, hits);
      world.raycast([0, 6, 0], [0, -1, 0], 20, ALL);
      world.overlapSphereInto([0, 1, 0], 3, ALL, ids);
    }

    /**
     * Retained heap after a full collection.
     *
     * @returns `heapUsed` once everything unreachable has been swept.
     */
    function retainedHeap(): number {
      collectGarbage();
      return process.memoryUsage().heapUsed;
    }

    // Warm up: JIT, pool growth and the contact array settle here.
    for (let i = 0; i < 200; i += 1) frame();
    const poolAfterWarmup = contacts.length;
    // A baseline window: whatever the first thousand frames still settle
    // (late tier-ups, lazily built binder caches) lands here, not in the
    // measured window.
    for (let i = 0; i < 1000; i += 1) frame();
    const before = retainedHeap();

    for (let i = 0; i < 1000; i += 1) frame();

    const growth = retainedHeap() - before;

    // The pools are the only thing allowed to have grown, and they must not.
    expect(contacts.length).toBe(poolAfterWarmup);
    // A frame makes ~8 KB of short-lived binder garbage, so a thousand frames
    // that kept it would retain megabytes. After a real collection the window
    // retains well under 100 KB; 512 KB catches anything keeping half a
    // kilobyte a frame.
    expect(growth).toBeLessThan(512 * 1024);
  }, 60_000);
});

describe('wrapper cache', () => {
  /**
   * How many JS wrappers the binder is interning for one Jolt class.
   *
   * `wrapPointer` caches one object per `(class, pointer)` pair and only
   * `destroy` evicts. Anything Jolt hands a callback by pointer — a contact
   * manifold, the `SubShapeIDPair` of a removed contact, the `BodyID`s inside
   * it — lives at an address that changes from one call to the next, so an
   * un-evicted wrapper is a leak that grows for as long as the game runs.
   *
   * @param cls The Jolt class.
   * @returns Live wrapper count.
   */
  function cacheSize(cls: unknown): number {
    const binder = jolt as unknown as { getCache(c: unknown): Record<string, unknown> };
    return Object.keys(binder.getCache(cls)).length;
  }

  it('does not grow over a thousand contact-heavy steps with body churn', () => {
    const world = makeWorld();
    addFloor(world);
    for (let i = 0; i < 12; i += 1) {
      world.addBody(
        body({
          id: i + 2,
          position: [(i % 4) * 1.5 - 2, 2 + Math.floor(i / 4) * 1.5, 0],
          flags: { reportContacts: true, reportStay: true, noSleep: true },
        }),
      );
    }
    const out = new Float32Array(64 * BODY_STRIDE);
    const pool: ContactRecord[] = [];
    let nextId = 1000;

    /**
     * One busy frame: a body dies, a body is born, everything collides.
     *
     * @param i Step number.
     */
    function frame(i: number): void {
      if (i % 5 === 0) {
        world.removeBody(nextId - 1);
        world.addBody(
          body({
            id: nextId,
            position: [(i % 7) * 0.5 - 1.5, 3, 0],
            flags: { reportContacts: true, reportStay: true, noSleep: true },
          }),
        );
        nextId += 1;
      }
      world.step(1 / 60);
      world.readBodies(out);
      world.drainContacts(pool);
    }

    for (let i = 0; i < 200; i += 1) frame(i);
    const before = {
      manifold: cacheSize(jolt.ContactManifold),
      pair: cacheSize(jolt.SubShapeIDPair),
      bodyId: cacheSize(jolt.BodyID),
    };

    for (let i = 200; i < 1200; i += 1) frame(i);
    const after = {
      manifold: cacheSize(jolt.ContactManifold),
      pair: cacheSize(jolt.SubShapeIDPair),
      bodyId: cacheSize(jolt.BodyID),
    };

    // Flat. Before the eviction this run ended with ~190 interned pairs and
    // ~560 interned body ids, climbing with every removed contact.
    expect(after.manifold).toBeLessThanOrEqual(before.manifold);
    expect(after.pair).toBeLessThanOrEqual(before.pair);
    expect(after.pair).toBeLessThan(8);
    expect(after.bodyId - before.bodyId).toBeLessThan(8);
  }, 60_000);
});

describe('dispose', () => {
  it('is idempotent and refuses further work', () => {
    const world = createPhysicsWorld(jolt);
    addFloor(world);
    world.dispose();
    world.dispose();
    expect(() => {
      world.step(1 / 60);
    }).toThrow(/disposed/);
  });

  it('gives Jolt its memory back', () => {
    const before = jolt.JoltInterface.prototype.sGetFreeMemory();
    for (let i = 0; i < 3; i += 1) {
      const world = createPhysicsWorld(jolt, { maxBodies: 128 });
      addFloor(world);
      for (let k = 0; k < 20; k += 1) world.addBody(body({ id: k + 2, position: [0, k + 1, 0] }));
      world.addBody(
        body({
          id: 500,
          shape: 'capsule',
          dims: [0.3, 0.6],
          position: [0, 1, 0],
          mass: 70,
          kind: 'character',
          layer: L_PLAYER,
        }),
      );
      for (let s = 0; s < 30; s += 1) world.step(1 / 60);
      world.dispose();
    }
    const after = jolt.JoltInterface.prototype.sGetFreeMemory();
    // Allocator bookkeeping moves a little; a leaked world would be megabytes.
    expect(before - after).toBeLessThan(256 * 1024);
  }, 60_000);
});
