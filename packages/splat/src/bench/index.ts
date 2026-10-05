/**
 * The splat benchmarks: spike S1 (static sort cost) and S2 (dynamic producer) as a library.
 *
 * They are library functions rather than a script because three things need them and must
 * agree: the viewer's `?bench=1` mode, the Playwright e2e suite, and whoever is bisecting a
 * regression after a three upgrade. Each runs a fixed camera path so the sort cadence does
 * not depend on how fast the machine is, and reports medians.
 *
 * What is measured, and why those and not others:
 *
 * - **sort** is the dominant new cost of splat rendering and the thing the whole plan budgets.
 * - **writeBuffer calls per frame** is the claim the dynamic path exists to make: gaussians
 *   reach the GPU without a CPU round trip. It counts *every* upload the process makes, so a
 *   producer that quietly falls back to `writeBuffer` cannot hide.
 * - **validation errors** because a WebGPU validation error is silent by default and a bench
 *   that reports fast, wrong numbers is worse than no bench.
 */
import { attachSrgbPass, type SrgbPass } from '@gameable/core/render';
import { Color, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';

import { createAnimatedSplat } from '../AnimatedSplat.js';
import { getGPUDevice, isWebGPUBackend } from '../backendBuffers.js';
import { createSplatObject, loadSplat } from '../static.js';
import { ANIMATE_PARAMS_BYTES, ANIMATE_WGSL, ANIMATE_WORKGROUP_SIZE } from './animateWgsl.js';

export { ANIMATE_WGSL, covarianceFromAxisAngle } from './animateWgsl.js';

/**
 * Degrees the camera turns per frame.
 *
 * Above three's `SORT_DIRECTION_THRESHOLD` (0.9995, about 1.81 degrees), so the *static* case
 * re-sorts on every single frame. That is the worst case, which is the only case worth
 * budgeting.
 */
export const BENCH_DEGREES_PER_FRAME = 2;

/** Frames discarded before measurement, to let shader compilation and caches settle. */
export const BENCH_WARMUP_FRAMES = 30;

/** What a benchmark run reports. */
export interface BenchResult {
  /** `'dynamic'` or `'static'`. */
  readonly mode: 'dynamic' | 'static';
  /** `'webgpu'` or `'webgl'`. */
  readonly backend: 'webgpu' | 'webgl';
  /** Gaussians rendered. */
  readonly count: number;
  /** Measured frames, excluding warm-up. */
  readonly frames: number;

  /**
   * Median sort cost in milliseconds.
   *
   * On WebGPU this is GPU time for three's four `CountingSort` compute passes. On the WebGL
   * fallback there is no GPU sort, so it is the CPU time of `_sortCPU` instead — the number
   * that actually blocks the frame there.
   */
  readonly sortMsP50: number;
  /** Median GPU time for the render pass, in milliseconds. `NaN` without `trackTimestamp`. */
  readonly gpuMsP50: number;
  /** Median GPU time for the producer's compute pass. `NaN` in static mode. */
  readonly animateMsP50: number;
  /** Median CPU time inside `updateSort`, in milliseconds. */
  readonly sortCpuMsP50: number;
  /** Median wall-clock frame time, in milliseconds. */
  readonly frameMsP50: number;
  /** 95th percentile wall-clock frame time. */
  readonly frameMsP95: number;

  /**
   * Sorts dispatched per frame. `1` means every frame re-sorted, which is the intent in
   * dynamic mode and the worst case in static mode.
   */
  readonly sortsPerFrame: number;
  /** `queue.writeBuffer` calls per frame, across the whole process. */
  readonly writeBufferPerFrame: number;
  /** Bytes uploaded per frame by those calls. */
  readonly writeBufferBytesPerFrame: number;
  /** WebGPU validation errors seen during the run. Empty is the only passing value. */
  readonly validationErrors: readonly string[];
}

/** Options shared by both benchmarks. */
interface BenchCommonOptions {
  /** Frames to measure, after warm-up. Defaults to 200. */
  readonly frames?: number;
  /**
   * Resolve GPU timestamps each frame. Defaults to `true`. The readback stalls the JS loop,
   * so `frameMsP50` is only an honest wall-clock number with this off.
   */
  readonly timestamps?: boolean;
}

/** Options accepted by {@link benchDynamic}. */
export interface BenchDynamicOptions extends BenchCommonOptions {
  /** Gaussians to animate. */
  readonly n: number;
}

/** Options accepted by {@link benchStatic}. */
export interface BenchStaticOptions extends BenchCommonOptions {
  /** A splat file to load. */
  readonly url: string;
}

/**
 * Percentile of a sample, nearest-rank.
 *
 * @param values The sample. Not mutated.
 * @param p Quantile in `[0, 1]`.
 * @returns The value, or `NaN` for an empty sample.
 */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

/** Everything a run collects. */
interface Probe {
  readonly sortCpuMs: number[];
  readonly sortGpuMs: number[];
  readonly renderGpuMs: number[];
  readonly animateGpuMs: number[];
  readonly frameMs: number[];
  readonly validationErrors: string[];
  sorts: number;
  writeBufferCalls: number;
  writeBufferBytes: number;
  writeBufferCallsAtStart: number;
  writeBufferBytesAtStart: number;
  restore: () => void;
}

/** Anything whose `updateSort` can be wrapped. */
interface SortableSplat {
  updateSort(renderer: WebGPURenderer, camera: PerspectiveCamera): boolean;
}

/**
 * Instrument the device queue and the splat's sort for one run.
 *
 * @param renderer The renderer under test.
 * @param splat The splat whose `updateSort` is timed.
 * @returns The probe, with a `restore` that undoes both hooks.
 */
function instrument(renderer: WebGPURenderer, splat: SortableSplat): Probe {
  const probe: Probe = {
    sortCpuMs: [],
    sortGpuMs: [],
    renderGpuMs: [],
    animateGpuMs: [],
    frameMs: [],
    validationErrors: [],
    sorts: 0,
    writeBufferCalls: 0,
    writeBufferBytes: 0,
    writeBufferCallsAtStart: 0,
    writeBufferBytesAtStart: 0,
    restore: () => undefined,
  };

  const originalUpdateSort = splat.updateSort.bind(splat);
  splat.updateSort = (r, camera) => {
    const t0 = performance.now();
    const dispatched = originalUpdateSort(r, camera);
    if (dispatched) {
      probe.sorts += 1;
      probe.sortCpuMs.push(performance.now() - t0);
    }
    return dispatched;
  };

  let restoreQueue = (): void => undefined;
  if (isWebGPUBackend(renderer)) {
    const device = getGPUDevice(renderer);
    const queue = device.queue;
    const original = queue.writeBuffer.bind(queue);
    queue.writeBuffer = (...args: Parameters<GPUQueue['writeBuffer']>) => {
      probe.writeBufferCalls += 1;
      probe.writeBufferBytes += args[2].byteLength;
      original(...args);
    };

    const onError = (event: Event): void => {
      probe.validationErrors.push((event as GPUUncapturedErrorEvent).error.message);
    };
    device.addEventListener('uncapturederror', onError);

    restoreQueue = () => {
      queue.writeBuffer = original;
      device.removeEventListener('uncapturederror', onError);
    };
  }

  probe.restore = () => {
    // @ts-expect-error putting the prototype method back where the instance override was
    delete splat.updateSort;
    restoreQueue();
  };
  return probe;
}

/**
 * Turn a probe into a result.
 *
 * @param probe The collected samples.
 * @param mode Which benchmark ran.
 * @param backend Which backend ran it.
 * @param count Gaussians rendered.
 * @param frames Measured frames.
 * @returns The report.
 */
function summarise(
  probe: Probe,
  mode: 'dynamic' | 'static',
  backend: 'webgpu' | 'webgl',
  count: number,
  frames: number,
): BenchResult {
  const sortCpuMsP50 = percentile(probe.sortCpuMs, 0.5);
  const divisor = Math.max(1, frames);
  return {
    mode,
    backend,
    count,
    frames,
    sortMsP50: backend === 'webgpu' ? percentile(probe.sortGpuMs, 0.5) : sortCpuMsP50,
    gpuMsP50: percentile(probe.renderGpuMs, 0.5),
    animateMsP50: percentile(probe.animateGpuMs, 0.5),
    sortCpuMsP50,
    frameMsP50: percentile(probe.frameMs, 0.5),
    frameMsP95: percentile(probe.frameMs, 0.95),
    sortsPerFrame: probe.sorts / divisor,
    writeBufferPerFrame: (probe.writeBufferCalls - probe.writeBufferCallsAtStart) / divisor,
    writeBufferBytesPerFrame: (probe.writeBufferBytes - probe.writeBufferBytesAtStart) / divisor,
    validationErrors: probe.validationErrors,
  };
}

/** One frame of the fixed camera path plus the render, shared by both benchmarks. */
interface FrameContext {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly probe: Probe;
  readonly frames: number;
  readonly timestamps: boolean;
  /** Called before `render`, with elapsed seconds. */
  readonly onFrame?: (elapsedSeconds: number) => void;
}

/**
 * Drive the fixed camera path for `warmup + frames` frames.
 *
 * @param ctx Everything the loop needs.
 * @returns Resolves when the run is over.
 */
async function runFrames(ctx: FrameContext): Promise<void> {
  const { renderer, scene, camera, probe } = ctx;
  const target = new Vector3().copy(scene.userData.target as Vector3);
  const radius = camera.position.distanceTo(target);
  const height = camera.position.y - target.y;
  const step = (BENCH_DEGREES_PER_FRAME * Math.PI) / 180;
  const total = BENCH_WARMUP_FRAMES + ctx.frames;
  const start = performance.now();

  let theta = 0;
  let last = performance.now();

  for (let frame = 0; frame < total; frame += 1) {
    const now = performance.now();
    const dt = now - last;
    last = now;

    theta += step;
    camera.position.set(
      target.x + Math.sin(theta) * radius,
      target.y + height,
      target.z + Math.cos(theta) * radius,
    );
    camera.lookAt(target);

    if (frame === BENCH_WARMUP_FRAMES) {
      probe.writeBufferCallsAtStart = probe.writeBufferCalls;
      probe.writeBufferBytesAtStart = probe.writeBufferBytes;
      probe.sorts = 0;
    }

    ctx.onFrame?.((now - start) / 1000);

    renderer.render(scene, camera);

    if (ctx.timestamps) {
      const renderMs = (await renderer.resolveTimestampsAsync('render').catch(() => 0)) ?? 0;
      const computeMs = (await renderer.resolveTimestampsAsync('compute').catch(() => 0)) ?? 0;
      if (frame >= BENCH_WARMUP_FRAMES) {
        if (renderMs > 0) probe.renderGpuMs.push(renderMs);
        // three only times its own compute calls, which for a splat is exactly the sort.
        if (computeMs > 0) probe.sortGpuMs.push(computeMs);
      }
    }

    if (frame >= BENCH_WARMUP_FRAMES) probe.frameMs.push(dt);

    // Yield to the compositor so the numbers are per-frame rather than per-microtask.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  }
}

/**
 * Build the scene both benchmarks render into.
 *
 * @param target Where the camera looks.
 * @param distance How far away it starts.
 * @returns A scene (with `userData.target`) and a camera on the path, and the sRGB pass that draws
 *   its splats (they are sRGB, as the engine draws them).
 */
function makeScene(
  renderer: WebGPURenderer,
  target: Vector3,
  distance: number,
): { scene: Scene; camera: PerspectiveCamera; pass: SrgbPass } {
  const scene = new Scene();
  scene.background = new Color(0x101014);
  scene.userData.target = target;
  const camera = new PerspectiveCamera(60, 4 / 3, 0.05, 500);
  camera.position.set(target.x, target.y + distance * 0.25, target.z + distance);
  return { scene, camera, pass: attachSrgbPass(renderer, scene) };
}

/**
 * Spike S2: `n` gaussians rewritten by a compute pass every frame, re-sorted every frame.
 *
 * The pass's 16-byte params uniform goes through a ring of persistently-mapped staging
 * buffers and a `copyBufferToBuffer`, not `queue.writeBuffer`, so `writeBufferPerFrame` stays
 * a measurement of the *splat* path rather than of the benchmark's own fixture.
 *
 * @param renderer An initialised `WebGPURenderer` on the WebGPU backend, ideally built with
 *   `trackTimestamp: true`.
 * @param options Gaussian count and frame count.
 * @returns The report.
 * @throws {Error} When the renderer fell back to WebGL; dynamic splats do not run there.
 *
 * @example
 * ```ts
 * import { benchDynamic } from 'gameable/splat/bench';
 *
 * const result = await benchDynamic(renderer, { n: 250_000, frames: 200 });
 * console.log(result.sortMsP50, result.writeBufferPerFrame);
 * ```
 */
export async function benchDynamic(
  renderer: WebGPURenderer,
  options: BenchDynamicOptions,
): Promise<BenchResult> {
  const { n } = options;
  const frames = options.frames ?? 200;
  const timestamps = options.timestamps ?? true;
  const device = getGPUDevice(renderer);

  const boxHalf = 7;
  const { scene, camera, pass } = makeScene(renderer, new Vector3(0, 0, 0), boxHalf * 2.2);

  const sink = await createAnimatedSplat(renderer, {
    capacity: n,
    boundingSphere: { center: [0, 0, 0], radius: boxHalf * 1.6 },
  });
  sink.allocate(n);
  scene.add(sink.object3D);

  const module = device.createShaderModule({ code: ANIMATE_WGSL, label: 'aos:animateGaussians' });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const params = device.createBuffer({
    size: ANIMATE_PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: 'aos:animateParams',
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: sink.buffers.center } },
      { binding: 1, resource: { buffer: sink.buffers.covarianceA } },
      { binding: 2, resource: { buffer: sink.buffers.covarianceB } },
      { binding: 3, resource: { buffer: sink.buffers.color } },
      { binding: 4, resource: { buffer: params } },
    ],
  });

  // A ring of mapped staging buffers, so the per-frame uniform costs no writeBuffer call.
  const ring: { buffer: GPUBuffer; mapped: boolean }[] = [];
  for (let i = 0; i < 3; i += 1) {
    ring.push({
      buffer: device.createBuffer({
        size: ANIMATE_PARAMS_BYTES,
        usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
        label: `aos:animateParamsStaging${String(i)}`,
        mappedAtCreation: true,
      }),
      mapped: true,
    });
  }

  const scratch = new ArrayBuffer(ANIMATE_PARAMS_BYTES);
  const scratchF32 = new Float32Array(scratch);
  const scratchU32 = new Uint32Array(scratch);
  const scratchBytes = new Uint8Array(scratch);
  const workgroups = Math.ceil(n / ANIMATE_WORKGROUP_SIZE);
  let cursor = 0;

  const timing = device.features.has('timestamp-query')
    ? {
        set: device.createQuerySet({ type: 'timestamp', count: 2 }),
        resolve: device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        }),
        read: device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
      }
    : null;
  let timingBusy = false;

  const probe = instrument(renderer, sink.splat);
  let measuring = false;

  try {
    await runFrames({
      renderer,
      scene,
      camera,
      probe,
      frames,
      timestamps,
      onFrame: (elapsed) => {
        scratchF32[0] = elapsed;
        scratchU32[1] = n;
        scratchF32[2] = boxHalf;
        scratchF32[3] = 0.6;

        let slot: { buffer: GPUBuffer; mapped: boolean } | null = null;
        for (let i = 0; i < ring.length; i += 1) {
          const candidate = ring[(cursor + i) % ring.length];
          if (candidate.mapped) {
            slot = candidate;
            cursor = (cursor + i + 1) % ring.length;
            break;
          }
        }

        const encoder = device.createCommandEncoder({ label: 'aos:animateGaussians' });
        if (slot !== null) {
          new Uint8Array(slot.buffer.getMappedRange()).set(scratchBytes);
          slot.buffer.unmap();
          slot.mapped = false;
          encoder.copyBufferToBuffer(slot.buffer, 0, params, 0, ANIMATE_PARAMS_BYTES);
        }

        const timeThis = timing !== null && !timingBusy;
        const pass = encoder.beginComputePass({
          label: 'aos:animateGaussiansPass',
          ...(timeThis
            ? {
                timestampWrites: {
                  querySet: timing.set,
                  beginningOfPassWriteIndex: 0,
                  endOfPassWriteIndex: 1,
                },
              }
            : {}),
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(workgroups);
        pass.end();
        if (timeThis) {
          encoder.resolveQuerySet(timing.set, 0, 2, timing.resolve, 0);
          encoder.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, 16);
        }
        device.queue.submit([encoder.finish()]);

        if (timeThis) {
          timingBusy = true;
          void timing.read.mapAsync(GPUMapMode.READ).then(
            () => {
              const stamps = new BigUint64Array(timing.read.getMappedRange().slice(0));
              timing.read.unmap();
              const ns = Number(stamps[1] - stamps[0]);
              if (ns > 0 && measuring) probe.animateGpuMs.push(ns / 1e6);
              timingBusy = false;
            },
            () => {
              timingBusy = false;
            },
          );
        }

        if (slot !== null) {
          const held = slot;
          void held.buffer.mapAsync(GPUMapMode.WRITE).then(
            () => {
              held.mapped = true;
            },
            () => undefined,
          );
        }

        // The gaussians moved, so the previous depth order is stale whatever the camera did.
        sink.markGaussiansChanged();
        measuring = probe.frameMs.length > 0;
      },
    });
  } finally {
    probe.restore();
  }

  const result = summarise(probe, 'dynamic', 'webgpu', n, frames);

  scene.remove(sink.object3D);
  pass.dispose();
  sink.dispose();
  params.destroy();
  for (const slot of ring) slot.buffer.destroy();
  timing?.resolve.destroy();
  timing?.read.destroy();
  timing?.set.destroy();

  return result;
}

