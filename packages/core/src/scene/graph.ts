/**
 * Numeric entity ids to `Object3D`s.
 *
 * The guest thinks in `u32` entity ids; three thinks in object references. The
 * scene graph is the only place the two meet. Everything the engine spawns goes
 * under one root group, so the host's objects never tangle with whatever else a
 * template puts in the scene.
 */
import { Group } from 'three/webgpu';
import type { Object3D, Scene } from 'three/webgpu';

/** The entity id that means "no entity"; also the id of the root group. */
export const NO_ENTITY = 0;

/** Maps entity ids to scene objects. */
export class SceneGraph {
  /** Group every spawned object is parented under. */
  readonly root: Group;

  /** The scene the root was added to. */
  readonly scene: Scene;

  /** Entity id to object. */
  #objects = new Map<number, Object3D>();

  /** Entity id to its parent's entity id; absent means parented to the root. */
  #parents = new Map<number, number>();

  /** Parent entity id to the ids parented under it, so a despawn is O(children). */
  #children = new Map<number, Set<number>>();

  /**
   * Build a scene graph and attach its root to the scene.
   *
   * @param scene Scene to attach to.
   * @param name Name given to the root group, for debugging.
   */
  constructor(scene: Scene, name = 'gameable:root') {
    this.scene = scene;
    this.root = new Group();
    this.root.name = name;
    scene.add(this.root);
  }

  /**
   * How many entities are in the graph.
   *
   * @returns The entity count.
   */
  get size(): number {
    return this.#objects.size;
  }

  /**
   * Add an object under an entity id.
   *
   * @param id Entity id. Must be a positive integer; `0` is the root.
   * @param object The object to add.
   * @param parentId Parent entity id, or `0` for the root.
   * @returns The object, so calls can be chained.
   *
   * @example
   * ```ts
   * import { SceneGraph } from 'gameable/core';
   * import { Group, Scene } from 'three/webgpu';
   *
   * const graph = new SceneGraph(new Scene());
   * graph.spawn(1, new Group());
   * graph.spawn(2, new Group(), 1); // child of entity 1
   * ```
   */
  spawn(id: number, object: Object3D, parentId: number = NO_ENTITY): Object3D {
    if (!Number.isInteger(id) || id <= NO_ENTITY) {
      throw new RangeError(
        `SceneGraph.spawn: entity id must be a positive integer, got ${String(id)}`,
      );
    }
    if (this.#objects.has(id)) {
      throw new Error(`SceneGraph.spawn: entity ${String(id)} already exists`);
    }
    object.userData.entityId = id;
    this.#objects.set(id, object);
    this.setParent(id, parentId);
    return object;
  }

  /**
   * Remove an entity.
   *
   * Children are re-parented to the root rather than removed with it, so a
   * despawn cannot silently take a subtree the caller still tracks. Despawn
   * them explicitly if that is what you want.
   *
   * @param id Entity id.
   * @returns True when the entity existed.
   */
  despawn(id: number): boolean {
    const object = this.#objects.get(id);
    if (object === undefined) return false;

    const children = this.#children.get(id);
    if (children !== undefined) {
      for (const childId of [...children]) this.setParent(childId, NO_ENTITY);
      this.#children.delete(id);
    }

    object.removeFromParent();
    delete object.userData.entityId;
    this.#objects.delete(id);
    this.#unlink(id);
    return true;
  }

  /**
   * Look up an entity's object.
   *
   * @param id Entity id.
   * @returns The object, or `undefined` when the id is not spawned.
   */
  get(id: number): Object3D | undefined {
    return this.#objects.get(id);
  }

  /**
   * The entity id an object was spawned under.
   *
   * @param object Any object in the graph.
   * @returns The id, or `0` when the object was not spawned here.
   */
  idOf(object: Object3D): number {
    const id: unknown = object.userData.entityId;
    return typeof id === 'number' ? id : NO_ENTITY;
  }

  /**
   * Re-parent an entity.
   *
   * @param id Entity id to move.
   * @param parentId New parent's entity id, or `0` for the root.
   */
  setParent(id: number, parentId: number = NO_ENTITY): void {
    const object = this.#objects.get(id);
    if (object === undefined) throw new Error(`SceneGraph.setParent: unknown entity ${String(id)}`);
    if (parentId === id)
      throw new Error(`SceneGraph.setParent: entity ${String(id)} cannot parent itself`);

    let parent: Object3D = this.root;
    if (parentId !== NO_ENTITY) {
      const found = this.#objects.get(parentId);
      if (found === undefined) {
        throw new Error(`SceneGraph.setParent: unknown parent entity ${String(parentId)}`);
      }
      if (this.#isDescendant(parentId, id)) {
        throw new Error(
          `SceneGraph.setParent: parenting ${String(id)} to ${String(parentId)} would make a cycle`,
        );
      }
      parent = found;
    }

    parent.add(object);
    this.#unlink(id);
    if (parentId !== NO_ENTITY) {
      this.#parents.set(id, parentId);
      let siblings = this.#children.get(parentId);
      if (siblings === undefined) {
        siblings = new Set();
        this.#children.set(parentId, siblings);
      }
      siblings.add(id);
    }
  }

  /**
   * Every spawned entity id, in insertion order.
   *
   * @returns An iterator over ids.
   */
  ids(): IterableIterator<number> {
    return this.#objects.keys();
  }

  /**
   * Remove every entity and detach the root from the scene.
   */
  dispose(): void {
    for (const object of this.#objects.values()) {
      object.removeFromParent();
      delete object.userData.entityId;
    }
    this.#objects.clear();
    this.#parents.clear();
    this.#children.clear();
    this.root.removeFromParent();
  }

  /**
   * Drop an entity's link to its current parent, if any.
   *
   * @param id Entity id.
   */
  #unlink(id: number): void {
    const parentId = this.#parents.get(id);
    if (parentId === undefined) return;
    this.#parents.delete(id);
    const siblings = this.#children.get(parentId);
    if (siblings === undefined) return;
    siblings.delete(id);
    if (siblings.size === 0) this.#children.delete(parentId);
  }

  /**
   * Whether `candidate` sits under `ancestor` in the tracked hierarchy.
   *
   * @param candidate Entity id to walk up from.
   * @param ancestor Entity id to look for.
   * @returns True when `ancestor` is on the path to the root.
   */
  #isDescendant(candidate: number, ancestor: number): boolean {
    let current: number | undefined = candidate;
    while (current !== undefined && current !== NO_ENTITY) {
      if (current === ancestor) return true;
      current = this.#parents.get(current);
    }
    return false;
  }
}
