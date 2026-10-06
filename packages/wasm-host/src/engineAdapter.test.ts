import { SceneGraph } from '@gameable/core';
import type { Engine, EngineModule } from '@gameable/core';
import type {
  AddBodyCmd,
  CameraState,
  Command,
  FrameOutput,
  HostFrameInput,
  Quat,
  Vec3,
} from '@gameable/sdk';
import { PerspectiveCamera, Scene } from 'three/webgpu';
import type { Mesh, Object3D } from 'three/webgpu';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyOutput } from './apply';
import { createEngineAdapter, createEngineHost, createHostLoop } from './engineAdapter';
import type { EngineAdapterHandle } from './engineAdapter';
import type { HudRenderer } from './hud';
import type { CharacterBridge, CharacterSpawnRequest } from './characters';
import type { Sandbox } from './sandbox';
import { retainedHeap } from './testing/collectGarbage';

/** Identity rotation and unit scale, reused by the helpers below. */
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
const ONE: Vec3 = { x: 1, y: 1, z: 1 };

/** One recorded physics call. */
interface PhysicsCall {
  method: string;
  args: readonly unknown[];
}

/**
 * Copy an argument that the adapter may reuse.
 *
 * @param value The argument as it was passed.
 * @returns A copy of an array-like argument; anything else unchanged.
 */
function snapshotArg(value: unknown): unknown {
  return Array.isArray(value) ? [...(value as unknown[])] : value;
}

/**
 * A physics service that records instead of simulating.
 *
 * @returns The fake, plus its recording.
 */
function fakePhysics(): Record<string, unknown> & { calls: PhysicsCall[] } {
  const calls: PhysicsCall[] = [];
  /**
   * Record one call.
   *
   * @param method Method name.
   * @param args Arguments.
   * @returns Nothing.
   */
  const record = (method: string, ...args: unknown[]): void => {
    // The adapter hands the same scratch arrays to every call, so a recording
    // that kept them by reference would show every call holding the last
    // call's numbers. Copy anything array-like on the way in.
    calls.push({ method, args: args.map(snapshotArg) });
  };
  return {
    calls,
    movingBodyCount: 0,
    addBody: (args: unknown) => {
      record('addBody', args);
    },
    removeBody: (id: number) => {
      record('removeBody', id);
    },
    setTransform: (...a: unknown[]) => {
      record('setTransform', ...a);
    },
    setVelocity: (...a: unknown[]) => {
      record('setVelocity', ...a);
    },
    applyImpulse: (...a: unknown[]) => {
      record('applyImpulse', ...a);
    },
    setEnabled: (...a: unknown[]) => {
      record('setEnabled', ...a);
    },
    moveCharacter: (...a: unknown[]) => {
      record('moveCharacter', ...a);
    },
    groundState: () => 'on-ground',
    readBodies: () => 0,
    drainContacts: () => 0,
    raycast: () => null,
    overlapSphereInto: () => 0,
    readBodyBounds: () => false,
  };
}

/** A manifest entry as the fake registry stores it. */
interface FakeEntry {
  id: string;
  type: string;
  loaded?: unknown;
}

/** What {@link makeEngine} hands back. */
interface Harness {
  engine: Engine;
  scene: Scene;
  camera: PerspectiveCamera;
  services: Map<string, unknown>;
  entries: FakeEntry[];
  loads: string[];
  /** Fire an engine event, the way `resize()` fires `engine:resize`. */
  emit: (type: string, payload: unknown) => void;
}

/**
 * Build the narrow slice of `Engine` the adapter actually uses.
 *
 * @param entries Manifest entries, in handle order.
 * @returns The harness.
 */
function makeEngine(entries: FakeEntry[] = []): Harness {
  const scene = new Scene();
  const camera = new PerspectiveCamera(70, 1, 0.1, 1000);
  const graph = new SceneGraph(scene);
  const services = new Map<string, unknown>();
  const loads: string[] = [];

  /**
   * Find an entry by id or handle.
   *
   * @param idOrHandle Asset id or 1-based handle.
   * @returns The entry, or undefined.
   */
  const find = (idOrHandle: string | number): FakeEntry | undefined =>
    typeof idOrHandle === 'number'
      ? entries[idOrHandle - 1]
      : entries.find((e) => e.id === idOrHandle);

  const assets = {
    resolve: (id: string) => entries.findIndex((e) => e.id === id) + 1,
    idOf: (handle: number) => entries[handle - 1]?.id,
    entry: (idOrHandle: string | number) => find(idOrHandle),
    get: (idOrHandle: string | number) => find(idOrHandle)?.loaded,
    load: (idOrHandle: string | number) => {
      const entry = find(idOrHandle);
      if (entry) loads.push(entry.id);
      return Promise.resolve(entry?.loaded);
    },
  };

  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const events = {
    on: (type: string, listener: (payload: unknown) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
  };

  /**
   * Fire one engine event at whatever is listening.
   *
   * @param type Event name.
   * @param payload Event payload.
   * @returns Nothing.
   */
  const emit = (type: string, payload: unknown): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(payload);
  };

  const engine = {
    scene,
    camera,
    graph,
    assets,
    events,
    renderer: { domElement: { width: 800, height: 600 }, getPixelRatio: () => 2 },
    ctx: { time: { timeScale: 1 }, config: { fixedHz: 60, fixedDt: 1 / 60 } },
    modules: {
      tryGet: (id: string) => services.get(id),
      fixedUpdateHooks: [] as { id: string }[],
    },
  } as unknown as Engine;

  return { engine, scene, camera, services, entries, loads, emit };
}

/**
 * A HUD renderer that records the JSON it is handed.
 *
 * @returns The fake renderer plus the payloads it saw.
 */
function fakeHud(): HudRenderer & { seen: string[] } {
  const seen: string[] = [];
  let model: unknown = null;
  return {
    seen,
    element: null as never,
    get model() {
      return model as never;
    },
    set(json) {
      if (json === undefined) return false;
      seen.push(json);
      model = JSON.parse(json);
      return true;
    },
    clear() {
      model = null;
    },
    dispose() {
      /* nothing to release */
    },
  };
}

/**
 * A minimal `add-body` payload.
 *
 * @param overrides Fields to change.
 * @returns The command payload.
 */
function addBodyCmd(overrides: Partial<AddBodyCmd> = {}): AddBodyCmd {
  return {
    body: 1,
    entity: 1,
    kind: 'dynamic',
    shape: { kind: 'capsule', halfExtents: { x: 0.3, y: 0.9, z: 0 } },
    position: { x: 0, y: 0, z: 0 },
    rotation: IDENTITY,
    mass: 60,
    friction: 0.5,
    restitution: 0,
    linearDamping: 0.05,
    angularDamping: 0.05,
    layer: { enemy: true },
    mask: { staticGeometry: true, player: true },
    flags: { reportContacts: true },
    ...overrides,
  };
}

/**
 * A camera record with sane defaults.
 *
 * @param overrides Fields to change.
 * @returns The camera state.
 */
