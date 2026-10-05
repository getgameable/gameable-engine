/**
 * The character showcase: a rig backend, a debug lift and a splat sink, and nothing else.
 *
 * WHAT IT PROVES. `packages/character` can take a baked GNM head, run it as two compute
 * passes on the renderer's own `GPUDevice`, and write gaussians into an
 * `AnimatedSplat` — the rig -> GPU -> splat chain, end to end, on real WebGPU. No
 * geometry or appearance decoders exist for GNM topology yet (they are being retrained by
 * another team), so the appearance half of a character is genuinely not here: what you see
 * is one 2 mm gaussian per rig vertex, coloured by skinning region.
 *
 * | Query | What runs |
 * | --- | --- |
 * | *(none)* | The truncated 64-coefficient myra pack, sliders, front view |
 * | `?pack=full` | The full 383-coefficient pack (42 MB) |
 * | `?rig=orl` | The ORL backend from `public/bundles/<name>/`, if you have one |
 * | `?anim=1` | The placeholder ARKit idle clip through `Animator` and the ARKit->GNM map |
 * | `?selftest=1` | S4: GPU vertices vs the CPU reference, into `window.__AOS_SELFTEST__` |
 * | `?bench=1` | Rig and sort GPU time, into `window.__AOS_BENCH__` |
 * | `?orbit=1` | Drag to orbit instead of the fixed front view |
 *
 * THE ENGINE PATH IS THE POINT of everything except `?bench=1`: the app boots through
 * `createEngine` with the `splat()` module, which is what a game does. The benchmark
 * builds its own renderer because it needs `trackTimestamp: true`.
 */
import { createAnimator, type Animator } from 'gameable/animation';
import faceIdleClip from 'gameable/assets/face_idle.arkit.json';
import {
  createArkitToGnmMap,
  createRigPreview,
  GnmRigBackend,
  jointTint,
  OrlRigBackend,
  parseAosRig,
  prepareLiftDevice,
  regionSlices,
  uvTint,
  type AosRigPack,
  type DebugShading,
  type RigBackend,
  type RigPreview,
} from 'gameable/character';
import { createEngine, type EngineContext, type EngineModule } from 'gameable/core';
import { createAnimatedSplat, splat, type AnimatedSplat } from 'gameable/splat';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Color, Object3D } from 'three/webgpu';

import { runBench } from './bench';
import { formatSelfTest, runSelfTest, type ReferenceFrames } from './selftest';
import { createOverlay, fixed, percentile, type SliderGroup } from './ui';

const query = new URLSearchParams(location.search);
const flags = {
  rig: query.get('rig') === 'orl' ? ('orl' as const) : ('gnm' as const),
  /** `e64` (default, 7.8 MB) or `full` (42 MB), or an explicit file under /generated/. */
  pack: query.get('pack') ?? 'e64',
  /** Directory under `public/bundles/` the ORL path reads. */
  bundle: query.get('bundle') ?? 'myra',
  anim: query.get('anim') === '1',
  selftest: query.get('selftest') === '1',
  bench: query.get('bench') === '1',
  orbit: query.get('orbit') === '1',
  sigma: Number(query.get('sigma') ?? 0.002),
  shading: (query.get('shading') ?? 'tint') as DebugShading,
  /**
   * Multiplier on the mapped expression coefficients when `?anim=1` is playing.
   *
   * The stopgap ARKit->GNM table is deliberately conservative — its gains keep every
   * coefficient inside the latent distribution the model was trained on — and the
   * placeholder idle is a quiet clip, so the two together move the face by about a
   * millimetre. Raising this exaggerates it for a screenshot; it does not make it more
   * correct.
   */
  gain: Number(query.get('gain') ?? 1),
  frames: Number(query.get('frames') ?? 180),
  /** Camera distance in metres. The fit scales the rig to 0.35 m tall at the origin. */
  distance: Number(query.get('dist') ?? 0.5),
};

/** Slots the sink holds; the shipped head is 17,821 vertices. */
const SINK_CAPACITY = 32_768;

/** Coefficients per region the slider panel exposes. */
const SLIDERS_PER_REGION = 3;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const overlay = createOverlay();

