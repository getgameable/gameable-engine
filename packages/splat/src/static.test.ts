/**
 * Format sniffing and decoding, on files small enough to build in the test.
 *
 * Sniffing is not cosmetic: `.ksplat` has no magic number and `.splat` has no header at all,
 * so picking a decoder is a genuine decision with a wrong answer. These cases pin exactly how
 * much the sniffer is allowed to guess.
 */
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  createSplatObject,
  loadSplat,
  parseSplat,
  sniffSplatFormat,
  SplatLoadError,
} from './static.js';

/**
 * One row of a `.splat` file: centre, scale, rgba, quaternion bytes (w, x, y, z).
 *
 * @param x
 * @param y
 * @param z
 */
function splatRow(x: number, y: number, z: number): Uint8Array {
  const row = new Uint8Array(32);
  const view = new DataView(row.buffer);
  view.setFloat32(0, x, true);
  view.setFloat32(4, y, true);
  view.setFloat32(8, z, true);
  view.setFloat32(12, 0.02, true);
  view.setFloat32(16, 0.02, true);
  view.setFloat32(20, 0.02, true);
  row.set([200, 150, 100, 255], 24);
  row.set([255, 128, 128, 128], 28); // identity-ish rotation in the (v - 128) / 128 encoding
  return row;
}

/**
 * A gzipped SPZ v2, the exact inverse of `SPZLoader.parseRawSPZ`.
 *
 * @param count
 */
function spzFile(count: number): ArrayBuffer {
  const FRACTIONAL_BITS = 12;
  const header = new Uint8Array(16);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, 0x5053474e, true); // "NGSP"
  headerView.setUint32(4, 2, true); // version
  headerView.setUint32(8, count, true);
  header[12] = 0; // stored SH degree
  header[13] = FRACTIONAL_BITS;

  const positions = new Uint8Array(count * 9);
  const alphas = new Uint8Array(count).fill(220);
  const colors = new Uint8Array(count * 3).fill(140);
  const scales = new Uint8Array(count * 3).fill(Math.round((Math.log(0.02) + 10) * 16));
  const rotations = new Uint8Array(count * 3).fill(128);

  for (let i = 0; i < count; i += 1) {
    const value = Math.round(i * 0.25 * (1 << FRACTIONAL_BITS)) & 0xffffff;
    for (let axis = 0; axis < 3; axis += 1) {
      const o = i * 9 + axis * 3;
      positions[o] = value & 0xff;
      positions[o + 1] = (value >> 8) & 0xff;
      positions[o + 2] = (value >> 16) & 0xff;
    }
  }

  const raw = Buffer.concat(
    [header, positions, alphas, colors, scales, rotations].map(Buffer.from),
  );
  const gz = gzipSync(raw, { level: 6 });
  const out = new ArrayBuffer(gz.byteLength);
  new Uint8Array(out).set(gz);
  return out;
}

describe('sniffSplatFormat', () => {
  const empty = new Uint8Array(8);

  it('takes the extension when it knows it', () => {
    expect(sniffSplatFormat('/models/arena.spz', empty)).toBe('spz');
    expect(sniffSplatFormat('/models/arena.ply', empty)).toBe('ply');
    expect(sniffSplatFormat('/models/arena.splat', empty)).toBe('splat');
    expect(sniffSplatFormat('/models/arena.ksplat', empty)).toBe('ksplat');
  });

  it('is case insensitive and ignores query and hash', () => {
    expect(sniffSplatFormat('/a/B.SPZ', empty)).toBe('spz');
    expect(sniffSplatFormat('https://cdn/x/arena.spz?v=3&sig=abc', empty)).toBe('spz');
    expect(sniffSplatFormat('/arena.ply#frag', empty)).toBe('ply');
  });

  it('falls back to the gzip magic for an extensionless URL', () => {
    const gzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0]);
    expect(sniffSplatFormat('/api/asset/1234', gzip)).toBe('spz');
  });

  it('falls back to the SPZ v4 magic', () => {
    const ngsp = new Uint8Array([0x4e, 0x47, 0x53, 0x50, 4, 0, 0, 0]);
    expect(sniffSplatFormat('/api/asset/1234', ngsp)).toBe('spz');
  });

  it('falls back to the PLY ascii header', () => {
    expect(sniffSplatFormat('/api/asset/1', new TextEncoder().encode('ply\nformat'))).toBe('ply');
    expect(sniffSplatFormat('/api/asset/1', new TextEncoder().encode('ply\r\nform'))).toBe('ply');
  });

  it('refuses to guess between the two headerless formats', () => {
    // .splat and .ksplat are both "some bytes"; guessing would silently mis-decode.
    expect(() =>
      sniffSplatFormat('/api/asset/1', new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0])),
    ).toThrow(SplatLoadError);
    expect(() => sniffSplatFormat('/models/arena.bin', empty)).toThrow(/not one of spz, ply/);
    expect(() => sniffSplatFormat('/models/arena', empty)).toThrow(/extension is missing/);
  });
});