function cameraState(overrides: Partial<CameraState> = {}): CameraState {
  return {
    mode: 'first-person',
    projection: 'perspective',
    position: { x: 0, y: 1.7, z: 0 },
    rotation: IDENTITY,
    target: undefined,
    fovYDeg: 75,
    near: 0.1,
    far: 1000,
    follow: undefined,
    armLength: 0,
    offset: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

/**
 * One packed transform row: entity, flags, position, identity rotation, unit scale.
 *
 * @param entity Entity id.
 * @param flags Transform flags.
 * @param x World x.
 * @returns A stride-12 row ready for `applyTransforms`.
 */
function transformRow(entity: number, flags: number, x: number): Float32Array {
  const row = new Float32Array(12);
  row[0] = entity;
  row[1] = flags;
  row[2] = x;
  row[8] = 1; // qw
  row[9] = 1;
  row[10] = 1;
  row[11] = 1;
  return row;
}

/**
 * Spawn one entity with no asset.
 *
 * @param adapter The adapter under test.
 * @param entity Entity id.
 * @param position Where to put it.
 * @returns Nothing.
 */
function spawnAt(adapter: EngineAdapterHandle, entity: number, position: Vec3): void {
  adapter.spawn(entity, undefined, position, IDENTITY, ONE, { visible: true, name: 'thing' });
}

describe('createEngineAdapter', () => {
  let harness: Harness;
  let adapter: EngineAdapterHandle;
  let warnings: string[];

  beforeEach(() => {
    harness = makeEngine();
    warnings = [];
    adapter = createEngineAdapter(harness.engine, {
      hud: false,
      warn: (m) => warnings.push(m),
    });
  });

  it('puts a spawned entity under the graph root at its transform', () => {
    spawnAt(adapter, 1, { x: 1, y: 2, z: 3 });
    const object = harness.engine.graph.get(1);
    expect(object).toBeDefined();
    expect(object?.parent).toBe(harness.engine.graph.root);
    expect(object?.position.toArray()).toEqual([1, 2, 3]);
    expect(object?.name).toBe('thing');
  });

  it('despawns an entity and forgets its slot', () => {
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    adapter.despawn(1);
    expect(harness.engine.graph.get(1)).toBeUndefined();
    expect(adapter.transforms.has(1)).toBe(false);
  });

  it('gives a body-having entity a placeholder sized from its shape', () => {
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    adapter.addBody(addBodyCmd());
    const object = harness.engine.graph.get(1) as Object3D;
    const mesh = object.children[0] as Mesh;
    expect(mesh.name).toBe('aos:placeholder');
    // Capsule: radius 0.3, cylinder section 2 * 0.9.
    const parameters = (mesh.geometry as unknown as { parameters: Record<string, number> })
      .parameters;
    expect(parameters.radius).toBeCloseTo(0.3);
    expect(parameters.height).toBeCloseTo(1.8);
  });

  it('add-body on body 0 only draws the placeholder: no body, no physics warning', () => {
    // A room's authority sends body 0 to tell a page an asset-less entity's
    // shape; the page has no physics module and must make no body.
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    adapter.addBody(
      addBodyCmd({ body: 0, shape: { kind: 'box', halfExtents: { x: 1, y: 2, z: 3 } } }),
    );
    const object = harness.engine.graph.get(1) as Object3D;
    const mesh = object.children[0] as Mesh;
    expect(mesh.name).toBe('aos:placeholder');
    const parameters = (mesh.geometry as unknown as { parameters: Record<string, number> })
      .parameters;
    expect(parameters.width).toBeCloseTo(2);
    expect(parameters.height).toBeCloseTo(4);
    expect(parameters.depth).toBeCloseTo(6);
    expect(warnings).toEqual([]);
  });

  it('draws nothing for an asset-less entity by default', () => {
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    expect(harness.engine.graph.get(1)?.children).toHaveLength(0);
  });

  it('draws a unit box for an asset-less entity when asked to', () => {
    const sketch = createEngineAdapter(harness.engine, {
      hud: false,
      placeholders: 'always',
      warn: () => undefined,
    });
    sketch.spawn(2, undefined, { x: 0, y: 0, z: 0 }, IDENTITY, ONE, { visible: true });
    expect(harness.engine.graph.get(2)?.children).toHaveLength(1);
  });

  it('draws nothing at all when placeholders are off', () => {
    const strict = createEngineAdapter(harness.engine, {
      hud: false,
      placeholders: 'never',
      warn: () => undefined,
    });
    strict.spawn(3, undefined, { x: 0, y: 0, z: 0 }, IDENTITY, ONE, { visible: true });
    strict.addBody(addBodyCmd({ body: 3, entity: 3 }));
    expect(harness.engine.graph.get(3)?.children).toHaveLength(0);
  });

  it('translates add-body into the physics module vocabulary', () => {
    const physics = fakePhysics();
    harness.services.set('physics', physics);
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    adapter.addBody(
      addBodyCmd({ kind: 'fixed', shape: { kind: 'box', halfExtents: { x: 1, y: 2, z: 3 } } }),
    );

    const call = physics.calls.find((c) => c.method === 'addBody');
    expect(call).toBeDefined();
    const args = call?.args[0] as Record<string, unknown>;
    expect(args.kind).toBe('static');
    expect(args.shape).toBe('box');
    expect(args.dims).toEqual([1, 2, 3]);
    // enemy is bit 3, staticGeometry bit 1, player bit 2.
    expect(args.layer).toBe(0b1000);
    expect(args.mask).toBe(0b0110);
  });

  it('maps a jump request onto an upward desired velocity', () => {
    const physics = fakePhysics();
    harness.services.set('physics', physics);
    adapter.moveCharacter(7, { x: 1, y: 0, z: 2 }, true, false, 45);
    const call = physics.calls.find((c) => c.method === 'moveCharacter');
    expect(call?.args[1]).toEqual([1, 5, 2]);
  });

  it('leaves an explicit vertical velocity alone', () => {
    const physics = fakePhysics();
    harness.services.set('physics', physics);
    adapter.moveCharacter(7, { x: 0, y: 9, z: 0 }, true, false, 45);
    const call = physics.calls.find((c) => c.method === 'moveCharacter');
    expect(call?.args[1]).toEqual([0, 9, 0]);
  });

  it('warns once when a command needs a module that is not registered', () => {
    adapter.removeBody(3);
    adapter.removeBody(4);
    expect(warnings.filter((w) => w.includes('remove-body'))).toHaveLength(1);
  });

  it('dedupes warnings on the key, not on the text they would have had', () => {
    // Two different entities, two different clips: one message, because the
    // key is the command and the message is never built the second time.
    adapter.setAnim(1, 'jump', false, 1, 0, 1);
    adapter.setAnim(2, 'fall', true, 1, 0, 1);
    const seen = warnings.filter((w) => w.includes('set-anim'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('"jump"');
  });

  it('warns once per character command when there is no bridge', () => {
    adapter.spawnCharacter(1, 2, { x: 0, y: 0, z: 0 }, IDENTITY);
    adapter.setCharacterState(1, 'idle', { x: 0, y: 0, z: 0 }, true);
    adapter.lookAt(1, undefined, 1);
    const characterWarnings = warnings.filter((w) => w.includes('createCharacterBridge'));
    expect(characterWarnings).toHaveLength(3);
    expect(characterWarnings[0]).toContain('spawn-character');
  });

  it('interpolates between the previous and current transform', () => {
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    const row = new Float32Array(12);
    row[0] = 1;
    row[1] = 1; // POSITION
    row[2] = 10;
    row[8] = 1; // qw
    row[9] = 1;
    row[10] = 1;
    row[11] = 1;

    adapter.beginFixedStep();
    adapter.applyTransforms(row, 1);
    adapter.interpolate(0.5);
    expect(harness.engine.graph.get(1)?.position.x).toBeCloseTo(5);
    adapter.interpolate(1);
    expect(harness.engine.graph.get(1)?.position.x).toBeCloseTo(10);
  });

  it('snaps rather than interpolating on a teleport', () => {
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    const row = new Float32Array(12);
    row[0] = 1;
    row[1] = 1 | 16; // POSITION | TELEPORT
    row[2] = 10;
    row[8] = 1;
    row[9] = 1;
    row[10] = 1;
    row[11] = 1;

    adapter.beginFixedStep();
    adapter.applyTransforms(row, 1);
    adapter.interpolate(0);
    expect(harness.engine.graph.get(1)?.position.x).toBeCloseTo(10);
  });

  it('ignores the destroyed transform flag: despawn is a command, not a flag', () => {
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    const row = new Float32Array(12);
    row[0] = 1;
    row[1] = 32; // DESTROYED, which `packing.ts` never sets
    adapter.applyTransforms(row, 1);
    expect(harness.engine.graph.get(1)).toBeDefined();
  });

  it('drives the engine camera and hides the entity it is inside', () => {
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    adapter.setCamera(cameraState({ follow: 1, fovYDeg: 90, position: { x: 4, y: 1, z: 2 } }));
    adapter.interpolate(1);
    expect(harness.camera.fov).toBe(90);
    expect(harness.camera.position.toArray()).toEqual([4, 1, 2]);
    expect(harness.engine.graph.get(1)?.visible).toBe(false);

    adapter.setCamera(cameraState({ mode: 'third-person', follow: 1 }));
    expect(harness.engine.graph.get(1)?.visible).toBe(true);
  });

  it('puts a third-person camera on a spring arm behind the entity it follows', () => {
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    adapter.setCamera(
      cameraState({
        mode: 'third-person',
        follow: 1,
        // A yaw of zero looks down -Z, so the boom swings out to +Z.
        rotation: IDENTITY,
        armLength: 4,
        offset: { x: 0, y: 1.5, z: 0 },
      }),
    );
    adapter.interpolate(1);
    expect(harness.camera.position.x).toBeCloseTo(0);
    expect(harness.camera.position.y).toBeCloseTo(1.5);
    expect(harness.camera.position.z).toBeCloseTo(4);
  });

  it('swings the arm round with the yaw the guest asked for', () => {
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    // quatFromYawPitch(pi/2, 0): looking down -X, so the boom is out on +X.
    const halfTurn = Math.SQRT1_2;
    adapter.setCamera(
      cameraState({
        mode: 'third-person',
        follow: 1,
        rotation: { x: 0, y: halfTurn, z: 0, w: halfTurn },
        armLength: 4,
        offset: { x: 0, y: 1.5, z: 0 },
      }),
    );
    adapter.interpolate(1);
    expect(harness.camera.position.x).toBeCloseTo(4);
    expect(harness.camera.position.z).toBeCloseTo(0);
  });

  it('pulls the arm in when the probe finds a wall', () => {
    const physics = fakePhysics();
    // Two metres of clear line, then something solid.
    physics.raycast = () => ({ body: 9, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 1, distance: 2 });
    harness.services.set('physics', physics);
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    adapter.setCamera(
      cameraState({
        mode: 'third-person',
        follow: 1,
        rotation: IDENTITY,
        armLength: 4,
        offset: { x: 0, y: 1.5, z: 0 },
      }),
    );
    adapter.interpolate(1);
    // 2 m to the hit, less the 0.15 m padding the rig leaves.
    expect(harness.camera.position.z).toBeCloseTo(1.85);
  });

  it('follows the entity as it moves, one probe per frame', () => {
    const physics = fakePhysics();
    let probes = 0;
    physics.raycast = () => {
      probes += 1;
      return null;
    };
    harness.services.set('physics', physics);
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    const camera = cameraState({
      mode: 'third-person',
      follow: 1,
      rotation: IDENTITY,
      armLength: 4,
      offset: { x: 0, y: 1.5, z: 0 },
    });
    adapter.setCamera(camera);

    const row = new Float32Array(12);
    row[0] = 1;
    row[1] = 1; // POSITION
    row[4] = -6; // z
    row[8] = 1; // qw
    row[9] = 1;
    row[10] = 1;
    row[11] = 1;
    adapter.beginFixedStep();
    adapter.applyTransforms(row, 1);
    adapter.setCamera(camera);
    adapter.interpolate(1);

    expect(harness.camera.position.z).toBeCloseTo(-2);
    expect(probes).toBe(2);
  });

  it('remembers what the character commands asked for', () => {
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    expect(adapter.animationOf(1)).toBeNull();

    adapter.spawnCharacter(1, 7, { x: 0, y: 0, z: 0 }, IDENTITY);
    adapter.setCharacterState(1, 'run', { x: 3, y: 0, z: -4 }, false);
    adapter.setAnim(1, 'jump', false, 1.25, 120, 0.5);

    const state = adapter.animationOf(1);
    expect(state?.bundle).toBe(7);
    expect(state?.state).toBe('run');
    expect(state?.velocity).toEqual({ x: 3, y: 0, z: -4 });
    expect(state?.grounded).toBe(false);
    expect(state?.clip).toBe('jump');
    expect(state?.looping).toBe(false);
    expect(state?.speed).toBeCloseTo(1.25);
    expect(state?.weight).toBeCloseTo(0.5);

    adapter.despawn(1);
    expect(adapter.animationOf(1)).toBeNull();
  });

  describe('with a character bridge', () => {
    /**
     * A bridge that records every call, so the adapter's half of the wiring can
     * be asserted without a GPU. `characters.test.ts` tests the real one.
     *
     * @returns The fake bridge and its log.
     */
    function fakeBridge(): CharacterBridge & { calls: string[]; spawns: CharacterSpawnRequest[] } {
      const calls: string[] = [];
      const spawns: CharacterSpawnRequest[] = [];
      return {
        calls,
        spawns,
        available: true,
        spawn: (request) => {
          calls.push('spawn');
          spawns.push(request);
        },
        setState: (entity, state) => calls.push(`setState:${String(entity)}:${state}`),
        setClipWeights: (entity) => calls.push(`setClipWeights:${String(entity)}`),
        setExpression: (entity, space) => calls.push(`setExpression:${String(entity)}:${space}`),
        lookAt: (entity, target) =>
          calls.push(`lookAt:${String(entity)}:${target === undefined ? 'none' : 'point'}`),
        say: (entity, text) => calls.push(`say:${String(entity)}:${text}`),
        update: (dt) => calls.push(`update:${dt.toFixed(4)}`),
        despawn: (entity) => calls.push(`despawn:${String(entity)}`),
        entryOf: () => null,
        dispose: () => calls.push('dispose'),
      };
    }

    let bridge: ReturnType<typeof fakeBridge>;
    let bridged: EngineAdapterHandle;

    beforeEach(() => {
      bridge = fakeBridge();
      bridged = createEngineAdapter(harness.engine, {
        hud: false,
        characters: bridge,
        warn: (message) => warnings.push(message),
      });
    });

    it('routes every character command to the bridge and warns about none of them', () => {
      spawnAt(bridged, 1, { x: 4, y: 0, z: 0 });
      bridged.spawnCharacter(1, 7, { x: 4, y: 0, z: 0 }, IDENTITY);
      bridged.setCharacterState(1, 'run', { x: 3, y: 0, z: -4 }, false);
      bridged.setClipWeights(1, ['walk'], [1], 1);
      bridged.setExpression(1, 'arkit52', new Float32Array(52));
      bridged.lookAt(1, { x: 0, y: 1.6, z: 0 }, 1);
      bridged.say(1, 'hello', undefined, undefined);

      expect(bridge.calls).toEqual([
        'spawn',
        'setState:1:run',
        'setClipWeights:1',
        'setExpression:1:arkit52',
        'lookAt:1:point',
        'say:1:hello',
      ]);
      expect(warnings.filter((w) => w.includes('createCharacterBridge'))).toEqual([]);
    });

    it('hands the bridge the entity object and still records the intent', () => {
      spawnAt(bridged, 1, { x: 4, y: 0, z: 0 });
      bridged.spawnCharacter(1, 7, { x: 4, y: 0, z: 0 }, IDENTITY);
      bridged.setCharacterState(1, 'run', { x: 3, y: 0, z: -4 }, false);

      const request = bridge.spawns[0];
      expect(request.entity).toBe(1);
      expect(request.bundle).toBe(7);
      expect(request.parent?.name).toBe('thing');
      // The recorded intent is still there: it is what `animationOf` publishes
      // and what the third-person e2e suite asserts locomotion through.
      expect(bridged.animationOf(1)?.state).toBe('run');
    });

    it('drops the placeholder once the bridge says the head is on screen', () => {
      spawnAt(bridged, 1, { x: 0, y: 0, z: 0 });
      bridged.addBody(addBodyCmd({ entity: 1, body: 1 }));
      const root = harness.scene.getObjectByName('thing');
      expect(root?.children.some((c) => c.name === 'aos:placeholder')).toBe(true);

      bridged.spawnCharacter(1, 7, { x: 0, y: 0, z: 0 }, IDENTITY);
      bridge.spawns[0].onAttached?.();
      expect(root?.children.some((c) => c.name === 'aos:placeholder')).toBe(false);
    });

    it.each([
      ['capsule', { x: 0.35, y: 0.8, z: 0 }, -1.15],
      ['sphere', { x: 0.5, y: 0, z: 0 }, -0.5],
      ['box', { x: 1, y: 2, z: 3 }, -2],
      ['cylinder', { x: 0.4, y: 0.6, z: 0 }, -1],
    ] as const)('passes the %s ground offset to the bridge', (shape, halfExtents, expected) => {
      spawnAt(bridged, 1, { x: 0, y: 0, z: 0 });
      bridged.addBody(addBodyCmd({ entity: 1, body: 1, shape: { kind: shape, halfExtents } }));
      bridged.spawnCharacter(1, 7, { x: 0, y: 0, z: 0 }, IDENTITY);
      expect(bridge.spawns[0].groundOffset).toBeCloseTo(expected, 6);
    });

    it('passes a zero ground offset for an entity with no body', () => {
      spawnAt(bridged, 1, { x: 0, y: 0, z: 0 });
      bridged.spawnCharacter(1, 7, { x: 0, y: 0, z: 0 }, IDENTITY);
      expect(bridge.spawns[0].groundOffset).toBe(0);
    });

    it('passes a zero ground offset for a shape whose origin it cannot guess', () => {
      spawnAt(bridged, 1, { x: 0, y: 0, z: 0 });
      bridged.addBody(
        addBodyCmd({
          entity: 1,
          body: 1,
          shape: { kind: 'plane', halfExtents: { x: 1, y: 1, z: 1 } },
        }),
      );
      bridged.spawnCharacter(1, 7, { x: 0, y: 0, z: 0 }, IDENTITY);
      expect(bridge.spawns[0].groundOffset).toBe(0);
    });

    it('sends set-material-param to the bridge once the placeholder is gone', () => {
      const tinted: string[] = [];
      bridge.setMaterialParam = (entity, name, value) => {
        tinted.push(`${String(entity)}:${name}:${JSON.stringify(value)}`);
        return true;
      };
      spawnAt(bridged, 1, { x: 0, y: 0, z: 0 });
      bridged.addBody(addBodyCmd({ entity: 1, body: 1 }));

      const red = { tag: 'color', val: { r: 1, g: 0, b: 0, a: 1 } } as const;
      // While the capsule is still there the adapter tints it itself.
      bridged.setMaterialParam(1, 'color', red);
      expect(tinted).toEqual([]);

      bridged.spawnCharacter(1, 7, { x: 0, y: 0, z: 0 }, IDENTITY);
      bridge.spawns[0].onAttached?.();
      bridged.setMaterialParam(1, 'color', red);
      expect(tinted).toEqual(['1:color:{"tag":"color","val":{"r":1,"g":0,"b":0,"a":1}}']);
    });

    it('advances the bridge from update and releases it on despawn and dispose', () => {
      spawnAt(bridged, 1, { x: 0, y: 0, z: 0 });
      bridged.spawnCharacter(1, 7, { x: 0, y: 0, z: 0 }, IDENTITY);
      bridged.update(1 / 60, 0.5);
      expect(bridge.calls).toContain('update:0.0167');

      bridged.despawn(1);
      expect(bridge.calls).toContain('despawn:1');
      bridged.dispose();
      expect(bridge.calls).toContain('dispose');
    });
  });

  it('forwards a teleport to physics and snaps the entity that body drives', () => {
    const physics = fakePhysics();
    harness.services.set('physics', physics);
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    adapter.addBody(addBodyCmd({ body: 5, entity: 1 }));

    // Applied in frame order: transforms, then this frame's commands.
    adapter.beginFixedStep();
    adapter.applyTransforms(transformRow(1, 1, 9), 1);
    adapter.setBodyTransform(5, { x: 9, y: 0, z: 0 }, IDENTITY, true);

    const call = physics.calls.find((c) => c.method === 'setTransform');
    expect(call?.args[0]).toBe(5);
    expect(call?.args[1]).toEqual([9, 0, 0]);
    expect(call?.args[3]).toBe(true);

    // Snapped: the entity's own slot forgot where it came from, so the visual
    // arrives rather than sliding across the level over the next frame.
    adapter.interpolate(0);
    expect(harness.engine.graph.get(1)?.position.x).toBeCloseTo(9);
  });

  it('leaves the entity interpolating when the move is not a teleport', () => {
    const physics = fakePhysics();
    harness.services.set('physics', physics);
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    adapter.addBody(addBodyCmd({ body: 5, entity: 1 }));

    adapter.beginFixedStep();
    adapter.applyTransforms(transformRow(1, 1, 9), 1);
    adapter.setBodyTransform(5, { x: 9, y: 0, z: 0 }, IDENTITY, false);
    expect(physics.calls.find((c) => c.method === 'setTransform')?.args[3]).toBe(false);
    adapter.interpolate(0);
    expect(harness.engine.graph.get(1)?.position.x).toBeCloseTo(0);
  });

  it('hands every physics call its own numbers, not the previous ones', () => {
    const physics = fakePhysics();
    harness.services.set('physics', physics);
    adapter.setBodyVelocity(1, { x: 1, y: 2, z: 3 }, undefined);
    adapter.setBodyVelocity(2, { x: 4, y: 5, z: 6 }, undefined);
    const calls = physics.calls.filter((c) => c.method === 'setVelocity');
    expect(calls[0].args[1]).toEqual([1, 2, 3]);
    expect(calls[1].args[1]).toEqual([4, 5, 6]);
  });

  it('copies camera.target instead of retaining the pooled guest object', () => {
    spawnAt(adapter, 1, { x: 0, y: 0, z: 0 });
    const target: Vec3 = { x: 0, y: 0, z: -10 };
    adapter.setCamera(cameraState({ position: { x: 0, y: 0, z: 0 }, target }));
    // The guest rewrites its pooled Vec3 the moment the tick is over.
    target.x = 1000;
    target.z = 1000;
    adapter.interpolate(1);
    // Looking down -Z: the camera's forward is -Z, so its quaternion is identity.
    expect(harness.camera.quaternion.x).toBeCloseTo(0);
    expect(harness.camera.quaternion.y).toBeCloseTo(0);
    expect(harness.camera.quaternion.z).toBeCloseTo(0);
    expect(Math.abs(harness.camera.quaternion.w)).toBeCloseTo(1);
  });

  it('warns once about the fields no module implements, and never silently', () => {
    const physics = fakePhysics();
    harness.services.set('physics', physics);
    adapter.moveCharacter(7, { x: 0, y: 0, z: 0 }, false, true, 70);
    adapter.moveCharacter(7, { x: 0, y: 0, z: 0 }, false, true, 70);
    expect(warnings.filter((w) => w.includes('crouch'))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('maxSlopeDeg'))).toHaveLength(1);

    // A game that asks for the defaults is not asking for anything.
    warnings.length = 0;
    const plain = createEngineAdapter(harness.engine, {
      hud: false,
      warn: (m) => warnings.push(m),
    });
    plain.moveCharacter(7, { x: 0, y: 0, z: 0 }, false, false, 45);
    expect(warnings).toEqual([]);
  });

  it('cuts a sound that cannot be faded, and says so once', () => {
    const stops: number[] = [];
    harness.services.set('audio', {
      stop: (id: number) => stops.push(id),
      setListener: () => undefined,
      ended: [],
    });
    adapter.stopSound(4, 250);
    adapter.stopSound(5, 250);
    expect(stops).toEqual([4, 5]);
    expect(warnings.filter((w) => w.includes('fadeMs'))).toHaveLength(1);
  });

  it('only moves the listener when the pose actually changed', () => {
    const poses: number[][] = [];
    harness.services.set('audio', {
      stop: () => undefined,
      setListener: (pos: number[]) => poses.push([...pos]),
      ended: [],
    });
    const zero: Vec3 = { x: 0, y: 0, z: 0 };
    adapter.setListener({ x: 0, y: 1.7, z: 0 }, IDENTITY, zero);
    adapter.setListener({ x: 0, y: 1.7, z: 0 }, IDENTITY, zero);
    expect(poses).toEqual([[0, 1.7, 0]]);
    adapter.setListener({ x: 1, y: 1.7, z: 0 }, IDENTITY, zero);
    expect(poses).toHaveLength(2);

    adapter.setListener({ x: 1, y: 1.7, z: 0 }, IDENTITY, { x: 0, y: 0, z: 3 });
    expect(warnings.filter((w) => w.includes('set-listener velocity'))).toHaveLength(1);
  });

  it('plays a decoded sound in the same turn the guest asked for it', () => {
    const buffer = { duration: 1 } as unknown as AudioBuffer;
    const played: unknown[] = [];
    const audioModule = {
      id: 'audio',
      init: () => undefined,
      decodeAsset: () => Promise.reject(new Error('should not be reached')),
      decodedAsset: (idOrHandle: string | number) => (idOrHandle === 3 ? buffer : undefined),
    };
    harness.services.set('audio', {
      play: (args: unknown) => played.push(args),
      stop: () => undefined,
      setListener: () => undefined,
      ended: [],
    });
    const sync = createEngineAdapter(harness.engine, {
      hud: false,
      warn: (m) => warnings.push(m),
      modules: [audioModule as never],
    });
    sync.playSound(1, 3, undefined, { x: 1, y: 2, z: 3 }, 1, 1, false, 'sfx');
    // No await: the voice exists already.
    expect(played).toHaveLength(1);
    expect((played[0] as { buffer: AudioBuffer }).buffer).toBe(buffer);
  });

  it('routes the HUD payload to the renderer', () => {
    const hud = fakeHud();
    const withHud = createEngineAdapter(harness.engine, { hud, warn: () => undefined });
    withHud.setHud('{"text":{"ammo":1}}');
    withHud.setHud(undefined);
    expect(hud.seen).toEqual(['{"text":{"ammo":1}}']);
    expect(withHud.hudModel).toEqual({ text: { ammo: 1 } });
  });

  it("lets the local player's own camera and HUD win over the frame's for that step", () => {
    const hud = fakeHud();
    const page = createEngineAdapter(harness.engine, {
      hud,
      localPlayer: 2,
      warn: () => undefined,
    });
    const cam = (fovYDeg: number): CameraState => ({
      mode: 'first-person',
      projection: 'perspective',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      target: undefined,
      fovYDeg,
      near: 0.1,
      far: 1000,
      follow: undefined,
      armLength: 0,
      offset: { x: 0, y: 0, z: 0 },
    });
    const frame = (commands: Command[]): FrameOutput => ({
      transforms: new Float32Array(12),
      commands,
      localCommands: [],
      camera: cam(50),
      hud: '{"text":{"frame":1}}',
    });
    page.beginFixedStep();
    applyOutput(
      page,
      frame([
        { tag: 'set-player-camera', val: { player: 2, camera: cam(90) } },
        { tag: 'set-player-hud', val: { player: 2, hud: '{"text":{"mine":1}}' } },
      ]),
    );
    expect(harness.camera.fov).toBe(90);
    expect(hud.seen).toEqual(['{"text":{"mine":1}}']);

    // The next step without the commands falls back to the frame's.
    page.beginFixedStep();
    applyOutput(page, frame([]));
    expect(harness.camera.fov).toBe(50);
    expect(hud.seen.at(-1)).toBe('{"text":{"frame":1}}');
  });

  it('scales simulated time', () => {
    adapter.setTimeScale(0.25);
    expect((harness.engine.ctx.time as unknown as { timeScale: number }).timeScale).toBe(0.25);
  });

  it('starts a load for an asset that is not resident, and queues the event', async () => {
    const withAsset = makeEngine([{ id: 'rock', type: 'gltf' }]);
    const a = createEngineAdapter(withAsset.engine, { hud: false, warn: () => undefined });
    a.spawn(1, 1, { x: 0, y: 0, z: 0 }, IDENTITY, ONE, { visible: true });
    expect(withAsset.loads).toEqual(['rock']);
    // The placeholder is up immediately, before the bytes exist.
    expect(withAsset.engine.graph.get(1)?.children).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(a.events[0]).toEqual({ tag: 'asset-loaded', val: { asset: 1, name: 'rock' } });
  });

  it('clones the loaded glTF scene', () => {
    const loaded = { scene: new Scene() };
    loaded.scene.name = 'rock-scene';
    const withAsset = makeEngine([{ id: 'rock', type: 'gltf', loaded }]);
    const a = createEngineAdapter(withAsset.engine, { hud: false, warn: () => undefined });
    a.spawn(1, 1, { x: 0, y: 0, z: 0 }, IDENTITY, ONE, { visible: true });
    const child = withAsset.engine.graph.get(1)?.children[0];
    expect(child?.name).toBe('rock-scene');
    expect(child).not.toBe(loaded.scene);
  });
});

describe('createEngineHost', () => {
  it('reports the entity behind a raycast hit', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const physics = fakePhysics();
    physics.raycast = () => ({ body: 5, px: 1, py: 2, pz: 3, nx: 0, ny: 1, nz: 0, distance: 4 });
    harness.services.set('physics', physics);

    adapter.spawn(9, undefined, { x: 0, y: 0, z: 0 }, IDENTITY, ONE, { visible: true });
    adapter.addBody(addBodyCmd({ body: 5, entity: 9 }));

    const host = createEngineHost(harness.engine, adapter, { seed: 7 });
    const hit = host.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 100, {
      layers: { enemy: true },
      solidOnly: true,
    });
    expect(hit?.entity).toBe(9);
    expect(hit?.distance).toBe(4);
    expect(host.seed()).toBe(7);
  });

  it('re-casts past an excluded entity', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const physics = fakePhysics();
    let call = 0;
    physics.raycast = () => {
      call += 1;
      return call === 1
        ? { body: 1, px: 0, py: 0, pz: -1, nx: 0, ny: 0, nz: 1, distance: 1 }
        : { body: 2, px: 0, py: 0, pz: -6, nx: 0, ny: 0, nz: 1, distance: 5 };
    };
    harness.services.set('physics', physics);

    for (const [entity, body] of [
      [1, 1],
      [2, 2],
    ]) {
      adapter.spawn(entity, undefined, { x: 0, y: 0, z: 0 }, IDENTITY, ONE, { visible: true });
      adapter.addBody(addBodyCmd({ body, entity }));
    }

    const host = createEngineHost(harness.engine, adapter);
    const hit = host.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 100, {
      layers: { enemy: true },
      solidOnly: true,
      excludeEntity: 1,
    });
    expect(hit?.entity).toBe(2);
    // Distance accumulates across the retry: 1 + epsilon + 5.
    expect(hit?.distance).toBeCloseTo(6, 2);
  });

  it('pools batch hits and overlap hits: valid until the next call', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const physics = fakePhysics();
    physics.raycast = () => ({ body: 5, px: 1, py: 2, pz: 3, nx: 0, ny: 1, nz: 0, distance: 4 });
    harness.services.set('physics', physics);
    const host = createEngineHost(harness.engine, adapter);

    const filter = { layers: { enemy: true }, solidOnly: true } as const;
    const rays = [
      { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, maxDistance: 10, filter },
      { origin: { x: 1, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, maxDistance: 10, filter },
    ];
    const first = host.raycastBatch(rays);
    expect(first).toHaveLength(2);
    // Each ray gets its own slot, not one shared record read twice.
    expect(first[0]).not.toBe(first[1]);
    expect(first[0]?.distance).toBe(4);

    // Parity with `raycast`: the guest may scribble on what it is handed, and
    // the next call hands the same objects back, rewritten.
    const scribbled = first[0];
    if (scribbled) scribbled.distance = -1;
    const second = host.raycastBatch(rays);
    expect(second[0]).toBe(scribbled);
    expect(second[0]?.distance).toBe(4);
    expect(second).toBe(first);
  });

  it('pools overlap-sphere results the same way', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const physics = fakePhysics();
    physics.overlapSphereInto = (_c: unknown, _r: unknown, _m: unknown, out: Uint32Array) => {
      out[0] = 5;
      out[1] = 6;
      return 2;
    };
    harness.services.set('physics', physics);
    const host = createEngineHost(harness.engine, adapter);

    const filter = { layers: { enemy: true }, solidOnly: true } as const;
    const first = host.overlapSphere({ x: 0, y: 0, z: 0 }, 3, filter, 8);
    expect(first.map((h) => h.body)).toEqual([5, 6]);
    first[0].body = 999;
    const second = host.overlapSphere({ x: 0, y: 0, z: 0 }, 3, filter, 8);
    expect(second[0].body).toBe(5);
    expect(second).toBe(first);
  });

  it('resolves manifest ids and describes them', () => {
    const harness = makeEngine([{ id: 'env.arena', type: 'splat', loaded: {} }]);
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const host = createEngineHost(harness.engine, adapter);
    const handle = host.resolveId('env.arena');
    expect(handle).toBe(1);
    expect(host.describe(1)).toMatchObject({ name: 'env.arena', kind: 'splat', ready: true });
    expect(host.resolveId('nope')).toBe(0);
  });
});

