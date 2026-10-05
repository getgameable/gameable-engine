/**
 * Room codes: four letters a player can read aloud and type on a phone.
 */
import { randomInt } from 'node:crypto';

/**
 * The letters a room code is made of: Tala's alphabet, A to Z without I, L and
 * O, which read as 1, 1 and 0.
 *
 * @example
 * ```ts
 * import { ROOM_CODE_ALPHABET } from 'gameable/rooms/server';
 *
 * console.log(ROOM_CODE_ALPHABET.length); // 23
 * ```
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Letters in a room code.
 *
 * @example
 * ```ts
 * import { ROOM_CODE_LENGTH } from 'gameable/rooms/server';
 *
 * console.log(ROOM_CODE_LENGTH); // 4: 279,841 codes
 * ```
 */
export const ROOM_CODE_LENGTH = 4;

/** @returns A uniform draw in [0, 1) from the system's CSPRNG: codes must not be predictable. */
const secureRandom = (): number => randomInt(0, 2 ** 32) / 2 ** 32;

/** Random codes tried before minting gives up. */
const ATTEMPTS = 64;
const PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${String(ROOM_CODE_LENGTH)}}$`);

/**
 * @param value Anything.
 * @returns True for a well-formed room code (four letters of the alphabet).
 *
 * @example
 * ```ts
 * import { isRoomCode } from 'gameable/rooms/server';
 *
 * console.log(isRoomCode('KXQR'), isRoomCode('kxqr')); // true false
 * ```
 */
export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && PATTERN.test(value);
}

/**
 * The codes of the live rooms in this process. `mint` hands out a code no live
 * room has; `release` gives it back when the room goes.
 *
 * Unique within one process. Across processes (phase 6, Redis presence) the
 * code is also the room id, and Colyseus refuses a second room with an id
 * already recorded.
 *
 * @example
 * ```ts
 * import { createRoomCodes } from 'gameable/rooms/server';
 *
 * const codes = createRoomCodes();
 * const code = codes.mint(); // 'KXQR'
 * codes.release(code);
 * ```
 */
export class RoomCodes {
  private readonly live = new Set<string>();

  /** @param random A source in [0, 1); the system's CSPRNG (`crypto.randomInt`) by default. */
  constructor(private readonly random: () => number = secureRandom) {}

  /** @returns How many codes are live. */
  get size(): number {
    return this.live.size;
  }

  /**
   * @param code A code.
   * @returns True while a live room has it.
   */
  has(code: string): boolean {
    return this.live.has(code);
  }

  /**
   * @returns A code no live room has, now live.
   * @throws {Error} When every code it tried was taken.
   */
  mint(): string {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const code = this.draw();
      if (this.live.has(code)) continue;
      this.live.add(code);
      return code;
    }
    throw new Error(`RoomCodes: no free room code after ${String(ATTEMPTS)} tries`);
  }

  /** @param code A code whose room has gone. */
  release(code: string): void {
    this.live.delete(code);
  }

  private draw(): string {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
      const index = Math.floor(this.random() * ROOM_CODE_ALPHABET.length);
      code += ROOM_CODE_ALPHABET[Math.min(index, ROOM_CODE_ALPHABET.length - 1)];
    }
    return code;
  }
}

/**
 * @param random A source in [0, 1); `crypto.randomInt` by default.
 * @returns An empty set of live codes.
 *
 * @example
 * ```ts
 * import { createRoomCodes } from 'gameable/rooms/server';
 *
 * const code = createRoomCodes().mint();
 * ```
 */
export function createRoomCodes(random?: () => number): RoomCodes {
  return new RoomCodes(random);
}
