import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseManifest } from '@gameable/assets';
import { SPZLoader } from 'three/addons/loaders/SPZLoader.js';
import { describe, expect, it } from 'vitest';

import { parseCollider } from './collider.js';
import { arenaSpawns, PLACEHOLDER_ASSETS_BASE, placeholderManifest } from './index.js';

/** Every file the published package ships in `assets/`. */
const PACK_FILES = [
  'CREDITS.md',
  'arena.collider.bin',
  'arena.spawns.json',
  'arena.spz',
  'assets.json',
  'face_idle.arkit.json',
  'hit.wav',
  'pickup.wav',
  'shot.wav',
  'step.wav',
];

/** The four sound effects, all 16-bit mono 22.05 kHz. */
const SFX_FILES = ['shot.wav', 'hit.wav', 'pickup.wav', 'step.wav'];

/**
 * Absolute path to a packaged asset.
 *
 * @param file File name inside `assets/`.
 * @returns The absolute filesystem path.
 */
function assetPath(file: string): string {
  return fileURLToPath(new URL(`../assets/${file}`, import.meta.url));
}

/**
 * Read a packaged asset as a standalone `ArrayBuffer`.
 *
 * @param file File name inside `assets/`.
 * @returns The file contents.
 */
function readAsset(file: string): ArrayBuffer {
  const bytes = readFileSync(assetPath(file));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * Read a packaged asset as parsed JSON.
 *
 * @param file File name inside `assets/`.
 * @returns The parsed document.
 */
function readJson(file: string): unknown {
  return JSON.parse(readFileSync(assetPath(file), 'utf8')) as unknown;
}

describe('the pack as a whole', () => {
  it('stays under the 12 MB budget from AGENTS.md rule 14', () => {
    const total = PACK_FILES.reduce((sum, file) => sum + statSync(assetPath(file)).size, 0);
    expect(total).toBeLessThanOrEqual(12 * 1024 * 1024);
  });

  it('ships every file the manifest and the exports reference', () => {
    for (const file of PACK_FILES) {
      expect(statSync(assetPath(file)).isFile(), file).toBe(true);
    }
  });

  it('resolves its own base URL to the assets directory', () => {
    expect(PLACEHOLDER_ASSETS_BASE.endsWith('/assets/')).toBe(true);
  });
});

describe('assets.json', () => {
  it('passes parseManifest from @gameable/assets', () => {
    const manifest = parseManifest(readJson('assets.json'), {
      baseUrl: PLACEHOLDER_ASSETS_BASE,
    });
    expect(manifest.assets.map((a) => a.id)).toEqual([
      'env.arena',
      'sfx.shot',
      'sfx.hit',
      'sfx.pickup',
      'sfx.step',
    ]);
  });

  it('declares the arena collider', () => {
    const manifest = parseManifest(readJson('assets.json'));
    const arena = manifest.assets.find((a) => a.id === 'env.arena');
    expect(arena?.type).toBe('splat');
    expect(arena?.collider).toEqual({
      shape: 'mesh',
      src: 'arena.collider.bin',
      layer: 'static',
    });
  });

  it('points every src at a file that exists', () => {
    const manifest = parseManifest(readJson('assets.json'));
    for (const entry of manifest.assets) {
      expect(statSync(assetPath(entry.src)).isFile(), entry.src).toBe(true);
      if (entry.collider?.src !== undefined) {
        expect(statSync(assetPath(entry.collider.src)).isFile(), entry.collider.src).toBe(true);
      }
    }
  });

  it('matches the placeholderManifest export exactly', () => {
    expect(readJson('assets.json')).toEqual(placeholderManifest);
  });

  it('leaves face.idle out, because the schema has no type for it', () => {
    const manifest = parseManifest(readJson('assets.json'));
    expect(manifest.assets.some((a) => a.id === 'face.idle')).toBe(false);
  });
});

describe('arena.spz', () => {
  // `parse` only returns a promise for SPZ v4 (zstd); this file is gzipped v2,
  // so it decodes synchronously and needs neither DOM nor fetch.
  const parsed = new SPZLoader().parse(readAsset('arena.spz'));
  if (parsed === undefined || parsed instanceof Promise) {
    throw new Error('arena.spz must decode synchronously as gzipped SPZ v2');
  }
  const geometry = parsed;

  it('parses with three r186 SPZLoader', () => {
    expect(geometry.attributes.position.count).toBeGreaterThan(0);
  });

  it('has a sane, budgeted splat count', () => {
    const count = geometry.attributes.position.count;
    expect(count).toBeGreaterThan(50_000);
    expect(count).toBeLessThanOrEqual(250_000);
  });

  it('decodes colour and covariance attributes', () => {
    expect(Object.keys(geometry.attributes).sort()).toEqual(['color', 'covariance', 'position']);
  });

  it('stays inside the arena, with the sky dome around it', () => {
    const box = geometry.boundingBox;
    expect(box).not.toBeNull();
    // The dome is a 32 m shell; nothing may be further out than that plus jitter.
    expect(box?.min.x).toBeGreaterThan(-35);
    expect(box?.max.x).toBeLessThan(35);
    expect(box?.min.z).toBeGreaterThan(-35);
    expect(box?.max.z).toBeLessThan(35);
    // Nothing digs into the floor, and nothing goes above the dome.
    expect(box?.min.y).toBeGreaterThan(-4);
    expect(box?.max.y).toBeLessThan(35);
  });

  it('puts most of its splats inside the playable bounds', () => {
    const positions = geometry.attributes.position;
    const { min, max } = arenaSpawns.bounds;
    let inside = 0;
    for (let i = 0; i < positions.count; i += 1) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);
      // A splat centre may sit half a wall-thickness outside the nominal box.
      if (
        x >= min[0] - 0.2 &&
        x <= max[0] + 0.2 &&
        y >= min[1] - 0.2 &&
        y <= max[1] + 0.2 &&
        z >= min[2] - 0.2 &&
        z <= max[2] + 0.2
      ) {
        inside += 1;
      }
    }
    expect(inside).toBeGreaterThan(100_000);
  });

  it('stays under the 4 MB budget', () => {
    expect(statSync(assetPath('arena.spz')).size).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});

describe('arena.collider.bin', () => {
  const mesh = parseCollider(readAsset('arena.collider.bin'));

  it('parses into whole vertices and whole triangles', () => {
    expect(mesh.positions.length % 3).toBe(0);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.indices.length / 3).toBeGreaterThan(100);
  });

  it('covers the arena, in metres, origin at the floor centre', () => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      minX = Math.min(minX, mesh.positions[i] ?? 0);
      maxX = Math.max(maxX, mesh.positions[i] ?? 0);
      minY = Math.min(minY, mesh.positions[i + 1] ?? 0);
      maxY = Math.max(maxY, mesh.positions[i + 1] ?? 0);
    }
    expect(minX).toBeCloseTo(-12.15, 2);
    expect(maxX).toBeCloseTo(12.15, 2);
    expect(minY).toBe(0);
    expect(maxY).toBeCloseTo(3, 5);
  });
});

