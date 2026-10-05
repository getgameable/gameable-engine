import v8 from 'node:v8';
import vm from 'node:vm';

import {
  AnimationClip,
  Bone,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';

import { type Animator, createAnimator, HEAD_AIM_DEFAULTS } from './Animator';
import { ARKIT_COUNT } from './face/arkitNames';
import { buildIndexFor } from './graph/evalCore';
import { edgeList, nodeList, type BodyGraph } from './graph/types';
import type { LocomotionIndex } from './locomotion';
import type { CharacterState } from './state/characterState';

/** A synthetic rig: Armature -> pelvis -> spine_01 -> head, bound to a skinned mesh. */
interface Rig {
  /** The rig root passed to the animator. */
  root: Object3D;
  /** The bones, in skeleton order. */
  bones: Bone[];
}

/**
 * Build the three-bone test rig.
 *
 * @returns The rig.
 */
function makeRig(): Rig {
  const root = new Object3D();
  root.name = 'Armature';
  const names = ['pelvis', 'spine_01', 'head'];
  const bones: Bone[] = [];
  let parent: Object3D = root;
  for (const name of names) {
    const bone = new Bone();
    bone.name = name;
    bone.position.set(0, 0.5, 0);
    parent.add(bone);
    bones.push(bone);
    parent = bone;
  }
  const skeleton = new Skeleton(bones);
  const mesh = new SkinnedMesh();
  mesh.name = 'body';
  root.add(mesh);
  mesh.bind(skeleton);
  root.updateMatrixWorld(true);
  return { root, bones };
}

/**
 * The `aosrig_v0` skeleton, shortened: `root -> c_spine0..3 -> c_neck -> c_head`.
 *
 * The names are the real rig's, and none of them is `pelvis` or `head`, so an
 * animator given no `bones` option finds neither the root bone nor the head —
 * which is exactly what that option is for.
 *
 * @returns The rig.
 */
function makeAosRig(): Rig {
  const root = new Object3D();
  root.name = 'AosRig';
  const spec: readonly (readonly [string, number])[] = [
    ['root', 0.92],
    ['c_spine0', 0.1],
    ['c_spine1', 0.12],
    ['c_spine2', 0.12],
    ['c_spine3', 0.12],
    ['c_neck', 0.15],
    ['c_head', 0.08],
  ];
  const bones: Bone[] = [];
  let parent: Object3D = root;
  for (const [name, y] of spec) {
    const bone = new Bone();
    bone.name = name;
    bone.position.set(0, y, 0);
    parent.add(bone);
    bones.push(bone);
    parent = bone;
  }
  const skeleton = new Skeleton(bones);
  const mesh = new SkinnedMesh();
  mesh.name = 'aosrig_v0';
  root.add(mesh);
  mesh.bind(skeleton);
  root.updateMatrixWorld(true);
  return { root, bones };
}

/** What `bootSkinned` passes for the real rig: neck takes 0.4, head takes 0.6. */
const AOSRIG_AIM: readonly (readonly [string, number])[] = [
  ['c_neck', 0.4],
  ['c_head', 0.6],
];

/**
 * An animator over the aosrig skeleton.
 *
 * @param bones Which bones are the root and the head.
 * @param bones.root Name of the bone `bodyPose.rootPos` comes from.
 * @param bones.head Name of the bone head aim measures from.
 *
 * @returns The animator and its rig.
 */
function makeAosAnimator(bones: { root?: string; head?: string }): {
  animator: Animator;
  rig: Rig;
} {
  const rig = makeAosRig();
  const animator = createAnimator({
    root: rig.root,
    clock: () => 0,
    expressionSpace: { kind: 'arkit52', dim: ARKIT_COUNT },
    bones,
    headAim: { joints: AOSRIG_AIM },
    blink: false,
    random: () => 0,
  });
  return { animator, rig };
}

/**
 * A clip that holds spine_01 at a fixed rotation about Y.
 *
 * @param name Clip name.
 * @param angle Rotation in radians.
 *
 * @returns The clip.
 */
function spineClip(name: string, angle: number): AnimationClip {
  const s = Math.sin(angle / 2);
  const c = Math.cos(angle / 2);
  return new AnimationClip(name, 1, [
    new QuaternionKeyframeTrack('spine_01.quaternion', [0, 1], [0, s, 0, c, 0, s, 0, c]),
  ]);
}

/** Idle holds the spine straight; walk twists it 0.5 rad, so the blend is readable. */
const LOCOMOTION: LocomotionIndex = {
  clips: [
    { name: 'idle', file: 'idle.glb', loop: true, speed: 0 },
    { name: 'walk', file: 'walk.glb', loop: true, speed: 2 },
  ],
};

/**
 * An animator over the test rig, with the two locomotion clips registered.
 *
 * @param now Millisecond clock.
 *
 * @returns The animator and its rig.
 */
function makeAnimator(now: () => number = () => 0): { animator: Animator; rig: Rig } {
  const rig = makeRig();
  const animator = createAnimator({
    root: rig.root,
    clock: now,
    expressionSpace: { kind: 'arkit52', dim: ARKIT_COUNT },
    locomotion: LOCOMOTION,
    blink: false,
    random: () => 0,
  });
  animator.addClip('idle', spineClip('idle', 0));
  animator.addClip('walk', spineClip('walk', 0.5));
  return { animator, rig };
}

/**
 * A minimal character state.
 *
 * @param patch Fields to override.
 *
 * @returns The state.
 */
function state(patch: Partial<CharacterState> = {}): CharacterState {
  return { velocity: [0, 0, 0], grounded: true, lookAt: null, ...patch };
}

/**
 * A two-state machine over the two registered clips; it stays in `idle`.
 *
 * Deliberately the shape with the most per-frame work in it: inner node and
 * edge lists, a nested state subgraph each side, and a rule graph on the
 * transition edge.
 *
 * @returns The graph.
 */
function smGraph(): BodyGraph {
  /**
   * One state with an inner `playClip` subgraph.
   *
   * @param id State id.
   * @param clip Clip name.
   *
   * @returns The state node.
   */
  const smState = (id: string, clip: string) => ({
    id,
    type: 'state',
    data: {
      innerNodes: [
        { id: 'output', type: 'stateOutput', data: {} },
        { id: `${id}_clip`, type: 'playClip', data: { clipName: clip, loop: true } },
      ],
      innerEdges: [{ source: `${id}_clip`, target: 'output', targetHandle: 'in' }],
    },
  });
  return {
    nodes: [
      { id: 'final', type: 'finalPose', data: {} },
      {
        id: 'sm',
        type: 'stateMachine',
        data: {
          innerNodes: [
            { id: 'entry', type: 'entry', data: {} },
            smState('idle', 'idle'),
            smState('walk', 'walk'),
          ],
          innerEdges: [
            { source: 'entry', target: 'idle', data: {} },
            {
              source: 'idle',
              target: 'walk',
              data: {
                ruleGraph: {
                  nodes: [
                    { id: 'ruleResult', type: 'ruleResult', data: {} },
                    { id: 'g', type: 'varGet', data: { varName: 'go' } },
                  ],
                  edges: [{ source: 'g', target: 'ruleResult', targetHandle: 'in' }],
                },
              },
            },
          ],
        },
      },
    ],
    edges: [{ source: 'sm', target: 'final', targetHandle: 'in' }],
  };
}

/**
 * Force a garbage collection, so a heap reading measures retained bytes rather
 * than whatever V8 has not swept yet.
 *
 * `--expose-gc` is not on in the default vitest run, so the flag is turned on
 * for long enough to pull `gc` out of a fresh context. Without it a heap
 * delta over a thousand frames is pure noise — it reads megabytes of
 * uncollected garbage on one run and a negative number on the next.
 */
function collectGarbage(): void {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    return;
  }
  v8.setFlagsFromString('--expose-gc');
  const fn: unknown = vm.runInNewContext('gc');
  v8.setFlagsFromString('--no-expose-gc');
  if (typeof fn === 'function') (fn as () => void)();
}

