// A `GPUDevice` that records instead of rendering.
//
// Everything in this package that touches the GPU does so through a handful of calls:
// create a buffer, create a pipeline, create a bind group, record a compute pass,
// write a buffer, submit. None of them needs a real adapter to be exercised, and the
// two properties worth pinning are both invisible in a screenshot:
//
//   HOW MANY SUBMISSIONS a character update costs. `Character.ts` has claimed "one
//   submission per update" since it was written and it was `3B + 1` for B branches,
//   because `setPoseGpu`, `GpuPlucker.compute` and `GpuLifter.lift` each created and
//   submitted an encoder of their own.
//
//   HOW MANY BUFFER WRITES an IDLE character costs. A rig whose controls did not
//   change must not re-upload its expression coefficients, its skin rows or its UV
//   maps, and the only way to see that is to count.
//
// Nothing here validates WebGPU. A test that wants to know whether a shader is right
// belongs in `tests/e2e`, against a real adapter.

/** The real `GPUBufferUsage` bit values, which node does not define. */
export const FAKE_BUFFER_USAGE = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
} as const;

/** One recorded `queue.writeBuffer`, enough to tell which uniform moved. */
export interface FakeWrite {
  /** The destination buffer's label. */
  readonly label: string;
  /** Byte offset written at. */
  readonly offset: number;
  /** How many bytes were written. */
  readonly size: number;
}

/** The books a {@link FakeGpuDevice} keeps. */
export interface FakeGpuLog {
  /** One entry per `queue.submit`, holding that submission's pass labels. */
  readonly submits: string[][];
  /** Every `queue.writeBuffer`, in order. */
  readonly writes: FakeWrite[];
  /** Labels of every buffer created and not yet destroyed. */
  readonly liveBuffers: () => string[];
  /** Labels of every buffer destroyed. */
  readonly destroyed: string[];
  /** Forget everything recorded so far, so a test can measure one frame. */
  readonly reset: () => void;
}

/** A recording `GPUDevice` plus its books. */
export interface FakeGpuDevice {
  /** The device to hand to the code under test. */
  readonly device: GPUDevice;
  /** What it recorded. */
  readonly log: FakeGpuLog;
}

/**
 * Install the WebGPU enums node does not define.
 *
 * Call it from a `beforeEach`: several modules read `GPUBufferUsage.STORAGE` at
 * buffer-creation time, and an undefined global is a `TypeError` rather than a
 * meaningful failure.
 */
export function installGpuGlobals(): void {
  const global = globalThis as unknown as Record<string, unknown>;
  global.GPUBufferUsage ??= FAKE_BUFFER_USAGE;
  global.GPUMapMode ??= { READ: 0x0001, WRITE: 0x0002 };
}

/**
 * A `GPUDevice` that records the calls this package makes and does nothing else.
 *
 * @param limits Overrides for `device.limits`; the default grants the eight storage
 *   buffers per shader stage `prepareLiftDevice` insists on and the 64 KB uniform
 *   binding the ORL skin rows are checked against.
 * @returns The device and the log of everything recorded through it.
 */
export function createFakeGpuDevice(limits: Record<string, number> = {}): FakeGpuDevice {
  installGpuGlobals();

  const submits: string[][] = [];
  const writes: FakeWrite[] = [];
  const destroyed: string[] = [];
  const live = new Set<string>();
  let nextBuffer = 0;

  const makeBuffer = (descriptor: { label?: string; size: number; usage: number }): GPUBuffer => {
    const label = descriptor.label ?? `buffer_${String(nextBuffer++)}`;
    live.add(label);
    return {
      label,
      size: descriptor.size,
      usage: descriptor.usage,
      mapState: 'unmapped',
      destroy() {
        live.delete(label);
        destroyed.push(label);
      },
    } as unknown as GPUBuffer;
  };

  const labelOf = (buffer: GPUBuffer): string =>
    (buffer as unknown as { label?: string }).label ?? '(unlabelled)';

  const makeEncoder = (): GPUCommandEncoder => {
    const passes: string[] = [];
    return {
      label: '',
      beginComputePass(descriptor?: { label?: string }) {
        passes.push(descriptor?.label ?? 'compute');
        return {
          setPipeline() {
            /* recorded by label alone */
          },
          setBindGroup() {
            /* recorded by label alone */
          },
          dispatchWorkgroups() {
            /* recorded by label alone */
          },
          end() {
            /* recorded by label alone */
          },
        };
      },
      copyBufferToBuffer() {
        passes.push('copy');
      },
      finish() {
        // The command buffer IS its pass list, so `queue.submit` can record what
        // each submission actually carried.
        return { passes } as unknown as GPUCommandBuffer;
      },
    } as unknown as GPUCommandEncoder;
  };

  const device = {
    limits: {
      maxStorageBuffersPerShaderStage: 8,
      maxUniformBufferBindingSize: 65536,
      maxBindGroups: 4,
      ...limits,
    },
    features: new Set<string>(),
    queue: {
      writeBuffer(
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBufferLike | ArrayBufferView,
        _dataOffset?: number,
        size?: number,
      ) {
        const bytes =
          size ?? (ArrayBuffer.isView(data) ? data.byteLength : (data as ArrayBuffer).byteLength);
        writes.push({ label: labelOf(buffer), offset, size: bytes });
      },
      submit(buffers: GPUCommandBuffer[]) {
        for (const buffer of buffers) {
          submits.push([...(buffer as unknown as { passes: string[] }).passes]);
        }
      },
      onSubmittedWorkDone: () => Promise.resolve(),
    },
    createBuffer: makeBuffer,
    createCommandEncoder: makeEncoder,
    createShaderModule: (descriptor: { code: string; label?: string }) => ({
      label: descriptor.label ?? '',
    }),
    createComputePipeline: (descriptor: { label?: string }) => ({
      label: descriptor.label ?? '',
      getBindGroupLayout: (index: number) => ({ index }),
    }),
    createBindGroup: (descriptor: { label?: string }) => ({ label: descriptor.label ?? '' }),
    destroy() {
      /* nothing to release */
    },
  } as unknown as GPUDevice;

  return {
    device,
    log: {
      submits,
      writes,
      destroyed,
      liveBuffers: () => [...live],
      reset() {
        submits.length = 0;
        writes.length = 0;
        destroyed.length = 0;
      },
    },
  };
}
