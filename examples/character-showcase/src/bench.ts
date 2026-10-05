/**
 * `?bench=1` — what the rig and the sort actually cost, on a real GPU.
 *
 * IT BUILDS ITS OWN RENDERER, exactly as the splat viewer's benchmark does, for one
 * reason: `trackTimestamp: true` is a `WebGPURenderer` constructor parameter that
 * `createEngine` does not expose, and without it three requests no `timestamp-query`
 * feature — so neither its own sort timings nor this file's query set exist. A game would
 * never want the per-frame timestamp readback anyway.
 *
 * HOW THE RIG IS TIMED. A compute pass's `timestampWrites` is the only timestamp WebGPU
 * offers without an optional feature, and the rig pass and the debug lift are recorded by
 * code that does not take one. So the encoder gets two EMPTY compute passes as markers,
 * one before and one after, and the span between marker one's END and marker two's
 * BEGINNING is the GPU time of everything in between. That measures the pair as the frame
 * actually runs them, rather than instrumenting the shaders and measuring something else.
 */
import { createAnimatedSplat, type AnimatedSplat } from 'gameable/splat';
import { createRigPreview, prepareLiftDevice, type RigPreview } from 'gameable/character';
import { attachSrgbPass } from 'gameable/core';
import { Color, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';

import { percentile } from './ui';

/** What `?bench=1` publishes on `window.__AOS_BENCH__`. */
export interface BenchReport {
  backend: string;
  rig: string;
  pack: string;
  vertices: number;
  coefficients: number;
  frames: number;
  /** GPU milliseconds for the rig blend + the debug lift, together. */
  rigMsP50: number;
  rigMsP95: number;
  /** GPU milliseconds three spent in compute during the render — the splat sort. */
  sortMsP50: number;
  /** GPU milliseconds of the render pass itself. */
  renderMsP50: number;
  /** The number the acceptance is stated against. */
  rigPlusSortMsP50: number;
  frameMsP50: number;
  frameMsP95: number;
  /** Sorts dispatched per frame. Must be 1: the vertices move every frame. */
  sortsPerFrame: number;
  /** `queue.writeBuffer` calls per frame — the rig's uniforms, and nothing per-vertex. */
  writeBufferPerFrame: number;
  writeBufferBytesPerFrame: number;
  /** Uncaptured WebGPU validation errors seen during the run. */
  validationErrors: string[];
}

/** What {@link runBench} needs. */
export interface BenchOptions {
  canvas: HTMLCanvasElement;
  /** A fully built, uninitialised backend factory — run after the device exists. */
  makeBackend: () => Parameters<typeof createRigPreview>[0]['backend'];
  getBytes: (name: string) => Uint8Array | undefined;
  /** A `head_ext` vector per frame, so the rig re-solves and re-uploads every frame. */
  controlsFor: (frame: number) => Float32Array;
  rig: string;
  pack: string;
  coefficients: number;
  frames?: number;
  sigma?: number;
}

/** Frames rendered before anything is recorded. */
const WARMUP = 30;

/**
 * Slots the sink holds.
 *
 * The shipped head is 17,821 vertices; 32,768 leaves room for a re-bake without a second
 * code path, and an unused slot costs 48 bytes and renders nothing (the debug lift clears
 * the tail of its range rather than leaving it stale).
 */
const SINK_CAPACITY = 32_768;

/**
 * Run the timed loop.
 *
 * @param options See {@link BenchOptions}.
 * @returns The report.
 */
export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const frames = options.frames ?? 180;
  const renderer = new WebGPURenderer({
    canvas: options.canvas,
    antialias: false,
    trackTimestamp: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(options.canvas.clientWidth || 800, options.canvas.clientHeight || 600);
  await renderer.init();

  const device = prepareLiftDevice(renderer);
  const validationErrors: string[] = [];
  const onError = (event: Event): void => {
    validationErrors.push((event as GPUUncapturedErrorEvent).error.message);
  };
  device.addEventListener('uncapturederror', onError);

  // Count what the frame uploads: the rig's own uniforms are a few hundred bytes, and
  // anything per-vertex would show up here as kilobytes.
  const queue = device.queue;
  const originalWriteBuffer = queue.writeBuffer.bind(queue);
  let writeBufferCalls = 0;
  let writeBufferBytes = 0;
  queue.writeBuffer = (...args: Parameters<GPUQueue['writeBuffer']>) => {
    writeBufferCalls += 1;
    writeBufferBytes += args[2].byteLength;
    originalWriteBuffer(...args);
  };

  let sink: AnimatedSplat | null = null;
  let preview: RigPreview | null = null;
  const querySet = device.features.has('timestamp-query')
    ? device.createQuerySet({ type: 'timestamp', count: 4 })
    : null;
  const resolveBuffer =
    querySet === null
      ? null
      : device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
  const readBuffer =
    querySet === null
      ? null
      : device.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  try {
    const splatSink = await createAnimatedSplat(renderer, { capacity: SINK_CAPACITY });
    sink = splatSink;
    const probe = await createRigPreview({
      device,
      sink: splatSink,
      backend: options.makeBackend(),
      getBytes: options.getBytes,
      sigma: options.sigma ?? 0.002,
    });
    preview = probe;

    const scene = new Scene();
    scene.background = new Color(0x0d0d12);
    scene.add(splatSink.object3D);
    // the sink is sRGB, as a character is: drawn by the sRGB pass
    attachSrgbPass(renderer, scene);
    const camera = new PerspectiveCamera(35, 4 / 3, 0.05, 50);
    camera.position.set(0, 0, 0.75);
    camera.lookAt(0, 0, 0);

    const rigMs: number[] = [];
    const sortMs: number[] = [];
    const renderMs: number[] = [];
    const frameMs: number[] = [];
    let sorts = 0;
    let writeCallsAtStart = 0;
    let writeBytesAtStart = 0;
    let timingBusy = false;

    const splat = splatSink.splat as unknown as {
      updateSort: (r: never, c: never) => boolean;
    };
    const originalUpdateSort = splat.updateSort.bind(splat);
    splat.updateSort = (r, c) => {
      const dispatched = originalUpdateSort(r, c);
      if (dispatched) sorts += 1;
      return dispatched;
    };

    let last = performance.now();
    for (let frame = 0; frame < WARMUP + frames; frame++) {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (frame === WARMUP) {
        writeCallsAtStart = writeBufferCalls;
        writeBytesAtStart = writeBufferBytes;
        sorts = 0;
      }

      probe.setControls(options.controlsFor(frame));

      const encoder = device.createCommandEncoder({ label: 'showcase:bench' });
      const timeThis =
        querySet !== null && resolveBuffer !== null && readBuffer !== null && !timingBusy;
      if (timeThis) marker(encoder, querySet, 0);
      probe.encode(encoder);
      if (timeThis) {
        marker(encoder, querySet, 2);
        encoder.resolveQuerySet(querySet, 0, 4, resolveBuffer, 0);
        encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, 32);
      }
      device.queue.submit([encoder.finish()]);
      // The vertices moved, so the previous depth order is stale whatever the camera did.
      splatSink.markGaussiansChanged();

      if (timeThis) {
        timingBusy = true;
        const measuring = frame >= WARMUP;
        void readBuffer.mapAsync(GPUMapMode.READ).then(
          () => {
            const stamps = new BigUint64Array(readBuffer.getMappedRange().slice(0));
            readBuffer.unmap();
            // Marker 1 ends before the rig pass; marker 2 begins after the lift.
            const ns = Number(stamps[2] - stamps[1]);
            if (ns > 0 && measuring) rigMs.push(ns / 1e6);
            timingBusy = false;
          },
          () => {
            timingBusy = false;
          },
        );
      }

      renderer.render(scene, camera);
      const renderGpu = (await renderer.resolveTimestampsAsync('render').catch(() => 0)) ?? 0;
      const computeGpu = (await renderer.resolveTimestampsAsync('compute').catch(() => 0)) ?? 0;
      if (frame >= WARMUP) {
        if (renderGpu > 0) renderMs.push(renderGpu);
        // three times only its own compute calls, which for a splat is exactly the sort.
        if (computeGpu > 0) sortMs.push(computeGpu);
        frameMs.push(dt);
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    }

    const divisor = Math.max(1, frameMs.length);
    const rigP50 = percentile(rigMs, 0.5);
    const sortP50 = percentile(sortMs, 0.5);
    return {
      backend: 'webgpu',
      rig: options.rig,
      pack: options.pack,
      vertices: probe.backend.vertexCount,
      coefficients: options.coefficients,
      frames: frameMs.length,
      rigMsP50: rigP50,
      rigMsP95: percentile(rigMs, 0.95),
      sortMsP50: sortP50,
      renderMsP50: percentile(renderMs, 0.5),
      rigPlusSortMsP50: rigP50 + sortP50,
      frameMsP50: percentile(frameMs, 0.5),
      frameMsP95: percentile(frameMs, 0.95),
      sortsPerFrame: sorts / divisor,
      writeBufferPerFrame: (writeBufferCalls - writeCallsAtStart) / divisor,
      writeBufferBytesPerFrame: (writeBufferBytes - writeBytesAtStart) / divisor,
      validationErrors,
    };
  } finally {
    queue.writeBuffer = originalWriteBuffer;
    device.removeEventListener('uncapturederror', onError);
    preview?.dispose();
    sink?.dispose();
    readBuffer?.destroy();
    resolveBuffer?.destroy();
    querySet?.destroy();
  }
}

/**
 * An empty compute pass that writes two timestamps.
 *
 * A pass with no pipeline and no dispatch is legal and does nothing, which is the point:
 * the timestamps land on the GPU timeline where the pass sits, so the gap between two
 * markers is the GPU time of the work recorded between them.
 *
 * @param encoder The frame's encoder.
 * @param querySet A 4-entry timestamp query set.
 * @param index First of the two indices this marker writes.
 */
function marker(encoder: GPUCommandEncoder, querySet: GPUQuerySet, index: number): void {
  const pass = encoder.beginComputePass({
    label: `showcase:marker${String(index)}`,
    timestampWrites: {
      querySet,
      beginningOfPassWriteIndex: index,
      endOfPassWriteIndex: index + 1,
    },
  });
  pass.end();
}