/**
 * A sandbox that returns a scripted frame.
 *
 * @param out What `tick` returns.
 * @returns The fake sandbox plus its recorded inputs.
 */
function fakeSandbox(out: FrameOutput): Sandbox & { inputs: HostFrameInput[]; inits: number } {
  const inputs: HostFrameInput[] = [];
  let inits = 0;
  return {
    mode: 'direct',
    get inputs() {
      return inputs;
    },
    get inits() {
      return inits;
    },
    init() {
      inits += 1;
    },
    tick(input: HostFrameInput) {
      inputs.push(input);
      return out;
    },
    shutdown() {
      /* nothing to release */
    },
    snapshot: () => new Uint8Array(0),
    restore: () => undefined,
    dead: false,
    error: null,
  } as unknown as Sandbox & { inputs: HostFrameInput[]; inits: number };
}

describe('createHostLoop', () => {
  /**
   * An empty, valid frame output.
   *
   * @returns The output.
   */
  function emptyOut(): FrameOutput {
    return {
      transforms: new Float32Array(12),
      localCommands: [],
      commands: [],
      camera: cameraState(),
      hud: undefined,
    };
  }

  it('initialises the sandbox with the engine configuration', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const sandbox = fakeSandbox(emptyOut());
    const loop = createHostLoop(harness.engine, sandbox, adapter, { seed: 3n });
    void loop.init(harness.engine.ctx);
    expect(sandbox.inits).toBe(1);
  });

  it('ticks the guest once per fixed step and advances the frame counter', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const sandbox = fakeSandbox(emptyOut());
    // The encoder deliberately reuses one record, so sample it during the tick.
    const seen: { frame: bigint; elapsed: number }[] = [];
    const original = sandbox.tick.bind(sandbox);
    sandbox.tick = (input: HostFrameInput) => {
      seen.push({ frame: input.frame, elapsed: input.elapsed });
      return original(input);
    };

    const loop = createHostLoop(harness.engine, sandbox, adapter, { init: false });
    void loop.init(harness.engine.ctx);
    loop.fixedUpdate?.(1 / 60);
    loop.fixedUpdate?.(1 / 60);
    expect(seen).toHaveLength(2);
    expect(seen[0].frame).toBe(0n);
    expect(seen[1].frame).toBe(1n);
    expect(seen[1].elapsed).toBeCloseTo(2 / 60);
  });

  it('reports the guest dying exactly once', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const sandbox = fakeSandbox(emptyOut()) as Sandbox & { dead: boolean };
    const onDead = vi.fn();
    const loop = createHostLoop(harness.engine, sandbox, adapter, { init: false, onDead });
    void loop.init(harness.engine.ctx);
    loop.fixedUpdate?.(1 / 60);
    (sandbox as unknown as { dead: boolean }).dead = true;
    loop.fixedUpdate?.(1 / 60);
    loop.fixedUpdate?.(1 / 60);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('forwards gamepads to the guest', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const pad = {
      index: 0,
      connected: true,
      buttons: 0b101,
      pressed: 0b100,
      released: 0,
      axes: new Float32Array([0.5, -0.25, 0, 0, 0, 0]),
    };
    harness.services.set('input', {
      state: {
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
          locked: false,
        },
        gamepads: [pad],
        focused: true,
      },
      consume: () => undefined,
    });

    const sandbox = fakeSandbox(emptyOut());
    const loop = createHostLoop(harness.engine, sandbox, adapter, { init: false });
    void loop.init(harness.engine.ctx);
    loop.fixedUpdate?.(1 / 60);
    expect(sandbox.inputs[0].input.gamepads).toHaveLength(1);
    expect(sandbox.inputs[0].input.gamepads[0].buttons).toBe(0b101);
    expect(sandbox.inputs[0].input.gamepads[0].axes[0]).toBeCloseTo(0.5);
  });

  it('turns engine:resize into a resized event on the next tick', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const sandbox = fakeSandbox(emptyOut());
    const loop = createHostLoop(harness.engine, sandbox, adapter, { init: false });
    void loop.init(harness.engine.ctx);

    harness.emit('engine:resize', { width: 1280, height: 720 });
    // A drag fires the observer many times per step; the guest sees one event.
    harness.emit('engine:resize', { width: 1281, height: 721 });
    loop.fixedUpdate?.(1 / 60);

    const events = sandbox.inputs[0].events;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      tag: 'resized',
      val: { width: 1281, height: 721, devicePixelRatio: 2 },
    });

    // The queue is drained, so a quiet step carries nothing.
    loop.fixedUpdate?.(1 / 60);
    expect(sandbox.inputs[1].events).toEqual([]);
  });

  it('reuses one event buffer rather than slicing the queue every step', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const sandbox = fakeSandbox(emptyOut());
    const loop = createHostLoop(harness.engine, sandbox, adapter, { init: false });
    void loop.init(harness.engine.ctx);

    adapter.events.push({ tag: 'asset-loaded', val: { asset: 1, name: 'a' } });
    loop.fixedUpdate?.(1 / 60);
    const firstBuffer = sandbox.inputs[0].events;
    expect(firstBuffer).toHaveLength(1);

    adapter.events.push({ tag: 'asset-loaded', val: { asset: 2, name: 'b' } });
    loop.fixedUpdate?.(1 / 60);
    expect(sandbox.inputs[1].events).toBe(firstBuffer);
    expect(sandbox.inputs[1].events[0]).toEqual({
      tag: 'asset-loaded',
      val: { asset: 2, name: 'b' },
    });
  });

  it('memoises the contact view per count', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const physics = fakePhysics();
    let contactCount = 1;
    physics.drainContacts = (out: Record<string, unknown>[]) => {
      for (let i = 0; i < contactCount; i += 1) {
        out[i] ??= {};
        Object.assign(out[i], {
          a: i + 1,
          b: 99,
          phase: 'begin',
          px: 0,
          py: 0,
          pz: 0,
          nx: 0,
          ny: 1,
          nz: 0,
          impulse: i,
        });
      }
      return contactCount;
    };
    harness.services.set('physics', physics);

    const sandbox = fakeSandbox(emptyOut());
    const loop = createHostLoop(harness.engine, sandbox, adapter, { init: false });
    void loop.init(harness.engine.ctx);
    loop.fixedUpdate?.(1 / 60);
    const one = sandbox.inputs[0].contacts;
    contactCount = 2;
    loop.fixedUpdate?.(1 / 60);
    expect(sandbox.inputs[1].contacts).not.toBe(one);
    expect(sandbox.inputs[1].contacts).toHaveLength(2);
    contactCount = 1;
    loop.fixedUpdate?.(1 / 60);
    // Back to one contact: the very same view, not a fresh slice.
    expect(sandbox.inputs[2].contacts).toBe(one);
  });

  it('sizes the body buffer before reading, so growth never reads twice', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const physics = fakePhysics();
    let reads = 0;
    let rows = 40;
    physics.movingBodyCount = rows;
    physics.readBodies = (out: Float32Array) => {
      reads += 1;
      expect(out.length).toBeGreaterThanOrEqual(rows * 15);
      return rows;
    };
    harness.services.set('physics', physics);

    const sandbox = fakeSandbox(emptyOut());
    const loop = createHostLoop(harness.engine, sandbox, adapter, { init: false, maxBodies: 8 });
    void loop.init(harness.engine.ctx);
    // The rows arrive on the event now: physics runs after the game module.
    harness.emit('physics:stepped', { dt: 1 / 60, movingBodyCount: rows, contacts: 0 });
    loop.fixedUpdate?.(1 / 60);
    expect(reads).toBe(1);
    expect(sandbox.inputs[0].bodies).toHaveLength(40 * 15);

    rows = 500;
    physics.movingBodyCount = rows;
    harness.emit('physics:stepped', { dt: 1 / 60, movingBodyCount: rows, contacts: 0 });
    loop.fixedUpdate?.(1 / 60);
    expect(reads).toBe(2);
    expect(sandbox.inputs[1].bodies).toHaveLength(500 * 15);
  });

  it('ticks the guest before physics, so its commands land in the same step', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const order: string[] = [];
    const physics = fakePhysics();
    physics.movingBodyCount = 1;
    physics.readBodies = (out: Float32Array) => {
      order.push('readBodies');
      out[0] = 1;
      out[7] = 1;
      return 1;
    };
    physics.moveCharacter = () => {
      order.push('moveCharacter');
    };
    harness.services.set('physics', physics);

    const out: FrameOutput = {
      transforms: new Float32Array(12),
      localCommands: [],
      commands: [
        {
          tag: 'move-character',
          val: {
            body: 1,
            desiredVelocity: { x: 1, y: 0, z: 0 },
            jump: false,
            crouch: false,
            maxSlopeDeg: 45,
          },
        },
      ],
      camera: cameraState(),
      hud: undefined,
    };
    const sandbox = fakeSandbox(out);
    const original = sandbox.tick.bind(sandbox);
    sandbox.tick = (input) => {
      order.push('tick');
      return original(input);
    };
    const loop = createHostLoop(harness.engine, sandbox, adapter, { init: false });
    void loop.init(harness.engine.ctx);

    // The module registry sorts by `order`: input (-100), game (-50), physics
    // (0). This is that step, in that order.
    expect(loop.order).toBeLessThan(0);
    loop.fixedUpdate?.(1 / 60);
    harness.emit('physics:stepped', { dt: 1 / 60, movingBodyCount: 1, contacts: 0 });

    // The guest ran, its command reached physics, and only then did the step's
    // rows come back — so the move is simulated by the step it was asked in.
    expect(order).toEqual(['tick', 'moveCharacter', 'readBodies']);
  });

  it('writes body rows into the transform store without the guest carrying them', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const physics = fakePhysics();
    physics.movingBodyCount = 1;
    physics.readBodies = (rows: Float32Array) => {
      rows[0] = 7; // body id
      rows[1] = 2; // x
      rows[2] = 3; // y
      rows[3] = 4; // z
      rows[4] = 0;
      rows[5] = 0.7071068;
      rows[6] = 0;
      rows[7] = 0.7071068;
      return 1;
    };
    harness.services.set('physics', physics);

    const sandbox = fakeSandbox(emptyOut());
    const loop = createHostLoop(harness.engine, sandbox, adapter, { init: false });
    void loop.init(harness.engine.ctx);

    // An entity with a non-unit scale, driven by body 7.
    adapter.spawn(
      5,
      undefined,
      { x: 0, y: 0, z: 0 },
      IDENTITY,
      { x: 2, y: 2, z: 2 },
      { visible: true },
    );
    adapter.addBody(addBodyCmd({ body: 7, entity: 5 }));

    harness.emit('physics:stepped', { dt: 1 / 60, movingBodyCount: 1, contacts: 0 });

    const position = adapter.transforms.getPosition(5, [0, 0, 0]);
    const rotation = adapter.transforms.getQuaternion(5, [0, 0, 0, 0]);
    expect([...position]).toEqual([2, 3, 4]);
    expect(rotation[3]).toBeCloseTo(0.7071068, 5);

    // The scale is the guest's to own, and nothing touched it.
    adapter.update(1 / 60, 1);
    const object = harness.scene.getObjectByName('entity:5');
    expect(object?.scale.x).toBe(2);
    expect(object?.position.y).toBeCloseTo(3, 5);

    // And the guest still receives the row, one step old, as `bodies`.
    loop.fixedUpdate?.(1 / 60);
    expect(sandbox.inputs[0].bodies).toHaveLength(15);
    expect(sandbox.inputs[0].bodies[2]).toBeCloseTo(3, 5);
  });

  it('preserves explicitly authored facing through physics without overriding its position', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    harness.services.set('physics', fakePhysics());
    adapter.spawn(1, undefined, { x: 0, y: 0, z: 0 }, IDENTITY, ONE, { visible: true });
    adapter.addBody(addBodyCmd({ body: 7, entity: 1, kind: 'character' }));
    const rows = new Float32Array([7, 2, 3, 4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
    adapter.beginFixedStep();
    // ROTATION only: turn the model by 180 degrees while the capsule moves.
    adapter.applyTransforms(new Float32Array([1, 2, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1]), 1);
    adapter.applyBodyRows(rows, 1);
    expect([...adapter.transforms.getPosition(1, [0, 0, 0])]).toEqual([2, 3, 4]);
    expect([...adapter.transforms.getQuaternion(1, [0, 0, 0, 0])]).toEqual([0, 1, 0, 0]);
    adapter.update(1 / 60, 1);
    expect(harness.scene.getObjectByName('entity:1')?.quaternion.y).toBe(1);
    // An ordinary physics rotation wins again on a step without guest intent.
    adapter.beginFixedStep();
    adapter.applyBodyRows(rows, 1);
    expect([...adapter.transforms.getQuaternion(1, [0, 0, 0, 0])]).toEqual([0, 0, 0, 1]);
    adapter.dispose();
  });

  it('does not apply the frame a dying guest returned', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const sandbox = fakeSandbox({
      transforms: new Float32Array(12),
      localCommands: [],
      commands: [],
      camera: cameraState({ fovYDeg: 33 }),
      hud: undefined,
    });
    const loop = createHostLoop(harness.engine, sandbox, adapter, {
      init: false,
      onDead: () => undefined,
    });
    void loop.init(harness.engine.ctx);
    (sandbox as unknown as { dead: boolean }).dead = true;
    loop.fixedUpdate?.(1 / 60);
    // The last live frame is still on screen; the inert frame never landed.
    expect(harness.camera.fov).not.toBe(33);
  });

  it('allocates nothing per fixed step once it is warm', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const physics = fakePhysics();
    harness.services.set('physics', physics);
    harness.services.set('audio', {
      play: () => undefined,
      stop: () => undefined,
      setListener: () => undefined,
      ended: [],
    });
    for (const entity of [1, 2, 3]) spawnAt(adapter, entity, { x: 0, y: 0, z: 0 });

    // One frame output, reused exactly as the guest reuses its own pools.
    const transforms = new Float32Array(3 * 12);
    for (let i = 0; i < 3; i += 1) {
      transforms[i * 12] = i + 1;
      transforms[i * 12 + 1] = 1; // POSITION
      transforms[i * 12 + 8] = 1; // qw
      transforms[i * 12 + 9] = 1;
      transforms[i * 12 + 10] = 1;
      transforms[i * 12 + 11] = 1;
    }
    const out: FrameOutput = {
      transforms,
      localCommands: [],
      commands: [
        {
          tag: 'move-character',
          val: {
            body: 1,
            desiredVelocity: { x: 1, y: 0, z: 0 },
            jump: false,
            crouch: false,
            maxSlopeDeg: 45,
          },
        },
        {
          tag: 'set-listener',
          val: {
            position: { x: 0, y: 1.7, z: 0 },
            rotation: IDENTITY,
            velocity: { x: 0, y: 0, z: 0 },
          },
        },
      ],
      camera: cameraState(),
      hud: undefined,
    };
    const sandbox = fakeSandbox(out);
    const loop = createHostLoop(harness.engine, sandbox, adapter, { init: false });
    void loop.init(harness.engine.ctx);

    /**
     * One representative fixed step, with entities that keep moving so the
     * transform store never settles into its early-out.
     *
     * @param tick The step number, used to vary the positions.
     * @returns Nothing.
     */
    const step = (tick: number): void => {
      for (let i = 0; i < 3; i += 1) transforms[i * 12 + 2] = tick * 0.01 + i;
      loop.fixedUpdate?.(1 / 60);
      adapter.update(1 / 60, 0.5);
      // The fake sandbox keeps every input it is handed; the real one does not.
      sandbox.inputs.length = 0;
      // Nor does the fake physics keep a copy of every `moveCharacter`: that
      // record alone retained ~190 bytes a step.
      physics.calls.length = 0;
    };

    // Warm up: the first ~3,000 steps still settle (they retain ~200 KB per
    // 1,500 and then give it back), so the measured windows start after them.
    for (let tick = 0; tick < 3500; tick += 1) step(tick);

    // Then three back-to-back windows of 1,500 steps, and the middle one of
    // the three readings is what counts. The settling occasionally lands
    // late: about one run in four, the first window retained ~145-170 KB and
    // the second gave ~145 KB back (observed: 170,288 then -144,176, then
    // 216), while settled windows held 0.2-7 KB. That one-off moves at most
    // one reading up and one down, so the median skips it; a real leak is in
    // every window and moves the median too. Not the minimum: the give-back
    // window is negative and would hide a leak.
    const retained: number[] = [];
    let tick = 3500;
    let previous = retainedHeap();
    for (let window = 0; window < 3; window += 1) {
      for (const end = tick + 1500; tick < end; tick += 1) step(tick);
      const now = retainedHeap();
      retained.push(now - previous);
      previous = now;
    }

    // Every reading follows a real collection, so only retained bytes count.
    // A settled window retains under 10 KB; 128 KB catches anything keeping
    // ~90 bytes a step.
    const median = [...retained].sort((a, b) => a - b)[1];
    expect(median, `retained per window: ${retained.join(', ')}`).toBeLessThan(128 * 1024);
  }, 30_000);

  it('is a module the engine can register', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    const loop: EngineModule = createHostLoop(harness.engine, fakeSandbox(emptyOut()), adapter, {
      init: false,
    });
    expect(loop.id).toBe('game');
    // After input (-100), before physics (0).
    expect(loop.order).toBe(-50);
  });
});