window.addEventListener('error', (event) => {
  overlay.fail(event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  overlay.fail(event.reason);
});

/** What the bake script left behind, or why it could not. */
interface BakeStatus {
  ok: boolean;
  reason?: string;
  packs?: {
    full: { file: string; megabytes: number; coefficients: number };
    truncated: {
      file: string;
      megabytes: number;
      coefficients: number;
      truncation: {
        coefficients: number;
        maxVertexErrorMm: number;
        meanVertexErrorMm: number;
        frames: number;
      } | null;
    };
  };
  reference?: { file: string; megabytes: number; frames: number };
}

/**
 * Fetch and parse JSON, with the URL in the failure.
 *
 * @param url What to fetch.
 * @returns The parsed body.
 * @throws {Error} On any non-2xx response.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${String(response.status)} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/**
 * Fetch bytes, with the URL in the failure.
 *
 * @param url What to fetch.
 * @returns The body as bytes.
 * @throws {Error} On any non-2xx response.
 */
async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${String(response.status)} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Which generated pack `?pack=` names. */
function packFileName(status: BakeStatus | null): string {
  if (flags.pack.endsWith('.aosrig')) return flags.pack;
  if (flags.pack === 'full') return status?.packs?.full.file ?? 'myra_head.aosrig';
  return status?.packs?.truncated.file ?? 'myra_head.e64.aosrig';
}

/** Everything the showcase loads before it can build a backend. */
interface Loaded {
  backendName: string;
  packFile: string;
  files: Map<string, Uint8Array>;
  controlNames: string[];
  makeBackend: () => RigBackend;
}

/**
 * Fetch the rig's own files and describe how to build its backend.
 *
 * The GNM path reads one generated `.aosrig`. The ORL path reads a bundle the repository
 * does not ship — it needs a character's own DNA-derived pack, which is licensed content —
 * so it fails with the exact two files to drop in rather than with a 404.
 *
 * @param status The bake status, for the generated file names.
 * @returns The loaded bytes and a backend factory.
 */
async function loadRig(status: BakeStatus | null): Promise<Loaded> {
  const files = new Map<string, Uint8Array>();
  if (flags.rig === 'gnm') {
    const packFile = packFileName(status);
    files.set(packFile, await fetchBytes(`generated/${packFile}`));
    return {
      backendName: 'gnm',
      packFile,
      files,
      controlNames: [],
      makeBackend: () => new GnmRigBackend({ packFile }),
    };
  }

  const base = `bundles/${flags.bundle}/`;
  const missing = `The ORL path needs a character bundle, which this repository does not ship: \
ORL is driven by a licensed per-character DNA. Drop "orl_pack.bin" and "rig_names.json" into \
examples/character-showcase/public/${base} and reload, or use the default ?rig=gnm path, whose \
pack is baked from the aosRig source by scripts/gen-gnm-pack.mjs.`;
  let pack: Uint8Array;
  let names: string[];
  try {
    pack = await fetchBytes(`${base}orl_pack.bin`);
    names = await fetchJson<string[]>(`${base}rig_names.json`);
  } catch (cause) {
    throw new Error(missing, { cause });
  }
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`${base}rig_names.json must be a non-empty array of control names`);
  }
  files.set('orl_pack.bin', pack);
  return {
    backendName: 'orl',
    packFile: 'orl_pack.bin',
    files,
    controlNames: names,
    // `skin` mode: the rig's own head mesh, which is what a preview wants. Shell mode
    // deforms a bundle branch's baked vertices and there is no bundle here.
    makeBackend: () => new OrlRigBackend({ mode: 'skin' }),
  };
}

/** The live state the sliders and the animator both write. */
interface RigState {
  /** The backend's own control vector: `head_ext` for GNM. */
  controls: Float32Array;
  /** True when something changed and the rig must re-solve. */
  dirty: boolean;
}

/**
 * Build the slider panel for a GNM pack: the first few coefficients of every region, plus
 * gaze.
 *
 * Three coefficients per region is a deliberate compromise. The regions are 100-150
 * coefficients wide and they are ordered by explained variance, so the first few are the
 * ones with visible, separable effects; a panel of 383 sliders would be unusable and a
 * panel of one would prove nothing.
 *
 * @param pack The parsed pack, for the region layout.
 * @param state The vector the sliders write into.
 * @param onChange Called after any slider moves.
 * @param onSigma Called when the gaussian-size slider moves.
 * @returns The groups for the overlay.
 */
