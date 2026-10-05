import { Group, Object3D, Scene } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { NO_ENTITY, SceneGraph } from './graph.js';

describe('SceneGraph', () => {
  it('adds its root to the scene', () => {
    const scene = new Scene();
    const graph = new SceneGraph(scene, 'test-root');
    expect(scene.children).toContain(graph.root);
    expect(graph.root.name).toBe('test-root');
    expect(graph.size).toBe(0);
  });

  it('parents a spawned object under the root by default', () => {
    const graph = new SceneGraph(new Scene());
    const object = new Group();

    expect(graph.spawn(1, object)).toBe(object);

    expect(graph.get(1)).toBe(object);
    expect(object.parent).toBe(graph.root);
    expect(graph.idOf(object)).toBe(1);
    expect(graph.size).toBe(1);
  });

  it('parents under another entity when asked', () => {
    const graph = new SceneGraph(new Scene());
    const parent = new Group();
    const child = new Group();
    graph.spawn(1, parent);
    graph.spawn(2, child, 1);
    expect(child.parent).toBe(parent);
  });

  it('rejects id 0 and non-positive or fractional ids', () => {
    const graph = new SceneGraph(new Scene());
    expect(() => graph.spawn(NO_ENTITY, new Group())).toThrow(RangeError);
    expect(() => graph.spawn(-1, new Group())).toThrow(RangeError);
    expect(() => graph.spawn(1.5, new Group())).toThrow(RangeError);
  });

  it('rejects a duplicate id', () => {
    const graph = new SceneGraph(new Scene());
    graph.spawn(1, new Group());
    expect(() => graph.spawn(1, new Group())).toThrow(/already exists/);
  });

  it('rejects an unknown parent', () => {
    const graph = new SceneGraph(new Scene());
    expect(() => graph.spawn(1, new Group(), 42)).toThrow(/unknown parent entity 42/);
  });

  it('returns undefined for an unknown id, and 0 for an untracked object', () => {
    const graph = new SceneGraph(new Scene());
    expect(graph.get(7)).toBeUndefined();
    expect(graph.idOf(new Object3D())).toBe(NO_ENTITY);
  });

  it('re-parents with setParent, and back to the root with 0', () => {
    const graph = new SceneGraph(new Scene());
    const a = new Group();
    const b = new Group();
    const child = new Group();
    graph.spawn(1, a);
    graph.spawn(2, b);
    graph.spawn(3, child, 1);

    graph.setParent(3, 2);
    expect(child.parent).toBe(b);

    graph.setParent(3, NO_ENTITY);
    expect(child.parent).toBe(graph.root);
  });

  it('refuses to parent an entity to itself or to its own descendant', () => {
    const graph = new SceneGraph(new Scene());
    graph.spawn(1, new Group());
    graph.spawn(2, new Group(), 1);
    graph.spawn(3, new Group(), 2);

    expect(() => {
      graph.setParent(1, 1);
    }).toThrow(/cannot parent itself/);
    expect(() => {
      graph.setParent(1, 3);
    }).toThrow(/would make a cycle/);
  });

  it('throws when re-parenting an unknown entity', () => {
    const graph = new SceneGraph(new Scene());
    expect(() => {
      graph.setParent(9);
    }).toThrow(/unknown entity 9/);
  });

  it('despawns an entity and re-parents its children to the root', () => {
    const graph = new SceneGraph(new Scene());
    const parent = new Group();
    const child = new Group();
    graph.spawn(1, parent);
    graph.spawn(2, child, 1);

    expect(graph.despawn(1)).toBe(true);

    expect(graph.get(1)).toBeUndefined();
    expect(parent.parent).toBeNull();
    expect(graph.get(2)).toBe(child);
    expect(child.parent).toBe(graph.root);
    expect(graph.size).toBe(1);
  });

  it('despawns a parent of many without touching unrelated subtrees', () => {
    const graph = new SceneGraph(new Scene());
    const a = graph.spawn(1, new Group());
    const b = graph.spawn(2, new Group());
    const children = [3, 4, 5].map((id) => graph.spawn(id, new Group(), 1));
    const other = graph.spawn(6, new Group(), 2);

    expect(graph.despawn(1)).toBe(true);
    for (const child of children) expect(child.parent).toBe(graph.root);
    expect(other.parent).toBe(b);
    expect(a.parent).toBeNull();

    // Moving a child away from a parent stops that parent's despawn from
    // touching it.
    graph.setParent(3, 2);
    graph.setParent(3, 0);
    expect(graph.despawn(2)).toBe(true);
    expect(other.parent).toBe(graph.root);
    expect(children[0]?.parent).toBe(graph.root);
  });

  it('reports false when despawning something that is not there', () => {
    const graph = new SceneGraph(new Scene());
    expect(graph.despawn(1)).toBe(false);
  });

  it('clears the entity marker on despawn, so the object can be reused', () => {
    const graph = new SceneGraph(new Scene());
    const object = new Group();
    graph.spawn(1, object);
    graph.despawn(1);
    expect(graph.idOf(object)).toBe(NO_ENTITY);
    expect(() => graph.spawn(5, object)).not.toThrow();
  });

  it('iterates ids in insertion order', () => {
    const graph = new SceneGraph(new Scene());
    graph.spawn(7, new Group());
    graph.spawn(3, new Group());
    graph.spawn(11, new Group());
    expect([...graph.ids()]).toEqual([7, 3, 11]);
  });

  it('detaches everything on dispose', () => {
    const scene = new Scene();
    const graph = new SceneGraph(scene);
    const object = new Group();
    graph.spawn(1, object);

    graph.dispose();

    expect(graph.size).toBe(0);
    expect(object.parent).toBeNull();
    expect(scene.children).not.toContain(graph.root);
  });
});
