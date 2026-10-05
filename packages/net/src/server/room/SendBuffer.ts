/**
 * `SendBuffer` — the one buffer a room writes its rows frames into.
 */

/**
 * A growable byte buffer with an exact-length view per frame size, so a send
 * hands the port a `Uint8Array` of exactly one frame without allocating one.
 *
 * The buffer grows (and its views are dropped) only when a frame is larger
 * than any before it; in a steady room every length has been seen and a send
 * allocates nothing. Views are cached by length, so the cache holds at most
 * one entry per distinct frame size up to the buffer's capacity.
 *
 * @example
 * ```ts
 * import { SendBuffer } from 'gameable/net/server';
 *
 * const buffer = new SendBuffer();
 * const out = buffer.reserve(11);
 * out.setUint8(0, 2);
 * const frame = buffer.bytes(11); // a Uint8Array of length 11 over the same memory
 * ```
 */
export class SendBuffer {
  private data: DataView;
  private views: (Uint8Array | undefined)[] = [];

  /** @param initialBytes Starting capacity; default 4 KiB. */
  constructor(initialBytes = 4096) {
    this.data = new DataView(new ArrayBuffer(Math.max(16, initialBytes)));
  }

  /**
   * Make room for a frame and return the view to write it through.
   *
   * @param bytes The frame's length.
   * @returns A `DataView` over at least `bytes` bytes; valid until the next `reserve`.
   */
  reserve(bytes: number): DataView {
    if (bytes > this.data.byteLength) {
      let size = this.data.byteLength;
      while (size < bytes) size *= 2;
      this.data = new DataView(new ArrayBuffer(size));
      this.views = [];
    }
    return this.data;
  }

  /**
   * @param length The frame's length, at most the reserved size.
   * @returns The buffer's first `length` bytes, as a cached view.
   */
  bytes(length: number): Uint8Array {
    let view = this.views[length];
    if (view === undefined) {
      view = new Uint8Array(this.data.buffer, 0, length);
      this.views[length] = view;
    }
    return view;
  }
}
