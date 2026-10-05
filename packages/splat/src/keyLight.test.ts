import { describe, expect, it } from 'vitest';

import {
  anglesFromDirection,
  clampElevation,
  DEFAULT_KEY_LIGHT,
  directionFromAngles,
  estimateKeyLightFromPanorama,
  estimateKeyLightFromSurfels,
  panoramaFromGaussians,
} from './keyLight';

const DEG = Math.PI / 180;

/** Degrees between two unit vectors. */
function angleBetween(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  return Math.acos(Math.max(-1, Math.min(1, d / (la * lb)))) / DEG;
}

/**
 * A panorama in three's equirectangular orientation, written independently of the code under
 * test: u = atan2(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5, the top row is v = 1.
 */
function panorama(
  width: number,
  radiance: (dir: [number, number, number]) => number,
): { width: number; height: number; data: Float32Array; channels: 1 } {
  const height = width / 2;
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const v = 1 - (row + 0.5) / height;
    const y = Math.sin((v - 0.5) * Math.PI);
    const r = Math.sqrt(1 - y * y);
    for (let col = 0; col < width; col += 1) {
      const u = (col + 0.5) / width;
      const phi = (u - 0.5) * 2 * Math.PI;
      data[row * width + col] = radiance([r * Math.cos(phi), y, r * Math.sin(phi)]);
    }
  }
  return { width, height, data, channels: 1 };
}

describe('directions', () => {
  it('round-trips azimuth and elevation, azimuth from +z toward +x', () => {
    expect(directionFromAngles(0, 0)[2]).toBeCloseTo(1);
    expect(directionFromAngles(90, 0)[0]).toBeCloseTo(1);
    expect(directionFromAngles(0, 90)[1]).toBeCloseTo(1);
    const [az, el] = anglesFromDirection(directionFromAngles(-120, 33));
    expect(az).toBeCloseTo(-120, 6);
    expect(el).toBeCloseTo(33, 6);
  });

  it('holds the elevation inside a range and keeps the azimuth', () => {
    const low = clampElevation(directionFromAngles(40, 5), 25, 70);
    const [az, el] = anglesFromDirection(low);
    expect(el).toBeCloseTo(25, 6);
    expect(az).toBeCloseTo(40, 6);
  });
});

describe('estimateKeyLightFromPanorama', () => {
  const sun = directionFromAngles(40, 35);
  const sunny = panorama(256, (dir) => {
    if (angleBetween(dir, sun) < 3) return 60;
    return dir[1] > 0 ? 0.35 : 0.12;
  });

  it('finds a small bright sun to within three degrees', () => {
    const key = estimateKeyLightFromPanorama(sunny);
    expect(angleBetween(key.direction, sun)).toBeLessThan(3);
    expect(key.azimuth).toBeCloseTo(40, -1);
    expect(key.keyToFill).toBeGreaterThan(2);
    expect(key.shadowStrength).toBeGreaterThan(0.3);
    expect(key.shadowStrength).toBeLessThan(0.95);
    expect(key.confidence).toBeGreaterThan(0.5);
  });

  it('finds a big window in a dim room to within six degrees', () => {
    const windowCentre = directionFromAngles(-60, 20);
    const room = panorama(192, (dir) => {
      const [az, el] = anglesFromDirection(dir);
      const inWindow = Math.abs(az + 60) < 15 && Math.abs(el - 20) < 15;
      return inWindow ? 4 : 0.2;
    });
    const key = estimateKeyLightFromPanorama(room);
    expect(angleBetween(key.direction, windowCentre)).toBeLessThan(6);
    expect(key.confidence).toBeGreaterThan(0.5);
  });

  it('reports low confidence for an overcast sky', () => {
    const key = estimateKeyLightFromPanorama(panorama(128, (dir) => (dir[1] > 0 ? 1 : 0.3)));
    expect(key.confidence).toBeLessThan(0.2);
  });

  it('reads 8-bit sRGB RGBA pictures', () => {
    const width = 128;
    const height = 64;
    const data = new Uint8ClampedArray(width * height * 4);
    const light = sunny.data;
    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        // Sample the 256-wide sunny picture at half resolution, then encode to sRGB bytes.
        const v = Math.min(1, light[row * 2 * 256 + col * 2] / 60);
        const encoded = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        const at = (row * width + col) * 4;
        data[at] = data[at + 1] = data[at + 2] = Math.round(encoded * 255);
        data[at + 3] = 255;
      }
    }
    const key = estimateKeyLightFromPanorama({
      width,
      height,
      data,
      channels: 4,
      scale: 1 / 255,
      colorSpace: 'srgb',
    });
    expect(angleBetween(key.direction, sun)).toBeLessThan(4);
  });

  it('never looks below the horizon for the key', () => {
    const bright = panorama(128, (dir) => (dir[1] < -0.5 ? 10 : 0.2));
    expect(estimateKeyLightFromPanorama(bright).elevation).toBeGreaterThanOrEqual(-1e-6);
  });

  it('lifts a lamp at eye height to a shadow-casting elevation and keeps its azimuth', () => {
    const lamp = directionFromAngles(-120, 3);
    const room = panorama(256, (dir) => (angleBetween(dir, lamp) < 4 ? 30 : 0.25));
    const key = estimateKeyLightFromPanorama(room, { minElevation: 0, holdAbove: 20 });
    expect(key.elevation).toBeCloseTo(20, 6);
    expect(Math.abs(key.azimuth + 120)).toBeLessThan(3);
    expect(key.keyToFill).toBeGreaterThan(1);
  });

  it('rejects data smaller than its size', () => {
    expect(() =>
      estimateKeyLightFromPanorama({ width: 10, height: 5, data: [1, 2, 3], channels: 1 }),
    ).toThrow(RangeError);
  });

  it('falls back to the default light for a black picture', () => {
    const key = estimateKeyLightFromPanorama(panorama(64, () => 0));
    expect(key).toEqual(DEFAULT_KEY_LIGHT);
  });
});

