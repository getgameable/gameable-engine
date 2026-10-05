import { describe, expect, it } from 'vitest';

import { CommandBuffer, TAG_ORDINAL, commandPoolSize } from './commands';
import type {
  AddBodyCmd,
  ApplyImpulseCmd,
  Command,
  CommandTag,
  LookAtCmd,
  SetBodyVelocityCmd,
  SetClipWeightsCmd,
  SetExpressionCmd,
  SetMaterialParamCmd,
  SpawnCmd,
} from './types';

/**
 * Every tag in the WIT `command` variant.
 *
 * Kept in step with `packages/wasm-host/src/apply.test.ts`, which pins the
 * same list from the host side: if the variant grows a case, both lists fail.
 */
const EVERY_TAG: CommandTag[] = [
  'spawn',
  'despawn',
  'set-asset',
  'set-parent',
  'set-anim',
  'set-material-param',
  'add-body',
  'remove-body',
  'set-body-transform',
  'set-body-velocity',
  'apply-impulse',
  'set-body-enabled',
  'move-character',
  'spawn-character',
  'set-character-state',
  'set-clip-weights',
  'set-expression',
  'look-at',
  'say',
  'play-sound',
  'stop-sound',
  'set-listener',
  'load-asset',
  'set-pointer-lock',
  'set-time-scale',
  'conversation',
  'send',
  'set-player-camera',
  'set-player-hud',
  'save-player-data',
  'save-game-data',
  'exchange',
  'set-player-entity',
];

/** Default layers, enough to build an `add-body`. */
const LAYER = { defaultLayer: true };

/**
 * The payload of the one command in the list with a tag.
 *
 * @param list The frame list.
 * @param tag The tag to find.
 * @returns The payload.
 */
function only(list: readonly Command[], tag: CommandTag): unknown {
  const found = list.filter((c) => c.tag === tag);
  expect(found).toHaveLength(1);
  return found[0].val;
}

describe('the tag ordinal table', () => {
  it('covers every tag in the WIT variant exactly once', () => {
    expect(Object.keys(TAG_ORDINAL).sort()).toEqual([...EVERY_TAG].sort());
  });

  it('is a dense 0..n-1 index, which is what makes the pools an array', () => {
    const ordinals = EVERY_TAG.map((tag) => TAG_ORDINAL[tag]).sort((a, b) => a - b);
    expect(ordinals).toEqual(EVERY_TAG.map((_, i) => i));
  });
});

describe('pooling', () => {
  it('hands the same slot back after reset, and a new one within a frame', () => {
    const buf = new CommandBuffer();
    buf.despawn(1);
    buf.despawn(2);
    const first = buf.list[0];
    const second = buf.list[1];
    expect(first).not.toBe(second);
    expect(first.val).toBe(1);
    expect(second.val).toBe(2);

    buf.reset();
    buf.despawn(7);
    expect(buf.list).toHaveLength(1);
    expect(buf.list[0]).toBe(first);
    expect(buf.list[0].val).toBe(7);
  });

  it('stops growing the pool once the shape of a frame settles', () => {
    const buf = new CommandBuffer();
    for (let frame = 0; frame < 3; frame += 1) {
      buf.reset();
      buf.despawn(1);
      buf.setBodyEnabled(2, true);
    }
    const settled = commandPoolSize();
    for (let frame = 0; frame < 100; frame += 1) {
      buf.reset();
      buf.despawn(1);
      buf.setBodyEnabled(2, true);
    }
    expect(commandPoolSize()).toBe(settled);
  });

  it('never shares a pooled object between two buffers', () => {
    const a = new CommandBuffer();
    const b = new CommandBuffer();
    a.spawn(1, 5, 1, 2, 3, 0, 0, 0, 1, 1, 1, 1, 'a');
    b.spawn(2, 6, 9, 9, 9, 0, 0, 0, 1, 1, 1, 1, 'b');

    expect(a.list[0]).not.toBe(b.list[0]);
    const pa = only(a.list, 'spawn') as SpawnCmd;
    const pb = only(b.list, 'spawn') as SpawnCmd;
    expect(pa).not.toBe(pb);
    expect(pa.position).not.toBe(pb.position);
    expect(pa.entity).toBe(1);
    expect(pa.position.x).toBe(1);
    expect(pb.entity).toBe(2);
    expect(pb.position.x).toBe(9);
  });

  it('gives two commands of the same tag in one frame their own vectors', () => {
    const buf = new CommandBuffer();
    buf.lookAt(1, { x: 1, y: 0, z: 0 }, 1);
    buf.lookAt(2, { x: 0, y: 0, z: 9 }, 1);
    const first = buf.list[0].val as LookAtCmd;
    const second = buf.list[1].val as LookAtCmd;
    expect(first.target).not.toBe(second.target);
    expect(first.target?.x).toBe(1);
    expect(second.target?.z).toBe(9);
  });
});

