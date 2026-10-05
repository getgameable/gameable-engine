/**
 * The splat viewer.
 *
 * Four things, chosen by query string, that between them exercise everything
 * `gameable/splat` does:
 *
 * | Query | What runs |
 * | --- | --- |
 * | *(none)* or `?model=<url>` | Static path: `loadSplat` through the engine's asset registry |
 * | `?mode=dynamic&n=250000` | Dynamic path: the fork plus a WGSL producer writing every frame |
 * | `?backend=webgl` | Same, on the WebGL fallback — static only, by design |
 * | `?bench=1` | Spike S1/S2 as a measurement, into `window.__AOS_BENCH__` and `<pre id="bench">` |
 *
 * Everything except `?bench=1` boots through `createEngine` with the `splat()` module, because
 * that is the path a game takes. The benchmark builds its own renderer: it needs
 * `trackTimestamp: true`, which is a renderer construction parameter the engine does not
 * expose, and a game would never want the per-frame timestamp readback anyway.
 */
import { createEngine, type EngineContext, type EngineModule } from 'gameable/core';
import {
  createAnimatedSplat,
  getGPUDevice,
  isWebGPUBackend,
  type AnimatedSplat,
} from 'gameable/splat';
import { splat } from 'gameable/splat';
import { ANIMATE_WGSL, benchDynamic, benchStatic, type BenchResult } from 'gameable/splat/bench';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Color, Vector3, WebGPURenderer } from 'three/webgpu';
import type { PerspectiveCamera } from 'three/webgpu';

const query = new URLSearchParams(location.search);
const modelUrl = query.get('model') ?? '/models/synthetic_150k.spz';
const mode = query.get('mode') === 'dynamic' ? 'dynamic' : 'static';
const forceWebGL = query.get('backend') === 'webgl';
const gaussians = Number(query.get('n') ?? 250000);
const benchFrames = Number(query.get('frames') ?? 200);
const isBench = query.get('bench') === '1';
/** Fixed degrees per *frame*, so the sort cadence does not depend on machine speed. */
const orbitDegreesPerFrame = Number(query.get('deg') ?? 2);
const autoOrbit = query.get('orbit') !== '0';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const statsElement = document.getElementById('stats') as HTMLElement;
const benchElement = document.getElementById('bench') as HTMLElement;
const errorElement = document.getElementById('error') as HTMLElement;

/** Everything the benchmark hands back, plus what the page did to get it. */
declare global {
  interface Window {
    /** Set by `?bench=1` once the run finishes. The e2e suite waits on it. */
    __AOS_BENCH__?: BenchResult & { url: string };
    /** Set once the viewer has rendered its first frame. The e2e suite waits on it. */
    __AOS_READY__?: { mode: string; backend: string; splats: number };
    /** Anything that went wrong, so a failure is a message and not a blank canvas. */
    __AOS_ERROR__?: string;
  }
}

/**
 * Show a failure instead of a black screen.
 *
 * @param error What went wrong.
 * @returns Nothing.
 */
function fail(error: unknown): void {
  // Walk the cause chain: `createEngine` wraps a module failure in a `ModuleError`, so the
  // reason a dynamic splat refused to boot is one level down and would otherwise be lost.
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(typeof current === 'string' ? current : (JSON.stringify(current) ?? 'unknown'));
      break;
    }
    parts.push(
      depth === 0 ? `${current.name}: ${current.message}` : `caused by: ${current.message}`,
    );
    current = current.cause;
  }
  if (error instanceof Error && error.stack !== undefined) parts.push(error.stack);

  window.__AOS_ERROR__ = (window.__AOS_ERROR__ ?? '') + parts.join('\n') + '\n';
  errorElement.classList.add('visible');
  errorElement.textContent = window.__AOS_ERROR__;
  console.error(error);
}

