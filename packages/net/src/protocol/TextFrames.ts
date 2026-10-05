/**
 * `TextFrames` — the JSON text frames, built and parsed.
 *
 * Parsing never throws: anything that is not valid JSON of a known shape comes
 * back as null. A client frame is size-checked by its UTF-8 length before
 * `JSON.parse` runs, so a hostile client cannot make the server parse a
 * megabyte; a server frame is not capped (a `welcome` carries the world), but a
 * `msg` payload is held to `MAX_PAYLOAD_BYTES` in both directions.
 *
 * Both directions refuse text nested deeper than `MAX_JSON_DEPTH`, found by a
 * scan before parsing. Shapes are checked to the depth this layer owns: `cmd` commands and
 * `welcome`'s snapshot are passed through as the server built them.
 */
import { MAX_CLIENT_TEXT_BYTES, MAX_JSON_DEPTH, MAX_PAYLOAD_BYTES } from './constants.js';
import {
  depthWithin,
  isFiniteNumber,
  isId,
  isInt,
  isObject,
  isPlayers,
  type Json,
} from './jsonGuards.js';
import type { ClientText, ClientTextFailure, ServerErrorCode, ServerText } from './types.js';

const ERROR_CODES: ReadonlySet<string> = new Set<ServerErrorCode>([
  'room',
  'full',
  'seat',
  'origin',
  'budget',
  'version',
  'ended',
]);

/**
 * Text frame building and parsing for both directions.
 *
 * @example
 * ```ts
 * const frames = new TextFrames();
 * const text = frames.buildClient({ t: 'ping', at: performance.now() });
 * const back = text === null ? null : frames.parseClient(text); // { t: 'ping', at: ... }
 * ```
 */
