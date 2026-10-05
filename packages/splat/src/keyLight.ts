/**
 * Where a scene's key light comes from, worked out once at load with no light placed by anyone.
 *
 * Three routes, all pure functions over typed arrays (no GPU, no DOM, no allocation per frame):
 *
 * - **panorama**: a place's own 360° picture ({@link estimateKeyLightFromPanorama});
 * - **place gaussians**: the same estimate over a small panorama drawn from the place's own
 *   gaussians as seen from where the character stands ({@link panoramaFromGaussians}), which
 *   finds the place's bright gaussians (its lamps, windows, sky);
 * - **character**: the light baked into a character's own colours, fitted against its surface
 *   normals ({@link estimateKeyLightFromSurfels}).
 *
 * Directions are unit vectors pointing from the scene toward the light, y up. Azimuth is
 * measured around y from +z toward +x, so a character facing +z with the light at azimuth 0 is
 * lit from the front.
 */

/** A key light's direction and balance. */
export interface KeyLightEstimate {
  /** Unit vector from the scene toward the light, y up. */
  readonly direction: readonly [number, number, number];
  /** Degrees above the horizon. */
  readonly elevation: number;
  /** Degrees around y, from +z toward +x. */
  readonly azimuth: number;
  /** Light on a surface facing the key over light on a surface facing away from it. */
  readonly keyToFill: number;
  /**
   * How dark the key's shadow is, 0 to 1: the key's share of the light on a surface facing it,
   * `1 - 1 / keyToFill`, held at 0.9 or below.
   */
  readonly shadowStrength: number;
  /** 0 when there is no single key to find (flat light), 1 for a clear one. */
  readonly confidence: number;
}

/** An equirectangular picture in three's orientation: the top row looks up, `u = 0.5` looks along +x. */
export interface Panorama {
  /** Pixels across (360°). */
  readonly width: number;
  /** Pixels down (180°). */
  readonly height: number;
  /** Row-major from the top row, `channels` numbers per pixel. */
  readonly data: ArrayLike<number>;
  /** Numbers per pixel: 1 (luminance), 3 (RGB) or 4 (RGBA). Defaults to 4. */
  readonly channels?: 1 | 3 | 4;
  /** Multiplier that brings a stored number to 0..1 (1/255 for bytes). Defaults to 1. */
  readonly scale?: number;
  /** `'srgb'` decodes each number before any sum (a photograph); `'linear'` uses it as is. Defaults to `'linear'`. */
  readonly colorSpace?: 'linear' | 'srgb';
  /**
   * Degrees added to every azimuth read from the picture, for a picture whose middle column
   * does not look along +x (three's orientation). A World Labs place's own panorama looks along
   * -z in its middle column: pass 90, plus the place's own turn. Defaults to 0.
   */
  readonly yaw?: number;
}

/** Options for {@link estimateKeyLightFromPanorama}. */
export interface PanoramaKeyLightOptions {
  /** The key is searched no lower than this, in degrees above the horizon. Defaults to 0. */
  readonly minElevation?: number;
  /**
   * The key found is then lifted to at least this elevation, keeping its azimuth (a lamp at eye
   * height still throws a floor shadow a camera can see). Defaults to `minElevation`.
   */
  readonly holdAbove?: number;
  /** Half-width of the key's cone, in degrees, for the confidence. Defaults to 25. */
  readonly keyCone?: number;
  /**
   * How much brighter than white a clipped pixel is taken to be (an 8-bit picture stores a lamp
   * or the sun as white): values above 0.8 are raised by up to `1 + clipBoost` times, as the
   * studio's place-light reader does. Defaults to 24 for an sRGB picture, 0 for a linear one.
   */
  readonly clipBoost?: number;
}