window.addEventListener('error', (event) => {
  fail(event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  fail(event.reason);
});

/** Rolling frame statistics for the overlay. */
const frameTimes: number[] = [];
let sortsDispatched = 0;
let framesRendered = 0;

/**
 * Nearest-rank percentile.
 *
 * @param values Sample.
 * @param p Quantile in `[0, 1]`.
 * @returns The value, or `NaN` when empty.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? Number.NaN;
}

/**
 * Two decimals, or `--`.
 *
 * @param value A measurement.
 * @returns Text for the overlay.
 */
function f2(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '--';
}

/** Anything with three's sort entry point. */
interface Sortable {
  updateSort(renderer: never, camera: never): boolean;
}

/**
 * Count how often the splat actually re-sorts.
 *
 * The whole point of `markGaussiansChanged` is that this reads 1.00 per frame in dynamic
 * mode; without it, a still camera would show 0.00 while the gaussians moved underneath.
 *
 * @param splatObject The splat to watch.
 * @returns Nothing.
 */
function countSorts(splatObject: object): void {
  const sortable = splatObject as Sortable;
  const original = sortable.updateSort.bind(sortable);
  sortable.updateSort = (renderer, camera) => {
    const dispatched = original(renderer, camera);
    if (dispatched) sortsDispatched += 1;
    return dispatched;
  };
}

/**
 * Orbit the camera on a fixed path, or let the user drive.
 *
 * 2 degrees per frame is above three's `SORT_DIRECTION_THRESHOLD` (about 1.81 degrees), so
 * the static case re-sorts every frame: the worst case, on screen, by default.
 *
 * @param camera The engine camera.
 * @param target What to look at.
 * @param controls The user's controls, used when `?orbit=0`.
 * @returns A per-frame update.
 */
function makeCameraPath(
  camera: PerspectiveCamera,
  target: Vector3,
  controls: OrbitControls,
): () => void {
  const radius = camera.position.distanceTo(target);
  const height = camera.position.y - target.y;
  const step = (orbitDegreesPerFrame * Math.PI) / 180;
  let theta = 0;

  return () => {
    if (!autoOrbit) {
      controls.update();
      return;
    }
    theta += step;
    camera.position.set(
      target.x + Math.sin(theta) * radius,
      target.y + height,
      target.z + Math.cos(theta) * radius,
    );
    camera.lookAt(target);
  };
}

/**
 * The stats overlay.
 *
 * @param lines What to show.
 * @returns Nothing.
 */
function setStats(lines: readonly string[]): void {
  statsElement.textContent = lines.join('\n');
}

/**
 * `?bench=1`: run the benchmark and publish the numbers.
 *
 * @returns Resolves when the run is over.
 */
async function runBench(): Promise<void> {
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL,
    // The only reason this path does not go through createEngine.
    trackTimestamp: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600);
  await renderer.init();

  const backend = isWebGPUBackend(renderer) ? 'webgpu' : 'webgl';
  setStats([`bench: ${mode}`, `backend: ${backend}`, 'running…']);

  const result =
    mode === 'dynamic'
      ? await benchDynamic(renderer, { n: gaussians, frames: benchFrames })
      : await benchStatic(renderer, { url: modelUrl, frames: benchFrames });

  const published = { ...result, url: mode === 'dynamic' ? `n=${String(gaussians)}` : modelUrl };
  window.__AOS_BENCH__ = published;
  benchElement.classList.add('visible');
  benchElement.textContent = JSON.stringify(published, null, 2);
  setStats([`bench: ${mode}`, `backend: ${backend}`, 'done']);
  console.log('GAMEABLE_BENCH ' + JSON.stringify(published));
}

/**
 * A module that owns the camera path and, in dynamic mode, the producer.
 *
 * It is a real `EngineModule` rather than a lump of code in a rAF, because that is how a game
 * would attach to the loop — and because `dispose` then actually runs.
 *
 * @returns The module.
 */
