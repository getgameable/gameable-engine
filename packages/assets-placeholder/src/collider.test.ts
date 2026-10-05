import { describe, expect, it } from 'vitest';

import { ColliderFormatError, encodeCollider, parseCollider } from './collider.js';

/** A unit tetrahedron: four vertices, four triangles. */
const POSITIONS = [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0];
const INDICES = [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];

describe('encodeCollider / parseCollider', () => {
  it('round-trips positions and indices', () => {
    const mesh = parseCollider(encodeCollider(POSITIONS, INDICES));
    expect([...mesh.positions]).toEqual(POSITIONS);
    expect([...mesh.indices]).toEqual(INDICES);
  });

  it('writes exactly 8 + 12n + 4m bytes', () => {
    const file = encodeCollider(POSITIONS, INDICES);
    expect(file.byteLength).toBe(8 + (POSITIONS.length / 3) * 12 + INDICES.length * 4);
  });

  it('writes the counts as little-endian u32s', () => {
    const view = new DataView(encodeCollider(POSITIONS, INDICES));
    expect(view.getUint32(0, true)).toBe(POSITIONS.length / 3);
    expect(view.getUint32(4, true)).toBe(INDICES.length);
  });

  it('accepts typed arrays as well as plain ones', () => {
    const file = encodeCollider(new Float32Array(POSITIONS), new Uint32Array(INDICES));
    expect([...parseCollider(file).indices]).toEqual(INDICES);
  });

  it('round-trips through a misaligned view', () => {
    const file = encodeCollider(POSITIONS, INDICES);
    // Copy the file to byte offset 1 of a larger buffer: the parser must not
    // try to build a Float32Array on an odd boundary.
    const padded = new Uint8Array(file.byteLength + 1);
    padded.set(new Uint8Array(file), 1);
    const mesh = parseCollider(padded.subarray(1));
    expect([...mesh.positions]).toEqual(POSITIONS);
    expect([...mesh.indices]).toEqual(INDICES);
  });

  it('rejects a truncated buffer', () => {
    const file = encodeCollider(POSITIONS, INDICES);
    expect(() => parseCollider(file.slice(0, 4))).toThrow(ColliderFormatError);
    expect(() => parseCollider(file.slice(0, file.byteLength - 4))).toThrow(/need exactly/);
  });

  it('rejects a partial triangle', () => {
    expect(() => encodeCollider(POSITIONS, [0, 1])).toThrow(/whole number of triangles/);
  });

  it('rejects a partial vertex', () => {
    expect(() => encodeCollider([0, 0], [])).toThrow(/whole number of vertices/);
  });

  it('rejects an out-of-range index', () => {
    expect(() => encodeCollider(POSITIONS, [0, 1, 9])).toThrow(/out of range/);
  });

  it('rejects an out-of-range index found while parsing', () => {
    const file = encodeCollider(POSITIONS, INDICES);
    // Corrupt the last index in place.
    new DataView(file).setUint32(file.byteLength - 4, 99, true);
    expect(() => parseCollider(file)).toThrow(/out of range/);
    expect(() => parseCollider(file, { validate: true })).toThrow(/out of range/);
  });

  it('skips the index scan when asked to, but still checks the header', () => {
    const file = encodeCollider(POSITIONS, INDICES);
    new DataView(file).setUint32(file.byteLength - 4, 99, true);

    // The scan is the only part `validate` controls: the mesh still parses,
    // with the bad index handed straight through to whoever asked for it.
    const mesh = parseCollider(file, { validate: false });
    expect(mesh.indices[mesh.indices.length - 1]).toBe(99);

    // The length check is not optional; a truncated file fails either way.
    expect(() => parseCollider(file.slice(0, 4), { validate: false })).toThrow(ColliderFormatError);
  });

  it('round-trips an empty mesh', () => {
    const mesh = parseCollider(encodeCollider([], []));
    expect(mesh.positions.length).toBe(0);
    expect(mesh.indices.length).toBe(0);
  });
});
