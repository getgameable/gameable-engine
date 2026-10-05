/**
 * The game, driven headlessly.
 *
 * No browser, no renderer, no Jolt: `gameable/test` supplies a mock
 * host and `createGuest` runs the very same systems the wasm component runs.
 * That makes gameplay a unit-test loop rather than a click-and-look loop.
 *
 * The mock host does not simulate physics, so `moveCharacter` produces no
 * motion on its own; these tests integrate the requested velocity themselves
 * by writing the body rows the host would have written. That is the contract
 * the guest actually depends on, and it is deterministic.
 */
import { arenaSpawns as packedSpawns } from 'gameable/placeholder';
import {
  BODY_STRIDE,
  createGuest,
  featuresOf,
  Enemy,
  Health,
  query,
  RigidBody,
  Transform,
  type Guest,
  type HostFrameInput,
  type RayHit,
} from 'gameable';
import {
  createFrameInput,
  createGameConfig,
  createInputState,
  createMockHost,
  endFrame,
  hashTransforms,
  press,
  pressMouse,
  release,
  releaseMouse,
  type MockHost,
  type MutableInputState,
} from 'gameable/test';
import { beforeEach, describe, expect, it } from 'vitest';

import game from '../src/game';
import { arenaSpawns } from '../src/arena';
import { weaponState } from '../src/systems/weapon';

/** The entity the declarative `player` block spawns; ids start at 1. */
const PLAYER = 1;

/** A scripted raycast result, replaced per test. */
let scriptedHit: RayHit | null = null;

