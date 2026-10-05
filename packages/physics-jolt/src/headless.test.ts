import { describe, expect, it, vi } from 'vitest';

// Records whether anything loaded three/webgpu, and lets the real module through.
const threeLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('three/webgpu', async (importOriginal) => {
  threeLoads.count += 1;
  return importOriginal();
});

describe('physics-jolt headless', () => {
  it('imports and steps a world without loading three.js', async () => {
    // If anything in the physics package imports three at module scope, this import loads it.
    const { physics } = await import('./index.js');
    expect(threeLoads.count).toBe(0);
    // The server's door into core: the package root also exports the renderer engine, which imports three.
    const { createHeadlessEngine } = await import('@gameable/core/headless');
    const engine = await createHeadlessEngine({ modules: [physics({ gravity: [0, -9.81, 0] })] });
    const world = engine.modules.get('physics');
    world.addBody({
      id: 1,
      shape: 'sphere',
      dims: [0.5],
      position: [0, 5, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
      kind: 'dynamic',
      layer: 1,
      mask: 0xffff,
      friction: 0.5,
      restitution: 0,
      linearDamping: 0,
      angularDamping: 0,
    });
    engine.step(0);
    for (let i = 1; i <= 60; i += 1) engine.step(i * (1000 / 60));
    const rows = new Float32Array(15);
    expect(world.readBodies(rows)).toBe(1);
    // Row is [id, px, py, pz, ...]; index 2 is y.
    expect(rows[2]).toBeLessThan(5);
    await engine.dispose();
    expect(threeLoads.count).toBe(0);
  }, 60_000);

  it('counts a three.js load when one happens (positive control for the zero above)', async () => {
    // Without this, a mock that never counts would make the zero meaningless.
    // The case above ends at zero, so the root import below is the first load of three/webgpu.
    vi.resetModules();
    // The core root loads three/webgpu through engine/Engine.ts.
    await import('@gameable/core');
    expect(threeLoads.count).toBeGreaterThan(0);
  }, 60_000);
});