describe('arena.spawns.json', () => {
  it('matches the arenaSpawns export exactly', () => {
    expect(readJson('arena.spawns.json')).toEqual(arenaSpawns);
  });

  it('has one player, six enemies and three pickups', () => {
    expect(arenaSpawns.enemies).toHaveLength(6);
    expect(arenaSpawns.pickups).toHaveLength(3);
  });

  it('puts every spawn point inside the arena bounds', () => {
    const { min, max } = arenaSpawns.bounds;
    const all = [arenaSpawns.player, ...arenaSpawns.enemies, ...arenaSpawns.pickups];
    for (const { position } of all) {
      for (let axis = 0; axis < 3; axis += 1) {
        const where = `axis ${String(axis)} of ${JSON.stringify(position)}`;
        expect(position[axis], where).toBeGreaterThanOrEqual(min[axis] ?? 0);
        expect(position[axis], where).toBeLessThanOrEqual(max[axis] ?? 0);
      }
    }
  });

  it('faces every spawn point at the centre of the arena', () => {
    const all = [arenaSpawns.player, ...arenaSpawns.enemies];
    for (const { position, yaw } of all) {
      // three's convention: forward is -Z, so looking at the origin is atan2(x, z).
      expect(yaw).toBeCloseTo(Math.atan2(position[0], position[2]), 3);
    }
  });
});

