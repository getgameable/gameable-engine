import { describe, expect, it, vi } from 'vitest';

// Counts every load of three/webgpu and lets the real module through.
const threeLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('three/webgpu', async (importOriginal) => {
  threeLoads.count += 1;
  return importOriginal();
});

describe('the server import graph', () => {
  it('loads no three.js', async () => {
    const core = await import('@gameable/core/headless');
    const jolt = await import('@gameable/physics-jolt');
    const server = await import('@gameable/wasm-host/server');
    const { defineGame } = await import('@gameable/sdk');
    const { createMockHost } = await import('@gameable/test-harness');
    expect(typeof core.createHeadlessEngine).toBe('function');
    expect(typeof jolt.physics).toBe('function');
    expect(typeof server.createServerLoop).toBe('function');
    // The sandbox and the slot come from the server entry, and running them loads no three either.
    const sandbox = server.createDirectSandbox({
      mode: 'direct',
      game: defineGame({}),
      host: createMockHost(),
    });
    expect(sandbox.dead).toBe(false);
    const slot = server.createGameSlot();
    expect(slot.module.id).toBe('game');
    expect(typeof server.createSandbox).toBe('function');
    expect(typeof server.applyOutput).toBe('function');
    expect(threeLoads.count).toBe(0);
  });

  it('resolves features through @gameable/core/headless without loading three.js', async () => {
    const { resolveFeatures } = await import('@gameable/core/headless');
    const loaded = await resolveFeatures(
      { probe: {} },
      { probe: () => Promise.resolve({ name: 'probe', modules: [] }) },
    );
    expect(loaded.map((f) => f.name)).toEqual(['probe']);
    expect(threeLoads.count).toBe(0);
  });

  it('counts a three.js load when one happens (positive control for the zero above)', async () => {
    // Without this, a mock that never counts would make the zero meaningless.
    // The case above ends at zero, so the root import below is the first load of three/webgpu.
    vi.resetModules();
    // The core root loads three/webgpu through engine/Engine.ts.
    await import('@gameable/core');
    expect(threeLoads.count).toBeGreaterThan(0);
  }, 60_000);
});
