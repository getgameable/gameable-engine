/**
 * `RowQueue` — the rows frames that arrived since the last fixed step, and
 * the newest `frame` applied, so a frame that a reordering link delivers late
 * is dropped instead of moving entities backwards.
 */
import { FrameKind, ROWS_HEADER_BYTES } from '../protocol/constants.js';
import { RowsCodec } from '../protocol/RowsCodec.js';
import type { FramedRowSink } from './NetService.js';

/**
 * @param bytes A rows frame, at least a header long.
 * @returns Its `frame` field (u32 little-endian at byte 1), read without a `DataView`.
 */
function frameOf(bytes: Uint8Array): number {
  return (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0;
}

/** Queued rows frames, decoded oldest first at the next drain. */
export class RowQueue {
  /** Frames dropped as stale. */
  stale = 0;
  /** Frames applied. */
  applied = 0;
  /** Frames that were not rows frames, or did not decode. */
  bad = 0;
  /** The `ack` of the newest frame applied. */
  ack = 0;

  private readonly codec = new RowsCodec();
  private readonly queue: Uint8Array[] = [];
  private newest = -1;

  /** @param bytes One received rows frame; the queue keeps it until the drain. */
  push(bytes: Uint8Array): void {
    if (bytes.byteLength < ROWS_HEADER_BYTES || bytes[0] !== FrameKind.ROWS) {
      this.bad += 1;
      return;
    }
    this.queue.push(bytes);
  }

  /** @returns How many frames are waiting for the drain. */
  get length(): number {
    return this.queue.length;
  }

  /** Drop what is queued, keeping the newest frame applied. */
  clear(): void {
    this.queue.length = 0;
  }

  /**
   * Forget what is queued: a new welcome starts the world again at `frame`,
   * and rows from before it are stale (a restarted room may count from 0 again).
   *
   * @param frame The welcome's frame.
   */
  reset(frame: number): void {
    this.queue.length = 0;
    this.newest = frame - 1;
  }

  /**
   * Decode every queued frame into `sink`, oldest first, once.
   *
   * @param sink Where the rows go.
   */
  drain(sink: FramedRowSink): void {
    const queue = this.queue;
    try {
      for (let i = 0; i < queue.length; i += 1) {
        const bytes = queue[i];
        const frame = frameOf(bytes);
        if (frame < this.newest) {
          this.stale += 1;
          continue;
        }
        sink.beginFrame?.(frame);
        const header = this.codec.decode(bytes, sink);
        if (header === null) {
          this.bad += 1;
          continue;
        }
        this.newest = frame;
        this.ack = header.ack;
        this.applied += 1;
      }
    } finally {
      queue.length = 0;
    }
  }
}
