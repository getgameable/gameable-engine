/**
 * The page's keys, on a client guest: F is `sit`, 1-6 wear a colour. E and
 * WASD are read by the authority from this player's own input.
 */
import { createGuest, type Command } from 'gameable';
import {
  createFrameInput,
  createGameConfig,
  createInputState,
  createMockHost,
  press,
} from 'gameable/test';
import { describe, expect, it } from 'vitest';

import game from '../src/game';
import { PALETTE } from '../src/systems/controls';

const CLIENT = '{"net":{"role":"client","localPlayer":1,"maxPlayers":12}}';

/**
 * @param key The key pressed on this frame.
 * @returns The `send`s the client made that frame, as `[name, payload]`.
 */
function pressing(key: string): [string, unknown][] {
  const host = createMockHost({ seed: 1, nowMs: () => 0, assets: ['env.arena', 'char.resident'] });
  const guest = createGuest(host, game);
  guest.init(createGameConfig({ fixedHz: 60, options: CLIENT }));
  const input = createInputState();
  press(input, key);
  // A client reads its own player's lane, as the client loop fills it.
  const out = guest.tick(createFrameInput({ frame: 0, players: [{ player: 1, seq: 0, input }] }));
  return out.commands
    .filter((c): c is Extract<Command, { tag: 'send' }> => c.tag === 'send')
    .map((c) => [c.val.name, JSON.parse(c.val.payload)]);
}

describe('the keys', () => {
  it('F sends sit', () => {
    expect(pressing('KeyF')).toEqual([['sit', null]]);
  });

  it('1 to 6 wear the palette', () => {
    expect(pressing('Digit1')).toEqual([['cosmetic', { color: PALETTE[0] }]]);
    expect(pressing('Digit6')).toEqual([['cosmetic', { color: PALETTE[5] }]]);
    expect(pressing('Digit7')).toEqual([]);
  });

  it("E sends nothing: the authority reads it from this player's input", () => {
    expect(pressing('KeyE')).toEqual([]);
  });
});
