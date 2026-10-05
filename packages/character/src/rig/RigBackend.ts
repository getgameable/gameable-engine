// The rig -> vertices stage, pluggable.
//
// Everything downstream of a rig backend is identical for every rig: the jacobians,
// the two lift passes, the decoders, the appearance pass. What differs is only how
// a control vector becomes posed vertices — Epic's RigLogic evaluated from a
// character's own DNA (`orl`), or Google's parametric head blended and skinned from
// a baked `.aosrig` pack (`gnm`). Swapping `"rig": "orl"` for `"gnm"` in a bundle's
// `scene.json` must change nothing else, which is what this interface is for.
//
// THE OUTPUT IS A GPU BUFFER, not an array. The posed vertices are born on the
// device the lift owns and go straight into `GpuLifter.setPoseGpu` — per frame that
// uploads a few tens of KB of joint matrices and coefficients instead of hundreds of
// KB of vertices, and there is no readback at all. `runCpu` exists for exactly one
// caller: calibration, which fits the rig->bundle similarity ONCE at load and is the
// only deliberate readback on the rig path.
//
// NO FENCES ARE NEEDED between `encode` and the lift. One device means one queue and
// WebGPU executes submissions in order, so a lift submitted after this pass provably
// reads finished output.

/** Which implementation is behind a backend, for logs and the manifest. */
export type RigKind = 'orl' | 'gnm';

/** Axis-aligned bounds of the posed vertices, in the rig's own units. */
export interface VertsAABB {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/** A per-joint override the animation layer applies on top of the solved rig. */
export interface JointOverride {
  /** Joint name in the backend's own namespace. */
  joint: string;
  /** Parent-relative rotation as a quaternion `(w, x, y, z)`. */
  rotation: readonly [number, number, number, number];
}

/** Everything a backend needs before it can pose anything. */
export interface RigBackendInit {
  /** The device the lift owns. A backend must build every buffer on THIS device. */
  device: GPUDevice;
  /** Bundle-relative file bytes, already resident. */
  getBytes: (name: string) => Uint8Array | undefined;
  /** Lazily fetch a bundle file the eager pass skipped. */
  fetchBytes?: (name: string) => Promise<Uint8Array>;
  /** The bundle's control-name list, in the order `setControls` takes values. */
  controlNames: string[];
  /** Expected vertex count; a mismatch throws rather than posing garbage. */
  expectVerts?: number;
}

/**
 * One rig -> vertices implementation.
 *
 * Lifecycle: `init` -> (`setControls` -> `encode`)* -> `dispose`. `setControls` is
 * pure CPU work (the solve); `encode` records the per-vertex half into a
 * caller-supplied encoder so a whole character is one submission.
 */
export interface RigBackend {
  /** Which implementation this is. */
  readonly kind: RigKind;
  /** The control space this backend drives, in `setControls` order. */
  readonly controlNames: readonly string[];
  /** Vertices produced per pose. */
  readonly vertexCount: number;

  /** Build the wasm/GPU resources. Idempotent; throws loudly on a bad asset. */
  init(options: RigBackendInit): Promise<void>;

  /**
   * Solve at `controls`. CPU-only and synchronous — there is no inference call to
   * await — so a caller may call it several times a frame and only `encode` once.
   */
  setControls(controls: Float32Array): void;

  /**
   * Apply per-joint rotation overrides on top of the solved pose (procedural head
   * aim, gaze). Optional: a backend with no addressable joints simply omits it.
   *
   * Returns whether anything actually MOVED. A converged head aim resends the same
   * quaternions every frame and a backend with no addressable joints ignores them
   * outright, so a caller that re-ran a full decode on every call was decoding an
   * idle character sixty times a second.
   */
  setJointOverrides?(overrides: readonly JointOverride[]): boolean;

  /** Record the per-vertex pass into `encoder`. No submit, no fence, no readback. */
  encode(encoder: GPUCommandEncoder): void;

  /**
   * The posed vertices, in the rig's own frame and units. Valid after the
   * `encode`d pass has executed; the lift's `copyBufferToBuffer` is what reads it.
   */
  readonly vertsBuffer: GPUBuffer;

  /** Bounds of the neutral pose, for the sink's bounding sphere. */
  readonly vertsAABB: VertsAABB;

  /**
   * Solve and deform ON THE CPU, for calibration only.
   *
   * The rig->bundle similarity and the per-vertex `corr` are fitted from this, and
   * `corr` is then added to every GPU-produced frame — so the two implementations
   * must agree. Never call it per frame.
   */
  runCpu(controls: Float32Array): Promise<Float32Array>;

  /** Approximate GPU + wasm bytes this backend holds, for `memoryReport()`. */
  bytes(): number;

  /** Release the wasm heap and every GPU buffer. Idempotent. */
  dispose(): void;
}
