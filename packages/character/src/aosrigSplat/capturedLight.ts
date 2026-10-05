/**
 * The light a character was captured under, read from its own package at load.
 *
 * A trained character's colours carry the light of its capture: the side facing the studio's
 * key is brighter. Each sampled gaussian gets an outward normal (its nearest rig-mesh vertex's,
 * both in the character's rest space), its linear luminance, its opacity as a weight, and a
 * group (its main joint and a colour class, so one garment is compared with itself). The fit
 * itself is `estimateKeyLightFromSurfels` in `gameable/splat`.
 */
import { parseGaussianPly, type AosrigSplatBundle } from './format.js';

/** The rig mesh at rest, in the character's space. */
export interface RigSurface {
  /** Vertex positions, three per vertex. */
  readonly positions: ArrayLike<number>;
  /** Unit vertex normals, three per vertex. */
  readonly normals: ArrayLike<number>;
}

/** One sample per gaussian visited, ready for `estimateKeyLightFromSurfels`. */
export interface CapturedLightSamples {
  /** Samples kept. */
  readonly count: number;
  /** Outward unit normals, three per sample. */
  readonly normals: Float32Array;
  /** Linear luminance per sample. */
  readonly luminance: Float32Array;
  /** Opacity per sample. */
  readonly weights: Float32Array;
  /** Main joint x 8 + colour class, per sample. */
  readonly groups: Uint16Array;
  /** Median distance from a sample to its nearest rig vertex, in metres: how well the two line up. */
  readonly medianGap: number;
}

/** Options for {@link capturedLightSamples}. */
export interface CapturedLightOptions {
  /** Gaussians visited, spread evenly over the package. Defaults to 12 000. */
  readonly maxSamples?: number;
  /** Gaussians fainter than this opacity are skipped. Defaults to 0.3. */
  readonly minOpacity?: number;
  /** Gaussians farther than this from any rig vertex are skipped, in metres. Defaults to 0.12. */
  readonly maxGap?: number;
}

const SH_C0 = 0.28209479177387814;
const CELL = 0.025;

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
 * A colour's class: 0 for greys and near-greys, 1 to 6 for the hue's sextant. Shading changes a
 * colour's brightness, not its hue, so a class holds one material under any light.
 *
 * @param r Linear red.
 * @param g Linear green.
 * @param b Linear blue.
 * @returns 0 to 6.
 */
function colourClass(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 0 || (max - min) / max < 0.2) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
  else if (max === g) hue = (b - r) / (max - min) + 2;
  else hue = (r - g) / (max - min) + 4;
  return 1 + Math.min(5, Math.floor(hue));
}

/** A dense grid of 2.5 cm cells over the rig's box, each cell's vertices stored together. */
interface VertexGrid {
  readonly min: readonly [number, number, number];
  readonly dims: readonly [number, number, number];
  /** Index into `order` where each cell's vertices start; one extra entry at the end. */
  readonly starts: Int32Array;
  /** Vertex numbers, cell by cell. */
  readonly order: Int32Array;
  /** Positions in `order`'s order, three per entry, so a cell's vertices are contiguous. */
  readonly sorted: Float32Array;
}

/**
 * Bucket the rig's vertices by 2.5 cm cell (a counting sort into a dense grid).
 *
 * @param rig The rig mesh at rest.
 * @returns The grid.
 */
