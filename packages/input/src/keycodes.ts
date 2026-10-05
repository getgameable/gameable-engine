/**
 * The frozen key-index table.
 *
 * `key-state` in `wit/types.wit` is 256 bits packed into eight `u32` words:
 * key `c` lives in bit `c & 31` of word `c >> 5`. This file maps a
 * `KeyboardEvent.code` string to that index `c`.
 *
 * ## The indexes are frozen forever
 *
 * A recorded input trace, a replay file and a compiled wasm guest all encode
 * these numbers. Changing an index silently reinterprets every recording ever
 * made. The table is therefore **append only**:
 *
 * - never reorder a group, never remove a code, never renumber;
 * - new codes go at the end of {@link APPENDED}, which starts at index 128 and
 *   grows towards {@link POINTER_BASE};
 * - indexes {@link POINTER_BASE}..255 are the reserved pointer block and are
 *   not keyboard codes.
 *
 * ## Host and guest must agree bit for bit
 *
 * The keyboard table itself lives in ONE place: `gameable/sdk/keycodes`
 * (`KEY_NAMES`, indexes 0..127). The guest reads it to decode the bitset and
 * this file re-uses it to encode, so the two cannot drift. The sdk subpath is
 * a dependency-free table module — importing it pulls in no game runtime.
 *
 * Indexes 0..127 are the shared keyboard table. 128..247 are free for appends.
 * Mouse buttons are mirrored into the reserved pointer block at the top
 * (`Mouse0`..`Mouse4`, 248+), which the guest table leaves empty, so a binding
 * like `'LMB'` resolves to an index and `isDown` works for the mouse exactly
 * as it does for the keyboard. The authoritative mouse bitset is still
 * `mouse.buttons`; the mirror is a convenience, not a second source of truth.
 */

import { KEY_NAMES as GUEST_KEY_NAMES } from '@gameable/sdk/keycodes';

/** Number of bits — and therefore key slots — in a packed key bitset. */
export const KEY_COUNT = 256;

/** Number of `u32` words a packed key bitset occupies. */
export const KEY_WORDS = KEY_COUNT / 32;

/**
 * First index of the reserved pointer block. Indexes below this are real
 * `KeyboardEvent.code` values; `POINTER_BASE + n` is mouse button `n`.
 */
export const POINTER_BASE = 248;

/** Highest mouse button the pointer block can represent (0..4). */
export const POINTER_BUTTON_MAX = 4;

/* -------------------------------------------------------------------------
 * Indexes 0..127 come verbatim from `gameable/sdk/keycodes` (the guest
 * table). Host-only additions append after the last guest entry.
 * ---------------------------------------------------------------------- */

/**
 * Codes added after the first release. Append here, never in the middle of a
 * group above, and never past {@link POINTER_BASE}.
 */
const APPENDED: string[] = [];

/** Mouse pseudo-codes occupying the reserved pointer block. */
const POINTER = Array.from({ length: POINTER_BUTTON_MAX + 1 }, (_, i) => `Mouse${String(i)}`);

/**
 * Index of every known key, by `KeyboardEvent.code`.
 *
 * Lookup is exact and case-sensitive; use {@link keyIndex} to accept friendly
 * aliases such as `'W'` or `'LMB'`.
 *
 * @example
 * ```ts
 * import { KEY_INDEX } from 'gameable/input';
 *
 * console.log(KEY_INDEX.KeyA); // 0
 * console.log(KEY_INDEX.Space); // 64
 * ```
 */
export const KEY_INDEX: Readonly<Record<string, number>> = buildIndex();

/**
 * The inverse of {@link KEY_INDEX}: 256 slots, `''` where nothing is assigned.
 *
 * @example
 * ```ts
 * import { KEY_NAMES } from 'gameable/input';
 *
 * console.log(KEY_NAMES[0]); // 'KeyA'
 * console.log(KEY_NAMES.length); // 256
 * ```
 */
export const KEY_NAMES: readonly string[] = buildNames();

/**
 * Friendly aliases, resolved by {@link keyIndex} after an exact code lookup
 * fails. Aliases are cosmetic: they may be added freely, unlike indexes.
 */
const ALIASES: Readonly<Record<string, string>> = buildAliases();

/**
 * Build the code-to-index map from the group lists above.
 *
 * @returns A frozen map from `KeyboardEvent.code` to bit index.
 */
