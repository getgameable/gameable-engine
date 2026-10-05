import type { JoltModule, JoltShape } from './jolt.js';

/** Options shared by the geometry shape builders. */
export interface MeshShapeOptions {
  /**
   * Triangles per BVH leaf. Higher builds faster and uses less memory, lower
   * queries faster. Jolt's own default is 8.
   */
  maxTrianglesPerLeaf?: number;
}

/** Options for {@link convexHullFromPoints}. */
export interface ConvexHullOptions {
  /** Distance, in metres, below which the hull builder merges coplanar faces. */
  hullTolerance?: number;
  /** Maximum convex radius used to round the hull off. */
  maxConvexRadius?: number;
}

/**
 * Turn indexed triangle geometry into a Jolt `MeshShape`.
 *
 * A `MeshShape` is a triangle soup with a BVH over it: it can only back a
 * **static** body, which is exactly what splat-environment colliders and
 * baked level geometry are. Building one is expensive (it constructs a tree),
 * so build it once at load time and share it across every body that needs it.
 *
 * The returned shape carries one reference owned by *you*. `addBody` takes its
 * own reference, so the shape survives bodies being removed; call
 * `shape.Release()` when the geometry itself is gone.
 *
 * @param jolt The initialised Jolt module.
 * @param positions Vertex positions, stride 3 (x, y, z), in metres.
 * @param indices Triangle indices, three per triangle, into `positions`.
 * @param options Build tuning.
 * @returns A shape with a reference count of one.
 * @throws {Error} When the arrays are malformed or Jolt rejects the mesh.
 *
 * @example
 * ```ts
 * import { loadJolt, meshShapeFromGeometry } from 'gameable/physics';
 *
 * const jolt = await loadJolt();
 * const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
 * const indices = new Uint32Array([0, 1, 2]);
 * const shape = meshShapeFromGeometry(jolt, positions, indices);
 * shape.Release();
 * ```
 */
export function meshShapeFromGeometry(
  jolt: JoltModule,
  positions: Float32Array,
  indices: Uint32Array,
  options: MeshShapeOptions = {},
): JoltShape {
  if (positions.length % 3 !== 0) {
    throw new Error(`positions length ${String(positions.length)} is not a multiple of 3`);
  }
  if (indices.length % 3 !== 0) {
    throw new Error(`indices length ${String(indices.length)} is not a multiple of 3`);
  }
  const vertexCount = positions.length / 3;

  const vertices = new jolt.VertexList();
  const triangles = new jolt.IndexedTriangleList();
  const settings = new jolt.MeshShapeSettings();
  // `push_back` copies into the list, so one scratch vertex and one scratch
  // triangle are enough for the whole mesh. Building a wasm object per vertex
  // is what made baking a splat collider take seconds.
  const vertex = new jolt.Float3(0, 0, 0);
  const triangle = new jolt.IndexedTriangle(0, 0, 0, 0);
  try {
    vertices.reserve(vertexCount);
    for (let i = 0; i < vertexCount; i += 1) {
      vertex.x = positions[i * 3] ?? 0;
      vertex.y = positions[i * 3 + 1] ?? 0;
      vertex.z = positions[i * 3 + 2] ?? 0;
      vertices.push_back(vertex);
    }
    const triangleCount = indices.length / 3;
    triangles.reserve(triangleCount);
    for (let t = 0; t < triangleCount; t += 1) {
      const a = indices[t * 3] ?? 0;
      const b = indices[t * 3 + 1] ?? 0;
      const c = indices[t * 3 + 2] ?? 0;
      if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
        throw new Error(`triangle ${String(t)} indexes past the ${String(vertexCount)} vertices`);
      }
      triangle.set_mIdx(0, a);
      triangle.set_mIdx(1, b);
      triangle.set_mIdx(2, c);
      triangles.push_back(triangle);
    }
    settings.mTriangleVertices = vertices;
    settings.mIndexedTriangles = triangles;
    settings.mMaxTrianglesPerLeaf = options.maxTrianglesPerLeaf ?? 8;
    settings.Sanitize();
    return createShape(settings, 'mesh');
  } finally {
    jolt.destroy(triangle);
    jolt.destroy(vertex);
    jolt.destroy(settings);
    jolt.destroy(triangles);
    jolt.destroy(vertices);
  }
}

/**
 * Wrap a point cloud in its convex hull.
 *
 * Unlike a mesh shape a convex hull can back a dynamic body, so this is the
 * right shape for props lifted out of a splat scene: feed it the point cloud
 * of the region you want solid and Jolt builds the tightest convex volume
 * around it.
 *
 * The returned shape carries one reference owned by you; see
 * {@link meshShapeFromGeometry}.
 *
 * @param jolt The initialised Jolt module.
 * @param points Point positions, stride 3 (x, y, z), in metres.
 * @param options Hull build tuning.
 * @returns A shape with a reference count of one.
 * @throws {Error} When there are fewer than four points or Jolt cannot build a hull.
 *
 * @example
 * ```ts
 * import { convexHullFromPoints, loadJolt } from 'gameable/physics';
 *
 * const jolt = await loadJolt();
 * const cube = new Float32Array([
 *   -1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1,
 *   -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1,
 * ]);
 * const hull = convexHullFromPoints(jolt, cube);
 * hull.Release();
 * ```
 */
export function convexHullFromPoints(
  jolt: JoltModule,
  points: Float32Array,
  options: ConvexHullOptions = {},
): JoltShape {
  if (points.length % 3 !== 0) {
    throw new Error(`points length ${String(points.length)} is not a multiple of 3`);
  }
  const count = points.length / 3;
  if (count < 4) {
    throw new Error(`a convex hull needs at least 4 points, got ${String(count)}`);
  }

  const settings = new jolt.ConvexHullShapeSettings();
  try {
    const list = settings.mPoints;
    list.clear();
    list.reserve(count);
    const v = new jolt.Vec3(0, 0, 0);
    for (let i = 0; i < count; i += 1) {
      v.Set(points[i * 3] ?? 0, points[i * 3 + 1] ?? 0, points[i * 3 + 2] ?? 0);
      list.push_back(v);
    }
    jolt.destroy(v);
    if (options.hullTolerance !== undefined) settings.mHullTolerance = options.hullTolerance;
    if (options.maxConvexRadius !== undefined) settings.mMaxConvexRadius = options.maxConvexRadius;
    return createShape(settings, 'convex hull');
  } finally {
    jolt.destroy(settings);
  }
}

/** The `ShapeSettings.Create()` surface both builders use. */
interface BuildableSettings {
  /**
   * Build the shape.
   *
   * @returns Jolt's shape result, which carries either a shape or an error.
   */
  Create(): { HasError(): boolean; GetError(): { c_str(): string }; Get(): JoltShape };
}

/**
 * Run a `ShapeSettings` through `Create()` and take a reference on the result.
 *
 * @param settings Settings to build from.
 * @param what Label used in the error message.
 * @returns The built shape, reference count one.
 * @throws {Error} When Jolt reports a build error.
 */
function createShape(settings: BuildableSettings, what: string): JoltShape {
  const result = settings.Create();
  if (result.HasError()) {
    throw new Error(`could not build ${what} shape: ${result.GetError().c_str()}`);
  }
  const shape = result.Get();
  shape.AddRef();
  return shape;
}
