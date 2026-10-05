/**
 * `WorldRecord` pose and state serials: what bumps a change tick and what does not, and teleports.
 */
import { describe, expect, it } from 'vitest';

import type { WorldRecord } from './WorldRecord';
import { worldWithFive } from './worldRecordTesting';

describe('WorldRecord: no change, no bump', () => {
  it('a repeated set-anim leaves serial where the first one put it', () => {
    const { world, serial } = worldWithFive();
    world.setAnim(5, 'walk', true, 1);
    expect(serial()).toBe(2);
    world.advance();
    world.setAnim(5, 'walk', true, 1);
    expect(serial()).toBe(2);
    world.setAnim(5, 'walk', true, 2);
    expect(serial()).toBe(3);
  });

  it('a repeated set-character-state leaves serial alone', () => {
    const { world, serial } = worldWithFive();
    world.setCharacter(5, 9);
    world.setCharacterState(5, 'run', false);
    world.advance();
    world.setCharacterState(5, 'run', false);
    expect(serial()).toBe(2);
    world.setCharacterState(5, 'run', true);
    expect(serial()).toBe(3);
    world.advance();
    world.setCharacter(5, 9); // back to idle and grounded: a change
    expect(serial()).toBe(4);
    world.advance();
    world.setCharacter(5, 9);
    expect(serial()).toBe(4);
  });

  it('asset and parent bump only when they change; a body id bumps nothing', () => {
    const { world, serial } = worldWithFive();
    world.setAsset(5, 7);
    world.setParent(5, undefined);
    expect(serial()).toBe(1);
    world.attachBody(11, 5);
    expect(world.get(5)?.body).toBe(11);
    expect(serial()).toBe(1);
    world.detachBody(11);
    expect(serial()).toBe(1);
    world.advance();
    world.setParent(5, 3);
    expect(serial()).toBe(3);
    expect(world.get(5)?.stateSerial).toBe(3);
  });

  it('a set-anim speed within 1e-3 of the last is no change', () => {
    const { world } = worldWithFive();
    world.setAnim(5, 'walk', true, 1);
    world.advance();
    world.setAnim(5, 'walk', true, 1.0005);
    expect(world.get(5)?.animSerial).toBe(2);
    expect(world.get(5)?.anim?.speed).toBe(1);
    world.setAnim(5, 'walk', true, 1.01);
    expect(world.get(5)?.animSerial).toBe(3);
  });
});

describe('WorldRecord: separate change ticks', () => {
  /**
   * @param world The world holding entity 5.
   * @returns The five ticks and `serial` of entity 5, in a fixed order.
   */
  const ticks = (world: WorldRecord): number[] => {
    const r = world.get(5)!;
    return [
      r.poseSerial,
      r.stateSerial,
      r.animSerial,
      r.characterSerial,
      r.visual.serial,
      r.serial,
    ];
  };

  it('a fresh record has every tick at its spawn and visual at -1', () => {
    const { world } = worldWithFive();
    expect(ticks(world)).toEqual([1, 1, 1, 1, -1, 1]);
  });

  it('a set-expression moves the visual ticks and serial, not the pose', () => {
    const { world } = worldWithFive();
    world.setExpression(5, 'arkit52', [0.5]);
    expect(ticks(world)).toEqual([1, 1, 1, 1, 2, 2]);
    expect(world.get(5)?.visual.expressions[0].serial).toBe(2);
  });

  it('set-anim moves only the anim tick; character state only the character tick', () => {
    const { world } = worldWithFive();
    world.setAnim(5, 'walk', true, 1);
    expect(ticks(world)).toEqual([1, 1, 2, 1, -1, 2]);
    world.advance();
    world.setCharacterState(5, 'run', true);
    expect(ticks(world)).toEqual([1, 1, 2, 3, -1, 3]);
  });

  it('a teleport moves only the pose tick', () => {
    const { world } = worldWithFive();
    world.teleport(5);
    expect(ticks(world)).toEqual([2, 1, 1, 1, -1, 2]);
  });

  it('serial is the latest of all of them', () => {
    const { world } = worldWithFive();
    world.setAsset(5, 8);
    world.advance();
    world.lookAt(5, undefined, 1);
    world.advance();
    world.setAnim(5, 'idle', true, 1);
    const [pose, state, anim, character, visual, serial] = ticks(world);
    expect([pose, state, anim, character, visual]).toEqual([1, 2, 4, 1, 3]);
    expect(serial).toBe(Math.max(pose, state, anim, character, visual));
  });
});

describe('WorldRecord: teleports', () => {
  it('teleport stamps teleportedAt and serial; a fresh record never teleported', () => {
    const { world, serial } = worldWithFive();
    expect(world.get(5)?.teleportedAt).toBe(-1);
    world.teleport(5);
    expect(world.get(5)?.teleportedAt).toBe(2);
    expect(serial()).toBe(2);
    world.teleport(99);
  });
});