describe('the sound effects', () => {
  for (const file of SFX_FILES) {
    it(`${file} is a valid 16-bit mono 22.05 kHz WAV`, () => {
      const buffer = readAsset(file);
      const view = new DataView(buffer);
      const ascii = (offset: number): string =>
        String.fromCharCode(...new Uint8Array(buffer, offset, 4));

      expect(ascii(0)).toBe('RIFF');
      expect(ascii(8)).toBe('WAVE');
      expect(ascii(12)).toBe('fmt ');
      expect(ascii(36)).toBe('data');

      expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);
      expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
      expect(view.getUint16(20, true)).toBe(1); // PCM
      expect(view.getUint16(22, true)).toBe(1); // mono
      expect(view.getUint32(24, true)).toBe(22_050); // sample rate
      expect(view.getUint32(28, true)).toBe(22_050 * 2); // byte rate
      expect(view.getUint16(32, true)).toBe(2); // block align
      expect(view.getUint16(34, true)).toBe(16); // bits per sample

      const dataBytes = view.getUint32(40, true);
      expect(dataBytes).toBe(buffer.byteLength - 44);
      expect(dataBytes % 2).toBe(0);
    });

    it(`${file} is under 60 KB and is not silence`, () => {
      const buffer = readAsset(file);
      expect(buffer.byteLength).toBeLessThanOrEqual(60 * 1024);

      const samples = new Int16Array(buffer, 44, (buffer.byteLength - 44) / 2);
      expect(samples.length).toBeGreaterThan(1000);
      let peak = 0;
      for (const s of samples) peak = Math.max(peak, Math.abs(s));
      expect(peak).toBeGreaterThan(20_000);
      // Normalised to 0.89 full scale, so it must not clip either.
      expect(peak).toBeLessThan(32_767);
      // No click: the waveform starts and ends at silence.
      expect(Math.abs(samples[0])).toBeLessThan(64);
      expect(Math.abs(samples[samples.length - 1])).toBeLessThan(64);
    });
  }
});

describe('face_idle.arkit.json', () => {
  const clip = readJson('face_idle.arkit.json') as {
    fps: number;
    frames: { timeCode: number; blendshapeWeights: number[] }[];
  };

  it('is four seconds of ARKit-52 weights at 30 fps', () => {
    expect(clip.fps).toBe(30);
    expect(clip.frames).toHaveLength(120);
    expect(clip.frames.at(-1)?.timeCode).toBeCloseTo(119 / 30, 4);
  });

  it('has 52 weights in [0, 1] on every frame', () => {
    for (const frame of clip.frames) {
      expect(frame.blendshapeWeights).toHaveLength(52);
      for (const w of frame.blendshapeWeights) {
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
  });

  it('blinks twice, both eyes together', () => {
    // ARKit channel 0 is EyeBlinkLeft and channel 7 is EyeBlinkRight.
    let closes = 0;
    let wasShut = false;
    for (const frame of clip.frames) {
      const left = frame.blendshapeWeights[0] ?? 0;
      const right = frame.blendshapeWeights[7] ?? 0;
      expect(left).toBeCloseTo(right, 6);
      const shut = left > 0.9;
      if (shut && !wasShut) closes += 1;
      wasShut = shut;
    }
    expect(closes).toBe(2);
  });

  it('breathes, and loops without a seam', () => {
    // ARKit channel 17 is JawOpen.
    const jaw = clip.frames.map((f) => f.blendshapeWeights[17] ?? 0);
    expect(Math.max(...jaw) - Math.min(...jaw)).toBeGreaterThan(0.02);
    // Frame 120 would be frame 0 again: the curve has to arrive back where it
    // started, within one frame of change.
    expect(jaw.at(-1)).toBeCloseTo(jaw[0] ?? 0, 2);
  });
});
