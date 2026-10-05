/**
 * The fresh, preallocated state one guest owns: every buffer, lane and table
 * `createGuest` mutates in place for the life of the instance.
 */
import { makeCameraState } from './camera';
import { KEY_WORDS } from './keycodes';
import { makeGamepad } from './inputLanes';
import { NetCommandBuffer, PlayerTable, parseNetOptions } from './net';
import { BodyIndex, TransformPacker } from './packing';
import { createRng } from './rng';
import type { GameDefinition } from './defineGame';
import type { InputLanes } from './inputLanes';
import type { RuntimeState } from './state';
import type { AssetDesc, HostApi } from './types';

/**
 * Build one guest's runtime state. Construction only, never per tick.
 *
 * @param host The host services.
 * @param definition The game, for its look sensitivity.
 * @param maxEntities The entity ceiling the packers are sized for.
 * @returns The state, with `inputLanes` pointing at its own lanes.
 */
export function createRuntimeState(
  host: HostApi,
  definition: GameDefinition,
  maxEntities: number,
): RuntimeState {
  const rt: RuntimeState = {
    host,
    config: {
      seed: 0,
      fixedHz: 60,
      viewportWidth: 0,
      viewportHeight: 0,
      devMode: false,
      options: undefined,
    },
    world: {},
    frame: 0,
    dt: 1 / 60,
    elapsed: 0,
    rng: createRng(1),
    packer: new TransformPacker(maxEntities),
    bodyIndex: new BodyIndex(maxEntities),
    commands: new NetCommandBuffer(),
    localCommands: new NetCommandBuffer(),
    camera: makeCameraState(),
    look: { yaw: 0, pitch: 0, sensitivity: definition.player?.sensitivity ?? 0.0025 },
    hud: { last: null, pending: undefined },
    keysDown: new Uint32Array(KEY_WORDS),
    keysPressed: new Uint32Array(KEY_WORDS),
    keysReleased: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
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
    gamepads: [makeGamepad(), makeGamepad(), makeGamepad(), makeGamepad()],
    gamepadCount: 0,
    focused: true,
    // Replaced just below: the runtime is its own lanes until a client points it at a slot.
    inputLanes: null as unknown as InputLanes,
    contacts: [],
    events: [],
    players: new PlayerTable(host),
    net: parseNetOptions(undefined),
    nextBody: 1,
    nextSound: 1,
    assetIds: new Map<string, number>(),
    assetDescs: new Map<number, AssetDesc | null>(),
    initialised: false,
    player: 0,
    carryCommands: false,
    dead: false,
    failures: 0,
  };
  rt.inputLanes = rt;
  return rt;
}
