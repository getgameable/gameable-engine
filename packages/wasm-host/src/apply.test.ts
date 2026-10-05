import { describe, expect, it } from 'vitest';

import { NullEngineAdapter } from './adapter/EngineAdapter';
import { applyCommand, applyOutput } from './apply';
import type { CameraState, Command, CommandTag, FrameOutput } from '@gameable/sdk';

const v3 = { x: 1, y: 2, z: 3 };
const quat = { x: 0, y: 0, z: 0, w: 1 };

const CAMERA: CameraState = {
  mode: 'first-person',
  projection: 'perspective',
  position: v3,
  rotation: quat,
  target: undefined,
  fovYDeg: 75,
  near: 0.1,
  far: 1000,
  follow: 1,
  armLength: 0,
  offset: v3,
};

/** One command of every tag, in WIT declaration order. */
const EVERY_COMMAND: Command[] = [
  {
    tag: 'spawn',
    val: {
      entity: 1,
      asset: 5,
      position: v3,
      rotation: quat,
      scale: v3,
      parent: undefined,
      visible: true,
      name: 'hero',
    },
  },
  { tag: 'despawn', val: 1 },
  { tag: 'set-asset', val: { entity: 1, asset: 6 } },
  { tag: 'set-parent', val: { entity: 1, parent: 2, keepWorldTransform: true } },
  {
    tag: 'set-anim',
    val: { entity: 1, clip: 'walk', looping: true, speed: 1, fadeMs: 100, weight: 1 },
  },
  {
    tag: 'set-material-param',
    val: { entity: 1, name: 'emissive', value: { tag: 'scalar', val: 0.5 } },
  },
  {
    tag: 'add-body',
    val: {
      body: 1,
      entity: 1,
      kind: 'dynamic',
      shape: { kind: 'box', halfExtents: v3, asset: undefined },
      position: v3,
      rotation: quat,
      mass: 10,
      friction: 0.5,
      restitution: 0,
      linearDamping: 0.05,
      angularDamping: 0.05,
      layer: { player: true },
      mask: { enemy: true },
      flags: { ccd: true },
    },
  },
  { tag: 'remove-body', val: 1 },
  { tag: 'set-body-transform', val: { body: 1, position: v3, rotation: quat, teleport: true } },
  { tag: 'set-body-velocity', val: { body: 1, linear: v3, angular: undefined } },
  { tag: 'apply-impulse', val: { body: 1, impulse: v3, atPoint: undefined } },
  { tag: 'set-body-enabled', val: { body: 1, enabled: false } },
  {
    tag: 'move-character',
    val: { body: 1, desiredVelocity: v3, jump: true, crouch: false, maxSlopeDeg: 45 },
  },
  { tag: 'spawn-character', val: { entity: 2, bundle: 7, position: v3, rotation: quat } },
  {
    tag: 'set-character-state',
    val: { entity: 2, state: 'run', velocity: v3, grounded: true },
  },
  { tag: 'set-clip-weights', val: { entity: 2, clips: ['a'], weights: [1], timeScale: 1 } },
  { tag: 'set-expression', val: { entity: 2, space: 'arkit52', weights: [0] } },
  { tag: 'look-at', val: { entity: 2, target: v3, weight: 1 } },
  { tag: 'say', val: { entity: 2, text: 'hi', audio: 8, visemes: undefined } },
  {
    tag: 'play-sound',
    val: {
      sound: 1,
      asset: 9,
      entity: 1,
      position: undefined,
      volume: 1,
      pitch: 1,
      looping: false,
      bus: 'sfx',
    },
  },
  { tag: 'stop-sound', val: { sound: 1, fadeMs: 50 } },
  { tag: 'set-listener', val: { position: v3, rotation: quat, velocity: v3 } },
  { tag: 'load-asset', val: { asset: 10, priority: 3 } },
  { tag: 'set-pointer-lock', val: true },
  { tag: 'set-time-scale', val: 0.5 },
  { tag: 'conversation', val: { entity: 7, action: 'start', character: 'steward', text: '' } },
  { tag: 'send', val: { to: 2, name: 'vote', payload: '{"for":1}', reliable: true } },
  { tag: 'set-player-camera', val: { player: 2, camera: CAMERA } },
  { tag: 'set-player-hud', val: { player: 2, hud: '{"role":"murderer"}' } },
  { tag: 'save-player-data', val: { player: 2, data: '{"gold":3}' } },
  { tag: 'save-game-data', val: { data: '{"round":4}' } },
  { tag: 'exchange', val: { id: 1, a: 2, b: 3, give: '{"gold":1}', take: '{"gem":1}' } },
  { tag: 'set-player-entity', val: { player: 2, entity: 7 } },
];

