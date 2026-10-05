/**
 * `defineMessage`: a game message's name, its type guard and its size cap,
 * declared once and used on both ends (`ctx.net.messages(def)` and
 * `ctx.net.send(def, payload)`), plus the two guard helpers.
 */
import { MAX_PAYLOAD_BYTES, RESERVED_MESSAGE_PREFIX } from '../wire';

/**
 * The game's own type guard for a payload, already parsed from JSON. It must
 * be pure: no wall time, no `Math.random`, no state, so the authority and
 * every replay agree on what it drops.
 */
export type MessageCheck<T> = (payload: unknown) => payload is T;

/**
 * Options for {@link defineMessage}.
 *
 * @example
 * ```ts
 * const Chat = defineMessage('chat', (p): p is string => typeof p === 'string', { maxBytes: 256 });
 * ```
 */
export interface MessageOptions {
  /** The largest payload, in UTF-8 bytes of its JSON; 1 to 2,048. Default 2,048, the wire cap. */
  maxBytes?: number;
}

/**
 * One game message: what `defineMessage` returns. Pass it to
 * `ctx.net.messages` and `ctx.net.send`.
 *
 * @example
 * ```ts
 * const Ready = defineMessage('ready', (p): p is true => p === true);
 * console.log(Ready.name, Ready.maxBytes); // 'ready' 2048
 * ```
 */
export class MessageDef<T> {
  /**
   * @param name The message name on the wire.
   * @param check The payload's type guard.
   * @param maxBytes The payload cap in UTF-8 bytes of JSON.
   */
  constructor(
    readonly name: string,
    readonly check: MessageCheck<T>,
    readonly maxBytes: number,
  ) {}
}

/** Names defined since the last `init`: "one game". */
const names = new Set<string>();

/**
 * Forget every defined name. The guest's `init` calls it, so a game module
 * evaluated again (a reload, a second test) can define its messages again.
 */
export function resetMessageNames(): void {
  names.clear();
}

/**
 * Declare a game message. Call it at module scope, once per name: a second
 * definition with the same name before the next `init` throws.
 *
 * A received payload that is over `maxBytes`, does not parse, fails `check`
 * or makes `check` throw is dropped and counted in `ctx.net.stats.dropped`;
 * a system never sees it.
 *
 * @param name The message name; unique within the game.
 * @param check The game's own type guard. Pure: no clock, no randomness.
 * @param options `maxBytes`, default 2,048 (the wire cap).
 * @returns The definition.
 * @throws {Error} On a duplicate name, an empty name, a name starting with
 *   `aos:` (reserved for the engine, as `ctx.net.setPhase`'s `aos:phase`), or
 *   a `maxBytes` that is not a whole number from 1 to 2,048.
 *
 * @example
 * ```ts
 * import { defineMessage, hasKeys } from 'gameable';
 *
 * const hasFor = hasKeys('for');
 * export const Vote = defineMessage(
 *   'vote',
 *   (p): p is { for: number } => hasFor(p) && typeof p.for === 'number',
 *   { maxBytes: 64 },
 * );
 * ```
 */
export function defineMessage<T>(
  name: string,
  check: MessageCheck<T>,
  options?: MessageOptions,
): MessageDef<T> {
  if (name === '') throw new Error('defineMessage: the name is empty');
  if (name.startsWith(RESERVED_MESSAGE_PREFIX)) {
    throw new Error(
      `defineMessage('${name}'): names starting with '${RESERVED_MESSAGE_PREFIX}' are reserved for the engine`,
    );
  }
  const maxBytes = options?.maxBytes ?? MAX_PAYLOAD_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `defineMessage('${name}'): maxBytes must be a whole number from 1 to ${String(MAX_PAYLOAD_BYTES)}`,
    );
  }
  if (names.has(name)) {
    throw new Error(`defineMessage('${name}'): this game already defines a message with that name`);
  }
  names.add(name);
  return new MessageDef(name, check, maxBytes);
}

/**
 * A plain JSON object: not `null`, not an array.
 *
 * @param x A parsed payload.
 * @returns True for an object record.
 *
 * @example
 * ```ts
 * const Move = defineMessage('move', (p): p is { x: number } => isRecord(p) && typeof p.x === 'number');
 * ```
 */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * A guard for a record with every one of `keys` as an own property (any
 * value, even `undefined`); extra keys are allowed. Make it once, at module
 * scope: the guard it returns allocates nothing per call.
 *
 * @param keys The keys a payload must have.
 * @returns The guard.
 *
 * @example
 * ```ts
 * const hasItemSlot = hasKeys('item', 'slot');
 * const Pick = defineMessage(
 *   'pick',
 *   (p): p is { item: string; slot: number } =>
 *     hasItemSlot(p) && typeof p.item === 'string' && typeof p.slot === 'number',
 * );
 * ```
 */
export function hasKeys<K extends string>(...keys: K[]): (x: unknown) => x is Record<K, unknown> {
  return (x: unknown): x is Record<K, unknown> => {
    if (!isRecord(x)) return false;
    for (let i = 0; i < keys.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(x, keys[i])) return false;
    }
    return true;
  };
}
