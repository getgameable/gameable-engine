/**
 * The shared build of an exported character's splats: the sinks it asks the host for, and that
 * every sink it made is freed when the build fails or the mouth is not built.
 */
import { Group, type Object3D, type WebGPURenderer } from 'three/webgpu';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AosrigSplatBundle } from './format.js';
import { buildAosrigCharacter, type AosrigHostSink, type AosrigSinkRequest } from './host.js';

let fail = false;
let mouthBuilt = true;
vi.mock('./runtime.js', () => ({
  createAosrigSplat: (options: { mouth?: unknown }) =>
    fail
      ? Promise.reject(new Error('bad bindings'))
      : Promise.resolve({ mouth: options.mouth && mouthBuilt ? {} : null, dispose: vi.fn() }),
}));

/** A package with 100 splats, a correction of 7 and, when asked, 12 teeth points. */
function bundle(teeth: boolean): AosrigSplatBundle {
  return {
    descriptor: { splatCount: 100 },
    files: new Map(),
    corrective: [{ info: { points: 7 } }],
    ...(teeth ? { teeth: { info: { points: 12 } } } : {}),
  } as unknown as AosrigSplatBundle;
}

let requests: AosrigSinkRequest[] = [];
let disposed = 0;
const makeSink = (request: AosrigSinkRequest): Promise<AosrigHostSink> => {
  requests.push(request);
  return Promise.resolve({
    object3D: new Group() as Object3D,
    dispose: () => {
      disposed += 1;
    },
  } as unknown as AosrigHostSink);
};
const renderer = {} as WebGPURenderer;

beforeEach(() => {
  fail = false;
  mouthBuilt = true;
  requests = [];
  disposed = 0;
});

describe('buildAosrigCharacter', () => {
  it('asks for room for the splats and the corrections, on the studio kernel, and hides them', async () => {
    const built = await buildAosrigCharacter({
      bundle: bundle(true),
      rig: new Group(),
      renderer,
      makeSink,
      mouth: true,
    });
    expect(requests).toEqual([
      { capacity: 107, colorSpace: 'srgb', kernel: 'studio' },
      { capacity: 12, colorSpace: 'srgb' },
    ]);
    expect(built.sink.object3D.visible).toBe(false);
    expect(built.teethSink).not.toBeNull();
  });

  it('makes no teeth when the mouth is off or the package has none', async () => {
    await buildAosrigCharacter({
      bundle: bundle(true),
      rig: new Group(),
      renderer,
      makeSink,
      mouth: false,
    });
    await buildAosrigCharacter({
      bundle: bundle(false),
      rig: new Group(),
      renderer,
      makeSink,
      mouth: true,
    });
    expect(requests.map((r) => r.capacity)).toEqual([107, 107]);
  });

  it('frees the teeth when the mouth was not built', async () => {
    mouthBuilt = false;
    const built = await buildAosrigCharacter({
      bundle: bundle(true),
      rig: new Group(),
      renderer,
      makeSink,
      mouth: true,
    });
    expect(built.teethSink).toBeNull();
    expect(disposed).toBe(1);
  });

  it('frees every sink it made when the build fails', async () => {
    fail = true;
    await expect(
      buildAosrigCharacter({
        bundle: bundle(true),
        rig: new Group(),
        renderer,
        makeSink,
        mouth: true,
      }),
    ).rejects.toThrow('bad bindings');
    expect(disposed).toBe(2);
  });
});
