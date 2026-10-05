/**
 * The canonical gameable key-code table.
 *
 * This file is the single source of truth for the mapping between a DOM
 * `KeyboardEvent.code` and the bit index used by `input-state.keys` in the WIT
 * contract. `gameable/input` (host side) and `gameable` (guest side)
 * MUST agree bit for bit, so the host package imports this table rather than
 * declaring its own.
 *
 * The table is **frozen and append-only**. A code's index is part of the
 * recorded-input format; changing one invalidates every tape and every
 * snapshot. New keys go on the end, below index 255.
 *
 * Layout:
 *
 * | Range     | Codes                                       |
 * | --------- | ------------------------------------------- |
 * | `0..25`   | `KeyA` .. `KeyZ`                            |
 * | `26..35`  | `Digit0` .. `Digit9`                        |
 * | `36..59`  | `F1` .. `F24`                               |
 * | `60..63`  | `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` |
 * | `64..69`  | `Space`, `Enter`, `Escape`, `Tab`, `Backspace`, `Delete` |
 * | `70..77`  | `ShiftLeft` .. `MetaRight`                  |
 * | `78..127` | punctuation, lock/navigation, numpad, media |
 */

/** Number of key bits the WIT `key-state` bitsets can carry. */
export const KEY_BITS = 256;

/** Number of `u32` words in one `key-state` bitset. */
export const KEY_WORDS = KEY_BITS / 32;

/**
 * Every key name in index order. The array index *is* the bit index.
 *
 * Do not reorder; append only.
 */
export const KEY_NAMES: readonly string[] = Object.freeze([
  // 0..25 — letters
  'KeyA',
  'KeyB',
  'KeyC',
  'KeyD',
  'KeyE',
  'KeyF',
  'KeyG',
  'KeyH',
  'KeyI',
  'KeyJ',
  'KeyK',
  'KeyL',
  'KeyM',
  'KeyN',
  'KeyO',
  'KeyP',
  'KeyQ',
  'KeyR',
  'KeyS',
  'KeyT',
  'KeyU',
  'KeyV',
  'KeyW',
  'KeyX',
  'KeyY',
  'KeyZ',
  // 26..35 — digit row
  'Digit0',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  // 36..59 — function keys
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  'F13',
  'F14',
  'F15',
  'F16',
  'F17',
  'F18',
  'F19',
  'F20',
  'F21',
  'F22',
  'F23',
  'F24',
  // 60..63 — arrows
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  // 64..69 — editing
  'Space',
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  // 70..77 — modifiers
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  // 78..91 — punctuation
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'IntlBackslash',
  'IntlRo',
  'IntlYen',
  // 92..102 — locks and navigation
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'PrintScreen',
  'Pause',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ContextMenu',
  // 103..120 — numpad
  'Numpad0',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'Numpad7',
  'Numpad8',
  'Numpad9',
  'NumpadDecimal',
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadEnter',
  'NumpadEqual',
  'NumpadComma',
  // 121..127 — media
  'AudioVolumeMute',
  'AudioVolumeDown',
  'AudioVolumeUp',
  'MediaPlayPause',
  'MediaStop',
  'MediaTrackNext',
  'MediaTrackPrevious',
]);

/** Number of key names currently assigned. */
export const KEY_COUNT = KEY_NAMES.length;

/**
 * Friendly aliases accepted anywhere a key name is. `'W'` is `'KeyW'`, `'1'`
 * is `'Digit1'`, `'Ctrl'` means either control key.
 */
const ALIASES: Readonly<Record<string, readonly [string] | readonly [string, string]>> =
  Object.freeze({
    Shift: ['ShiftLeft', 'ShiftRight'],
    Ctrl: ['ControlLeft', 'ControlRight'],
    Control: ['ControlLeft', 'ControlRight'],
    Alt: ['AltLeft', 'AltRight'],
    Option: ['AltLeft', 'AltRight'],
    Meta: ['MetaLeft', 'MetaRight'],
    Cmd: ['MetaLeft', 'MetaRight'],
    Command: ['MetaLeft', 'MetaRight'],
    Win: ['MetaLeft', 'MetaRight'],
    Esc: ['Escape'],
    Return: ['Enter'],
    Spacebar: ['Space'],
    Up: ['ArrowUp'],
    Down: ['ArrowDown'],
    Left: ['ArrowLeft'],
    Right: ['ArrowRight'],
    Del: ['Delete'],
  });

const PRIMARY = new Map<string, number>();
const SECONDARY = new Map<string, number>();

for (let i = 0; i < KEY_NAMES.length; i += 1) {
  const name = KEY_NAMES[i] ?? '';
  PRIMARY.set(name, i);
  if (name.startsWith('Key') && name.length === 4) PRIMARY.set(name.slice(3), i);
  if (name.startsWith('Digit') && name.length === 6) PRIMARY.set(name.slice(5), i);
}
// Bare letters and F-keys also answer in lower case (`'w'`, `'f1'`), resolved
// here once so a lookup never builds a string: every all-caps name holds one
// letter, so its lower-case form is its only other spelling.
for (const name of [...PRIMARY.keys()]) {
  const lower = name.toLowerCase();
  if (name === name.toUpperCase() && lower !== name) PRIMARY.set(lower, PRIMARY.get(name) ?? -1);
}
for (const [alias, targets] of Object.entries(ALIASES)) {
  const a = PRIMARY.get(targets[0]);
  if (a !== undefined) PRIMARY.set(alias, a);
  const second = targets[1];
  if (second !== undefined) {
    const b = PRIMARY.get(second);
    if (b !== undefined) SECONDARY.set(alias, b);
  }
}

/**
 * Any string this table accepts: a DOM `code`, a bare letter or digit, or one
 * of the friendly aliases.
 */
export type KeyName = string;

/**
 * Bit index for a key name, or `-1` when the name is unknown. Names are
 * case-sensitive, except that a bare letter or F-key also answers in lower
 * case (`'w'`, `'f1'`). Allocates nothing.
 *
 * @param name A DOM `KeyboardEvent.code`, a bare letter/digit, or an alias.
 * @returns The bit index in `0..255`, or `-1`.
 */
export function keyIndex(name: KeyName): number {
  return PRIMARY.get(name) ?? -1;
}

/**
 * Second bit index for names that cover a left/right pair (`'Shift'`), or `-1`.
 * Case-sensitive, like the aliases it covers. Allocates nothing.
 *
 * @param name A key name or alias.
 * @returns The second bit index, or `-1` when the name maps to one key.
 */
export function keyIndex2(name: KeyName): number {
  return SECONDARY.get(name) ?? -1;
}

/**
 * Read one bit out of an 8-word key bitset.
 *
 * @param words The bitset, exactly `KEY_WORDS` long.
 * @param index A bit index from `keyIndex`.
 * @returns True when the bit is set.
 */
export function readKeyBit(words: ArrayLike<number>, index: number): boolean {
  if (index < 0 || index >= KEY_BITS) return false;
  return ((words[index >>> 5] ?? 0) & (1 << (index & 31))) !== 0;
}

/**
 * Set or clear one bit in an 8-word key bitset, in place.
 *
 * @param words The bitset, exactly `KEY_WORDS` long.
 * @param index A bit index from `keyIndex`.
 * @param value True to set the bit, false to clear it.
 * @returns Nothing; `words` is mutated.
 */
export function writeKeyBit(words: Uint32Array, index: number, value: boolean): void {
  if (index < 0 || index >= KEY_BITS) return;
  const w = index >>> 5;
  const bit = 1 << (index & 31);
  words[w] = value ? (words[w] ?? 0) | bit : (words[w] ?? 0) & ~bit;
}
