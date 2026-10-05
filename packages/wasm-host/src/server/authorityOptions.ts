/**
 * The `game-config.options` string an authority hands its guest.
 */

/** A parsed JSON object. */
type JsonObject = Record<string, unknown>;

/**
 * @param value Anything `JSON.parse` returned.
 * @returns True for a plain object (not an array, not null).
 */
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge `{"net":{"role":"authority"}}` into the caller's options JSON.
 *
 * The caller's keys are kept, including any other `net` keys; `net.role` is
 * always `"authority"`, because the server loop is the authority whatever the
 * caller wrote.
 *
 * @param caller The caller's options JSON, or `undefined` for none.
 * @returns The options string for `game-config.options`.
 * @throws {TypeError} When `caller` is not a JSON object, or its `net` is not one.
 * @throws {SyntaxError} When `caller` is not valid JSON (from `JSON.parse`).
 *
 * @example
 * ```ts
 * authorityOptions('{"mode":"duel"}'); // '{"mode":"duel","net":{"role":"authority"}}'
 * ```
 */
export function authorityOptions(caller: string | undefined): string {
  const options: unknown = caller === undefined ? {} : JSON.parse(caller);
  if (!isObject(options)) {
    throw new TypeError('createServerLoop: options must be a JSON object');
  }
  const net: unknown = options.net ?? {};
  if (!isObject(net)) {
    throw new TypeError('createServerLoop: options.net must be a JSON object');
  }
  return JSON.stringify({ ...options, net: { ...net, role: 'authority' } });
}