/**
 * Spike S1: a static splat file, re-sorted every frame by a camera that turns past the
 * threshold.
 *
 * Runs on both backends. On the WebGL fallback, `sortMsP50` is the CPU sort, which is the
 * number that decides whether a given splat count is playable there at all.
 *
 * @param renderer An initialised renderer, ideally built with `trackTimestamp: true`.
 * @param options The file to load and the frame count.
 * @returns The report.
 *
 * @example
 * ```ts
 * import { benchStatic } from 'gameable/splat/bench';
 *
 * const result = await benchStatic(renderer, { url: '/models/arena.spz', frames: 200 });
 * console.log(result.count, result.sortMsP50);
 * ```
 */
export async function benchStatic(
  renderer: WebGPURenderer,
  options: BenchStaticOptions,
): Promise<BenchResult> {
  const frames = options.frames ?? 200;
  const timestamps = options.timestamps ?? true;

  const asset = await loadSplat(options.url);
  const splat = createSplatObject(asset);
  const sphere = splat.boundingSphere ?? asset.boundingSphere;
  const { scene, camera, pass } = makeScene(
    renderer,
    sphere.center.clone(),
    Math.max(0.5, sphere.radius * 2),
  );
  scene.add(splat);

  const probe = instrument(renderer, splat);
  try {
    await runFrames({ renderer, scene, camera, probe, frames, timestamps });
  } finally {
    probe.restore();
  }

  const result = summarise(
    probe,
    'static',
    isWebGPUBackend(renderer) ? 'webgpu' : 'webgl',
    asset.count,
    frames,
  );

  scene.remove(splat);
  pass.dispose();
  splat.geometry.dispose();
  splat.material.dispose();
  asset.geometry.dispose();

  return result;
}