function buildIndex(): Readonly<Record<string, number>> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  // Appends start after the *whole* guest table, not after its last filled
  // slot: the guest reserves its empty tail, and starting the cursor inside it
  // would hand a host-only code an index the guest already owns.
  let next = GUEST_KEY_NAMES.length;
  for (let i = 0; i < GUEST_KEY_NAMES.length; i += 1) {
    const code = GUEST_KEY_NAMES[i];
    if (code === '') continue;
    if (i >= POINTER_BASE) {
      throw new RangeError(`guest key table overlaps the pointer block at ${code}`);
    }
    out[code] = i;
  }
  for (const code of APPENDED) {
    if (next >= POINTER_BASE) {
      throw new RangeError(`key table overflowed the pointer block at ${code}`);
    }
    out[code] = next;
    next += 1;
  }
  for (let i = 0; i < POINTER.length; i += 1) out[POINTER[i]] = POINTER_BASE + i;
  return Object.freeze(out);
}

/**
 * Build the index-to-code table.
 *
 * @returns A frozen array of 256 names, `''` for unassigned slots.
 */
function buildNames(): readonly string[] {
  const names = new Array<string>(KEY_COUNT).fill('');
  for (const [code, index] of Object.entries(KEY_INDEX)) names[index] = code;
  return Object.freeze(names);
}

/**
 * Second code for aliases that name a left/right pair, so `'Shift'` means
 * either shift key. Resolved by {@link keyIndex2}.
 */
const PAIRED: Readonly<Record<string, string>> = Object.freeze({
  Shift: 'ShiftRight',
  Ctrl: 'ControlRight',
  Control: 'ControlRight',
  Alt: 'AltRight',
  Option: 'AltRight',
  Meta: 'MetaRight',
  Cmd: 'MetaRight',
  Command: 'MetaRight',
  Super: 'MetaRight',
  Win: 'MetaRight',
});

/**
 * Build the alias map: single letters and digits, short modifier names, arrow
 * short names and the mouse-button spellings.
 *
 * @returns A frozen map from alias to `KeyboardEvent.code`.
 */
function buildAliases(): Readonly<Record<string, string>> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let i = 0; i < 26; i += 1) out[String.fromCharCode(65 + i)] = GUEST_KEY_NAMES[i];
  for (let i = 0; i < 10; i += 1) out[String(i)] = GUEST_KEY_NAMES[26 + i];
  Object.assign(out, {
    Esc: 'Escape',
    Return: 'Enter',
    Spacebar: 'Space',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Shift: 'ShiftLeft',
    Ctrl: 'ControlLeft',
    Control: 'ControlLeft',
    Alt: 'AltLeft',
    Option: 'AltLeft',
    Meta: 'MetaLeft',
    Cmd: 'MetaLeft',
    Command: 'MetaLeft',
    Super: 'MetaLeft',
    Win: 'MetaLeft',
    Del: 'Delete',
    Plus: 'Equal',
    Dash: 'Minus',
    Tilde: 'Backquote',
    LMB: 'Mouse0',
    MMB: 'Mouse1',
    RMB: 'Mouse2',
    MB3: 'Mouse3',
    MB4: 'Mouse4',
    MouseLeft: 'Mouse0',
    MouseMiddle: 'Mouse1',
    MouseRight: 'Mouse2',
    MouseBack: 'Mouse3',
    MouseForward: 'Mouse4',
  });
  return Object.freeze(out);
}

/**
 * Resolve a `KeyboardEvent.code`, a friendly alias or a mouse-button name to
 * its frozen bit index.
 *
 * Accepted spellings, in order: the exact code (`'KeyW'`, `'Space'`), a single
 * letter or digit (`'W'`, `'7'`), a short name (`'Esc'`, `'Ctrl'`, `'Up'`), a
 * mouse button (`'LMB'`, `'RMB'`, `'Mouse3'`). Gamepad bindings are not keys —
 * see `createActionMap` for those.
 *
 * @param nameOrCode The code or alias to resolve.
 *
 * @returns The bit index, or `-1` when nothing matches.
 *
 * @example
 * ```ts
 * import { keyIndex } from 'gameable/input';
 *
 * keyIndex('KeyW'); // 22
 * keyIndex('W'); // 22, the same key
 * keyIndex('LMB'); // 248, the left mouse button
 * keyIndex('nonsense'); // -1
 * ```
 */
