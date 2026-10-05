/**
 * A seat that stops sending input (a hidden tab, a stalled link) goes neutral
 * after 250 ms: nothing held, every held key released once (phase 3 review,
 * client I1, the server half).
 */
import { keyIndex, writeKeyBit } from '@gameable/sdk/keycodes';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../../protocol/constants.js';
import { blankInput, inputFrame, roomSetup as setup } from './roomTesting.js';

const STEP = 1000 / 60;
const hello = JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'ABCD', name: 'A' });

/** @returns An input snapshot with W held. */
function holdingW(): ReturnType<typeof blankInput> {
  const input = blankInput();
  writeKeyBit(input.down, keyIndex('KeyW'), true);
  return input;
}

describe('Room: input goes neutral after 250 ms without a frame', () => {
  it('lets go of a held W once no frame has come for 250 ms, and only once', () => {
    const { room, game, ports } = setup();
    room.handle('a', hello);
    room.handle('a', inputFrame(1, holdingW()));
    ports.advance(STEP);
    expect(game.inputs.at(-1)?.down.some((word) => word !== 0)).toBe(true);
    for (let i = 0; i < 20; i += 1) ports.advance(STEP); // 333 ms, no frames
    const last = game.inputs.at(-1);
    expect(last?.down.every((word) => word === 0)).toBe(true);
    expect(last?.released.some((word) => word !== 0)).toBe(true);
    const count = game.inputs.length;
    for (let i = 0; i < 20; i += 1) ports.advance(STEP);
    expect(game.inputs.length).toBe(count); // released once, not every tick
  });

  it('keeps a key held while frames keep coming', () => {
    const { room, game, ports } = setup();
    room.handle('a', hello);
    for (let seq = 1; seq <= 40; seq += 1) {
      room.handle('a', inputFrame(seq, holdingW()));
      ports.advance(STEP);
    }
    expect(game.inputs.every((input) => input.down.some((word) => word !== 0))).toBe(true);
  });
});
