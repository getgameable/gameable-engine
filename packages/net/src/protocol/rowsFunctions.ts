/**
 * The rows functions: thin calls on one shared {@link RowsCodec}, for callers
 * that do not need an instance of their own.
 */
import { RowsCodec } from './RowsCodec.js';
import type { RowSink, RowSource, RowsHeader } from './types.js';

/**
 * A new rows codec with its own reusable header.
 *
 * @returns The codec.
 *
 * @example
 * ```ts
 * const codec = createRowsCodec();
 * ```
 */
export function createRowsCodec(): RowsCodec {
  return new RowsCodec();
}

const shared = new RowsCodec();

/**
 * The bytes `encodeRows` would write for `rows`; size the send buffer with it.
 *
 * @param rows - The rows to size.
 * @returns The frame's length.
 *
 * @example
 * ```ts
 * const position = new Float32Array([1.5, 0, -2]);
 * const rotation = new Float32Array([0, 0, 0, 1]);
 * const scale = new Float32Array([1, 1, 1]);
 * const rows: RowSource = {
 *   count: 1,
 *   entity: () => 7,
 *   flags: () => RowFlag.POSITION | RowFlag.ROTATION,
 *   position: () => position,
 *   rotation: () => rotation,
 *   scale: () => scale,
 * };
 * const out = new DataView(new ArrayBuffer(rowsFrameBytes(rows))); // 11 + 21 bytes
 * ```
 */
export function rowsFrameBytes(rows: RowSource): number {
  return shared.frameBytes(rows);
}

/**
 * Writes one rows frame at the start of `out`; see {@link RowsCodec.encode}.
 *
 * @param out - The send buffer, owned by the caller.
 * @param frame - The authority's fixed-step counter.
 * @param ack - The last input `seq` applied for the receiving player.
 * @param rows - The rows to write.
 * @returns Bytes written, or 0 when `out` is too small.
 *
 * @example
 * ```ts
 * const position = new Float32Array([1.5, 0, -2]);
 * const rotation = new Float32Array([0, 0, 0, 1]);
 * const scale = new Float32Array([1, 1, 1]);
 * const rows: RowSource = {
 *   count: 1,
 *   entity: () => 7,
 *   flags: () => RowFlag.POSITION | RowFlag.ROTATION,
 *   position: () => position,
 *   rotation: () => rotation,
 *   scale: () => scale,
 * };
 * const out = new DataView(new ArrayBuffer(1024));
 * const bytes = encodeRows(out, 600, 12, rows);
 * const frame = new Uint8Array(out.buffer, out.byteOffset, bytes); // the bytes to send
 * ```
 */
export function encodeRows(out: DataView, frame: number, ack: number, rows: RowSource): number {
  return shared.encode(out, frame, ack, rows);
}

/**
 * Reads one rows frame into `sink`; see {@link RowsCodec.decode}. The returned
 * object is shared by every call: read it before the next decode.
 *
 * @param bytes - Exactly one received frame.
 * @param sink - Receives the rows.
 * @returns `{ frame, ack, count }`, or null for a malformed frame.
 *
 * @example
 * ```ts
 * const position = new Float32Array([1.5, 0, -2]);
 * const rotation = new Float32Array([0, 0, 0, 1]);
 * const scale = new Float32Array([1, 1, 1]);
 * const rows: RowSource = {
 *   count: 1,
 *   entity: () => 7,
 *   flags: () => RowFlag.POSITION | RowFlag.ROTATION,
 *   position: () => position,
 *   rotation: () => rotation,
 *   scale: () => scale,
 * };
 * const sink: RowSink = {
 *   position: new Float32Array(3),
 *   rotation: new Float32Array(4),
 *   scale: new Float32Array(3),
 *   row: (entity) => console.log(entity, sink.position),
 * };
 * const out = new DataView(new ArrayBuffer(rowsFrameBytes(rows)));
 * const message = new Uint8Array(out.buffer, 0, encodeRows(out, 600, 12, rows));
 * const newest = decodeRows(message, sink)?.frame; // 600
 * ```
 */
export function decodeRows(bytes: Uint8Array, sink: RowSink): RowsHeader | null {
  return shared.decode(bytes, sink);
}