function buildGrid(rig: RigSurface): VertexGrid {
  const count = Math.floor(rig.positions.length / 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < count; v += 1)
    for (let k = 0; k < 3; k += 1) {
      const value = rig.positions[v * 3 + k];
      if (value < min[k]) min[k] = value;
      if (value > max[k]) max[k] = value;
    }
  if (count === 0) {
    return {
      min: [0, 0, 0],
      dims: [1, 1, 1],
      starts: new Int32Array(2),
      order: new Int32Array(0),
      sorted: new Float32Array(0),
    };
  }
  const dims: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k += 1)
    dims[k] = Math.max(1, Math.min(512, Math.floor((max[k] - min[k]) / CELL) + 1));
  const cellOf = new Int32Array(count);
  const starts = new Int32Array(dims[0] * dims[1] * dims[2] + 1);
  for (let v = 0; v < count; v += 1) {
    const ix = Math.min(dims[0] - 1, Math.floor((rig.positions[v * 3] - min[0]) / CELL));
    const iy = Math.min(dims[1] - 1, Math.floor((rig.positions[v * 3 + 1] - min[1]) / CELL));
    const iz = Math.min(dims[2] - 1, Math.floor((rig.positions[v * 3 + 2] - min[2]) / CELL));
    const cell = (iz * dims[1] + iy) * dims[0] + ix;
    cellOf[v] = cell;
    starts[cell + 1] += 1;
  }
  for (let c = 1; c < starts.length; c += 1) starts[c] += starts[c - 1];
  const fill = starts.slice(0, -1);
  const order = new Int32Array(count);
  for (let v = 0; v < count; v += 1) order[fill[cellOf[v]]++] = v;
  const sorted = new Float32Array(count * 3);
  for (let at = 0; at < count; at += 1) {
    const v = order[at];
    sorted[at * 3] = rig.positions[v * 3];
    sorted[at * 3 + 1] = rig.positions[v * 3 + 1];
    sorted[at * 3 + 2] = rig.positions[v * 3 + 2];
  }
  return { min, dims, starts, order, sorted };
}

/**
 * The nearest rig vertex within `maxGap`, searching outward ring by ring.
 *
 * @param grid The grid.
 * @param x Query x.
 * @param y Query y.
 * @param z Query z.
 * @param maxGap Largest distance searched, metres.
 * @returns `[vertex, distance]`, or `[-1, Infinity]` when none is near enough.
 */
function nearestVertex(
  grid: VertexGrid,
  x: number,
  y: number,
  z: number,
  maxGap: number,
): [number, number] {
  const [nx, ny, nz] = grid.dims;
  const { starts, sorted } = grid;
  const cx = Math.floor((x - grid.min[0]) / CELL),
    cy = Math.floor((y - grid.min[1]) / CELL),
    cz = Math.floor((z - grid.min[2]) / CELL);
  let bestAt = -1;
  let bestSq = maxGap * maxGap;
  const rings = Math.ceil(maxGap / CELL);
  for (let r = 0; r <= rings; r += 1) {
    // Anything in ring r is at least (r - 1) cells away.
    const reach = Math.max(0, r - 1) * CELL;
    if (bestAt >= 0 && reach * reach > bestSq) break;
    for (let dz = -r; dz <= r; dz += 1) {
      const iz = cz + dz;
      if (iz < 0 || iz >= nz) continue;
      for (let dy = -r; dy <= r; dy += 1) {
        const iy = cy + dy;
        if (iy < 0 || iy >= ny) continue;
        const edge = Math.abs(dz) === r || Math.abs(dy) === r;
        for (let dx = -r; dx <= r; dx += edge ? 1 : 2 * r || 1) {
          const ix = cx + dx;
          if (ix < 0 || ix >= nx) continue;
          const cell = (iz * ny + iy) * nx + ix;
          const end = starts[cell + 1];
          for (let at = starts[cell]; at < end; at += 1) {
            const ex = sorted[at * 3] - x;
            const ey = sorted[at * 3 + 1] - y;
            const ez = sorted[at * 3 + 2] - z;
            const sq = ex * ex + ey * ey + ez * ez;
            if (sq < bestSq) {
              bestSq = sq;
              bestAt = at;
            }
          }
        }
      }
    }
  }
  return bestAt < 0 ? [-1, Infinity] : [grid.order[bestAt], Math.sqrt(bestSq)];
}

/**
 * Sample a character's package for the light it was captured under. Call it while the package's
 * bytes are still held (before the loader drops them); it reads the PLY and the bindings, keeps
 * nothing, and costs a few tens of milliseconds once.
 *
 * @param bundle The loaded package (its `character.ply` and `bindings.bin`).
 * @param rig The rig mesh at rest, in the character's space.
 * @param options How many gaussians to visit and which to skip.
 * @returns The samples.
 * @throws {Error} When the package's files are gone or malformed.
 */