function buildSliders(
  pack: AosRigPack,
  state: RigState,
  onChange: () => void,
  onSigma: (sigma: number) => void,
): SliderGroup[] {
  const layout = pack.header.headExt;
  const slices = regionSlices(layout);
  const groups: SliderGroup[] = [];

  for (const [region, count] of layout.regions) {
    const slice = slices[region];
    const sliders = [];
    for (let k = 0; k < Math.min(SLIDERS_PER_REGION, count); k++) {
      const slot = slice.start + k;
      sliders.push({
        id: `coeff-${region}-${String(k)}`,
        label: `${region} ${String(k)}`,
        min: -2,
        max: 2,
        step: 0.05,
        value: 0,
        onChange: (value: number) => {
          state.controls[slot] = value;
          state.dirty = true;
          onChange();
        },
      });
    }
    if (sliders.length > 0) groups.push({ title: region, sliders });
  }

  // Gaze is the tail of `head_ext` and is in RADIANS, not coefficients: both eyes share a
  // slider here, because a preview wants to see the eyeballs move, not to test vergence.
  const gaze = layout.exprDim;
  groups.push({
    title: 'gaze (radians)',
    sliders: [
      {
        id: 'gaze-pitch',
        label: 'pitch',
        min: -0.35,
        max: 0.35,
        step: 0.01,
        value: 0,
        decimals: 2,
        onChange: (value: number) => {
          state.controls[gaze] = value;
          state.controls[gaze + 2] = value;
          state.dirty = true;
          onChange();
        },
      },
      {
        id: 'gaze-yaw',
        label: 'yaw',
        min: -0.35,
        max: 0.35,
        step: 0.01,
        value: 0,
        decimals: 2,
        onChange: (value: number) => {
          state.controls[gaze + 1] = value;
          state.controls[gaze + 3] = value;
          state.dirty = true;
          onChange();
        },
      },
    ],
  });

  groups.push({
    title: 'debug lift',
    sliders: [
      {
        id: 'sigma',
        label: 'sigma (mm)',
        min: 0.5,
        max: 6,
        step: 0.1,
        value: flags.sigma * 1000,
        decimals: 1,
        onChange: (value: number) => {
          onSigma(value / 1000);
        },
      },
    ],
  });

  return groups;
}

/**
 * The engine module that owns the rig, the preview and the overlay.
 *
 * It is a real `EngineModule` rather than a lump of code in a `requestAnimationFrame`,
 * because that is how a game attaches to the loop — and because `dispose` then runs.
 *
 * @param loaded What `loadRig` fetched.
 * @param status The bake status, for the overlay.
 * @param reference The reference frames, when `?selftest=1` asked for them.
 * @returns The module.
 */
