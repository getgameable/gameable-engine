/**
 * Test doubles for client-side prediction: a page input module the test
 * presses keys on, an adapter whose body commands reach the page's Jolt
 * world, a stand-in client guest that walks its own character body, and a
 * second Jolt world that plays the authority for scripted trailers.
 * Not exported from the package.
 */
import type { EngineModule } from '@gameable/core';
import { physics, type PhysicsService } from '@gameable/physics-jolt';
import type { AddBodyCmd, Command, FrameOutput, HostFrameInput } from '@gameable/sdk';
import { keyIndex } from '@gameable/sdk/keycodes';
import type { Sandbox } from '@gameable/wasm-host';
import { createServerAdapter } from '@gameable/wasm-host/server';

import { GUEST_CAMERA, testClientAdapter, type TestClientAdapter } from './clientTesting.js';

/** Metres per second the walker moves while W is held. */
export const WALK = 4;

/** A page `input` module whose keys the test holds. */
export interface FakeInput extends EngineModule {
  /** @param key A key name to hold down, or release with `false`. */
  hold(key: string, down?: boolean): void;
}

/** @returns An `input` module the client loop reads like the real one. */
export function fakeInput(): FakeInput {
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
  return {
    id: 'input',
    order: -100,
    init: () => ({ state }),
    dispose: () => undefined,
    hold(key: string, down = true): void {
      const bit = keyIndex(key);
      const word = bit >> 5;
      const mask = 1 << (bit & 31);
      state.keysDown[word] = down ? state.keysDown[word] | mask : state.keysDown[word] & ~mask;
    },
  };
}

/**
 * @param world Where the page's bodies live, once the engine has booted.
 * @returns A recording adapter whose `add-body`, `remove-body` and
 *   `move-character` reach that world through the server adapter's body
 *   forwarding (the same `toJoltBody` and jump rule the page adapter uses).
 */
export function bodyAdapter(world: () => PhysicsService): TestClientAdapter & { adds: number } {
  const base = Object.assign(testClientAdapter(), { adds: 0 });
  let forward: ReturnType<typeof createServerAdapter> | null = null;
  const bodies = (): ReturnType<typeof createServerAdapter> =>
    (forward ??= createServerAdapter(world(), { warn: () => undefined }));
  return Object.assign(base, {
    addBody: (args: AddBodyCmd) => {
      base.adds += 1;
      bodies().addBody(args);
    },
    removeBody: (body: number) => {
      bodies().removeBody(body);
    },
    moveCharacter: (...args: Parameters<TestClientAdapter['moveCharacter']>) => {
      bodies().moveCharacter(...args);
    },
  });
}

/** @returns The page physics module, gravity on (no floor unless the test adds one). */
export function pagePhysics(): EngineModule {
  return physics({ maxBodies: 64 });
}

/**
 * The walker's own character body: a capsule, as the tiny game's player is.
 *
 * @param body The body id.
 * @param entity The entity it drives.
 * @param y Where it starts, metres up.
 * @returns The `add-body`.
 */
export const WALKER_BODY = (body: number, entity: number, y = 1): AddBodyCmd => ({
  body,
  entity,
  kind: 'character',
  shape: { kind: 'capsule', halfExtents: { x: 0.3, y: 0.9, z: 0.3 }, asset: undefined },
  position: { x: 0, y, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  mass: 80,
  friction: 0.5,
  restitution: 0,
  linearDamping: 0,
  angularDamping: 0,
  layer: { player: true },
  mask: { staticGeometry: true },
  flags: { lockRotation: true, noSleep: true },
});

/**
 * A client-role guest that is not the SDK (so it can share a realm with a
 * direct authority): on its first tick it adds its own character body, then
 * every tick walks it -Z while its seat's W is down. A second character body
 * and a box it adds on its first tick are the bodies prediction must refuse.
 */
export class WalkerStub implements Sandbox {
  readonly mode = 'direct';
  dead = false;
  error: Error | null = null;
  /** Ticks run. */
  ticks = 0;
  /** Add a second character and a dynamic box on the first tick. */
  extraBodies = false;
  private readonly commands: Command[] = [];
  private readonly move = {
    tag: 'move-character' as const,
    val: {
      body: 1,
      desiredVelocity: { x: 0, y: 0, z: 0 },
      jump: false,
      crouch: false,
      maxSlopeDeg: 45,
    },
  };
  private readonly out: FrameOutput = {
    transforms: new Float32Array(12),
    commands: this.commands,
    localCommands: [],
    camera: GUEST_CAMERA,
    hud: undefined,
  };
  private readonly w = keyIndex('W');

  init(): void {}

  tick(input: HostFrameInput): FrameOutput {
    this.ticks += 1;
    this.commands.length = 0;
    if (this.ticks === 1) {
      this.commands.push({ tag: 'add-body', val: WALKER_BODY(1, 1) });
      if (this.extraBodies) {
        this.commands.push({ tag: 'add-body', val: WALKER_BODY(2, 2) });
        this.commands.push({ tag: 'add-body', val: { ...WALKER_BODY(3, 3), kind: 'dynamic' } });
      }
    }
    const down = input.players.at(0)?.input.keys.down;
    const walking = down !== undefined && (down[this.w >> 5] & (1 << (this.w & 31))) !== 0;
    this.move.val.desiredVelocity.z = walking ? -WALK : 0;
    this.commands.push(this.move);
    return this.out;
  }

  shutdown(): void {}
  snapshot(): Uint8Array {
    return new Uint8Array(0);
  }
  restore(): void {}
}
