/**
 * The physics wireframe. It names `three/webgpu` for types only: `module.ts`
 * loads this file and three itself with two dynamic `import()`s and hands
 * three's classes in. A static import here would be hoisted to the top of a
 * server bundle (esbuild does that with an external module), so a room server
 * would load three at startup; the bundle test in `packages/cli` checks it.
 */
import type {
  BufferAttribute,
  BufferGeometry,
  LineBasicNodeMaterial,
  LineSegments,
  Scene,
} from 'three/webgpu';

import type { PhysicsWorld } from './world.js';

/** Corners of a unit box, the 12 edges of an AABB as 24 line endpoints. */
const EDGES: readonly number[] = [
  0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7,
];

/** Floats per body written by `readBodyBounds`. */
const BOUNDS_STRIDE = 13;

/** The wireframe view of one {@link PhysicsWorld}. */
export interface DebugDraw {
  /** Add the lines to a scene and schedule a rebuild. */
  attach(scene: Scene): void;
  /** Remove the lines from their scene and free the geometry. */
  detach(): void;
  /** Rebuild when the body set changed, then transform the cached corners. */
  update(): void;
  /** Free everything. */
  dispose(): void;
}

/** The three classes the wireframe builds, as `import('three/webgpu')` gives them. */
export interface DebugDrawThree {
  readonly BufferAttribute: typeof BufferAttribute;
  readonly BufferGeometry: typeof BufferGeometry;
  readonly LineBasicNodeMaterial: typeof LineBasicNodeMaterial;
  readonly LineSegments: typeof LineSegments;
}

/**
 * Create the wireframe view for a world.
 *
 * @param world The world whose bodies are drawn.
 * @param three three's classes, from a dynamic `import('three/webgpu')`.
 * @returns A view that draws nothing until `attach` is called.
 */
export function createDebugDraw(world: PhysicsWorld, three: DebugDrawThree): DebugDraw {
  const { BufferAttribute, BufferGeometry, LineBasicNodeMaterial, LineSegments } = three;
  let scene: Scene | null = null;
  let lines: LineSegments | null = null;
  let material: LineBasicNodeMaterial | null = null;
  let positions = new Float32Array(0);
  let bounds = new Float32Array(0);
  let drawnRevision = -1;
  let drawnCount = 0;

  /** Release the GPU resources. */
  function free(): void {
    if (lines !== null) {
      lines.removeFromParent();
      lines.geometry.dispose();
      lines = null;
    }
    if (material !== null) {
      material.dispose();
      material = null;
    }
    positions = new Float32Array(0);
    bounds = new Float32Array(0);
    drawnRevision = -1;
    drawnCount = 0;
  }

  /** Rebuild the line buffer for the current body set. */
  function rebuild(): void {
    const count = world.bodyCount;
    const floats = count * EDGES.length * 3;
    if (positions.length !== floats) {
      positions = new Float32Array(floats);
      bounds = new Float32Array(count * BOUNDS_STRIDE);
      if (lines !== null) {
        lines.geometry.dispose();
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(positions, 3));
        lines.geometry = geometry;
      }
    }
    // A shape is immutable, so its local bounds are read here — once per
    // structural change — and never again in the per-frame path.
    const ids = world.bodyIds();
    for (let i = 0; i < count && i < ids.length; i += 1) {
      world.readBodyBounds(ids[i], bounds, i * BOUNDS_STRIDE);
    }
    drawnCount = count;
    drawnRevision = world.revision;
  }

  /** Transform every body's local bounds into the line buffer. */
  function refresh(): void {
    const ids = world.bodyIds();
    let cursor = 0;
    for (let i = 0; i < drawnCount && i < ids.length; i += 1) {
      const base = i * BOUNDS_STRIDE;
      // Bounds were cached by `rebuild`; only the pose can have moved.
      if (!world.readBodyPose(ids[i], bounds, base + 6)) continue;
      const minX = bounds[base];
      const minY = bounds[base + 1];
      const minZ = bounds[base + 2];
      const maxX = bounds[base + 3];
      const maxY = bounds[base + 4];
      const maxZ = bounds[base + 5];
      const px = bounds[base + 6];
      const py = bounds[base + 7];
      const pz = bounds[base + 8];
      const qx = bounds[base + 9];
      const qy = bounds[base + 10];
      const qz = bounds[base + 11];
      const qw = bounds[base + 12];
      for (const corner of EDGES) {
        const lx = (corner & 1) === 0 ? minX : maxX;
        const ly = (corner & 2) === 0 ? minY : maxY;
        const lz = (corner & 4) === 0 ? minZ : maxZ;
        // q * v * q^-1, written out so nothing allocates.
        const ix = qw * lx + qy * lz - qz * ly;
        const iy = qw * ly + qz * lx - qx * lz;
        const iz = qw * lz + qx * ly - qy * lx;
        const iw = -qx * lx - qy * ly - qz * lz;
        positions[cursor] = px + ix * qw + iw * -qx + iy * -qz - iz * -qy;
        positions[cursor + 1] = py + iy * qw + iw * -qy + iz * -qx - ix * -qz;
        positions[cursor + 2] = pz + iz * qw + iw * -qz + ix * -qy - iy * -qx;
        cursor += 3;
      }
    }
    positions.fill(0, cursor);
    if (lines !== null) lines.geometry.attributes.position.needsUpdate = true;
  }

  return {
    attach(target: Scene): void {
      scene = target;
      if (lines === null) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(positions, 3));
        material = new LineBasicNodeMaterial({ color: 0x44ff88 });
        lines = new LineSegments(geometry, material);
        lines.frustumCulled = false;
      }
      target.add(lines);
      drawnRevision = -1;
    },

    detach(): void {
      scene = null;
      free();
    },

    update(): void {
      if (scene === null || lines === null) return;
      if (world.revision !== drawnRevision) rebuild();
      refresh();
    },

    dispose(): void {
      scene = null;
      free();
    },
  };
}
