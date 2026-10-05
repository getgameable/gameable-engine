/**
 * `gameable/physics` — the engine's physics module, backed by
 * `jolt-physics` compiled to WebAssembly.
 *
 * Three layers, smallest first:
 *
 * - {@link loadJolt} instantiates the wasm module, once per page.
 * - {@link createPhysicsWorld} wraps it in a {@link PhysicsWorld}: bodies,
 *   character controllers, queries and contact events, with a body buffer
 *   shaped exactly like the WIT `frame-input.bodies` contract.
 * - {@link physics} packages that as an `EngineModule` the engine can register.
 *
 * Games use the third. Tools and tests use the first two. Every export below
 * carries its own TSDoc and a runnable `@example` at its declaration site.
 *
 * @example
 * ```ts
 * import { createPhysicsWorld, loadJolt } from 'gameable/physics';
 *
 * const world = createPhysicsWorld(await loadJolt());
 * world.addBody({
 *   id: 1,
 *   shape: 'sphere',
 *   dims: [0.5],
 *   position: [0, 4, 0],
 *   rotation: [0, 0, 0, 1],
 *   mass: 10,
 *   kind: 'dynamic',
 *   layer: 0b1,
 *   mask: 0xffff,
 *   friction: 0.4,
 *   restitution: 0.2,
 * });
 * world.step(1 / 60);
 * world.dispose();
 * ```
 */

export {
  isJoltLoaded,
  loadJolt,
  type JoltInstance,
  type JoltModule,
  type JoltShape,
  type LoadJoltOptions,
} from './jolt.js';

export { type LayerOptions } from './layers.js';

export {
  convexHullFromPoints,
  meshShapeFromGeometry,
  type ConvexHullOptions,
  type MeshShapeOptions,
} from './mesh.js';

export {
  physics,
  type PhysicsOptions,
  type PhysicsService,
  type PhysicsSteppedEvent,
} from './module.js';

export {
  BODY_STRIDE,
  RAY_HIT_STRIDE,
  RAY_STRIDE,
  createContactRecord,
  createPhysicsWorld,
  type BodyArgs,
  type BodyFlags,
  type BodyKind,
  type ContactPhase,
  type ContactRecord,
  type GroundState,
  type PhysicsWorld,
  type PhysicsWorldOptions,
  type Quat,
  type RayHit,
  type ShapeKind,
  type Vec3,
} from './world.js';

/**
 * Package identity marker for `gameable/physics`.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/physics';
 *
 * console.log(PACKAGE); // 'gameable/physics'
 * ```
 */
export const PACKAGE = '@gameable/physics-jolt' as const;
