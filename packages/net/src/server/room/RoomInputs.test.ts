import { keyIndex, readKeyBit, writeKeyBit } from '@gameable/sdk/keycodes';
import { describe, expect, it } from 'vitest';

import { RoomInputs } from './RoomInputs.js';
import { blankInput } from './roomTesting.js';

const W = keyIndex('W');

describe('RoomInputs', () => {
  it('lists players ascending, whatever the join order, and the same array every call', () => {
    const inputs = new RoomInputs();
    inputs.add(3);
    inputs.add(0);
    inputs.add(1);
    const first = inputs.players();
    expect(first).toEqual([0, 1, 3]);
    inputs.remove(1);
    expect(inputs.players()).toBe(first);
    expect(first).toEqual([0, 3]);
  });

  it('leaves a held player out of the list, in place, and puts them back in order', () => {
    const inputs = new RoomInputs();
    inputs.add(0);
    inputs.add(1);
    inputs.add(2);
    const list = inputs.players();
    inputs.hold(0);
    inputs.hold(0); // twice is harmless
    expect(inputs.players()).toBe(list);
    expect(list).toEqual([1, 2]);
    inputs.hold(2);
    expect(list).toEqual([1]);
    inputs.resume(2);
    inputs.resume(0);
    expect(list).toEqual([0, 1, 2]);
    inputs.hold(1);
    inputs.remove(1); // a held seat that times out
    inputs.resume(1); // nothing to resume
    expect(list).toEqual([0, 2]);
  });

  it("hands player 0's input over as anyone's, and a neutral input for someone not seated", () => {
    const inputs = new RoomInputs();
    inputs.add(0);
    const w = blankInput();
    writeKeyBit(w.down, W, true);
    inputs.absorb(0, 4, w);
    expect(readKeyBit(inputs.snapshotFor(0).keys.down, W)).toBe(true);
    expect(readKeyBit(inputs.snapshotFor(7).keys.down, W)).toBe(false);
    expect(inputs.seqFor(0)).toBe(4);
  });

  it('ORs edges and sums deltas across room ticks, until a step consumes them', () => {
    const inputs = new RoomInputs();
    inputs.add(0);
    const press = blankInput();
    writeKeyBit(press.down, W, true);
    writeKeyBit(press.pressed, W, true);
    press.mouse.dx = 2;
    press.mouse.pressed = 1;
    const release = blankInput();
    writeKeyBit(release.released, W, true);
    release.mouse.dx = 3;
    inputs.absorb(0, 1, press);
    inputs.absorb(0, 2, release); // a room tick that ran no step in between
    const got = inputs.snapshotFor(0);
    expect(readKeyBit(got.keys.pressed, W)).toBe(true);
    expect(readKeyBit(got.keys.released, W)).toBe(true);
    expect(readKeyBit(got.keys.down, W)).toBe(false);
    expect(got.mouse.dx).toBe(5);
    expect(got.mouse.pressed).toBe(1);
    inputs.consumed();
    expect(readKeyBit(got.keys.pressed, W)).toBe(false);
    expect(readKeyBit(got.keys.released, W)).toBe(false);
    expect(got.mouse.dx).toBe(0);
    expect(got.mouse.pressed).toBe(0);
  });

  it('keeps held keys across a step and names the seq only once a step applied it', () => {
    const inputs = new RoomInputs();
    inputs.add(0);
    const hold = blankInput();
    writeKeyBit(hold.down, W, true);
    inputs.absorb(0, 9, hold);
    expect(inputs.appliedFor(0)).toBe(0);
    inputs.consumed();
    expect(inputs.appliedFor(0)).toBe(9);
    expect(readKeyBit(inputs.snapshotFor(0).keys.down, W)).toBe(true);
  });

  it('ignores input for a player not seated', () => {
    const inputs = new RoomInputs();
    inputs.absorb(5, 1, blankInput());
    expect(inputs.players()).toEqual([]);
    expect(inputs.seqFor(5)).toBe(0);
  });
});