/** The light a character's colours carry, one sample per gaussian. */
export interface SurfelSamples {
  /** Samples. */
  readonly count: number;
  /** Outward unit normals, three per sample. */
  readonly normals: ArrayLike<number>;
  /** Linear luminance per sample. */
  readonly luminance: ArrayLike<number>;
  /** Weight per sample (opacity). Defaults to 1. */
  readonly weights?: ArrayLike<number>;
  /**
   * Which patch of the same material each sample belongs to (a body part and a colour), so a
   * dark coat and a pale face are compared only with themselves. Defaults to one group.
   */
  readonly groups?: ArrayLike<number>;
}

/** Options for {@link estimateKeyLightFromSurfels}. */
export interface SurfelKeyLightOptions {
  /** Groups with fewer samples are ignored. Defaults to 24. */
  readonly minGroupSize?: number;
  /** Groups darker than this mean luminance are ignored (black carries no shading). Defaults to 0.01. */
  readonly minGroupLuminance?: number;
  /** The elevation is kept inside this range, in degrees. Defaults to [25, 70]. */
  readonly elevationRange?: readonly [number, number];
}

/** Gaussians of a place, for {@link panoramaFromGaussians}. */
export interface GaussianCloud {
  /** Centres, three per gaussian, in the cloud's own space. */
  readonly positions: ArrayLike<number>;
  /** RGBA per gaussian (alpha = opacity), multiplied by `colorScale` to reach 0..1. */
  readonly colors: ArrayLike<number>;
  /** Multiplier on `colors`. Defaults to 1/255. */
  readonly colorScale?: number;
  /** `'srgb'` decodes the colours before any sum. Defaults to `'srgb'` (a place trained on photographs). */
  readonly colorSpace?: 'linear' | 'srgb';
  /** Column-major 4x4 from the cloud's space to the world (three's `Matrix4.elements`). Defaults to identity. */
  readonly matrixWorld?: ArrayLike<number>;
}

/** Options for {@link panoramaFromGaussians}. */
export interface GaussianPanoramaOptions {
  /** Pixels across; the height is half. Defaults to 64. */
  readonly width?: number;
  /** Gaussians nearer than this to the probe are skipped (the character's own space). Defaults to 0.35 m. */
  readonly minDistance?: number;
  /** Gaussians fainter than this opacity are skipped. Defaults to 0.3. */
  readonly minOpacity?: number;
  /** Upper bound on gaussians visited; the rest are skipped evenly. Defaults to 600 000. */
  readonly maxSamples?: number;
}

const DEG = Math.PI / 180;

/** The light used when nothing can be read: above and to the front-right of a character facing +z. */
export const DEFAULT_KEY_LIGHT: KeyLightEstimate = fromAngles(-35, 50, 2, 0.5, 0);

/**
 * An estimate from a direction's two angles.
 *
 * @param azimuth Degrees around y from +z toward +x.
 * @param elevation Degrees above the horizon.
 * @param keyToFill Key over fill.
 * @param shadowStrength Shadow darkness, 0 to 1.
 * @param confidence 0 to 1.
 * @returns The estimate.
 */
function fromAngles(
  azimuth: number,
  elevation: number,
  keyToFill: number,
  shadowStrength: number,
  confidence: number,
): KeyLightEstimate {
  return {
    direction: directionFromAngles(azimuth, elevation),
    elevation,
    azimuth,
    keyToFill,
    shadowStrength,
    confidence,
  };
}

/**
 * A unit direction from azimuth and elevation.
 *
 * @param azimuth Degrees around y from +z toward +x.
 * @param elevation Degrees above the horizon.
 * @returns The unit vector, y up.
 */
