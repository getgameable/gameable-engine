// Author-time 2D opacity/occlusion map -> the UV-space OpacityMask grid the
// gaussian lift culls against. This is the
// MetaHuman "hide mesh under clothing" workflow adapted for splats: paint a
// grayscale map (white = keep, black = hide); the lift drops every Gaussian
// whose sampled mask value is below the cull threshold — fewer splats, never a
// per-Gaussian fade.
//
// Two layers, deliberately split so CI can test the contract without a DOM:
//   - imageDataToOpacityMask — PURE (RGBA8 bytes -> OpacityMask). Unit-tested.
//   - loadOpacityMaskImage   — browser loader (Image -> canvas readback ->
//     imageDataToOpacityMask). DOM-only; called at authoring time.
//
// Ported from aos-threejs-poc/src/ogs/inference/opacityMask.ts @ cdd63b10

import type { OpacityMask } from '../types.js';

/**
 * Which image channel supplies the mask value. 'luminance' (default) is the
 *  Rec.709 luma of RGB; 'a' reads alpha (for PNGs whose cutout lives in the
 *  alpha channel).
 */
export type MaskChannel = 'r' | 'g' | 'b' | 'a' | 'luminance';

/**
 * The shape this module reads: a browser `ImageData`, or any object with an
 *  RGBA8 row-major buffer (4 bytes/texel). `number[]` is allowed so tests can
 *  build fixtures without a typed array.
 */
export interface ImageDataLike {
  data: Uint8ClampedArray | Uint8Array | number[];
  width: number;
  height: number;
}

export interface MaskConvertOpts {
  /** Channel to sample. Default 'luminance'. */
  channel?: MaskChannel;
  /** Flip the meaning so white = hide. Default false (white = keep). */
  invert?: boolean;
}

// Byte offset of each single channel within an RGBA8 texel.
const CH_OFFSET: Record<string, number> = { r: 0, g: 1, b: 2, a: 3 };

/**
 * Convert RGBA8 image bytes (a browser `ImageData`, or any {data,width,height}
 * with a 4-bytes-per-texel row-major buffer) to an `OpacityMask` of normalized
 * floats in [0,1]. Row-major, top row first — the same layout the lift samples
 * (no V-flip; author the map to match the UV grid). Pure: no DOM, allocates
 * only the output grid.
 *
 * Throws on an undersized buffer rather than reading past the end — a malformed
 * mask is a loud failure, never a silently truncated cutout (CLAUDE.md UX rule).
 *
 * @param img The RGBA8 source bytes plus their width and height.
 * @param opts Which channel to sample and whether to invert; defaults to Rec.709 luminance
 *   with white meaning keep.
 * @returns The mask grid at the image's own width and height, values normalized to [0,1].
 */
export function imageDataToOpacityMask(
  img: ImageDataLike,
  opts: MaskConvertOpts = {},
): OpacityMask {
  const { data, width, height } = img;
  const channel = opts.channel ?? 'luminance';
  const invert = opts.invert ?? false;
  const n = width * height;
  if (width <= 0 || height <= 0) {
    throw new Error(`imageDataToOpacityMask: bad size ${String(width)}x${String(height)}`);
  }
  if (data.length < n * 4) {
    throw new Error(
      `imageDataToOpacityMask: expected RGBA8 (${String(n * 4)} bytes) for ${String(width)}x${String(height)}, got ${String(data.length)}`,
    );
  }
  const out = new Float32Array(n);
  if (channel === 'luminance') {
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      // Rec.709 luma. The coefficients sum to 1, so a gray ramp maps exactly to
      // value/255; for a colour map this keeps the cutout perceptually weighted.
      const lum = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
      out[i] = lum / 255;
    }
  } else {
    const off = CH_OFFSET[channel];
    for (let i = 0; i < n; i++) out[i] = data[i * 4 + off] / 255;
  }
  if (invert) for (let i = 0; i < n; i++) out[i] = 1 - out[i];
  return { data: out, width, height };
}

/**
 * Browser-only: load an image URL and convert it to an `OpacityMask` via an
 * offscreen-canvas readback. Rejects on load / CORS / zero-size error — never
 * resolves to a fake mask (CLAUDE.md: loud failure beats silent fakery). Called
 * at authoring time (mask edits are rare), so the canvas round-trip is free.
 *
 * @param url The image to load, fetched with `crossOrigin = "anonymous"`.
 * @param opts Channel and inversion options, passed through to {@link imageDataToOpacityMask}.
 * @returns A promise for the converted mask, at the image's natural width and height.
 */
export async function loadOpacityMaskImage(
  url: string,
  opts: MaskConvertOpts = {},
): Promise<OpacityMask> {
  if (typeof document === 'undefined') {
    throw new Error('loadOpacityMaskImage requires a DOM (browser-only)');
  }
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      resolve(im);
    };
    im.onerror = () => {
      reject(new Error(`opacity mask image failed to load: ${url}`));
    };
    im.src = url;
  });
  const w = image.naturalWidth,
    h = image.naturalHeight;
  if (!w || !h) throw new Error(`opacity mask image has zero size: ${url}`);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('opacity mask: 2D canvas context unavailable');
  ctx.drawImage(image, 0, 0);
  const id = ctx.getImageData(0, 0, w, h);
  return imageDataToOpacityMask(id, opts);
}