describe('setTransformFromHost', () => {
  it('writes only the lanes the flags name, snaps on TELEPORT and shows on VISIBLE', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    adapter.spawn(
      4,
      undefined,
      { x: 0, y: 0, z: 0 },
      IDENTITY,
      { x: 2, y: 2, z: 2 },
      { visible: false },
    );
    const position = new Float32Array([1, 2, 3]);
    const rotation = new Float32Array([0, 1, 0, 0]);
    const scale = new Float32Array([9, 9, 9]);
    adapter.beginFixedStep();
    // POSITION | ROTATION: the scale lane is junk from another row and must not land.
    adapter.setTransformFromHost(4, 1 | 2, position, rotation, scale);
    expect([...adapter.transforms.getPosition(4, [0, 0, 0])]).toEqual([1, 2, 3]);
    expect([...adapter.transforms.getQuaternion(4, [0, 0, 0, 0])]).toEqual([0, 1, 0, 0]);
    adapter.update(1 / 60, 1);
    const root = harness.scene.getObjectByName('entity:4');
    expect(root?.scale.x).toBe(2);
    expect(root?.visible).toBe(false);
    // Interpolated from the step's start: half way at alpha 0.5.
    adapter.beginFixedStep();
    position[0] = 3;
    adapter.setTransformFromHost(4, 1, position, rotation, scale);
    adapter.update(1 / 60, 0.5);
    expect(root?.position.x).toBeCloseTo(2, 5);
    // TELEPORT snaps; VISIBLE shows; SCALE lands.
    adapter.beginFixedStep();
    position[0] = 10;
    adapter.setTransformFromHost(4, 1 | 4 | 8 | 16, position, rotation, scale);
    adapter.update(1 / 60, 0.5);
    expect(root?.position.x).toBe(10);
    expect(root?.scale.x).toBe(9);
    expect(root?.visible).toBe(true);
    // An entity the adapter does not know is ignored.
    adapter.setTransformFromHost(77, 1, position, rotation, scale);
    expect(adapter.transforms.has(77)).toBe(false);
    adapter.dispose();
  });
});

describe('setTransformFromHost and the first-person camera', () => {
  it('never shows the entity the first-person camera is inside', () => {
    const harness = makeEngine();
    const adapter = createEngineAdapter(harness.engine, { hud: false, warn: () => undefined });
    adapter.spawn(6, undefined, { x: 0, y: 0, z: 0 }, IDENTITY, ONE, { visible: true });
    adapter.setCamera(cameraState({ mode: 'first-person', follow: 6 }));
    const root = harness.scene.getObjectByName('entity:6');
    expect(root?.visible).toBe(false);
    const lanes = new Float32Array(4);
    adapter.setTransformFromHost(6, 8, lanes, lanes, lanes); // VISIBLE
    expect(root?.visible).toBe(false);
    adapter.dispose();
  });
});