/**
 * The spine_01 rotation the animator produced, as an angle about Y.
 *
 * @param animator The animator.
 *
 * @returns The angle in radians.
 */
function spineYaw(animator: Animator): number {
  const i = animator.boneNames.indexOf('spine_01') * 4;
  return 2 * Math.atan2(animator.bodyPose.bones[i + 1], animator.bodyPose.bones[i + 3]);
}

/**
 * The head override rotation, as an angle about Y.
 *
 * @param animator The animator.
 *
 * @returns The angle in radians.
 */
function headOverrideYaw(animator: Animator): number {
  const q = animator.jointOverrides.get('head');
  expect(q).toBeDefined();
  return q === undefined ? 0 : 2 * Math.atan2(q[1], q[3]);
}

describe('createAnimator', () => {
  it('exposes the skeleton in order and sizes the pose buffers to it', () => {
    const { animator } = makeAnimator();
    expect(animator.boneNames).toEqual(['pelvis', 'spine_01', 'head']);
    expect(animator.bodyPose.bones.length).toBe(12);
    expect(animator.bodyPose.rootPos.length).toBe(3);
    expect(animator.expression.length).toBe(ARKIT_COUNT);
  });

  it('rejects a non-ARKit expression space with no map', () => {
    const rig = makeRig();
    expect(() =>
      createAnimator({ root: rig.root, expressionSpace: { kind: 'gnm', dim: 383 } }),
    ).toThrow(/needs a map/);
  });

  it('blends locomotion by planar speed', () => {
    const { animator } = makeAnimator();

    animator.setState(state({ velocity: [0, 0, 0] }));
    animator.update(1 / 60);
    expect(spineYaw(animator)).toBeCloseTo(0, 4);

    animator.setState(state({ velocity: [2, 0, 0] }));
    animator.update(1 / 60);
    expect(spineYaw(animator)).toBeCloseTo(0.5, 4);

    animator.setState(state({ velocity: [1, 0, 0] }));
    animator.update(1 / 60);
    expect(spineYaw(animator)).toBeCloseTo(0.25, 4);

    // A vertical fall is not locomotion.
    animator.setState(state({ velocity: [0, -9, 0], grounded: false }));
    animator.update(1 / 60);
    expect(spineYaw(animator)).toBeCloseTo(0, 4);
  });

  it('honours explicit clip weights from the guest', () => {
    const { animator } = makeAnimator();
    animator.setState(state({ velocity: [2, 0, 0], clips: [{ name: 'idle', weight: 1 }] }));
    animator.update(1 / 60);
    expect(spineYaw(animator)).toBeCloseTo(0, 4);
  });

  it('blends face clips into the expression vector', () => {
    let t = 0;
    const { animator } = makeAnimator(() => t);
    const open = new Float32Array(ARKIT_COUNT);
    open[17] = 1; // JawOpen
    animator.addFaceClip('talk', {
      fps: 2,
      frames: [
        { timeCode: 0, blendshapeWeights: open },
        { timeCode: 0.5, blendshapeWeights: open },
      ],
    });

    animator.setState(state({ clips: [{ name: 'talk', weight: 0.5 }] }));
    animator.update(1 / 60);
    expect(animator.expression[17]).toBeCloseTo(0.5, 5);

    // Dropping the drive clears the channel.
    t = 100;
    animator.setState(state());
    animator.update(1 / 60);
    expect(animator.expression[17]).toBe(0);
  });

  it('takes the guest expression vector when one is supplied', () => {
    const { animator } = makeAnimator();
    const expression = new Float32Array(ARKIT_COUNT);
    expression[17] = 0.75;
    animator.setState(state({ expression }));
    animator.update(1 / 60);
    expect(animator.expression[17]).toBeCloseTo(0.75, 6);
  });

  it('writes the blink channels when the blink layer is on', () => {
    let t = 0;
    const rig = makeRig();
    const animator = createAnimator({
      root: rig.root,
      clock: () => t,
      expressionSpace: { kind: 'arkit52', dim: ARKIT_COUNT },
      blink: { minInterval: 0, maxInterval: 0 },
      random: () => 0,
    });
    animator.setState(state());
    animator.update(1 / 60); // starts the blink at t = 0
    t = 40; // half way through the close ramp
    animator.update(1 / 60);
    expect(animator.expression[0]).toBeCloseTo(0.5, 5);
    expect(animator.expression[7]).toBeCloseTo(0.5, 5);
    animator.dispose();
  });

  it('clamps the head aim and leaves the residual to the eyes', () => {
    const { animator, rig } = makeAnimator();
    // Hard left, far beyond the neck's range.
    animator.setState(state({ lookAt: [-100, 0.5, 0] }));
    for (let i = 0; i < 400; i += 1) animator.update(1 / 60);

    // The rig has no neck_01 / neck_02, so only the head's 0.5 share applies.
    const applied = headOverrideYaw(animator) / 0.5;
    expect(Math.abs(applied)).toBeLessThanOrEqual(HEAD_AIM_DEFAULTS.maxYaw + 1e-6);
    expect(Math.abs(applied)).toBeCloseTo(HEAD_AIM_DEFAULTS.maxYaw, 4);
    expect(applied).toBeLessThan(0); // it turns toward the target, not away

    // Whatever the neck could not reach is handed to the eyes, clamped.
    expect(Math.abs(animator.gaze[1])).toBeCloseTo(HEAD_AIM_DEFAULTS.maxEyeYaw, 4);
    expect(animator.jointOverrides.get('neck_01')?.[3]).toBe(1); // absent bone stays identity

    // Releasing the look target decays the aim back to neutral.
    animator.setState(state({ lookAt: null }));
    for (let i = 0; i < 400; i += 1) animator.update(1 / 60);
    expect(Math.abs(headOverrideYaw(animator))).toBeLessThan(1e-3);
    expect(rig.bones).toHaveLength(3);
  });

  it('shares a look between the head and the eyes by headAim.share', () => {
    const { animator } = makeAnimator();
    animator.headAim.share = 0.55;
    // 30 degrees to the side, far away: within both the head's and the eyes' range
    const yaw = (30 * Math.PI) / 180;
    animator.setState(state({ lookAt: [-1000 * Math.sin(yaw), 1.6, 1000 * Math.cos(yaw)] }));
    for (let i = 0; i < 400; i += 1) animator.update(1 / 60);
    const head = Math.abs(headOverrideYaw(animator) / 0.5);
    expect(head).toBeCloseTo(0.55 * yaw, 2);
    expect(Math.abs(animator.gaze[1])).toBeCloseTo(0.45 * yaw, 2);
    // the eyes' share scales what is left for them
    animator.headAim.eyeShare = 0.5;
    for (let i = 0; i < 400; i += 1) animator.update(1 / 60);
    expect(Math.abs(animator.gaze[1])).toBeCloseTo(0.5 * 0.45 * yaw, 2);
    animator.dispose();
  });

  it('runs the gesture layer additively without stopping it from the base layer', () => {
    let t = 0;
    const { animator } = makeAnimator(() => t);
    animator.addClip('wave', spineClip('wave', 1), { additive: true });
    expect(animator.gesture.play('wave', { durationMs: 1000, fadeInMs: 0, fadeOutMs: 0 })).toBe(
      true,
    );
    t = 500;
    animator.setState(state());
    animator.update(1 / 60);
    expect(animator.gesture.isActive()).toBe(true);
    t = 1001;
    animator.update(1 / 60);
    expect(animator.gesture.isActive()).toBe(false);
  });

  it('aims at the camera when the state names no look target', () => {
    const { animator } = makeAnimator();
    const camera = new Object3D();
    camera.position.copy(new Vector3(-100, 0.5, 0));
    camera.updateMatrixWorld(true);
    animator.setState(state());
    for (let i = 0; i < 400; i += 1) animator.update(1 / 60, { camera });
    expect(headOverrideYaw(animator)).toBeLessThan(-0.1);
  });

  it('reads rootPos from the bone `bones.root` names', () => {
    const { animator } = makeAosAnimator({ root: 'root', head: 'c_head' });
    animator.setState(state());
    animator.update(1 / 60);
    expect(animator.bodyPose.rootPos[1]).toBeCloseTo(0.92, 6);

    // Any bone, not just the first: the name is what picks it.
    const other = makeAosAnimator({ root: 'c_neck', head: 'c_head' });
    other.animator.setState(state());
    other.animator.update(1 / 60);
    expect(other.animator.bodyPose.rootPos[1]).toBeCloseTo(0.15, 6);
  });

  it('aims the head bone `bones.head` names, tipping up toward a target above', () => {
    const { animator } = makeAosAnimator({ root: 'root', head: 'c_head' });
    // Straight ahead on +Z and well above the head.
    animator.setState(state({ lookAt: [0, 20, 4] }));
    for (let i = 0; i < 400; i += 1) animator.update(1 / 60);

    const head = animator.jointOverrides.get('c_head');
    expect(head).toBeDefined();
    // A positive rotation about +X tips +Z DOWN, so looking up is x < 0.
    expect(head![0]).toBeLessThan(-0.01);
    expect(2 * Math.asin(-head![0])).toBeCloseTo(HEAD_AIM_DEFAULTS.maxPitch * 0.6, 3);
    // The neck took 0.4 of the same aim: same direction, smaller.
    const neck = animator.jointOverrides.get('c_neck')!;
    expect(neck[0]).toBeLessThan(0);
    expect(neck[0]).toBeGreaterThan(head![0]);
  });

  it('clamps the head yaw against context.bodyYaw rather than the root', () => {
    const { animator } = makeAosAnimator({ root: 'root', head: 'c_head' });
    // Hard left of world forward, far beyond the neck's range.
    animator.setState(state({ lookAt: [-100, 1.5, 0] }));
    for (let i = 0; i < 400; i += 1) animator.update(1 / 60);
    const free = animator.jointOverrides.get('c_head')!;
    expect(2 * Math.atan2(free[1], free[3])).toBeCloseTo(-HEAD_AIM_DEFAULTS.maxYaw * 0.6, 3);

    // Now say the body is already facing the target: nothing is left to turn.
    const facing = Math.atan2(-100, 0);
    for (let i = 0; i < 400; i += 1) animator.update(1 / 60, { bodyYaw: facing });
    const clamped = animator.jointOverrides.get('c_head')!;
    expect(Math.abs(2 * Math.atan2(clamped[1], clamped[3]))).toBeLessThan(1e-3);
  });

  it('parks the head aim once it has converged with nothing to look at', () => {
    const { animator } = makeAnimator();
    animator.setState(state({ lookAt: [-100, 0.5, 0] }));
    for (let i = 0; i < 400; i += 1) animator.update(1 / 60);

    // Released, but not yet decayed: the transport must still run, or the head
    // would snap back to neutral instead of easing.
    animator.setState(state({ lookAt: null }));
    const spy = vi.spyOn(Quaternion.prototype, 'setFromAxisAngle');
    try {
      animator.update(1 / 60);
      expect(spy).toHaveBeenCalled();
      expect(Math.abs(headOverrideYaw(animator))).toBeGreaterThan(1e-3);

      // Converged: no target, no camera, nothing left to transport.
      for (let i = 0; i < 400; i += 1) animator.update(1 / 60);
      expect(headOverrideYaw(animator)).toBe(0);
      spy.mockClear();
      animator.update(1 / 60);
      animator.update(1 / 60);
      expect(spy).not.toHaveBeenCalled();
      expect(animator.gaze[1]).toBe(0);

      // A camera appearing wakes it up again on the very next frame.
      const camera = new Object3D();
      camera.position.copy(new Vector3(-100, 0.5, 0));
      camera.updateMatrixWorld(true);
      animator.update(1 / 60, { camera });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('folds overrides in through the precomputed bone index, not a per-bone map lookup', () => {
    const { animator, rig } = makeAnimator();
    // pelvis is not an aimed joint and no clip drives it: it must come through
    // the pose untouched, at whatever the bone itself holds.
    const pelvis = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.3);
    rig.bones[0].quaternion.copy(pelvis);

    animator.setState(state({ lookAt: [-100, 0.5, 0] }));
    for (let i = 0; i < 400; i += 1) animator.update(1 / 60);

    const pose = animator.bodyPose.bones;
    expect(pose[0]).toBeCloseTo(pelvis.x, 6);
    expect(pose[1]).toBeCloseTo(pelvis.y, 6);
    expect(pose[2]).toBeCloseTo(pelvis.z, 6);
    expect(pose[3]).toBeCloseTo(pelvis.w, 6);

    // The head IS aimed, so its slot is the override pre-multiplied onto the
    // bone's own rotation.
    const head = animator.boneNames.indexOf('head');
    const override = animator.jointOverrides.get('head')!;
    const expected = new Quaternion(override[0], override[1], override[2], override[3]).multiply(
      rig.bones[head].quaternion,
    );
    expect(pose[head * 4 + 1]).toBeCloseTo(expected.y, 6);
    expect(pose[head * 4 + 3]).toBeCloseTo(expected.w, 6);
    expect(Math.abs(pose[head * 4 + 1])).toBeGreaterThan(1e-3);
  });

  it('leaves rootPos alone and warns when the rig has no bone by that name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // The aosrig skeleton has no `pelvis`, and no `bones.root` names one.
      const { animator } = makeAosAnimator({ head: 'c_head' });
      animator.setState(state());
      animator.update(1 / 60);
      expect(animator.bodyPose.rootPos[0]).toBe(0);
      expect(animator.bodyPose.rootPos[1]).toBe(0);
      expect(animator.bodyPose.rootPos[2]).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('pelvis');
    } finally {
      warn.mockRestore();
    }
  });

  it('runs blink off the accumulated dt, identically for two animators', () => {
    /**
     * An animator with no injected clock, so it runs on its own `dt`.
     *
     * @returns The animator.
     */
    function dtAnimator(): Animator {
      return createAnimator({
        root: makeRig().root,
        expressionSpace: { kind: 'arkit52', dim: ARKIT_COUNT },
        blink: { minInterval: 0.5, maxInterval: 0.5 },
        random: () => 0,
      });
    }

    const a = dtAnimator();
    a.setState(state());

    // Deliberately uneven: a dt-driven clock follows the steps it is given, not
    // the wall clock the two runs share.
    const steps = [1 / 60, 1 / 30, 1 / 120, 1 / 45];
    const seen: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      a.update(steps[i % steps.length]);
      seen.push(a.expression[0]);
    }
    expect(seen.some((w) => w > 0.2)).toBe(true); // the blink actually fired

    // A second animator fed the same sequence, at whatever wall-clock time this
    // happens to run at, produces the same trace.
    const b = dtAnimator();
    b.setState(state());
    for (let i = 0; i < 200; i += 1) {
      b.update(steps[i % steps.length]);
      expect(b.expression[0]).toBeCloseTo(seen[i], 6);
    }
  });

  it('allocates nothing over a thousand updates on a stable graph', () => {
    const { animator } = makeAnimator();
    // A state machine, not a bare clip: the inner node lists, their indices and
    // the transition edge's rule graph are the things that used to be rebuilt
    // five to eight times a frame.
    const graph = smGraph();
    animator.setGraph(graph);
    animator.setState(state());

    /** One representative frame: graph, weights, mixer, face, aim, pose read. */
    function frame(): void {
      animator.update(1 / 60);
    }

    // Warm up: JIT, the graph index, the mixer's bindings and the clip timings
    // all settle here.
    for (let i = 0; i < 200; i += 1) frame();

    // Every cached structure the frame path touches, as it stands after warmup.
    // These are identity checks on purpose: a heap delta can only see what was
    // RETAINED, whereas a rebuilt-every-frame index is collectable garbage that
    // a GC hides. If any of these is a different object after a thousand
    // frames, something in the frame path rebuilt it.
    const smNode = graph.nodes[1];
    const inner = nodeList(smNode.data, 'innerNodes');
    const topIndex = buildIndexFor(graph.nodes, graph.edges);
    const innerIndex = buildIndexFor(inner, edgeList(smNode.data, 'innerEdges'));
    const stateInner = nodeList(inner[1].data, 'innerNodes');
    const stateIndex = buildIndexFor(stateInner, edgeList(inner[1].data, 'innerEdges'));

    collectGarbage();
    const before = process.memoryUsage().heapUsed;

    for (let i = 0; i < 1000; i += 1) frame();

    collectGarbage();
    const growth = process.memoryUsage().heapUsed - before;

    expect(buildIndexFor(graph.nodes, graph.edges)).toBe(topIndex);
    expect(buildIndexFor(inner, edgeList(smNode.data, 'innerEdges'))).toBe(innerIndex);
    expect(buildIndexFor(stateInner, edgeList(inner[1].data, 'innerEdges'))).toBe(stateIndex);
    expect(nodeList(smNode.data, 'innerNodes')).toBe(inner);

    // And nothing accumulated: measured at ~100 KB of V8 bookkeeping for the
    // whole run. A per-frame Map that is kept — a cache keyed on something that
    // changes every frame, say — shows up here.
    expect(growth).toBeLessThan(1024 * 1024);
  }, 60_000);

  it('disposes without throwing and stops everything', () => {
    const { animator } = makeAnimator();
    animator.setState(state({ velocity: [2, 0, 0] }));
    animator.update(1 / 60);
    expect(() => {
      animator.dispose();
    }).not.toThrow();
  });
});

it('holds an explicit one-shot at its last pose and restarts after release', () => {
  const { root, bones } = makeRig();
  const animator = createAnimator({
    root,
    expressionSpace: { kind: 'arkit52', dim: 52 },
    blink: false,
  });
  const clip = new AnimationClip('jump', 0.2, [
    new QuaternionKeyframeTrack(
      'pelvis.quaternion',
      [0, 0.2],
      [0, 0, 0, 1, 0, Math.sin(0.5), 0, Math.cos(0.5)],
    ),
  ]);
  animator.addClip('jump', clip, { loop: false });
  const state: CharacterState = {
    clips: [{ name: 'jump', weight: 1 }],
    velocity: [0, 0, 0],
    grounded: false,
  };
  animator.setState(state);
  animator.update(0.3);
  expect(bones[0].quaternion.y).toBeCloseTo(Math.sin(0.5));
  animator.update(0.3);
  expect(bones[0].quaternion.y).toBeCloseTo(Math.sin(0.5));
  state.clips = [];
  animator.update(0.01);
  state.clips = [{ name: 'jump', weight: 1 }];
  animator.update(0.05);
  expect(bones[0].quaternion.y).toBeCloseTo(Math.sin(0.125));
  animator.dispose();
});