describe('panoramaFromGaussians', () => {
  /** A 6 x 3 x 6 m room of grey gaussians around the origin (floor at y = 0), one bright ceiling lamp. */
  function room(extraBehindWall: boolean): { positions: number[]; colors: number[] } {
    const positions: number[] = [];
    const colors: number[] = [];
    const add = (x: number, y: number, z: number, value: number): void => {
      positions.push(x, y, z);
      colors.push(value, value, value, 255);
    };
    const step = 0.1;
    for (let a = -3; a <= 3; a += step) {
      for (let b = -3; b <= 3; b += step) {
        add(a, 0, b, 90); // floor
        const lamp = Math.abs(a - 1.5) < 0.5 && Math.abs(b + 1) < 0.5;
        add(a, 3, b, lamp ? 255 : 110); // ceiling
      }
      for (let h = 0; h <= 3; h += step) {
        add(a, h, -3, 100);
        add(a, h, 3, 100);
        add(-3, h, a, 100);
        add(3, h, a, 100);
      }
    }
    if (extraBehindWall) {
      // A much brighter patch outside the room, behind the +x wall: the wall must hide it.
      for (let a = -0.5; a <= 0.5; a += 0.05) for (let h = 1; h <= 2; h += 0.05) add(4, h, a, 255);
    }
    return { positions, colors };
  }

  it('sees the lamp from where the character stands and not the light behind the wall', () => {
    const { positions, colors } = room(true);
    const probe = [0, 1.2, 0];
    const pano = panoramaFromGaussians({ positions, colors }, probe, { width: 64 });
    expect(pano.covered).toBeGreaterThan(0.75);
    // Every pixel has a colour after the fill.
    let empty = 0;
    for (let p = 0; p < pano.width * pano.height; p += 1) if (pano.data[p * 3] === 0) empty += 1;
    expect(empty).toBe(0);
    const key = estimateKeyLightFromPanorama(pano);
    const toLamp = [1.5 - probe[0], 3 - probe[1], -1 - probe[2]];
    expect(angleBetween(key.direction, toLamp)).toBeLessThan(8);
  });

  it('applies the cloud transform', () => {
    const { positions, colors } = room(false);
    // Stored upside down and 2 m to the side; the matrix puts it back (rotation x by 180 degrees, then translate).
    const flipped = positions.slice();
    for (let i = 0; i < flipped.length; i += 3) {
      flipped[i] -= 2;
      flipped[i + 1] = -flipped[i + 1];
      flipped[i + 2] = -flipped[i + 2];
    }
    const matrix = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 2, 0, 0, 1];
    const pano = panoramaFromGaussians(
      { positions: flipped, colors, matrixWorld: matrix },
      [0, 1.2, 0],
    );
    const key = estimateKeyLightFromPanorama(pano);
    expect(angleBetween(key.direction, [1.5, 1.8, -1])).toBeLessThan(8);
  });
});