/** Bodies the fake physics integrates, in body-id order. */
interface FakeBody {
  body: number;
  entity: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** What {@link boot} hands back. */
interface Harness {
  guest: Guest;
  host: MockHost;
  input: MutableInputState;
  bodies: FakeBody[];
  /** Every command the guest has emitted since `boot`, newest last. */
  commands: { tag: string; val: unknown }[];
  step(frames?: number): void;
  frame: number;
}

/**
 * Start the game and stand in for the host physics.
 *
 * @returns The harness.
 */
function boot(): Harness {
  const host = createMockHost({
    seed: 0xf95,
    nowMs: () => 0,
    assets: ['env.arena', 'char.enemy', 'sfx.shot', 'sfx.hit', 'sfx.pickup', 'sfx.step'],
    raycast: () => scriptedHit,
  });
  const guest = createGuest(host, game);
  guest.init(createGameConfig({ seed: 0xf95n, fixedHz: 60 }));

  const input = createInputState();
  const bodies: FakeBody[] = [];
  const commands: { tag: string; val: unknown }[] = [];
  const buffer = new Float32Array(64 * BODY_STRIDE);
  const harness: Harness = { guest, host, input, bodies, commands, frame: 0, step };

  /**
   * Mirror the guest's `add-body` / `move-character` commands.
   *
   * @param output The frame the guest just produced.
   * @returns Nothing.
   */
  function applyCommands(output: { commands: readonly { tag: string; val: unknown }[] }): void {
    for (const command of output.commands) {
      commands.push({ tag: command.tag, val: command.val });
      if (command.tag === 'add-body') {
        const c = command.val as {
          body: number;
          entity: number;
          position: { x: number; y: number; z: number };
        };
        bodies.push({
          body: c.body,
          entity: c.entity,
          x: c.position.x,
          y: c.position.y,
          z: c.position.z,
          vx: 0,
          vy: 0,
          vz: 0,
        });
      } else if (command.tag === 'remove-body') {
        const id = command.val as number;
        const index = bodies.findIndex((b) => b.body === id);
        if (index >= 0) bodies.splice(index, 1);
      } else if (command.tag === 'move-character') {
        const c = command.val as {
          body: number;
          desiredVelocity: { x: number; y: number; z: number };
        };
        const record = bodies.find((b) => b.body === c.body);
        if (record) {
          record.vx = c.desiredVelocity.x;
          record.vy = c.desiredVelocity.y;
          record.vz = c.desiredVelocity.z;
        }
      }
    }
  }

  /**
   * Integrate the fake bodies and pack them the way the host would.
   *
   * @param dt Seconds.
   * @returns The row count.
   */
  function packBodies(dt: number): number {
    bodies.sort((a, b) => a.body - b.body);
    for (const [index, record] of bodies.entries()) {
      record.x += record.vx * dt;
      record.y += record.vy * dt;
      record.z += record.vz * dt;
      const base = index * BODY_STRIDE;
      buffer[base] = record.body;
      buffer[base + 1] = record.x;
      buffer[base + 2] = record.y;
      buffer[base + 3] = record.z;
      buffer[base + 4] = 0;
      buffer[base + 5] = 0;
      buffer[base + 6] = 0;
      buffer[base + 7] = 1;
      buffer[base + 8] = record.vx;
      buffer[base + 9] = record.vy;
      buffer[base + 10] = record.vz;
      buffer[base + 11] = 0;
      buffer[base + 12] = 0;
      buffer[base + 13] = 0;
    }
    return bodies.length;
  }

  /**
   * Run `frames` fixed steps.
   *
   * @param frames How many. Defaults to one.
   * @returns Nothing.
   */
  function step(frames = 1): void {
    const dt = 1 / 60;
    for (let i = 0; i < frames; i += 1) {
      const rows = packBodies(dt);
      const frameInput: HostFrameInput = createFrameInput({
        frame: harness.frame,
        dt,
        elapsed: harness.frame * dt,
        input,
        bodies: buffer.subarray(0, rows * BODY_STRIDE),
      });
      const output = guest.tick(frameInput);
      applyCommands(output);
      endFrame(input);
      harness.frame += 1;
    }
  }

  // The commands `init` queued — the player, six enemies, three medkits — are
  // carried into frame 0, so one tick puts every body in the fake world.
  step(1);
  return harness;
}

/**
 * Every living enemy entity.
 *
 * @param guest The guest under test.
 * @returns The entity ids.
 */
function livingEnemies(guest: Guest): number[] {
  const world = guest.state.world;
  const out: number[] = [];
  for (const e of query(world, [Enemy, Health])) {
    if ((Health.current[e] ?? 0) > 0) out.push(e);
  }
  return out;
}

beforeEach(() => {
  scriptedHit = null;
});

describe('the arena', () => {
  it('matches the placeholder pack it was copied from', () => {
    expect(arenaSpawns.player).toEqual(packedSpawns.player);
    expect(arenaSpawns.enemies).toEqual(packedSpawns.enemies);
    expect(arenaSpawns.pickups).toEqual(packedSpawns.pickups);
    expect(arenaSpawns.bounds).toEqual(packedSpawns.bounds);
  });

  it('spawns a player, six enemies and three medkits', () => {
    const harness = boot();
    expect(livingEnemies(harness.guest)).toHaveLength(6);
    // One player + six enemies + three medkits, each with a body.
    expect(harness.bodies).toHaveLength(10);
    expect(Health.current[PLAYER]).toBe(100);
  });
});

describe('moving', () => {
  it('walks forward while W is held', () => {
    const harness = boot();
    const before = Transform.z[PLAYER] ?? 0;
    press(harness.input, 'W');
    harness.step(60);
    const after = Transform.z[PLAYER] ?? 0;
    // Forward is -Z at a yaw of zero, and the walk speed is 5 m/s.
    expect(after).toBeLessThan(before - 4);
    release(harness.input, 'W');
  });

  it('stands still with nothing held', () => {
    const harness = boot();
    const before = Transform.z[PLAYER] ?? 0;
    harness.step(60);
    expect(Transform.z[PLAYER] ?? 0).toBeCloseTo(before, 5);
  });

  it('strafes right on D', () => {
    const harness = boot();
    const before = Transform.x[PLAYER] ?? 0;
    press(harness.input, 'D');
    harness.step(30);
    expect(Transform.x[PLAYER] ?? 0).toBeGreaterThan(before + 1);
  });
});

describe('shooting', () => {
  it('takes health off the enemy in the crosshair', () => {
    const harness = boot();
    const target = livingEnemies(harness.guest)[0];
    const before = Health.current[target] ?? 0;
    scriptedHit = {
      body: RigidBody.handle[target] ?? 0,
      entity: target,
      point: { x: 0, y: 1, z: -5 },
      normal: { x: 0, y: 0, z: 1 },
      distance: 5,
    };

    pressMouse(harness.input, 1);
    harness.step(1);
    releaseMouse(harness.input, 1);
    harness.step(1);

    expect(Health.current[target]).toBe(before - 20);
    expect(weaponState.ammo).toBe(11);
    expect(weaponState.hits).toBe(1);
  });

  it('respects the fire-rate cooldown', () => {
    const harness = boot();
    const target = livingEnemies(harness.guest)[0];
    scriptedHit = {
      body: RigidBody.handle[target] ?? 0,
      entity: target,
      point: { x: 0, y: 1, z: -5 },
      normal: { x: 0, y: 0, z: 1 },
      distance: 5,
    };
    pressMouse(harness.input, 1);
    // Ten frames is 0.166 s: one shot at a 0.18 s interval.
    harness.step(10);
    expect(weaponState.hits).toBe(1);
    releaseMouse(harness.input, 1);
  });

  it('empties the magazine and stops', () => {
    const harness = boot();
    const target = livingEnemies(harness.guest)[0];
    scriptedHit = {
      body: RigidBody.handle[target] ?? 0,
      entity: target,
      point: { x: 0, y: 1, z: -5 },
      normal: { x: 0, y: 0, z: 1 },
      distance: 5,
    };
    // Health.max is 40, so the target dies; aim at a fresh one each time.
    pressMouse(harness.input, 1);
    for (let i = 0; i < 200; i += 1) {
      const alive = livingEnemies(harness.guest);
      if (alive.length === 0) break;
      scriptedHit = {
        body: RigidBody.handle[alive[0]] ?? 0,
        entity: alive[0],
        point: { x: 0, y: 1, z: -5 },
        normal: { x: 0, y: 0, z: 1 },
        distance: 5,
      };
      harness.step(1);
    }
    releaseMouse(harness.input, 1);
    expect(weaponState.ammo).toBeGreaterThanOrEqual(0);
  });
});

describe('winning', () => {
  it('shows the win message once every enemy is dead', () => {
    const harness = boot();
    let hud = '';
    // Kill them by hand: this test is about the rule, not about the weapon.
    for (const enemy of livingEnemies(harness.guest)) Health.current[enemy] = 0;
    for (let i = 0; i < 3; i += 1) {
      const output = harness.guest.tick(
        createFrameInput({ frame: 500 + i, input: harness.input, bodies: new Float32Array(0) }),
      );
      if (output.hud !== undefined) hud = output.hud;
    }
    expect(livingEnemies(harness.guest)).toHaveLength(0);
    expect(hud).toContain('ARENA CLEARED');
  });

  it('shows the lose message when the player runs out of health', () => {
    const harness = boot();
    Health.current[PLAYER] = 0;
    let hud = '';
    for (let i = 0; i < 3; i += 1) {
      const output = harness.guest.tick(
        createFrameInput({ frame: 600 + i, input: harness.input, bodies: new Float32Array(0) }),
      );
      if (output.hud !== undefined) hud = output.hud;
    }
    expect(hud).toContain('YOU DIED');
  });
});

describe('the character commands', () => {
  it('asks the host to spawn a character for each enemy', () => {
    const harness = boot();
    const spawns = harness.commands.filter((c) => c.tag === 'spawn-character');
    expect(spawns).toHaveLength(6);
    const entities = spawns.map((c) => (c.val as { entity: number }).entity);
    expect(entities).toEqual(livingEnemies(harness.guest));
    expect((spawns[0].val as { bundle: number }).bundle).toBeGreaterThan(0);
  });

  it('tells the animator a chasing enemy is moving at the enemy speed', () => {
    const harness = boot();
    const enemy = livingEnemies(harness.guest)[5];
    harness.step(10);
    const states = harness.commands.filter(
      (c) => c.tag === 'set-character-state' && (c.val as { entity: number }).entity === enemy,
    );
    expect(states.length).toBeGreaterThan(0);
    const last = states[states.length - 1].val as {
      state: string;
      velocity: { x: number; z: number };
      grounded: boolean;
    };
    expect(last.state).toBe('chase');
    // 2.2 m/s is `rules.enemySpeed`; the host blends walk and run from it.
    expect(Math.hypot(last.velocity.x, last.velocity.z)).toBeCloseTo(2.2, 3);
    expect(last.grounded).toBe(true);
  });

  it('turns a chasing enemy towards the player', () => {
    const harness = boot();
    const enemy = livingEnemies(harness.guest)[5];
    harness.step(10);
    // Yaw 0 faces +Z, so looking at something is atan2(dx, dz).
    const yaw = Math.atan2(
      (Transform.x[PLAYER] ?? 0) - (Transform.x[enemy] ?? 0),
      (Transform.z[PLAYER] ?? 0) - (Transform.z[enemy] ?? 0),
    );
    expect(Transform.qy[enemy] ?? 0).toBeCloseTo(Math.sin(yaw / 2), 3);
    expect(Transform.qw[enemy] ?? 0).toBeCloseTo(Math.cos(yaw / 2), 3);
    expect(Transform.qx[enemy] ?? 0).toBe(0);
    expect(Transform.qz[enemy] ?? 0).toBe(0);
  });

  it('faces the player while attacking, and stands still to do it', () => {
    const harness = boot();
    const enemy = livingEnemies(harness.guest)[5];
    const body = harness.bodies.find((b) => b.entity === enemy);
    expect(body).toBeDefined();
    if (body) {
      body.x = Transform.x[PLAYER] ?? 0;
      body.z = (Transform.z[PLAYER] ?? 0) - 1;
    }
    harness.step(3);
    const states = harness.commands.filter(
      (c) => c.tag === 'set-character-state' && (c.val as { entity: number }).entity === enemy,
    );
    const last = states[states.length - 1].val as {
      state: string;
      velocity: { x: number; z: number };
    };
    expect(last.state).toBe('attack');
    expect(Math.hypot(last.velocity.x, last.velocity.z)).toBeCloseTo(0, 5);
    // The player is roughly on +Z from the enemy, so it looks roughly down +Z.
    const yaw = Math.atan2(
      (Transform.x[PLAYER] ?? 0) - (Transform.x[enemy] ?? 0),
      (Transform.z[PLAYER] ?? 0) - (Transform.z[enemy] ?? 0),
    );
    expect(Math.abs(yaw)).toBeLessThan(0.1);
    expect(Transform.qy[enemy] ?? 0).toBeCloseTo(Math.sin(yaw / 2), 3);
    expect(Transform.qw[enemy] ?? 0).toBeCloseTo(Math.cos(yaw / 2), 3);
  });
});

describe('enemies', () => {
  it('chase the player when it is in sight', () => {
    const harness = boot();
    // The sixth spawn point is 11 m away, inside the 14 m sight range.
    const enemy = livingEnemies(harness.guest)[5];
    const before = Math.hypot(
      (Transform.x[PLAYER] ?? 0) - (Transform.x[enemy] ?? 0),
      (Transform.z[PLAYER] ?? 0) - (Transform.z[enemy] ?? 0),
    );
    harness.step(60);
    const after = Math.hypot(
      (Transform.x[PLAYER] ?? 0) - (Transform.x[enemy] ?? 0),
      (Transform.z[PLAYER] ?? 0) - (Transform.z[enemy] ?? 0),
    );
    expect(after).toBeLessThan(before - 1);
  });

  it('hurt the player once they are in reach', () => {
    const harness = boot();
    const enemy = livingEnemies(harness.guest)[5];
    // Put one right next to the player rather than waiting for it to walk.
    const body = harness.bodies.find((b) => b.entity === enemy);
    expect(body).toBeDefined();
    if (body) {
      body.x = Transform.x[PLAYER] ?? 0;
      body.z = (Transform.z[PLAYER] ?? 0) - 1;
    }
    harness.step(5);
    expect(Health.current[PLAYER] ?? 0).toBeLessThan(100);
  });
});

describe('medkits', () => {
  it('heal the player that walks into one', () => {
    const harness = boot();
    Health.current[PLAYER] = 40;
    const body = harness.bodies.find((b) => b.entity === PLAYER);
    expect(body).toBeDefined();
    if (body) {
      // The first medkit sits at the centre of the arena.
      body.x = arenaSpawns.pickups[0].position[0];
      body.y = arenaSpawns.pickups[0].position[1];
      body.z = arenaSpawns.pickups[0].position[2];
    }
    harness.step(3);
    expect(Health.current[PLAYER] ?? 0).toBe(75);
  });
});

describe('determinism', () => {
  it('produces the same transforms twice from the same seed and inputs', () => {
    /**
     * Run a scripted round and hash what came out.
     *
     * @returns A hash of the final transform buffer.
     */
    const run = (): number => {
      const harness = boot();
      press(harness.input, 'W');
      harness.step(45);
      release(harness.input, 'W');
      harness.step(1);
      press(harness.input, 'D');
      harness.step(45);
      release(harness.input, 'D');
      const output = harness.guest.tick(
        createFrameInput({ frame: 400, input: harness.input, bodies: new Float32Array(0) }),
      );
      return hashTransforms(output.transforms);
    };
    expect(run()).toBe(run());
  });
});

it('declares the characters feature', () => {
  expect(featuresOf(game)).toEqual({ characters: {} });
});