function viewerModule(): EngineModule {
  let advanceCamera: (() => void) | null = null;
  let controls: OrbitControls | null = null;
  let sink: AnimatedSplat | null = null;
  let runProducer: ((elapsedSeconds: number) => void) | null = null;
  let disposeProducer: (() => void) | null = null;
  let splatCount = 0;
  let shDegree = 0;
  let backendName = 'unknown';
  let lastFrameAt = performance.now();
  let elapsed = 0;

  return {
    id: 'splat-viewer',
    // After the splat module, whose asset loader the static path needs.
    order: 300,

    async init(ctx: EngineContext) {
      backendName = ctx.caps.webgpu ? 'webgpu' : 'webgl (fallback)';
      ctx.scene.background = new Color(0x101014);

      controls = new OrbitControls(ctx.camera, ctx.renderer.domElement);
      controls.enableDamping = true;

      if (mode === 'dynamic') {
        if (!ctx.caps.webgpu) {
          throw new Error(
            'dynamic mode needs the WebGPU backend: this viewer writes its gaussians with a ' +
              'WGSL compute pipeline, and the WebGL fallback has no GPUDevice to run one. ' +
              'Drop ?backend=webgl.',
          );
        }
        splatCount = gaussians;
        const boxHalf = 7;
        sink = await createAnimatedSplat(ctx.renderer, {
          capacity: gaussians,
          boundingSphere: { center: [0, 0, 0], radius: boxHalf * 1.6 },
        });
        sink.allocate(gaussians);
        ctx.scene.add(sink.object3D);
        countSorts(sink.splat);

        const producer = createProducer(ctx.renderer, sink, gaussians, boxHalf);
        runProducer = producer.run;
        disposeProducer = producer.dispose;

        ctx.camera.position.set(0, 2.5, boxHalf * 2.3);
        controls.target.set(0, 0, 0);
        advanceCamera = makeCameraPath(ctx.camera, new Vector3(0, 0, 0), controls);
      } else {
        await ctx.assets.load('model');
        const object = ctx.get('splat').add('model');
        countSorts(object);
        const asset = ctx.get('splat').loaded.get('model');
        splatCount = asset?.count ?? 0;
        shDegree = asset?.shDegree ?? 0;

        const sphere = asset?.boundingSphere;
        const center = sphere?.center.clone() ?? new Vector3();
        const distance = Math.max(0.5, (sphere?.radius ?? 4) * 2);
        ctx.camera.position.set(center.x, center.y + distance * 0.25, center.z + distance);
        ctx.camera.near = Math.max(0.01, distance / 500);
        ctx.camera.far = distance * 20;
        ctx.camera.updateProjectionMatrix();
        controls.target.copy(center);
        advanceCamera = makeCameraPath(ctx.camera, center, controls);
      }
    },

    update(dt) {
      elapsed += dt;
      advanceCamera?.();
      if (runProducer !== null && sink !== null) {
        runProducer(elapsed);
        // The gaussians moved: the previous depth order is stale whatever the camera did.
        sink.markGaussiansChanged();
      }

      const now = performance.now();
      frameTimes.push(now - lastFrameAt);
      if (frameTimes.length > 240) frameTimes.shift();
      lastFrameAt = now;
      framesRendered += 1;

      if (framesRendered % 10 === 0) {
        const p50 = percentile(frameTimes, 0.5);
        setStats([
          `mode        ${mode}`,
          `backend     ${backendName}`,
          mode === 'static' ? `model       ${modelUrl}` : `capacity    ${String(gaussians)}`,
          `splats      ${splatCount.toLocaleString()}`,
          `frames      ${String(framesRendered)}`,
          `fps         ${f2(1000 / p50)}`,
          `frame ms    p50 ${f2(p50)}  p95 ${f2(percentile(frameTimes, 0.95))}`,
          `sorts/frame ${f2(sortsDispatched / Math.max(1, framesRendered))}`,
          mode === 'dynamic'
            ? `slots       ${String(sink?.used ?? 0)} used, ${String(sink?.available ?? 0)} free`
            : `sh degree   ${String(shDegree)}`,
          '',
          autoOrbit ? 'orbiting (?orbit=0 to drag)' : 'drag to orbit',
        ]);
      }

      if (framesRendered === 2) {
        window.__AOS_READY__ = { mode, backend: backendName, splats: splatCount };
      }
    },

    dispose() {
      disposeProducer?.();
      sink?.dispose();
      controls?.dispose();
    },
  };
}

/**
 * The synthetic producer: one compute pass per frame, straight into the splat's buffers.
 *
 * The 16-byte params uniform goes through `queue.writeBuffer`, which is fine here and is the
 * one difference from `benchDynamic`: the benchmark uses a ring of mapped staging buffers so
 * that its `writeBufferPerFrame` measurement is about the *splat* path and not about its own
 * fixture. No gaussian data is ever uploaded from the CPU on either path.
 *
 * @param renderer The engine renderer.
 * @param sink The splat to write into.
 * @param count Gaussians to animate.
 * @param boxHalf Half-extent of the box they move in.
 * @returns A per-frame `run` and a `dispose`.
 */
function createProducer(
  renderer: WebGPURenderer,
  sink: AnimatedSplat,
  count: number,
  boxHalf: number,
): { run: (elapsedSeconds: number) => void; dispose: () => void } {
  const device = getGPUDevice(renderer);
  const module = device.createShaderModule({ code: ANIMATE_WGSL, label: 'viewer:animate' });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const params = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: 'viewer:animateParams',
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

  // Preallocated: this runs every frame.
  const scratch = new ArrayBuffer(16);
  const asF32 = new Float32Array(scratch);
  const asU32 = new Uint32Array(scratch);
  const workgroups = Math.ceil(count / 256);

  return {
    run(elapsedSeconds) {
      asF32[0] = elapsedSeconds;
      asU32[1] = count;
      asF32[2] = boxHalf;
      asF32[3] = 0.6;
      device.queue.writeBuffer(params, 0, scratch);

      const encoder = device.createCommandEncoder({ label: 'viewer:animate' });
      const pass = encoder.beginComputePass({ label: 'viewer:animatePass' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    dispose() {
      params.destroy();
    },
  };
}

/**
 * Boot the engine and start the loop.
 *
 * @returns Resolves once the first frame has been scheduled.
 */
async function runViewer(): Promise<void> {
  const engine = await createEngine({
    canvas,
    // An inline manifest: the viewer has exactly one asset and no `assets.json` to ship.
    // Game code never sees the URL — `?model=` is the *host's* configuration, and the id
    // `model` is what the rest of this file uses.
    manifest: {
      version: 1,
      assets: mode === 'static' ? [{ id: 'model', type: 'splat', src: modelUrl }] : [],
    },
    modules: [splat(), viewerModule()],
    renderer: { backend: forceWebGL ? 'webgl' : 'auto', antialias: false },
  });

  engine.start();
}

if (isBench) {
  runBench().catch(fail);
} else {
  runViewer().catch(fail);
}