describe('estimateKeyLightFromSurfels', () => {
  /** Normals over a sphere or a vertical cylinder, with material groups and a known light. */
  function body(
    light: [number, number, number] | null,
    shape: 'sphere' | 'cylinder',
  ): {
    count: number;
    normals: Float32Array;
    luminance: Float32Array;
    groups: Uint16Array;
    weights: Float32Array;
  } {
    const count = 6000;
    const normals = new Float32Array(count * 3);
    const luminance = new Float32Array(count);
    const groups = new Uint16Array(count);
    const weights = new Float32Array(count).fill(1);
    let seed = 7;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < count; i += 1) {
      let x: number, y: number, z: number;
      if (shape === 'sphere') {
        y = 1 - (2 * (i + 0.5)) / count;
        const r = Math.sqrt(1 - y * y);
        const phi = i * 2.399963;
        x = r * Math.cos(phi);
        z = r * Math.sin(phi);
      } else {
        const phi = i * 2.399963;
        y = (random() - 0.5) * 0.3;
        const r = Math.sqrt(1 - y * y);
        x = r * Math.cos(phi);
        z = r * Math.sin(phi);
      }
      normals.set([x, y, z], i * 3);
      // Materials: a dark back (hair, a coat's back), a pale front (a face), four body colours.
      let group: number;
      let albedo: number;
      if (z < -0.4) {
        group = 1;
        albedo = 0.06;
      } else if (z > 0.6) {
        group = 2;
        albedo = 0.75;
      } else {
        group = 3 + (i % 4);
        albedo = 0.2 + 0.15 * (i % 4);
      }
      groups[i] = group;
      const lit = light ? Math.max(0, x * light[0] + y * light[1] + z * light[2]) : 0.5;
      // Capture noise of a few percent, as a trained cloud has.
      luminance[i] = albedo * (0.35 + 0.65 * lit) * (1 + (random() - 0.5) * 0.06);
    }
    return { count, normals, luminance, groups, weights };
  }

  it('finds the light a sphere of mixed materials was lit by, to within six degrees', () => {
    const light = directionFromAngles(30, 45);
    const key = estimateKeyLightFromSurfels(body(light, 'sphere'));
    expect(angleBetween(key.direction, light)).toBeLessThan(6);
    expect(key.confidence).toBeGreaterThan(0.5);
    expect(key.keyToFill).toBeGreaterThan(1.5);
    expect(key.shadowStrength).toBeGreaterThan(0.1);
    expect(key.shadowStrength).toBeLessThan(0.8);
  });

  it('is not pulled toward the front by a pale face and a dark back', () => {
    const light = directionFromAngles(-100, 40);
    const key = estimateKeyLightFromSurfels(body(light, 'sphere'));
    expect(angleBetween(key.direction, light)).toBeLessThan(6);
    // One group for everything, the plugin's plain fit: pulled toward the pale front.
    const plain = body(light, 'sphere');
    const naive = estimateKeyLightFromSurfels({ ...plain, groups: undefined });
    expect(angleBetween(naive.direction, light)).toBeGreaterThan(
      angleBetween(key.direction, light),
    );
  });

  it('gets the azimuth from a standing body whose normals are mostly horizontal', () => {
    const light = directionFromAngles(150, 50);
    const key = estimateKeyLightFromSurfels(body(light, 'cylinder'));
    expect(Math.abs(key.azimuth - 150)).toBeLessThan(6);
    expect(key.elevation).toBeGreaterThanOrEqual(25);
    expect(key.elevation).toBeLessThanOrEqual(70);
  });

  it('keeps the elevation inside the range asked for', () => {
    const light = directionFromAngles(0, 85);
    const key = estimateKeyLightFromSurfels(body(light, 'sphere'), { elevationRange: [30, 60] });
    expect(key.elevation).toBeCloseTo(60, 6);
  });

  it('reports low confidence for flat light', () => {
    const key = estimateKeyLightFromSurfels(body(null, 'sphere'));
    expect(key.confidence).toBeLessThan(0.2);
  });

  it('ignores groups that are too small or black', () => {
    const light = directionFromAngles(30, 45);
    const b = body(light, 'sphere');
    const key = estimateKeyLightFromSurfels(b, { minGroupSize: 5000 });
    expect(key.groupsUsed).toBe(0);
    expect(key.confidence).toBe(0);
  });
});
