/**
 * The text frame functions: thin calls on one shared {@link TextFrames}, for
 * callers that do not need an instance of their own.
 */
import { TextFrames } from './TextFrames.js';
import type { ClientText, ClientTextFailure, ServerText } from './types.js';

const shared = new TextFrames();

/**
 * A new text frame builder and parser.
 *
 * @returns The builder.
 *
 * @example
 * ```ts
 * const frames = createTextFrames();
 * frames.parseServer('{"t":"pong","at":1,"server":2}'); // { t: 'pong', at: 1, server: 2 }
 * ```
 */
export function createTextFrames(): TextFrames {
  return new TextFrames();
}

/**
 * UTF-8 bytes of `text`, counted without encoding it.
 *
 * @param text - Any string.
 * @returns Its UTF-8 length.
 *
 * @example
 * ```ts
 * utf8ByteLength('€'); // 3
 * ```
 */
export function utf8ByteLength(text: string): number {
  return shared.byteLength(text);
}

/**
 * A client frame as JSON text, or null when a `msg` payload is over `MAX_PAYLOAD_BYTES`.
 *
 * @param frame - The frame to send.
 * @returns The text, or null.
 *
 * @example
 * ```ts
 * const text = buildClientText({ t: 'hello', v: 1, room: 'lobby', name: 'Ana' });
 * // '{"t":"hello","v":1,"room":"lobby","name":"Ana"}'
 * ```
 */
export function buildClientText(frame: ClientText): string | null {
  return shared.buildClient(frame);
}

/**
 * A server frame as JSON text, or null when a `msg` payload is over `MAX_PAYLOAD_BYTES`.
 *
 * @param frame - The frame to send.
 * @returns The text, or null.
 *
 * @example
 * ```ts
 * const text = buildServerText({ t: 'pong', at: 12.5, server: Date.now() });
 * ```
 */
export function buildServerText(frame: ServerText): string | null {
  return shared.buildServer(frame);
}

/**
 * A client frame from its text, or null for anything malformed or over the cap.
 *
 * @param text - A received text message.
 * @returns The checked frame, or null.
 *
 * @example
 * ```ts
 * const frame = parseClientText('{"t":"ping","at":12.5}');
 * const at = frame?.t === 'ping' ? frame.at : null; // 12.5
 * ```
 */
export function parseClientText(text: string): ClientText | null {
  return shared.parseClient(text);
}

/**
 * A client frame from its text, or the reason it was refused: `size`, `depth`,
 * `json`, `type` or `shape`.
 *
 * @param text - A received text message.
 * @returns The checked frame, or the reason.
 *
 * @example
 * ```ts
 * const result = parseClientTextDetailed('{"t":"nope"}'); // 'type'
 * const frame = typeof result === 'string' ? null : result;
 * ```
 */
export function parseClientTextDetailed(text: string): ClientText | ClientTextFailure {
  return shared.parseClientDetailed(text);
}

/**
 * A server frame from its text, or null for anything malformed.
 *
 * @param text - A received text message.
 * @returns The checked frame, or null.
 *
 * @example
 * ```ts
 * const frame = parseServerText('{"t":"error","code":"full"}');
 * const full = frame?.t === 'error' && frame.code === 'full'; // true
 * ```
 */
export function parseServerText(text: string): ServerText | null {
  return shared.parseServer(text);
}
