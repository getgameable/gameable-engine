import { describe, expect, it, vi } from 'vitest';

// Counts every load of three/webgpu and lets the real module through.
const threeLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('three/webgpu', async (importOriginal) => {
  threeLoads.count += 1;
  return importOriginal();
});

describe('the server entry of the net package', () => {
  it('loads no three.js, rooms and the engine room game included', async () => {
    const server = await import('./index.js');
    expect(typeof server.createRoom).toBe('function');
    expect(typeof server.createEngineRoomGame).toBe('function');
    expect(threeLoads.count).toBe(0);
  });

  it('counts a three.js load when one happens (positive control for the zero above)', async () => {
    vi.resetModules();
    await import('@gameable/core');
    expect(threeLoads.count).toBeGreaterThan(0);
  });
});