export function directionFromAngles(azimuth: number, elevation: number): [number, number, number] {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/**
 * Azimuth and elevation of a direction.
 *
 * @param direction Any non-zero vector, y up.
 * @returns `[azimuth, elevation]` in degrees.
 */
export function anglesFromDirection(direction: ArrayLike<number>): [number, number] {
  const x = direction[0],
    y = direction[1],
    z = direction[2];
  const length = Math.hypot(x, y, z) || 1;
  return [Math.atan2(x, z) / DEG, Math.asin(Math.max(-1, Math.min(1, y / length))) / DEG];
}

/**
 * The same direction with its elevation held inside a range.
 *
 * @param direction Unit direction.
 * @param min Lowest elevation, degrees.
 * @param max Highest elevation, degrees.
 * @returns The adjusted unit direction.
 */
export function clampElevation(
  direction: ArrayLike<number>,
  min: number,
  max: number,
): [number, number, number] {
  const [azimuth, elevation] = anglesFromDirection(direction);
  // Straight up has no azimuth of its own: keep the one the vector had (atan2 of ~0 is still defined).
  return directionFromAngles(azimuth, Math.max(min, Math.min(max, elevation)));
}

/**
 * How dark a shadow of the key is: the key's share of the light on a surface facing it.
 *
 * @param keyToFill Key over fill, 1 or more.
 * @returns 0 to 0.9.
 */
export function strengthOf(keyToFill: number): number {
  if (!(keyToFill > 1)) return 0;
  return Math.min(0.9, 1 - 1 / keyToFill);
}

/**
 * sRGB transfer to linear.
 *
 * @param c 0..1.
 * @returns Linear 0..1.
 */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Rec. 709 luminance.
 *
 * @param r Linear red.
 * @param g Linear green.
 * @param b Linear blue.
 * @returns Luminance.
 */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A panorama reduced to per-pixel direction, solid angle and luminance. */
interface Sphere {
  readonly count: number;
  readonly dirs: Float32Array;
  readonly weights: Float32Array;
}

/**
 * Down-sample a panorama to at most 128 pixels across and return radiance x solid angle per pixel.
 *
 * @param panorama The picture.
 * @returns Directions and weights.
 */
function toSphere(panorama: Panorama, clipBoost: number): Sphere {
  const { width, height, data } = panorama;
  const channels = panorama.channels ?? 4;
  const scale = panorama.scale ?? 1;
  const srgb = panorama.colorSpace === 'srgb';
  const yaw = (panorama.yaw ?? 0) * DEG;
  if (!(width > 0 && height > 0) || data.length < width * height * channels)
    throw new RangeError('Panorama data is smaller than width x height x channels');
  const w = Math.min(width, 128);
  const h = Math.max(1, Math.min(height, Math.round(w / 2)));
  const sums = new Float64Array(w * h);
  const hits = new Float64Array(w * h);
  for (let row = 0; row < height; row += 1) {
    const r = Math.min(h - 1, Math.floor((row * h) / height));
    for (let col = 0; col < width; col += 1) {
      const c = Math.min(w - 1, Math.floor((col * w) / width));
      const at = (row * width + col) * channels;
      let value: number;
      let peak: number;
      if (channels === 1) {
        const v = data[at] * scale;
        peak = v;
        value = srgb ? srgbToLinear(v) : v;
      } else {
        let red = data[at] * scale,
          green = data[at + 1] * scale,
          blue = data[at + 2] * scale;
        peak = Math.max(red, green, blue);
        if (srgb) {
          red = srgbToLinear(red);
          green = srgbToLinear(green);
          blue = srgbToLinear(blue);
        }
        value = luminance(red, green, blue);
      }
      if (clipBoost > 0 && peak > 0.8) {
        const knee = Math.min(1, (peak - 0.8) / 0.2);
        value *= 1 + clipBoost * knee * knee;
      }
      sums[r * w + c] += Number.isFinite(value) ? Math.max(0, value) : 0;
      hits[r * w + c] += 1;
    }
  }
  const dirs = new Float32Array(w * h * 3);
  const weights = new Float32Array(w * h);
  const cell = ((2 * Math.PI) / w) * (Math.PI / h);
  for (let r = 0; r < h; r += 1) {
    const theta = (0.5 - (r + 0.5) / h) * Math.PI;
    const cosTheta = Math.cos(theta);
    const solid = cell * cosTheta;
    for (let c = 0; c < w; c += 1) {
      // three's orientation; `yaw` turns the picture's azimuths (azimuth = atan2(x, z)).
      const phi = ((c + 0.5) / w - 0.5) * 2 * Math.PI - yaw;
      const p = r * w + c;
      dirs[p * 3] = cosTheta * Math.cos(phi);
      dirs[p * 3 + 1] = Math.sin(theta);
      dirs[p * 3 + 2] = cosTheta * Math.sin(phi);
      weights[p] = hits[p] > 0 ? (sums[p] / hits[p]) * solid : 0;
    }
  }
  return { count: w * h, dirs, weights };
}

/**
 * Irradiance on a surface facing `n`, from a reduced panorama.
 *
 * @param sphere The reduced panorama.
 * @param nx Normal x.
 * @param ny Normal y.
 * @param nz Normal z.
 * @returns Irradiance (arbitrary units, comparable between normals).
 */
function irradiance(sphere: Sphere, nx: number, ny: number, nz: number): number {
  let sum = 0;
  const { dirs, weights } = sphere;
  for (let p = 0; p < sphere.count; p += 1) {
    const d = dirs[p * 3] * nx + dirs[p * 3 + 1] * ny + dirs[p * 3 + 2] * nz;
    if (d > 0) sum += weights[p] * d;
  }
  return sum;
}

/**
 * Find the key light in a 360° picture: the brightest compact region above the horizon.
 *
 * The picture is reduced to at most 128 x 64, every direction above `minElevation` is scored
 * by the light inside a narrow lobe around it (a 12° half-width), and the best is refined to
 * the centroid of the light near it. The balance follows from irradiance: `keyToFill` compares
 * a surface facing the key with one facing away, and `shadowStrength` is the key's share of
 * the light on the surface facing it, the share its shadow takes away. An 8-bit picture clips
 * a sun at white, so its key reads weaker than it was and the shadow comes out lighter.
 *
 * @param panorama The picture, three's equirectangular orientation.
 * @param options Search limits.
 * @returns The key light; `confidence` near 0 for an evenly lit (overcast) picture.
 */
export function estimateKeyLightFromPanorama(
  panorama: Panorama,
  options: PanoramaKeyLightOptions = {},
): KeyLightEstimate {
  const sphere = toSphere(panorama, options.clipBoost ?? (panorama.colorSpace === 'srgb' ? 24 : 0));
  const minElevation = options.minElevation ?? 0;
  const holdAbove = Math.max(minElevation, options.holdAbove ?? minElevation);
  const cone = Math.cos((options.keyCone ?? 25) * DEG);
  const { dirs, weights } = sphere;
  let total = 0;
  for (let p = 0; p < sphere.count; p += 1) total += weights[p];
  if (!(total > 0)) return DEFAULT_KEY_LIGHT;

  // Coarse search: every 2nd pixel direction as a candidate, scored by a cos^32 lobe.
  const minY = Math.sin(minElevation * DEG);
  let best = -1;
  let bestScore = -1;
  for (let q = 0; q < sphere.count; q += 2) {
    const cx = dirs[q * 3],
      cy = dirs[q * 3 + 1],
      cz = dirs[q * 3 + 2];
    if (cy < minY) continue;
    let score = 0;
    for (let p = 0; p < sphere.count; p += 1) {
      const wp = weights[p];
      if (wp === 0) continue;
      const d = dirs[p * 3] * cx + dirs[p * 3 + 1] * cy + dirs[p * 3 + 2] * cz;
      if (d <= 0.9) continue; // cos^32 is below 0.035 outside ~25°
      let lobe = d * d; // d^2
      lobe *= lobe; // d^4
      lobe *= lobe; // d^8
      lobe *= lobe; // d^16
      lobe *= lobe; // d^32
      score += wp * lobe;
    }
    if (score > bestScore) {
      bestScore = score;
      best = q;
    }
  }
  if (best < 0) return DEFAULT_KEY_LIGHT;

  // Refine: the light-weighted centroid of the directions within 15° of the best candidate.
  let kx = 0,
    ky = 0,
    kz = 0;
  const bx = dirs[best * 3],
    by = dirs[best * 3 + 1],
    bz = dirs[best * 3 + 2];
  const near = Math.cos(15 * DEG);
  for (let p = 0; p < sphere.count; p += 1) {
    const d = dirs[p * 3] * bx + dirs[p * 3 + 1] * by + dirs[p * 3 + 2] * bz;
    if (d < near) continue;
    const w = weights[p] * (d - near);
    kx += dirs[p * 3] * w;
    ky += dirs[p * 3 + 1] * w;
    kz += dirs[p * 3 + 2] * w;
  }
  let length = Math.hypot(kx, ky, kz);
  if (!(length > 0)) {
    kx = bx;
    ky = by;
    kz = bz;
    length = 1;
  }
  const found = clampElevation([kx / length, ky / length, kz / length], minElevation, 90);
  const key = clampElevation(found, holdAbove, 90);

  // The balance is read at the light as found, before any lift.
  const facing = irradiance(sphere, found[0], found[1], found[2]);
  const away = irradiance(sphere, -found[0], -found[1], -found[2]);
  let lobeLight = 0;
  let lobeSolid = 0;
  let upperLight = 0;
  let upperSolid = 0;
  for (let p = 0; p < sphere.count; p += 1) {
    const y = dirs[p * 3 + 1];
    const cosTheta = Math.sqrt(Math.max(0, 1 - y * y));
    const d = dirs[p * 3] * found[0] + y * found[1] + dirs[p * 3 + 2] * found[2];
    if (y > 0) {
      upperLight += weights[p];
      upperSolid += cosTheta;
    }
    if (d > cone) {
      lobeLight += weights[p];
      lobeSolid += cosTheta;
    }
  }
  const lobeMean = lobeSolid > 0 ? lobeLight / lobeSolid : 0;
  const upperMean = upperSolid > 0 ? upperLight / upperSolid : 0;
  const contrast = upperMean > 0 ? lobeMean / upperMean : 1;
  const [azimuth, elevation] = anglesFromDirection(key);
  const keyToFill = facing / Math.max(away, facing * 1e-3, 1e-12);
  return {
    direction: key,
    elevation,
    azimuth,
    keyToFill,
    shadowStrength: strengthOf(keyToFill),
    confidence: Math.max(0, Math.min(1, (contrast - 1.15) / 2)),
  };
}

/**
 * Draw a small panorama of a place's gaussians as seen from one point: each pixel takes the
 * colour of the nearest surface in its direction (the front layer of gaussians), so a lamp
 * behind a wall is not seen and a window beside the character is. Feed the result to
 * {@link estimateKeyLightFromPanorama}: the light the place gives at that point.
 *
 * @param cloud The place's gaussians.
 * @param at The probe point in world space (a character's chest height is a good one).
 * @param options Size and filters.
 * @returns A linear RGB panorama, `width` x `width / 2`.
 */
export function panoramaFromGaussians(
  cloud: GaussianCloud,
  at: ArrayLike<number>,
  options: GaussianPanoramaOptions = {},
): Panorama & { readonly data: Float32Array; readonly covered: number } {
  const width = Math.max(8, Math.round(options.width ?? 64));
  const height = Math.max(4, Math.round(width / 2));
  const minDistance = options.minDistance ?? 0.35;
  const minOpacity = options.minOpacity ?? 0.3;
  const colorScale = cloud.colorScale ?? 1 / 255;
  const srgb = (cloud.colorSpace ?? 'srgb') === 'srgb';
  const count = Math.floor(cloud.positions.length / 3);
  const stride = Math.max(1, Math.ceil(count / (options.maxSamples ?? 600_000)));
  const m = cloud.matrixWorld;
  const px = at[0],
    py = at[1],
    pz = at[2];
  const nearest = new Float32Array(width * height).fill(Infinity);
  const pixelOf = new Int32Array(Math.ceil(count / stride)).fill(-1);
  const depthOf = new Float32Array(pixelOf.length);

  // Pass 1: the nearest surface per pixel.
  for (let i = 0, k = 0; i < count; i += stride, k += 1) {
    const opacity = cloud.colors[i * 4 + 3] * colorScale;
    if (!(opacity >= minOpacity)) continue;
    let x = cloud.positions[i * 3],
      y = cloud.positions[i * 3 + 1],
      z = cloud.positions[i * 3 + 2];
    if (m) {
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      x = wx;
      y = wy;
      z = wz;
    }
    x -= px;
    y -= py;
    z -= pz;
    const distance = Math.hypot(x, y, z);
    if (!(distance >= minDistance)) continue;
    const u = Math.atan2(z, x) / (2 * Math.PI) + 0.5;
    const v = Math.asin(Math.max(-1, Math.min(1, y / distance))) / Math.PI + 0.5;
    const col = Math.min(width - 1, Math.floor(u * width));
    const row = Math.min(height - 1, Math.floor((1 - v) * height));
    const pixel = row * width + col;
    pixelOf[k] = pixel;
    depthOf[k] = distance;
    if (distance < nearest[pixel]) nearest[pixel] = distance;
  }

  // Pass 2: average the colours of the front layer (within 12 % + 5 cm of the nearest).
  const sums = new Float64Array(width * height * 3);
  const weight = new Float64Array(width * height);
  for (let i = 0, k = 0; i < count; i += stride, k += 1) {
    const pixel = pixelOf[k];
    if (pixel < 0) continue;
    if (depthOf[k] > nearest[pixel] * 1.12 + 0.05) continue;
    const opacity = cloud.colors[i * 4 + 3] * colorScale;
    let r = cloud.colors[i * 4] * colorScale,
      g = cloud.colors[i * 4 + 1] * colorScale,
      b = cloud.colors[i * 4 + 2] * colorScale;
    if (srgb) {
      r = srgbToLinear(Math.min(1, Math.max(0, r)));
      g = srgbToLinear(Math.min(1, Math.max(0, g)));
      b = srgbToLinear(Math.min(1, Math.max(0, b)));
    }
    sums[pixel * 3] += r * opacity;
    sums[pixel * 3 + 1] += g * opacity;
    sums[pixel * 3 + 2] += b * opacity;
    weight[pixel] += opacity;
  }
  const data = new Float32Array(width * height * 3);
  let covered = 0;
  for (let p = 0; p < width * height; p += 1) {
    if (weight[p] <= 0) continue;
    covered += 1;
    data[p * 3] = sums[p * 3] / weight[p];
    data[p * 3 + 1] = sums[p * 3 + 1] / weight[p];
    data[p * 3 + 2] = sums[p * 3 + 2] / weight[p];
  }
  fillHoles(data, weight, width, height);
  return {
    width,
    height,
    data,
    channels: 3,
    colorSpace: 'linear',
    covered: covered / (width * height),
  };
}

/**
 * Give every empty pixel the colour of its nearest filled neighbour along its row (the rows by
 * the poles are thin slivers that few gaussians land in); a row with nothing takes the nearest
 * filled row.
 *
 * @param data RGB per pixel, rewritten in place.
 * @param weight Coverage per pixel; 0 is empty.
 * @param width Pixels across.
 * @param height Pixels down.
 * @returns Nothing.
 */
function fillHoles(data: Float32Array, weight: Float64Array, width: number, height: number): void {
  const rowFilled = new Uint8Array(height);
  for (let row = 0; row < height; row += 1) {
    let any = -1;
    for (let col = 0; col < width; col += 1) if (weight[row * width + col] > 0) any = col;
    if (any < 0) continue;
    rowFilled[row] = 1;
    // Two sweeps around the ring carry the last filled colour into the gaps.
    let last = any;
    for (let step = 1; step <= width * 2; step += 1) {
      const col = (any + step) % width;
      const p = row * width + col;
      if (weight[p] > 0) {
        last = col;
        continue;
      }
      const from = (row * width + last) * 3;
      if (step > width || data[p * 3] + data[p * 3 + 1] + data[p * 3 + 2] === 0) {
        data[p * 3] = data[from];
        data[p * 3 + 1] = data[from + 1];
        data[p * 3 + 2] = data[from + 2];
      }
    }
  }
  for (let row = 0; row < height; row += 1) {
    if (rowFilled[row]) continue;
    let source = -1;
    for (let d = 1; d < height && source < 0; d += 1) {
      if (row - d >= 0 && rowFilled[row - d]) source = row - d;
      else if (row + d < height && rowFilled[row + d]) source = row + d;
    }
    if (source < 0) return;
    data.copyWithin(row * width * 3, source * width * 3, (source + 1) * width * 3);
  }
}

/**
 * Solve a symmetric 3x3 system by Cramer's rule.
 *
 * @param a Row-major 3x3.
 * @param b Right-hand side.
 * @returns The solution, or null when the matrix is singular.
 */
function solve3(a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number] | null {
  const det =
    a[0] * (a[4] * a[8] - a[5] * a[7]) -
    a[1] * (a[3] * a[8] - a[5] * a[6]) +
    a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (!(Math.abs(det) > 1e-18)) return null;
  const x =
    (b[0] * (a[4] * a[8] - a[5] * a[7]) -
      a[1] * (b[1] * a[8] - a[5] * b[2]) +
      a[2] * (b[1] * a[7] - a[4] * b[2])) /
    det;
  const y =
    (a[0] * (b[1] * a[8] - a[5] * b[2]) -
      b[0] * (a[3] * a[8] - a[5] * a[6]) +
      a[2] * (a[3] * b[2] - b[1] * a[6])) /
    det;
  const z =
    (a[0] * (a[4] * b[2] - b[1] * a[7]) -
      a[1] * (a[3] * b[2] - b[1] * a[6]) +
      b[0] * (a[3] * a[7] - a[4] * a[6])) /
    det;
  return [x, y, z];
}

/**
 * Find the light a character was captured under from its own colours.
 *
 * The capture-lighting idea (brightness against surface normal) with one change that matters
 * for a clothed person: within each group of samples of one material (one body part, one
 * colour), brightness relative to the group's mean is fitted against the normal's offset from
 * the group's mean normal, `L / mean(L) - 1 = d . (n - mean(n))`, so a dark coat on the back
 * and a pale face on the front do not read as light from the front. The fitted `d` points at
 * the key; its length is the key's strength against the ambient light.
 *
 * @param samples One sample per gaussian: outward normal, luminance, weight and group.
 * @param options Group filters and the elevation range.
 * @returns The key light in the samples' own space; `confidence` near 0 when the colours carry no shading.
 */
export function estimateKeyLightFromSurfels(
  samples: SurfelSamples,
  options: SurfelKeyLightOptions = {},
): KeyLightEstimate & {
  readonly fitStrength: number;
  readonly groupsUsed: number;
  readonly fitDirection: readonly [number, number, number];
} {
  const minGroupSize = options.minGroupSize ?? 24;
  const minGroupLuminance = options.minGroupLuminance ?? 0.01;
  const [minElevation, maxElevation] = options.elevationRange ?? [25, 70];
  const { count, normals, luminance: lum } = samples;
  const w = samples.weights;
  const g = samples.groups;

  // Per-group sums: weight, weight x luminance, weight x normal.
  const groupIndex = new Map<number, number>();
  const stats: number[] = [];
  const slotOf = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    const key = g ? g[i] : 0;
    let slot = groupIndex.get(key);
    if (slot === undefined) {
      slot = groupIndex.size;
      groupIndex.set(key, slot);
      stats.push(0, 0, 0, 0, 0, 0);
    }
    slotOf[i] = slot;
    const wi = w ? w[i] : 1;
    if (!(wi > 0) || !Number.isFinite(lum[i])) continue;
    const s = slot * 6;
    stats[s] += wi;
    stats[s + 1] += wi * lum[i];
    stats[s + 2] += wi * normals[i * 3];
    stats[s + 3] += wi * normals[i * 3 + 1];
    stats[s + 4] += wi * normals[i * 3 + 2];
    stats[s + 5] += 1;
  }

  // Normal equations for d over every usable group.
  const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b = [0, 0, 0];
  let groupsUsed = 0;
  const usable = new Uint8Array(groupIndex.size);
  for (let slot = 0; slot < groupIndex.size; slot += 1) {
    const s = slot * 6;
    if (stats[s + 5] < minGroupSize || !(stats[s] > 0)) continue;
    if (stats[s + 1] / stats[s] < minGroupLuminance) continue;
    usable[slot] = 1;
    groupsUsed += 1;
  }
  let yy = 0;
  for (let i = 0; i < count; i += 1) {
    const slot = slotOf[i];
    if (usable[slot] === 0) continue;
    const wi = w ? w[i] : 1;
    if (!(wi > 0) || !Number.isFinite(lum[i])) continue;
    const s = slot * 6;
    const mean = stats[s + 1] / stats[s];
    const y = lum[i] / mean - 1;
    const x0 = normals[i * 3] - stats[s + 2] / stats[s];
    const x1 = normals[i * 3 + 1] - stats[s + 3] / stats[s];
    const x2 = normals[i * 3 + 2] - stats[s + 4] / stats[s];
    a[0] += wi * x0 * x0;
    a[1] += wi * x0 * x1;
    a[2] += wi * x0 * x2;
    a[4] += wi * x1 * x1;
    a[5] += wi * x1 * x2;
    a[8] += wi * x2 * x2;
    b[0] += wi * y * x0;
    b[1] += wi * y * x1;
    b[2] += wi * y * x2;
    yy += wi * y * y;
  }
  a[3] = a[1];
  a[6] = a[2];
  a[7] = a[5];
  // A little ridge keeps a group whose normals all agree from blowing the fit up.
  const ridge = 1e-6 * (a[0] + a[4] + a[8] + 1e-12);
  a[0] += ridge;
  a[4] += ridge;
  a[8] += ridge;
  const d = groupsUsed > 0 ? solve3(a, b) : null;
  const k = d ? Math.hypot(d[0], d[1], d[2]) : 0;
  if (!d || !(k > 1e-4))
    return {
      ...DEFAULT_KEY_LIGHT,
      fitStrength: 0,
      groupsUsed,
      fitDirection: DEFAULT_KEY_LIGHT.direction,
    };

  const explained = d[0] * b[0] + d[1] * b[1] + d[2] * b[2];
  const r2 = yy > 0 ? Math.max(0, Math.min(1, explained / yy)) : 0;
  const direction = clampElevation([d[0] / k, d[1] / k, d[2] / k], minElevation, maxElevation);
  const [azimuth, elevation] = anglesFromDirection(direction);
  // E(n) = m (1 + d . n): a surface facing the key gets m (1 + k), one facing away m (1 - k).
  const kc = Math.min(k, 0.95);
  const keyToFill = (1 + kc) / Math.max(1 - kc, 0.05);
  return {
    direction,
    elevation,
    azimuth,
    keyToFill,
    shadowStrength: strengthOf(keyToFill),
    // A clear key moves brightness by a fifth or more and explains a real share of it.
    confidence: Math.max(0, Math.min(1, (k / 0.2) * Math.min(1, r2 / 0.08))),
    fitStrength: k,
    groupsUsed,
    fitDirection: [d[0] / k, d[1] / k, d[2] / k],
  };
}