export class TextFrames {
  /**
   * UTF-8 bytes of `text`, counted without encoding it. A lone surrogate counts
   * 3, as `TextEncoder` writes U+FFFD for it.
   *
   * @param text - Any string.
   * @returns Its UTF-8 length.
   */
  byteLength(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i += 1) {
      const unit = text.charCodeAt(i);
      if (unit < 0x80) bytes += 1;
      else if (unit < 0x800) bytes += 2;
      else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i += 1;
        } else bytes += 3;
      } else bytes += 3;
    }
    return bytes;
  }

  /**
   * A client frame as JSON text.
   *
   * @param frame - The frame to send.
   * @returns The text, or null when a `msg` payload is over the cap or not JSON,
   * or the frame is over `MAX_CLIENT_TEXT_BYTES`.
   */
  buildClient(frame: ClientText): string | null {
    const text = frame.t === 'msg' ? this.buildMsg(frame) : this.stringify(frame);
    return text !== null && this.byteLength(text) <= MAX_CLIENT_TEXT_BYTES ? text : null;
  }

  /**
   * A server frame as JSON text.
   *
   * @param frame - The frame to send.
   * @returns The text, or null when a `msg` payload is over the cap or anything is not JSON.
   */
  buildServer(frame: ServerText): string | null {
    return frame.t === 'msg' ? this.buildMsg(frame) : this.stringify(frame);
  }

  /**
   * A client frame from its text. The frame is rebuilt from the fields it was
   * checked on, so nothing else the client sent survives.
   *
   * @param text - A received text message.
   * @returns The checked frame, or null for anything malformed, mistyped or over the cap.
   */
  parseClient(text: string): ClientText | null {
    const result = this.parseClientDetailed(text);
    return typeof result === 'string' ? null : result;
  }

  /**
   * {@link TextFrames.parseClient} that says why it refused.
   *
   * @param text - A received text message.
   * @returns The checked frame, or the reason: `size` (over the cap), `depth`
   * (nested too deep), `json` (not JSON), `type` (no known `t`) or `shape`
   * (not an object, or the fields of a known `t` are wrong).
   */
  parseClientDetailed(text: string): ClientText | ClientTextFailure {
    if (text.length > MAX_CLIENT_TEXT_BYTES || this.byteLength(text) > MAX_CLIENT_TEXT_BYTES) {
      return 'size';
    }
    const o = this.parseObjectOrReason(text);
    if (typeof o === 'string') return o;
    const frame = this.clientFrame(o);
    return frame ?? (o.t === 'hello' || o.t === 'msg' || o.t === 'ping' ? 'shape' : 'type');
  }

  /**
   * The checked client frame of a parsed object.
   *
   * @param o - The parsed frame.
   * @returns The rebuilt frame, or null when `t` is unknown or its fields are wrong.
   */
  private clientFrame(o: Json): ClientText | null {
    switch (o.t) {
      case 'hello': {
        const { v, room, name, seat, token } = o;
        if (!isInt(v) || typeof room !== 'string' || typeof name !== 'string') return null;
        if (token !== undefined && typeof token !== 'string') return null;
        if (seat === undefined) {
          return token === undefined
            ? { t: 'hello', v, room, name }
            : { t: 'hello', v, room, name, token };
        }
        if (!isObject(seat) || !isId(seat.id) || typeof seat.secret !== 'string') return null;
        const held = { id: seat.id, secret: seat.secret };
        return token === undefined
          ? { t: 'hello', v, room, name, seat: held }
          : { t: 'hello', v, room, name, seat: held, token };
      }
      case 'msg':
        return typeof o.name === 'string' && this.isMsg(o)
          ? { t: 'msg', name: o.name, payload: o.payload }
          : null;
      case 'ping':
        return isFiniteNumber(o.at) ? { t: 'ping', at: o.at } : null;
      default:
        return null;
    }
  }

  /**
   * A server frame from its text.
   *
   * @param text - A received text message.
   * @returns The checked frame, or null for anything malformed or mistyped.
   */
  parseServer(text: string): ServerText | null {
    const o = this.parseObject(text);
    if (o === null) return null;
    let ok: boolean;
    switch (o.t) {
      case 'welcome':
        ok = isId(o.player) && typeof o.secret === 'string' && isId(o.frame) && 'snapshot' in o;
        ok &&= isId(o.entity);
        ok &&= o.room === undefined || typeof o.room === 'string';
        ok &&= isPlayers(o.players);
        break;
      case 'cmd':
        ok = isId(o.frame) && isId(o.ack) && isId(o.entity) && Array.isArray(o.commands);
        break;
      case 'players':
        ok = isPlayers(o.players);
        break;
      case 'msg':
        ok = isId(o.from) && this.isMsg(o);
        break;
      case 'pong':
        ok = isFiniteNumber(o.at) && isFiniteNumber(o.server);
        break;
      case 'error':
        ok = typeof o.code === 'string' && ERROR_CODES.has(o.code);
        ok &&= o.detail === undefined || typeof o.detail === 'string';
        break;
      default:
        ok = false;
    }
    return ok ? (o as ServerText) : null;
  }

  /**
   * A `msg` frame of either side, its payload measured on its own.
   *
   * @param frame - The frame to send.
   * @returns The text, or null when the payload is over the cap or not JSON.
   */
  private buildMsg(frame: Extract<ClientText | ServerText, { t: 'msg' }>): string | null {
    const payload = this.stringify(frame.payload);
    if (payload === null || this.byteLength(payload) > MAX_PAYLOAD_BYTES) return null;
    const from = 'from' in frame ? `"from":${JSON.stringify(frame.from)},` : '';
    return `{"t":"msg",${from}"name":${JSON.stringify(frame.name)},"payload":${payload}}`;
  }

  /**
   * Whether a parsed object is a well-formed `msg`.
   *
   * @param o - The parsed frame.
   * @returns True when it has a string `name` and a payload within the cap.
   */
  private isMsg(o: Json): boolean {
    if (typeof o.name !== 'string' || !('payload' in o)) return false;
    const payload = this.stringify(o.payload);
    return payload !== null && this.byteLength(payload) <= MAX_PAYLOAD_BYTES;
  }

  /**
   * `JSON.stringify` that answers null instead of throwing or returning undefined.
   *
   * @param value - Anything.
   * @returns Its JSON, or null for a cycle, a bigint or `undefined`.
   */
  private stringify(value: unknown): string | null {
    try {
      const text = JSON.stringify(value) as string | undefined;
      return text ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A plain JSON object from `text`.
   *
   * @param text - A received text message.
   * @returns The object, or null for invalid JSON, any other JSON value, or
   * nesting deeper than `MAX_JSON_DEPTH`.
   */
  private parseObject(text: string): Json | null {
    const o = this.parseObjectOrReason(text);
    return typeof o === 'string' ? null : o;
  }

  /**
   * {@link TextFrames.parseObject} that says why it refused.
   *
   * @param text - A received text message.
   * @returns The object, or `depth`, `json`, or `shape` (valid JSON, not an object).
   */
  private parseObjectOrReason(text: string): Json | 'depth' | 'json' | 'shape' {
    if (!depthWithin(text, MAX_JSON_DEPTH)) return 'depth';
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return 'json';
    }
    return isObject(value) ? value : 'shape';
  }
}