describe('re-initialising a reused slot', () => {
  it('clears set-body-velocity.angular when the next call omits it', () => {
    const buf = new CommandBuffer();
    buf.setBodyVelocity(1, 1, 2, 3, 0.5, 0, 0);
    const withAngular = only(buf.list, 'set-body-velocity') as SetBodyVelocityCmd;
    expect(withAngular.angular?.x).toBe(0.5);

    buf.reset();
    buf.setBodyVelocity(1, 4, 5, 6);
    const without = only(buf.list, 'set-body-velocity') as SetBodyVelocityCmd;
    expect(without.angular).toBeUndefined();
    expect(without.linear?.x).toBe(4);
  });

  it('clears apply-impulse.atPoint when the next call omits it', () => {
    const buf = new CommandBuffer();
    buf.applyImpulse(1, 0, 1, 0, 2, 3, 4);
    expect((only(buf.list, 'apply-impulse') as ApplyImpulseCmd).atPoint?.y).toBe(3);

    buf.reset();
    buf.applyImpulse(1, 0, 1, 0);
    expect((only(buf.list, 'apply-impulse') as ApplyImpulseCmd).atPoint).toBeUndefined();
  });

  it('clears look-at.target when the look-at is released', () => {
    const buf = new CommandBuffer();
    buf.lookAt(3, { x: 1, y: 1, z: 1 }, 1);
    expect((only(buf.list, 'look-at') as LookAtCmd).target?.x).toBe(1);

    buf.reset();
    buf.lookAt(3, null, 0.5);
    const released = only(buf.list, 'look-at') as LookAtCmd;
    expect(released.target).toBeUndefined();
    expect(released.weight).toBe(0.5);
  });

  it('clears spawn.name when the next spawn has none', () => {
    const buf = new CommandBuffer();
    buf.spawn(1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 'hero');
    expect((only(buf.list, 'spawn') as SpawnCmd).name).toBe('hero');

    buf.reset();
    buf.spawn(2, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
    const anonymous = only(buf.list, 'spawn') as SpawnCmd;
    expect(anonymous.name).toBeUndefined();
    expect(anonymous.asset).toBeUndefined();
  });

  it('restores the add-body defaults a caller overwrote', () => {
    const buf = new CommandBuffer();
    const tuned = buf.addBody(1, 1, 'dynamic', 'box', 1, 1, 1, 0, 0, 0, 1, LAYER, LAYER, {});
    tuned.friction = 0.9;
    tuned.restitution = 0.7;
    tuned.rotation.w = 0;
    tuned.rotation.x = 1;

    buf.reset();
    const fresh = buf.addBody(2, 2, 'dynamic', 'box', 1, 1, 1, 0, 0, 0, 1, LAYER, LAYER, {});
    expect(fresh.friction).toBe(Math.fround(0.5));
    expect(fresh.restitution).toBe(0);
    expect(fresh.linearDamping).toBe(Math.fround(0.05));
    expect(fresh.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});

describe('f32 rounding', () => {
  it('rounds a set-material-param scalar and colour', () => {
    const buf = new CommandBuffer();
    buf.setMaterialParam(1, 'glow', { tag: 'scalar', val: 0.1 });
    const scalar = (only(buf.list, 'set-material-param') as SetMaterialParamCmd).value;
    expect(scalar.tag).toBe('scalar');
    expect(scalar.val).toBe(Math.fround(0.1));

    buf.reset();
    buf.setMaterialParam(1, 'tint', { tag: 'color', val: { r: 0.1, g: 0.2, b: 0.3, a: 0.7 } });
    const colour = (only(buf.list, 'set-material-param') as SetMaterialParamCmd).value;
    expect(colour.tag).toBe('color');
    expect(colour.val).toEqual({
      r: Math.fround(0.1),
      g: Math.fround(0.2),
      b: Math.fround(0.3),
      a: Math.fround(0.7),
    });
  });

  it('copies a set-material-param value instead of retaining the caller’s', () => {
    const buf = new CommandBuffer();
    const mine = { x: 0.1, y: 0.2, z: 0.3 };
    buf.setMaterialParam(1, 'offset', { tag: 'vector', val: mine });
    const held = (only(buf.list, 'set-material-param') as SetMaterialParamCmd).value;
    expect(held.val).not.toBe(mine);
    mine.x = 99;
    expect((held.val as { x: number }).x).toBe(Math.fround(0.1));
  });

  it('rounds set-clip-weights into pooled storage the host can keep', () => {
    const buf = new CommandBuffer();
    const mine = [0.1, 0.2, 0.7];
    buf.setClipWeights(1, ['idle', 'walk', 'run'], mine, 0.3);
    const cmd = only(buf.list, 'set-clip-weights') as SetClipWeightsCmd;
    expect(cmd.weights).toBeInstanceOf(Float32Array);
    expect(cmd.weights).not.toBe(mine);
    expect([...(cmd.weights as Float32Array)]).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.7),
    ]);
    expect(cmd.timeScale).toBe(Math.fround(0.3));

    const storage = cmd.weights;
    buf.reset();
    buf.setClipWeights(1, ['idle', 'walk', 'run'], [0.5, 0.25, 0.25], 1);
    // Same length, same slot: the array is reused, not reallocated.
    expect((only(buf.list, 'set-clip-weights') as SetClipWeightsCmd).weights).toBe(storage);
  });

  it('rounds set-expression weights and resizes when the space changes', () => {
    const buf = new CommandBuffer();
    buf.setExpression(1, 'arkit52', [0.1, 0.9]);
    const first = only(buf.list, 'set-expression') as SetExpressionCmd;
    expect([...(first.weights as Float32Array)]).toEqual([Math.fround(0.1), Math.fround(0.9)]);

    buf.reset();
    buf.setExpression(1, 'gnm68', [0.3, 0.3, 0.3]);
    const second = only(buf.list, 'set-expression') as SetExpressionCmd;
    expect(second.weights).toHaveLength(3);
    expect(second.space).toBe('gnm68');
  });

  it('rounds the add-body lanes', () => {
    const buf = new CommandBuffer();
    const cmd = buf.addBody(1, 1, 'dynamic', 'sphere', 0.1, 0, 0, 0.3, 0, 0, 0.7, LAYER, LAYER, {});
    const payload: AddBodyCmd = cmd;
    expect(payload.shape.halfExtents.x).toBe(Math.fround(0.1));
    expect(payload.position.x).toBe(Math.fround(0.3));
    expect(payload.mass).toBe(Math.fround(0.7));
  });
});
