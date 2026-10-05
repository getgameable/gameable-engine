/**
 * `InboundParser` — sorts one raw client frame into text, input or bad.
 */
import { KEY_WORDS } from '@gameable/sdk/keycodes';

import { FrameKind, MAX_CLIENT_TEXT_BYTES, MAX_PAYLOAD_BYTES } from '../../protocol/constants.js';
import { InputCodec } from '../../protocol/InputCodec.js';
import { utf8ByteLength } from '../../protocol/textFrameFunctions.js';
import { TextFrames } from '../../protocol/TextFrames.js';
import type { ClientText, MutableInputSnapshot } from '../../protocol/types.js';

/** Why a frame was refused; see {@link InboundParser.parse}. */
export type BadReason = 'size' | 'payload' | 'json' | 'type' | 'shape' | 'kind' | 'depth';

/** A checked client frame, or the reason it was refused. */
export type InboundFrame =
  | { kind: 'text'; msg: ClientText }
  | { kind: 'input'; seq: number; snapshot: MutableInputSnapshot }
  | { kind: 'bad'; reason: BadReason };

type TextResult = Extract<InboundFrame, { kind: 'text' }>;
type InputResult = Extract<InboundFrame, { kind: 'input' }>;

const REASONS: readonly BadReason[] = ['size', 'payload', 'json', 'type', 'shape', 'kind', 'depth'];

/**
 * Classifies a received frame. A string is a text frame, checked by
 * `TextFrames` (size, depth, JSON, type, shape); bytes are a binary frame,
 * which must be exactly one input frame, decoded by `InputCodec`. The size
 * and depth checks are those two classes', not repeated here.
 *
 * One parser per connection: it owns the result objects and the input
 * snapshot and reuses them on every call, so the input path allocates nothing
 * (the text path allocates what `JSON.parse` does). The result of one `parse`
 * is good only until the next: copy what you keep.
 *
 * @example
 * ```ts
 * import { InboundParser } from 'gameable/net/server';
 *
 * const parser = new InboundParser();
 * const frame = parser.parse('{"t":"ping","at":12.5}');
 * const at = frame.kind === 'text' && frame.msg.t === 'ping' ? frame.msg.at : null; // 12.5
 * ```
 */
export class InboundParser {
  private readonly frames = new TextFrames();
  private readonly codec = new InputCodec();
  private readonly snapshot: MutableInputSnapshot = {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
    focused: false,
  };
  private readonly textResult: TextResult = { kind: 'text', msg: { t: 'ping', at: 0 } };
  private readonly inputResult: InputResult = {
    kind: 'input',
    seq: 0,
    snapshot: this.snapshot,
  };
  private readonly bad = new Map<BadReason, InboundFrame>(
    REASONS.map((reason) => [reason, { kind: 'bad', reason }]),
  );

  /**
   * Classifies one received frame.
   *
   * @param data - A received message: a string for text, bytes for binary.
   * @returns `text` with the checked frame; `input` with the `seq` and the
   * parser's snapshot; or `bad` with a reason: `size` (over
   * `MAX_CLIENT_TEXT_BYTES`), `payload` (a `msg` whose payload alone is over
   * `MAX_PAYLOAD_BYTES`), `depth`, `json`, `type` (unknown `t`), `shape`
   * (wrong fields) for text; `kind` for bytes that are not exactly one input
   * frame (an unknown first byte, or a truncated, padded or otherwise
   * malformed input frame, which `InputCodec` does not tell apart). The
   * result and its snapshot are reused by the next call.
   */
  parse(data: string | Uint8Array): InboundFrame {
    return typeof data === 'string' ? this.parseText(data) : this.parseBinary(data);
  }

  private parseText(text: string): InboundFrame {
    const result = this.frames.parseClientDetailed(text);
    if (result === 'shape' && isOversizeMsg(text)) return this.refuse('payload');
    if (typeof result === 'string') return this.refuse(result);
    this.textResult.msg = result;
    return this.textResult;
  }

  private parseBinary(bytes: Uint8Array): InboundFrame {
    if (bytes.length > MAX_CLIENT_TEXT_BYTES) return this.refuse('size');
    if (bytes.length === 0 || bytes[0] !== FrameKind.INPUT) return this.refuse('kind');
    const header = this.codec.decode(bytes, this.snapshot);
    if (header === null) return this.refuse('kind');
    this.inputResult.seq = header.seq;
    return this.inputResult;
  }

  private refuse(reason: BadReason): InboundFrame {
    return this.bad.get(reason) as InboundFrame;
  }
}

/**
 * Whether a frame `TextFrames` refused as `shape` is a `msg` refused for its
 * payload's size alone. Only a refused frame longer than the payload cap is
 * parsed again, so the price is paid by frames that already cost a token.
 *
 * @param text - A text frame refused as `shape`.
 * @returns True when it is a `msg` with a string `name` and a payload over `MAX_PAYLOAD_BYTES`.
 */
function isOversizeMsg(text: string): boolean {
  if (utf8ByteLength(text) <= MAX_PAYLOAD_BYTES) return false;
  const o = JSON.parse(text) as { t?: unknown; name?: unknown; payload?: unknown } | null;
  if (typeof o !== 'object' || o === null) return false; // `shape` also means "not an object"
  if (o.t !== 'msg' || typeof o.name !== 'string' || !('payload' in o)) return false;
  const payload = JSON.stringify(o.payload) as string | undefined;
  return payload !== undefined && utf8ByteLength(payload) > MAX_PAYLOAD_BYTES;
}

const shared = new InboundParser();

/**
 * Classifies one received frame with a parser shared by every caller; see
 * {@link InboundParser.parse}. Fine for a single-threaded server that reads
 * the result before parsing the next frame.
 *
 * @param data - A received message: a string for text, bytes for binary.
 * @returns The classified frame; copy what you keep.
 *
 * @example
 * ```ts
 * import { parseClientFrame } from 'gameable/net/server';
 *
 * const frame = parseClientFrame('{"t":"nope"}'); // { kind: 'bad', reason: 'type' }
 * ```
 */
export function parseClientFrame(data: string | Uint8Array): InboundFrame {
  return shared.parse(data);
}