export function capturedLightSamples(
  bundle: AosrigSplatBundle,
  rig: RigSurface,
  options: CapturedLightOptions = {},
): CapturedLightSamples {
  const d = bundle.descriptor;
  const plyBytes = bundle.files.get('character.ply');
  const bindingBytes = bundle.files.get('bindings.bin');
  if (!plyBytes || !bindingBytes) throw new Error('aosrig-splat: the package bytes are gone');
  const ply = parseGaussianPly(plyBytes, d.splatCount);
  if (bindingBytes.length !== 32 + d.splatCount * 112)
    throw new Error('aosrig-splat: invalid bindings size');
  const binding = new DataView(bindingBytes.buffer, bindingBytes.byteOffset, bindingBytes.length);
  const lane = (name: string): number => (ply.properties.get(name) ?? 0) * 4;
  const xAt = lane('x'),
    yAt = lane('y'),
    zAt = lane('z'),
    opacityAt = lane('opacity'),
    dc0 = lane('f_dc_0'),
    dc1 = lane('f_dc_1'),
    dc2 = lane('f_dc_2');
  const shift = [d.plyToCharacter[3], d.plyToCharacter[7], d.plyToCharacter[11]];
  const srgb = (d.colorSpace ?? 'srgb') === 'srgb';
  const minOpacity = options.minOpacity ?? 0.3;
  const maxGap = options.maxGap ?? 0.12;
  const stride = Math.max(1, Math.ceil(d.splatCount / (options.maxSamples ?? 12_000)));
  const capacity = Math.ceil(d.splatCount / stride);
  const normals = new Float32Array(capacity * 3);
  const luminance = new Float32Array(capacity);
  const weights = new Float32Array(capacity);
  const groups = new Uint16Array(capacity);
  const gaps: number[] = [];
  const grid = buildGrid(rig);
  let count = 0;
  for (let i = 0; i < d.splatCount; i += stride) {
    const o = i * ply.stride;
    const opacity = 1 / (1 + Math.exp(-ply.data.getFloat32(o + opacityAt, true)));
    if (!(opacity >= minOpacity)) continue;
    const x = ply.data.getFloat32(o + xAt, true) + shift[0];
    const y = ply.data.getFloat32(o + yAt, true) + shift[1];
    const z = ply.data.getFloat32(o + zAt, true) + shift[2];
    const [vertex, gap] = nearestVertex(grid, x, y, z, maxGap);
    if (vertex < 0) continue;
    let r = Math.min(1, Math.max(0, 0.5 + SH_C0 * ply.data.getFloat32(o + dc0, true)));
    let g = Math.min(1, Math.max(0, 0.5 + SH_C0 * ply.data.getFloat32(o + dc1, true)));
    let b = Math.min(1, Math.max(0, 0.5 + SH_C0 * ply.data.getFloat32(o + dc2, true)));
    if (srgb) {
      r = srgbToLinear(r);
      g = srgbToLinear(g);
      b = srgbToLinear(b);
    }
    // The main joint: the largest of the record's four skin weights.
    const record = 32 + i * 112;
    let joint = binding.getUint32(record, true);
    let heaviest = binding.getFloat32(record + 16, true);
    for (let k = 1; k < 4; k += 1) {
      const w = binding.getFloat32(record + 16 + k * 4, true);
      if (w > heaviest) {
        heaviest = w;
        joint = binding.getUint32(record + k * 4, true);
      }
    }
    normals[count * 3] = rig.normals[vertex * 3];
    normals[count * 3 + 1] = rig.normals[vertex * 3 + 1];
    normals[count * 3 + 2] = rig.normals[vertex * 3 + 2];
    luminance[count] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    weights[count] = opacity;
    groups[count] = Math.min(8191, joint) * 8 + colourClass(r, g, b);
    gaps.push(gap);
    count += 1;
  }
  gaps.sort((p, q) => p - q);
  return {
    count,
    normals: normals.subarray(0, count * 3),
    luminance: luminance.subarray(0, count),
    weights: weights.subarray(0, count),
    groups: groups.subarray(0, count),
    medianGap: gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : Infinity,
  };
}