describe('parseSplat', () => {
  it('decodes a .splat by extension', async () => {
    const rows = [splatRow(0, 0, 0), splatRow(1, 2, 3)];
    const bytes = new Uint8Array(64);
    bytes.set(rows[0], 0);
    bytes.set(rows[1], 32);

    const asset = await parseSplat(bytes.buffer, '/models/tiny.splat');
    expect(asset.format).toBe('splat');
    expect(asset.count).toBe(2);
    expect(asset.shDegree).toBe(0);
    expect(asset.geometry.getAttribute('covariance').itemSize).toBe(6);
    expect(asset.boundingSphere.radius).toBeGreaterThan(0);
  });

  it('rejects a .splat whose length is not a whole number of rows', async () => {
    await expect(parseSplat(new ArrayBuffer(33), '/models/tiny.splat')).rejects.toThrow(
      /whole number of 32-byte rows/,
    );
  });

  it('decodes a gzipped SPZ', async () => {
    const asset = await parseSplat(spzFile(4), '/models/tiny.spz');
    expect(asset.format).toBe('spz');
    expect(asset.count).toBe(4);
    expect(asset.shDegree).toBe(0);
  });

  it('honours an explicit format over the extension', async () => {
    // Deliberately mislabelled: the caller knows better than the URL.
    const asset = await parseSplat(spzFile(2), '/api/asset/7.bin', 'spz');
    expect(asset.count).toBe(2);
  });

  it('wraps a decoder failure in a SplatLoadError naming the url', async () => {
    const garbage = new Uint8Array(32).fill(0xab);
    await expect(parseSplat(garbage.buffer, '/models/bad.spz')).rejects.toThrow(SplatLoadError);
    await expect(parseSplat(garbage.buffer, '/models/bad.spz')).rejects.toThrow(/bad\.spz/);
  });
});

describe('loadSplat', () => {
  it('fetches, then decodes', async () => {
    const buffer = spzFile(3);
    const seen: string[] = [];
    const asset = await loadSplat('/models/arena.spz', {
      fetch: (input) => {
        seen.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(new Response(buffer, { status: 200 }));
      },
    });
    expect(seen).toEqual(['/models/arena.spz']);
    expect(asset.count).toBe(3);
    expect(asset.url).toBe('/models/arena.spz');
  });

  it('reports a non-2xx response with its status', async () => {
    await expect(
      loadSplat('/models/missing.spz', {
        fetch: () => Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' })),
      }),
    ).rejects.toThrow(/fetch failed: 404 Not Found/);
  });

  it('passes the abort signal through to fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadSplat('/models/arena.spz', {
        signal: controller.signal,
        fetch: (_input, init) => {
          if (init?.signal?.aborted === true) return Promise.reject(new Error('aborted'));
          return Promise.resolve(new Response(spzFile(1)));
        },
      }),
    ).rejects.toThrow('aborted');
  });
});

it('opts into relighting through the normal factory and preserves the unlit default', async () => {
  const { AnimatedGaussianSplat } = await import('./three-fork/AnimatedGaussianSplat.js');
  const asset = await parseSplat(splatRow(0, 0, 0).buffer as ArrayBuffer, 'fixture.splat');
  const native = createSplatObject(asset);
  const lit = createSplatObject(asset, {
    environmentLighting: {
      radianceSH: Array.from({ length: 9 }, () => [0, 0, 0] as const),
      emissionWeight: 0.2,
    },
  });
  expect(native).toBeInstanceOf(AnimatedGaussianSplat); // sRGB by default: the fork
  expect(lit).toBeInstanceOf(AnimatedGaussianSplat);
  expect(lit.renderOrder).toBe(native.renderOrder);
  native.dispose();
  lit.dispose();
  asset.geometry.dispose();
});

it("draws a splat as sRGB by default, and as three's own GaussianSplat when told 'linear'", async () => {
  const { AnimatedGaussianSplat } = await import('./three-fork/AnimatedGaussianSplat.js');
  const plainAsset = await parseSplat(splatRow(0, 0, 0).buffer as ArrayBuffer, 'fixture.splat');
  const plain = createSplatObject(plainAsset, { colorSpace: 'linear' });
  expect(plain).not.toBeInstanceOf(AnimatedGaussianSplat);
  expect(plainAsset.geometry.userData.colorSpace).toBe('linear');
  const placeAsset = await parseSplat(splatRow(0, 0, 0).buffer as ArrayBuffer, 'place.splat');
  const place = createSplatObject(placeAsset);
  expect(place).toBeInstanceOf(AnimatedGaussianSplat);
  expect((place as InstanceType<typeof AnimatedGaussianSplat>).colorSpace).toBe('srgb');
  expect((place as { srgbOutput?: { value: number } | null }).srgbOutput?.value).toBe(0);
  expect(placeAsset.geometry.userData.colorSpace).toBe('srgb');
  plain.dispose();
  place.dispose();
  plainAsset.geometry.dispose();
  placeAsset.geometry.dispose();
});