/** The adapter method each tag dispatches to. */
const EXPECTED: Record<CommandTag, string> = {
  spawn: 'spawn',
  despawn: 'despawn',
  'set-asset': 'setAsset',
  'set-parent': 'setParent',
  'set-anim': 'setAnim',
  'set-material-param': 'setMaterialParam',
  'add-body': 'addBody',
  'remove-body': 'removeBody',
  'set-body-transform': 'setBodyTransform',
  'set-body-velocity': 'setBodyVelocity',
  'apply-impulse': 'applyImpulse',
  'set-body-enabled': 'setBodyEnabled',
  'move-character': 'moveCharacter',
  'spawn-character': 'spawnCharacter',
  'set-character-state': 'setCharacterState',
  'set-clip-weights': 'setClipWeights',
  'set-expression': 'setExpression',
  'look-at': 'lookAt',
  say: 'say',
  'play-sound': 'playSound',
  'stop-sound': 'stopSound',
  'set-listener': 'setListener',
  'load-asset': 'loadAsset',
  'set-pointer-lock': 'setPointerLock',
  'set-time-scale': 'setTimeScale',
  conversation: 'conversation',
  send: 'send',
  'set-player-camera': 'setPlayerCamera',
  'set-player-hud': 'setPlayerHud',
  'save-player-data': 'savePlayerData',
  'save-game-data': 'saveGameData',
  exchange: 'exchange',
  'set-player-entity': 'setPlayerEntity',
};

describe('applyCommand', () => {
  it('covers every tag in the WIT variant', () => {
    const tags = EVERY_COMMAND.map((c) => c.tag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('dispatches each tag to its adapter method', () => {
    for (const command of EVERY_COMMAND) {
      const adapter = NullEngineAdapter();
      applyCommand(adapter, command);
      expect(adapter.calls).toHaveLength(1);
      expect(adapter.calls[0]?.method).toBe(EXPECTED[command.tag]);
    }
  });

  it('unpacks spawn into positional arguments plus a flags object', () => {
    const adapter = NullEngineAdapter();
    applyCommand(adapter, EVERY_COMMAND[0]);
    const args = adapter.calls[0]?.args ?? [];
    expect(args[0]).toBe(1);
    expect(args[1]).toBe(5);
    expect(args[2]).toBe(v3);
    expect(args[5]).toEqual({ parent: undefined, visible: true, name: 'hero' });
  });

  it('unpacks the net and data commands into their adapter arguments', () => {
    const adapter = NullEngineAdapter();
    for (const tag of ['send', 'set-player-hud', 'save-player-data'] as const) {
      applyCommand(
        adapter,
        EVERY_COMMAND.find((c) => c.tag === tag)!,
      );
    }
    expect(adapter.by('send')[0]?.args).toEqual([2, 'vote', '{"for":1}', true]);
    expect(adapter.by('setPlayerHud')[0]?.args).toEqual([2, '{"role":"murderer"}']);
    expect(adapter.by('savePlayerData')[0]?.args).toEqual([2, '{"gold":3}']);
  });

  it('hands add-body the whole record', () => {
    const adapter = NullEngineAdapter();
    const addBody = EVERY_COMMAND.find((c) => c.tag === 'add-body')!;
    applyCommand(adapter, addBody);
    expect(adapter.calls[0]?.args[0]).toBe(addBody.val);
  });
});

describe('applyOutput', () => {
  it('applies transforms, then commands, then camera, then hud', () => {
    const adapter = NullEngineAdapter();
    const out: FrameOutput = {
      transforms: new Float32Array(24),
      localCommands: [],
      commands: [EVERY_COMMAND[1]],
      camera: CAMERA,
      hud: '{"a":1}',
    };
    applyOutput(adapter, out);
    expect(adapter.calls.map((c) => c.method)).toEqual([
      'applyTransforms',
      'despawn',
      'setCamera',
      'setHud',
    ]);
    expect(adapter.lastTransformCount).toBe(2);
    expect(adapter.by('setHud')[0]?.args[0]).toBe('{"a":1}');
  });

  it('passes undefined through when the hud did not change', () => {
    const adapter = NullEngineAdapter();
    applyOutput(adapter, {
      transforms: new Float32Array(12),
      localCommands: [],
      commands: [],
      camera: CAMERA,
      hud: undefined,
    });
    expect(adapter.by('setHud')[0]?.args[0]).toBeUndefined();
  });

  it('applies localCommands after commands when the adapter applies local ones', () => {
    const adapter = NullEngineAdapter();
    applyOutput(adapter, {
      transforms: new Float32Array(12),
      commands: [EVERY_COMMAND[1]],
      localCommands: [{ tag: 'despawn', val: 9 }],
      camera: CAMERA,
      hud: undefined,
    });
    expect(adapter.by('despawn').map((c) => c.args[0])).toEqual([1, 9]);
    expect(adapter.calls.map((c) => c.method).indexOf('setCamera')).toBe(3);
  });

  it('skips localCommands on an adapter that does not apply them', () => {
    const adapter = NullEngineAdapter({ appliesLocal: false });
    applyOutput(adapter, {
      transforms: new Float32Array(12),
      commands: [],
      localCommands: [{ tag: 'despawn', val: 9 }],
      camera: CAMERA,
      hud: undefined,
    });
    expect(adapter.by('despawn')).toHaveLength(0);
  });
});
