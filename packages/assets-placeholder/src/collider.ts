/**
 * `arena.collider.bin` — the placeholder arena's collision mesh, and the
 * smallest format that can carry one.
 *
 * ## The format
 *
 * Every field is little-endian. There is no magic number, no version and no
 * padding: the file is a header and two arrays, and its length is completely
 * determined by the two counts.
 *
 * | Offset          | Type       | Meaning                                   |
 * | --------------- | ---------- | ----------------------------------------- |
 * | `0`             | `u32`      | `vertexCount` — number of vertices, `n`   |
 * | `4`             | `u32`      | `indexCount` — number of indices, `m`     |
 * | `8`             | `f32[3n]`  | positions, `x y z` per vertex, in metres  |
 * | `8 + 12n`       | `u32[m]`   | triangle indices; `m` is a multiple of 3  |
 *
 * Total size is `8 + 12n + 4m` bytes. Triangles are wound counter-clockwise
 * seen from outside the solid, the coordinate system is Y-up with the origin at
 * the centre of the arena floor, and the units are metres — the same frame the
 * splats and the spawn points use.
 *
 * The format exists because a glTF collider would drag a glTF parser into the
 * physics path for eight boxes and a wedge. Jolt wants a flat position array
 * and a flat index array; this is exactly that, with a four-byte header.
 */

/** A triangle mesh: flat positions plus flat triangle indices. */
export interface ColliderMesh {
  /** Vertex positions in metres, flattened `x y z`. Length is `3 * vertexCount`. */
  readonly positions: Float32Array;
  /** Triangle indices into `positions`. Length is a multiple of three. */
  readonly indices: Uint32Array;
}

/** Options for {@link parseCollider}. */
export interface ParseColliderOptions {
  /**
   * Walk the index array and reject an index that points past the last vertex.
   *
   * The scan is `O(indexCount)` on the asset-loading path, and it catches
   * exactly one thing: a corrupt or mis-generated file. That is a development
   * concern, so it defaults to `import.meta.env.DEV` — true under `vite dev`,
   * false in a production build — and to `true` wherever there is no
   * `import.meta.env` at all (Node, vitest, a plain bundler), so the safe
   * answer is the one you get by saying nothing.
   *
   * Turning it off does not make a bad index safe: Jolt reads the array
   * itself. It moves the check to the place that already has to do it.
   */
  readonly validate?: boolean;
}

/** Bytes before the first vertex. */
const HEADER_BYTES = 8;

/**
 * Whether index validation is on by default here.
 *
 * @returns True unless the bundler told us this is a production build.
 */
