import { describe, expect, it } from 'vitest';

import { defineGame } from '../defineGame';
import { DEFAULT_SEND_HZ, roomSendHz } from './sendHz';

describe('roomSendHz', () => {
  it('is 20 when the game declares no rate, or no multiplayer at all', () => {
    expect(roomSendHz(defineGame({}))).toBe(DEFAULT_SEND_HZ);
    expect(roomSendHz(defineGame({ features: { multiplayer: true } }))).toBe(20);
    expect(roomSendHz(defineGame({ features: { multiplayer: { maxPlayers: 4 } } }))).toBe(20);
  });

  it('returns a declared rate from 1 to 60', () => {
    expect(roomSendHz(defineGame({ features: { multiplayer: { sendHz: 1 } } }))).toBe(1);
    expect(roomSendHz(defineGame({ features: { multiplayer: { sendHz: 60 } } }))).toBe(60);
    expect(roomSendHz(defineGame({ features: { multiplayer: { sendHz: 12.5 } } }))).toBe(12.5);
  });

  it('refuses a rate outside 1 to 60, or not a number', () => {
    for (const sendHz of [0, 0.5, 61, -20, Number.NaN, Number.POSITIVE_INFINITY, '20'])
      expect(() =>
        roomSendHz(defineGame({ features: { multiplayer: { sendHz: sendHz as number } } })),
      ).toThrow(RangeError);
  });
});