function showcaseModule(
  loaded: Loaded,
  status: BakeStatus | null,
  reference: ReferenceFrames | null,
): EngineModule {
  let sink: AnimatedSplat | null = null;
  let preview: RigPreview | null = null;
  let controls: OrbitControls | null = null;
  let animator: Animator | null = null;
  let pack: AosRigPack | null = null;
  let device: GPUDevice | null = null;
  let backendName = 'unknown';

  const state: RigState = { controls: new Float32Array(0), dirty: true };
  const frameTimes: number[] = [];
  const encodeTimes: number[] = [];
  let frames = 0;
  let sorts = 0;
  let lastFrameAt = performance.now();
  let selfTestDone = false;
  let selfTestText: string | null = null;

  return {
    id: 'character-showcase',
    // After the splat module, whose service the static path would use.
    order: 300,

    async init(ctx: EngineContext) {
      ctx.scene.background = new Color(0x0d0d12);
      if (!ctx.caps.webgpu) {
        throw new Error(
          'characters need the WebGPU backend: the rig runs as compute shaders on the ' +
            "renderer's own device and there is no CPU path. This machine fell back to WebGL.",
        );
      }
      device = prepareLiftDevice(ctx.renderer);

      // WebGPU validation failures are silent by default: the offending call is dropped,
      // the frame still renders, and a bind-group mistake looks like a rendering choice.
      // The e2e suite asserts this list is empty.
      window.__AOS_VALIDATION__ = [];
      device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent) => {
        const message = event.error.message;
        window.__AOS_VALIDATION__?.push(message);
        console.error(`[webgpu] ${message}`);
      });

      // Initialise the backend FIRST, so the pack is parsed and the per-vertex palette can
      // be computed from its skinning before the preview builds its buffers.
      const backend = loaded.makeBackend();
      backendName = backend.kind;
      await backend.init({
        device,
        getBytes: (name) => loaded.files.get(name),
        controlNames: loaded.controlNames,
      });

      let tint: Uint32Array | undefined;
      if (backend instanceof GnmRigBackend) {
        pack = backend.assets;
        tint =
          flags.shading === 'tint' && query.get('tint') === 'uv' && pack.uv
            ? uvTint(pack.uv, pack.vertexCount)
            : jointTint(pack);
      }

      sink = await createAnimatedSplat(ctx.renderer, { capacity: SINK_CAPACITY });
      ctx.scene.add(sink.object3D);

      preview = await createRigPreview({
        device,
        sink,
        backend,
        tint,
        shading: flags.shading,
        sigma: flags.sigma,
      });

      state.controls = new Float32Array(
        pack ? pack.header.headExt.dim : backend.controlNames.length,
      );

      // The camera sits on +Z, which is out of the face: GNM's head-local frame is +Y up,
      // +X toward the subject's left, +Z out of the face, and the placement fit only
      // centres and scales.
      ctx.camera.position.set(0, 0, flags.distance);
      ctx.camera.near = 0.01;
      ctx.camera.far = 20;
      ctx.camera.updateProjectionMatrix();
      ctx.camera.lookAt(0, 0, 0);
      if (flags.orbit) {
        controls = new OrbitControls(ctx.camera, ctx.renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 0, 0);
      }

      // Count the sorts the way the splat viewer does: the claim `markGaussiansChanged`
      // exists to make is that this reads 1.00 even with the camera still.
      const sortable = sink.splat as unknown as { updateSort: (r: never, c: never) => boolean };
      const originalUpdateSort = sortable.updateSort.bind(sortable);
      sortable.updateSort = (r, c) => {
        const dispatched = originalUpdateSort(r, c);
        if (dispatched) sorts += 1;
        return dispatched;
      };

      if (pack) {
        overlay.setControls(
          buildSliders(
            pack,
            state,
            () => {
              /* the loop re-solves on `dirty` */
            },
            (sigma) => preview?.lift.setSigma(sigma),
          ),
          [
            {
              label: 'reset',
              onClick: () => {
                overlay.resetControls();
                state.controls.fill(0);
                state.dirty = true;
              },
            },
          ],
        );
      }

      // `?anim=1`: the placeholder ARKit-52 idle, through the real animator. The face
      // layer blends in ARKit and `expressionSpace.map` widens it into `head_ext`, which
      // is exactly the seam a bundle's own `arkit_to_gnm.json` will slot into.
      if (flags.anim && pack) {
        const mapper = createArkitToGnmMap(pack.header.headExt);
        if (mapper.dropped.length > 0) {
          console.warn(`[showcase] ARKit->GNM map dropped: ${mapper.dropped.join('; ')}`);
        }
        animator = createAnimator({
          // No skeleton: the head is not skinned to a body here, so the body layer has no
          // bones to pose and the face layer is the only one doing anything.
          root: new Object3D(),
          expressionSpace: { kind: 'gnm', dim: mapper.dim, map: mapper.map },
        });
        animator.addFaceClip('idle', faceIdleClip);
        animator.setState({
          clips: [{ name: 'idle', weight: 1 }],
          velocity: [0, 0, 0],
          grounded: true,
        });
      }

      window.__AOS_READY__ = {
        rig: backendName,
        pack: loaded.packFile,
        vertices: backend.vertexCount,
        coefficients: pack?.coeffCount ?? backend.controlNames.length,
        backend: 'webgpu',
      };

      // `?debug=1`: a handle on the live objects, so the browser console can read back a
      // slot range and answer "did the lift actually write anything?" without a rebuild.
      if (query.get('debug') === '1') {
        (window as unknown as { __AOS_DEBUG__: unknown }).__AOS_DEBUG__ = {
          device,
          sink,
          preview,
          camera: ctx.camera,
          async readSlots(first: number, count: number) {
            const staging = device!.createBuffer({
              size: count * 16,
              usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
            const encoder = device!.createCommandEncoder();
            encoder.copyBufferToBuffer(sink!.buffers.center, first * 16, staging, 0, count * 16);
            device!.queue.submit([encoder.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const centers = [...new Float32Array(staging.getMappedRange().slice(0))];
            staging.unmap();
            staging.destroy();
            return centers;
          },
        };
      }
    },

    update(dt) {
      const currentSink = sink;
      const currentPreview = preview;
      const currentDevice = device;
      if (!currentSink || !currentPreview || !currentDevice) return;

      controls?.update();

      if (animator !== null) {
        animator.update(dt);
        state.controls.set(animator.expression.subarray(0, state.controls.length));
        if (flags.gain !== 1 && pack !== null) {
          // The gaze tail is in radians and is already clamped by the map, so only the
          // coefficient half is exaggerated.
          for (let i = 0; i < pack.header.headExt.exprDim; i++) {
            state.controls[i] = Math.max(-4, Math.min(4, state.controls[i] * flags.gain));
          }
        }
        state.dirty = true;
      }

      const t0 = performance.now();
      if (state.dirty) {
        currentPreview.setControls(state.controls);
        state.dirty = false;
      }
      // One encoder, one submission: the rig blend and the debug lift, in order. No
      // fences — one device means one queue, and WebGPU executes submissions in order.
      const encoder = currentDevice.createCommandEncoder({ label: 'showcase:frame' });
      currentPreview.encode(encoder);
      currentDevice.queue.submit([encoder.finish()]);
      // The vertices moved: the previous depth order is stale whatever the camera did.
      currentSink.markGaussiansChanged();
      encodeTimes.push(performance.now() - t0);
      if (encodeTimes.length > 240) encodeTimes.shift();

      const now = performance.now();
      frameTimes.push(now - lastFrameAt);
      if (frameTimes.length > 240) frameTimes.shift();
      lastFrameAt = now;
      frames += 1;

      if (frames === 2) {
        window.__AOS_READY__ = {
          ...(window.__AOS_READY__ ?? {
            rig: backendName,
            pack: loaded.packFile,
            vertices: 0,
            coefficients: 0,
            backend: 'webgpu',
          }),
        };
      }

      // The self-test stalls the queue with a readback, so it runs once, after the first
      // frames have settled, and never on the interactive path.
      if (flags.selftest && !selfTestDone && frames === 5 && reference !== null && pack !== null) {
        selfTestDone = true;
        void runSelfTest({
          device: currentDevice,
          preview: currentPreview,
          pack,
          packFile: loaded.packFile,
          reference,
        })
          .then((report) => {
            window.__AOS_SELFTEST__ = report;
            selfTestText = formatSelfTest(report);
            overlay.setReport(selfTestText);
            console.log(`GAMEABLE_SELFTEST ${JSON.stringify(report)}`);
            // The rig was left at the last reference frame; put it back.
            state.controls.fill(0);
            state.dirty = true;
          })
          .catch((error: unknown) => {
            overlay.fail(error);
          });
      }

      if (frames % 10 === 0) {
        const p50 = percentile(frameTimes, 0.5);
        const truncation = status?.packs?.truncated.truncation ?? null;
        overlay.setStats([
          `rig          ${backendName}`,
          `pack         ${loaded.packFile}`,
          `coefficients ${String(pack?.coeffCount ?? 0)}${
            truncation && loaded.packFile.includes('e64')
              ? ` (of ${String(status?.packs?.full.coefficients ?? 383)}, max ` +
                `${fixed(truncation.maxVertexErrorMm, 2)} mm error)`
              : ''
          }`,
          `vertices     ${String(currentPreview.backend.vertexCount)}`,
          `slots        ${String(currentPreview.range.count)} of ${String(currentSink.capacity)}`,
          `fps          ${fixed(1000 / p50)}`,
          `frame ms     p50 ${fixed(p50)}  p95 ${fixed(percentile(frameTimes, 0.95))}`,
          `rig cpu ms   ${fixed(percentile(encodeTimes, 0.5), 3)}  (encode + submit)`,
          `sorts/frame  ${fixed(sorts / Math.max(1, frames))}`,
          `anim         ${animator === null ? 'off (?anim=1)' : 'arkit idle -> gnm'}`,
          '',
          'GPU timings: ?bench=1 (needs trackTimestamp)',
          flags.orbit ? 'drag to orbit' : 'fixed view (?orbit=1 to drag)',
        ]);
      }
    },

    dispose() {
      animator?.dispose();
      preview?.dispose();
      sink?.dispose();
      controls?.dispose();
    },
  };
}

/**
 * A `head_ext` vector for benchmark frame `n`: a slow sweep through the first coefficient
 * of every region, so the rig genuinely re-solves and re-uploads every frame.
 *
 * @param pack The parsed pack, for the layout.
 * @returns A per-frame control-vector factory.
 */
function benchControls(pack: AosRigPack): (frame: number) => Float32Array {
  const layout = pack.header.headExt;
  const slices = regionSlices(layout);
  const starts = layout.regions.map(([region]) => slices[region].start);
  const controls = new Float32Array(layout.dim);
  return (frame: number) => {
    const t = frame * 0.05;
    for (let i = 0; i < starts.length; i++) controls[starts[i]] = Math.sin(t + i) * 1.5;
    controls[layout.exprDim] = Math.sin(t * 0.5) * 0.25;
    controls[layout.exprDim + 1] = Math.cos(t * 0.5) * 0.25;
    controls[layout.exprDim + 2] = controls[layout.exprDim];
    controls[layout.exprDim + 3] = controls[layout.exprDim + 1];
    return controls;
  };
}

/** Boot. */
async function main(): Promise<void> {
  const exported = query.get('character');
  if (exported) {
    const { showExportedCharacter } = await import('./exportedCharacter');
    await showExportedCharacter(canvas, new URL(exported, location.href).href, overlay);
    return;
  }
  // A 404 here is the normal state of a fresh clone whose `predev` found no source npz:
  // the app then shows the bake's own explanation instead of failing.
  const status = await fetchJson<BakeStatus>('generated/status.json').catch(() => null);

  if (status !== null && !status.ok) {
    // A missing bake is a normal state on a machine without the source data, not a crash.
    overlay.setStats(['the GNM pack was not baked', '', 'see the panel below']);
    overlay.setReport(
      `No GNM pack in public/generated/.\n\n${status.reason ?? ''}\n\n` +
        'Then: npm run gen:pack -w examples/character-showcase',
    );
    window.__AOS_READY__ = {
      rig: flags.rig,
      pack: 'none',
      vertices: 0,
      coefficients: 0,
      backend: 'unknown',
      blocked: status.reason ?? 'the GNM pack is not baked',
    };
    return;
  }

  const loaded = await loadRig(status);

  if (flags.bench) {
    // The benchmark parses the pack itself, to build a control vector for its layout.
    const packBytes = loaded.files.get(loaded.packFile);
    const parsed = flags.rig === 'gnm' && packBytes ? parseAosRig(packBytes) : null;
    // Published BEFORE the run, not after: the bench takes a couple of minutes and a
    // caller waiting to find out whether this machine has a pack at all should not have to
    // wait for it.
    window.__AOS_READY__ = {
      rig: loaded.backendName,
      pack: loaded.packFile,
      vertices: parsed?.vertexCount ?? 0,
      coefficients: parsed?.coeffCount ?? 0,
      backend: 'webgpu',
    };
    const report = await runBench({
      canvas,
      makeBackend: loaded.makeBackend,
      getBytes: (name) => loaded.files.get(name),
      controlsFor: parsed
        ? benchControls(parsed)
        : () => new Float32Array(loaded.controlNames.length),
      rig: loaded.backendName,
      pack: loaded.packFile,
      coefficients: parsed?.coeffCount ?? 0,
      frames: flags.frames,
      sigma: flags.sigma,
    });
    window.__AOS_BENCH__ = report;
    overlay.setReport(JSON.stringify(report, null, 2));
    overlay.setStats(['bench', `rig ${report.rig}`, 'done']);
    console.log(`GAMEABLE_BENCH ${JSON.stringify(report)}`);
    return;
  }

  const reference = flags.selftest
    ? await fetchJson<ReferenceFrames>('generated/reference_frames.json')
    : null;

  const engine = await createEngine({
    canvas,
    modules: [splat(), showcaseModule(loaded, status, reference)],
    renderer: { backend: 'webgpu', antialias: false },
  });
  engine.start();
}

main().catch((error: unknown) => {
  overlay.fail(error);
});