function validateByDefault(): boolean {
  // Read `import.meta.env` in place: a bundler or Vite's module runner replaces the expression,
  // and the runner refuses `import.meta` held in a variable ("dynamic access").
  return (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ?? true;
}

/**
 * A collider buffer that could not be read.
 *
 * The message always says what was expected and what was found, because the
 * only realistic way to hit it is to hand the parser the wrong file.
 */
export class ColliderFormatError extends Error {
  /**
   * Build a collider format error.
   *
   * @param message What is wrong with the buffer.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ColliderFormatError';
  }
}

/**
 * Narrow any binary input to an `ArrayBuffer` plus the offset to read from.
 *
 * `Float32Array` and `Uint32Array` views need a four-byte-aligned start, so a
 * view that does not sit on a four-byte boundary is copied first. That is rare
 * and cheap; the alternative is a per-element `DataView` read.
 *
 * @param source The bytes, as a buffer or any view over one.
 * @returns The buffer to read and the byte offset the header starts at.
 */
function alignedBuffer(source: ArrayBuffer | ArrayBufferView): {
  buffer: ArrayBuffer;
  offset: number;
} {
  if (source instanceof ArrayBuffer) return { buffer: source, offset: 0 };
  const { buffer, byteOffset, byteLength } = source;
  if (byteOffset % 4 === 0 && buffer instanceof ArrayBuffer) {
    return { buffer, offset: byteOffset };
  }
  const copy = new Uint8Array(byteLength);
  copy.set(new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength));
  return { buffer: copy.buffer, offset: 0 };
}

/**
 * Read an `arena.collider.bin` buffer.
 *
 * The header is always validated — counts and total length — so a mesh that
 * parses has the right number of bytes in it. The per-index range scan is the
 * one part that costs time proportional to the file, so it follows
 * {@link ParseColliderOptions.validate}.
 *
 * @param buffer The file contents, as an `ArrayBuffer` or any view over one.
 * @param options See {@link ParseColliderOptions}.
 * @returns The vertex positions and triangle indices, as views over `buffer`.
 * @throws {ColliderFormatError} When the buffer is truncated, the index count
 *   is not a multiple of three, or (when validating) an index is out of range.
 *
 * @example
 * ```ts
 * import { parseCollider, placeholderAssetUrl } from 'gameable/placeholder';
 *
 * const bytes = await (await fetch(placeholderAssetUrl('arena.collider.bin'))).arrayBuffer();
 * const { positions, indices } = parseCollider(bytes);
 * console.log(positions.length / 3, indices.length / 3); // 98 142
 * ```
 */
export function parseCollider(
  buffer: ArrayBuffer | ArrayBufferView,
  options: ParseColliderOptions = {},
): ColliderMesh {
  const { buffer: bytes, offset } = alignedBuffer(buffer);
  const available = bytes.byteLength - offset;
  if (available < HEADER_BYTES) {
    throw new ColliderFormatError(
      `collider is ${String(available)} bytes; the header alone needs ${String(HEADER_BYTES)}`,
    );
  }

  const view = new DataView(bytes, offset);
  const vertexCount = view.getUint32(0, true);
  const indexCount = view.getUint32(4, true);

  if (indexCount % 3 !== 0) {
    throw new ColliderFormatError(
      `indexCount is ${String(indexCount)}, which is not a whole number of triangles`,
    );
  }

  const expected = HEADER_BYTES + vertexCount * 12 + indexCount * 4;
  if (available !== expected) {
    throw new ColliderFormatError(
      `collider is ${String(available)} bytes; ${String(vertexCount)} vertices and ` +
        `${String(indexCount)} indices need exactly ${String(expected)}`,
    );
  }

  const positions = new Float32Array(bytes, offset + HEADER_BYTES, vertexCount * 3);
  const indices = new Uint32Array(bytes, offset + HEADER_BYTES + vertexCount * 12, indexCount);

  if (options.validate ?? validateByDefault()) {
    for (const index of indices) {
      if (index >= vertexCount) {
        throw new ColliderFormatError(
          `index ${String(index)} is out of range for ${String(vertexCount)} vertices`,
        );
      }
    }
  }

  return { positions, indices };
}

/**
 * Write an `arena.collider.bin` buffer.
 *
 * The exact inverse of {@link parseCollider}: `parseCollider(encodeCollider(p, i))`
 * returns `p` and `i` unchanged, up to `f32` rounding of the positions.
 *
 * @param positions Vertex positions in metres, flattened `x y z`.
 * @param indices Triangle indices into `positions`.
 * @returns The encoded file, ready to write to disk.
 * @throws {ColliderFormatError} When `positions` is not a whole number of
 *   vertices, `indices` is not a whole number of triangles, or an index is out
 *   of range.
 *
 * @example
 * ```ts
 * import { encodeCollider, parseCollider } from 'gameable/placeholder';
 *
 * // A single 1 m triangle on the floor.
 * const file = encodeCollider([0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 1, 2]);
 * console.log(file.byteLength); // 8 + 9 * 4 + 3 * 4 = 56
 * console.log(parseCollider(file).indices.length); // 3
 * ```
 */
export function encodeCollider(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): ArrayBuffer {
  if (positions.length % 3 !== 0) {
    throw new ColliderFormatError(
      `positions has ${String(positions.length)} values, which is not a whole number of vertices`,
    );
  }
  if (indices.length % 3 !== 0) {
    throw new ColliderFormatError(
      `indices has ${String(indices.length)} values, which is not a whole number of triangles`,
    );
  }

  const vertexCount = positions.length / 3;
  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i] ?? -1;
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
      throw new ColliderFormatError(
        `indices[${String(i)}] is ${String(index)}, out of range for ${String(
          vertexCount,
        )} vertices`,
      );
    }
  }

  const buffer = new ArrayBuffer(HEADER_BYTES + positions.length * 4 + indices.length * 4);
  const view = new DataView(buffer);
  view.setUint32(0, vertexCount, true);
  view.setUint32(4, indices.length, true);
  new Float32Array(buffer, HEADER_BYTES, positions.length).set(positions);
  new Uint32Array(buffer, HEADER_BYTES + positions.length * 4, indices.length).set(indices);
  return buffer;
}
