import { describe, expect, it, vi } from 'vitest';
import type { FeatureLoader, LoadedFeature } from './features.js';
import type { EngineModule } from './module.js';
import { bindFeatures, FeatureError, resolveFeatures } from './features.js';
import { createHeadlessEngine } from './headless.js';

const mod = (id: string): EngineModule => ({ id, init: () => undefined, dispose: () => undefined });
const empty = (name: string): Promise<LoadedFeature> => Promise.resolve({ name, modules: [] });

describe('resolveFeatures', () => {
  it('loads only the declared features, in declaration order', async () => {
    const a = vi.fn(() => Promise.resolve({ name: 'a', modules: [mod('a')] }));
    const b = vi.fn(() => Promise.resolve({ name: 'b', modules: [mod('b')] }));
    const loaded = await resolveFeatures({ b: {}, a: {} }, { a, b });
    expect(loaded.map((f) => f.name)).toEqual(['b', 'a']);
    expect(a).toHaveBeenCalledWith({});
  });
  it('does not touch a loader whose feature is not declared', async () => {
    const a = vi.fn(() => empty('a'));
    await resolveFeatures({}, { a });
    expect(a).not.toHaveBeenCalled();
  });
  it('names the known features when one is unknown', async () => {
    await expect(resolveFeatures({ nope: {} }, { characters: () => empty('characters') }))
      .rejects.toThrow(FeatureError);
    await expect(resolveFeatures({ nope: {} }, { characters: () => empty('characters') }))
      .rejects.toThrow(/known: characters/);
  });
  it('passes the options through', async () => {
    const m = vi.fn<FeatureLoader>(() => empty('multiplayer'));
    await resolveFeatures({ multiplayer: { maxPlayers: 6 } }, { multiplayer: m });
    expect(m).toHaveBeenCalledWith({ maxPlayers: 6 });
  });
});

describe('bindFeatures', () => {
  it('runs bind in order and keys the results by name', async () => {
    const engine = {} as never;
    const bound = await bindFeatures(
      [{ name: 'x', modules: [], bind: () => Promise.resolve('X') }, { name: 'y', modules: [] }],
      engine,
    );
    expect(bound.get('x')).toBe('X');
    expect(bound.has('y')).toBe(false);
  });
  it('hands a headless engine to bind', async () => {
    const engine = await createHeadlessEngine();
    const bound = await bindFeatures(
      [{ name: 'x', modules: [], bind: (e) => Promise.resolve(e) }],
      engine,
    );
    expect(bound.get('x')).toBe(engine);
    await engine.dispose();
  });
});
