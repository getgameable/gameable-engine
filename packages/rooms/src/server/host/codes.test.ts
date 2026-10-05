import { describe, expect, it } from 'vitest';

import { createRoomCodes, isRoomCode, ROOM_CODE_ALPHABET } from './codes.js';

describe('RoomCodes', () => {
  it("mints four letters from Tala's alphabet: no I, L, O", () => {
    expect(ROOM_CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ');
    const codes = createRoomCodes();
    for (let i = 0; i < 200; i += 1) {
      const code = codes.mint();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
      expect(isRoomCode(code)).toBe(true);
    }
    expect(codes.size).toBe(200);
  });

  it('never hands out a live code twice, and reuses one once released', () => {
    // A random source stuck on 0 always proposes AAAA first.
    let calls = 0;
    const codes = createRoomCodes(() => (calls++ < 4 ? 0 : 0.5));
    expect(codes.mint()).toBe('AAAA');
    const second = codes.mint();
    expect(second).not.toBe('AAAA');
    expect(codes.has('AAAA')).toBe(true);
    codes.release('AAAA');
    expect(codes.has('AAAA')).toBe(false);
    calls = 0;
    expect(codes.mint()).toBe('AAAA');
  });

  it('fails clearly when every code it tries is taken', () => {
    const codes = createRoomCodes(() => 0);
    codes.mint();
    expect(() => codes.mint()).toThrow(/no free room code/);
  });

  it('tells a code from anything else', () => {
    expect(isRoomCode('ABCD')).toBe(true);
    expect(isRoomCode('abcd')).toBe(false);
    expect(isRoomCode('ABCI')).toBe(false); // I is not in the alphabet
    expect(isRoomCode('ABC')).toBe(false);
    expect(isRoomCode(1234)).toBe(false);
  });
});