export function keyIndex(nameOrCode: string): number {
  // `Record<string, number>` hides the undefined an unknown key really yields.
  const direct = KEY_INDEX[nameOrCode] as number | undefined;
  if (direct !== undefined) return direct;
  const alias = (ALIASES[nameOrCode] ?? ALIASES[nameOrCode.toUpperCase()]) as string | undefined;
  if (alias === undefined) return -1;
  const resolved = KEY_INDEX[alias] as number | undefined;
  return resolved ?? -1;
}

/**
 * The second index of an alias that names a left/right pair, so a binding of
 * `'Shift'` covers both shift keys.
 *
 * @param nameOrCode The code or alias to resolve.
 *
 * @returns The second bit index, or `-1` when the name maps to one key only.
 *
 * @example
 * ```ts
 * import { keyIndex, keyIndex2, KEY_NAMES } from 'gameable/input';
 *
 * console.log(KEY_NAMES[keyIndex('Shift')]); // 'ShiftLeft'
 * console.log(KEY_NAMES[keyIndex2('Shift')]); // 'ShiftRight'
 * console.log(keyIndex2('KeyW')); // -1
 * ```
 */
export function keyIndex2(nameOrCode: string): number {
  const paired = (PAIRED[nameOrCode] ?? PAIRED[capitalise(nameOrCode)]) as string | undefined;
  if (paired === undefined) return -1;
  const resolved = KEY_INDEX[paired] as number | undefined;
  return resolved ?? -1;
}

/**
 * Capitalise the first letter and lowercase the rest, so `'shift'` and
 * `'SHIFT'` both find `'Shift'`.
 *
 * @param name The spelling to normalise.
 *
 * @returns The normalised spelling.
 */
function capitalise(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/**
 * The key index that mirrors a DOM `MouseEvent.button` number.
 *
 * @param button `MouseEvent.button`: 0 left, 1 middle, 2 right, 3 back, 4
 *   forward.
 *
 * @returns The mirrored key index, or `-1` for a button outside the block.
 *
 * @example
 * ```ts
 * import { pointerKeyIndex } from 'gameable/input';
 *
 * pointerKeyIndex(0); // 248
 * pointerKeyIndex(9); // -1
 * ```
 */
export function pointerKeyIndex(button: number): number {
  if (!Number.isInteger(button) || button < 0 || button > POINTER_BUTTON_MAX) return -1;
  return POINTER_BASE + button;
}

/**
 * Standard-mapping gamepad button indexes, by friendly name. The names follow
 * the Xbox layout because that is what the W3C standard mapping describes;
 * `GamepadCross` and friends alias the PlayStation spelling.
 *
 * @example
 * ```ts
 * import { GAMEPAD_BUTTON_INDEX } from 'gameable/input';
 *
 * console.log(GAMEPAD_BUTTON_INDEX.GamepadA); // 0
 * console.log(GAMEPAD_BUTTON_INDEX.GamepadRT); // 7
 * ```
 */
export const GAMEPAD_BUTTON_INDEX: Readonly<Record<string, number>> = Object.freeze({
  GamepadA: 0,
  GamepadB: 1,
  GamepadX: 2,
  GamepadY: 3,
  GamepadCross: 0,
  GamepadCircle: 1,
  GamepadSquare: 2,
  GamepadTriangle: 3,
  GamepadLB: 4,
  GamepadRB: 5,
  GamepadLT: 6,
  GamepadRT: 7,
  GamepadBack: 8,
  GamepadStart: 9,
  GamepadLS: 10,
  GamepadRS: 11,
  GamepadUp: 12,
  GamepadDown: 13,
  GamepadLeft: 14,
  GamepadRight: 15,
  GamepadHome: 16,
});

/**
 * Resolve a gamepad binding name to a standard-mapping button index.
 *
 * @param name A `Gamepad*` name from {@link GAMEPAD_BUTTON_INDEX}.
 *
 * @returns The button index, or `-1` when the name is not a gamepad button.
 *
 * @example
 * ```ts
 * import { gamepadButtonIndex } from 'gameable/input';
 *
 * gamepadButtonIndex('GamepadA'); // 0
 * gamepadButtonIndex('KeyW'); // -1
 * ```
 */
export function gamepadButtonIndex(name: string): number {
  const index = GAMEPAD_BUTTON_INDEX[name] as number | undefined;
  return index ?? -1;
}
