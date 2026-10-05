import { describe, expect, it } from 'vitest';

import {
  gamepadButtonIndex,
  KEY_COUNT,
  KEY_INDEX,
  KEY_NAMES,
  keyIndex,
  keyIndex2,
  POINTER_BASE,
  pointerKeyIndex,
} from './keycodes';

describe('the frozen key table', () => {
  it('pins the indexes that recordings depend on', () => {
    // Changing any of these reinterprets every recorded input trace, and
    // breaks agreement with the guest table in packages/sdk/src/keycodes.ts.
    expect(KEY_INDEX.KeyA).toBe(0);
    expect(KEY_INDEX.KeyZ).toBe(25);
    expect(KEY_INDEX.Digit0).toBe(26);
    expect(KEY_INDEX.F1).toBe(36);
    expect(KEY_INDEX.F24).toBe(59);
    expect(KEY_INDEX.ArrowUp).toBe(60);
    expect(KEY_INDEX.Space).toBe(64);
    expect(KEY_INDEX.ShiftLeft).toBe(70);
    expect(KEY_INDEX.Backquote).toBe(78);
    expect(KEY_INDEX.CapsLock).toBe(92);
    expect(KEY_INDEX.Numpad0).toBe(103);
    expect(KEY_INDEX.MediaTrackPrevious).toBe(127);
    expect(KEY_INDEX.Mouse0).toBe(248);
  });

  it('is a bijection into 0..255 with the pointer block at the top', () => {
    const entries = Object.entries(KEY_INDEX);
    const seen = new Set<number>();
    for (const [code, index] of entries) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(KEY_COUNT);
      expect(seen.has(index)).toBe(false);
      seen.add(index);
      expect(KEY_NAMES[index]).toBe(code);
      if (!code.startsWith('Mouse')) expect(index).toBeLessThan(POINTER_BASE);
    }
    expect(KEY_NAMES).toHaveLength(KEY_COUNT);
  });

  it('leaves room to append new codes', () => {
    const highestKeyboard = Math.max(
      ...Object.entries(KEY_INDEX)
        .filter(([code]) => !code.startsWith('Mouse'))
        .map(([, index]) => index),
    );
    expect(highestKeyboard).toBe(127); // appends start at 128
    expect(highestKeyboard).toBeLessThan(POINTER_BASE - 1);
    expect(KEY_NAMES[highestKeyboard + 1]).toBe('');
  });
});

describe('keyIndex', () => {
  it('resolves exact KeyboardEvent codes', () => {
    expect(keyIndex('KeyW')).toBe(KEY_INDEX.KeyW);
    expect(keyIndex('Space')).toBe(KEY_INDEX.Space);
    expect(keyIndex('NumpadEnter')).toBe(KEY_INDEX.NumpadEnter);
  });

  it('resolves friendly aliases', () => {
    expect(keyIndex('W')).toBe(KEY_INDEX.KeyW);
    expect(keyIndex('7')).toBe(KEY_INDEX.Digit7);
    expect(keyIndex('Esc')).toBe(KEY_INDEX.Escape);
    expect(keyIndex('Ctrl')).toBe(KEY_INDEX.ControlLeft);
    expect(keyIndex('Up')).toBe(KEY_INDEX.ArrowUp);
    expect(keyIndex('Return')).toBe(KEY_INDEX.Enter);
  });

  it('resolves mouse buttons into the pointer block', () => {
    expect(keyIndex('LMB')).toBe(POINTER_BASE);
    expect(keyIndex('MMB')).toBe(POINTER_BASE + 1);
    expect(keyIndex('RMB')).toBe(POINTER_BASE + 2);
    expect(keyIndex('Mouse4')).toBe(POINTER_BASE + 4);
  });

  it('is case-insensitive for aliases only', () => {
    expect(keyIndex('w')).toBe(KEY_INDEX.KeyW);
    expect(keyIndex('lmb')).toBe(POINTER_BASE);
    expect(keyIndex('keyw')).toBe(-1);
  });

  it('resolves a left/right pair through keyIndex2', () => {
    expect(keyIndex('Shift')).toBe(KEY_INDEX.ShiftLeft);
    expect(keyIndex2('Shift')).toBe(KEY_INDEX.ShiftRight);
    expect(keyIndex2('ctrl')).toBe(KEY_INDEX.ControlRight);
    expect(keyIndex2('KeyW')).toBe(-1);
    expect(keyIndex2('nonsense')).toBe(-1);
  });

  it('returns -1 for anything it does not know', () => {
    expect(keyIndex('nonsense')).toBe(-1);
    expect(keyIndex('')).toBe(-1);
    expect(keyIndex('constructor')).toBe(-1);
    expect(keyIndex('GamepadA')).toBe(-1);
  });
});

describe('pointerKeyIndex', () => {
  it('mirrors MouseEvent.button into the pointer block', () => {
    expect(pointerKeyIndex(0)).toBe(POINTER_BASE);
    expect(pointerKeyIndex(4)).toBe(POINTER_BASE + 4);
  });

  it('rejects buttons outside the block', () => {
    expect(pointerKeyIndex(-1)).toBe(-1);
    expect(pointerKeyIndex(5)).toBe(-1);
    expect(pointerKeyIndex(1.5)).toBe(-1);
  });
});

describe('gamepadButtonIndex', () => {
  it('follows the W3C standard mapping', () => {
    expect(gamepadButtonIndex('GamepadA')).toBe(0);
    expect(gamepadButtonIndex('GamepadRT')).toBe(7);
    expect(gamepadButtonIndex('GamepadCross')).toBe(gamepadButtonIndex('GamepadA'));
  });

  it('returns -1 for a keyboard name', () => {
    expect(gamepadButtonIndex('KeyW')).toBe(-1);
  });
});
