// One branch's decoder chain: rig -> trunk -> `code` -> geom -> `geom_uv`, and
// `code` + plücker -> appr -> `color_uv`.
//
// Replaces aos-threejs-poc/src/ogs/graph/nodes/{OGSAvatar,OGSDecoder}.ts and
// graph/nodes/decoderFactories.ts @ cdd63b10. Those were graph NODES with declared
// ports, because a blueprint editor could rewire them at runtime; a game engine has
// no such editor, so what is left is the chain itself — which is the only shape any
// bundle ever ran.
//
// THE GEOM/APPEARANCE SPLIT IS KEPT, and it is the whole reason this is not one
// call: a camera-only orbit re-runs plücker + appr against the CACHED `code` latent
// and never touches the trunk or geom. On a 750² head that is the difference between
// a re-decode and a re-colour.
//
// FUSED BRANCHES. A single-region bundle has no trunk ONNX: its geom takes
// `rig_params` straight in and emits `code` alongside `geom_uv`. Everything
// downstream is identical, which is why a single-region bundle needs no pipeline of
// its own.
//
// REGION-FACTORED (V8+) BUNDLES emit a SECOND trunk output, `zpack`: the packed
// per-group rig latent that geom/appr slice for their baked mask-gated FiLM. It is
// declared OPTIONAL and resolved against the loaded graph's own IO names, so a
// pre-V8 trunk is unaffected and the mode is detected from the asset rather than
// from a flag.
//
// DO NOT enable ORT graph capture on these sessions. `enableGraphCapture` records
// the command list once and replays it, and replay only re-reads inputs bound by the
// graph's LEADING op. A region-factored geom/appr binds `code` on its leading
// ConvTranspose, so `zpack` would be frozen at whatever the RECORDING frame held:
// the face would modulate with a stale expression, every frame, with no error.

import {
  createResolvedDecoder,
  PrecisionCache,
  type DecoderKind,
  type OrtEnvLike,
} from './decoderBuild.js';
import type { DecoderSession, DecoderSessionOptions, OrtLike } from './DecoderSession.js';
import type { OrtLike as OrtSessionLike } from './ortSession.js';
import type { NodeTensor } from './types.js';

/** Everything the chain needs to build its three sessions. */
export interface BranchDecoderOptions {
  ort: OrtEnvLike & OrtLike & OrtSessionLike;
  providers: string[];
  /** Branch name, for the build log. */
  label: string;
  /** Keep `code` / `geom_uv` / `color_uv` on gpu-buffers (the shared-device path). */
  gpuBufferIo: boolean;
  /** Prefer the bundle's fp16-internal decoders where they exist and the EP allows. */
  preferFp16: boolean;
  /** Absent on a FUSED branch — its geom takes `rig_params` and emits `code`. */
  trunk?: { bytes: Uint8Array };
  geom: DecoderSource;
  appr: DecoderSource;
  onDowngrade?: (kind: DecoderKind, reason: string) => void;
}

/** An fp32 source plus the optional fp16 sibling that is preferred over it. */
export interface DecoderSource {
  /** Already-resident fp32 bytes, when the eager pass fetched them. */
  bytes?: Uint8Array;
  /** Lazily-fetched fp32 bytes, so an fp16-preferred bundle need not hold fp32. */
  getFp32?: () => Promise<Uint8Array>;
  /** The fp16-internal variant. Absent -> fp32-only, and no downgrade is reported. */
  fp16Bytes?: Uint8Array;
}

/** What a precision-aware decoder build produced. */
interface BuiltDecoder {
  session: DecoderSession;
  usedFp16: boolean;
}

/** The chain's two terminal outputs. */
export interface BranchUvs {
  geom_uv: NodeTensor;
  color_uv: NodeTensor;
}

/**
 * The lazy fp32 fetch for one decoder source, whichever way the bundle supplied it.
 *
 * @param source The branch's fp32 half: an explicit `getFp32`, or already-resident
 * `bytes` the eager pass fetched.
 * @param label The decoder's name (`head.geom`), used only in the rejection message.
 * @returns A thunk resolving to the fp32 model bytes, or rejecting when the bundle
 * carries neither — never a stub session, since an absent model would decode to a
 * grey face.
 */
function fp32Getter(source: DecoderSource, label: string): () => Promise<string | Uint8Array> {
  if (source.getFp32) return source.getFp32;
  if (source.bytes) return () => Promise.resolve(source.bytes as Uint8Array);
  // Loud, never a stub session: an absent model must not decode to a grey face.
  return () => Promise.reject(new Error(`[character] no fp32 source for '${label}'`));
}

/** The trunk -> geom -> appr chain for one branch. */
export class BranchDecoders {
  private readonly options: BranchDecoderOptions;
  private trunk: DecoderSession | null = null;
  private geom: DecoderSession | null = null;
  private appr: DecoderSession | null = null;
  private readonly geomPrecisions = new PrecisionCache();
  private readonly apprPrecisions = new PrecisionCache();

  private lastCode: NodeTensor | null = null;
  private lastZpack: NodeTensor | null = null;
  private lastGeom: NodeTensor | null = null;
  private lastColor: NodeTensor | null = null;
  private reportedRegion = false;
  private downloadOutputs = false;
  // The two precision-aware builders, kept so `setPrecision` rebuilds through the
  // same warm cache `init` filled rather than through a second, divergent spec.
  private buildGeom: ((want16: boolean) => Promise<BuiltDecoder>) | null = null;
  private buildAppr: ((want16: boolean) => Promise<BuiltDecoder>) | null = null;

  /** Precision each decoder ACTUALLY built at (fp16 auto-downgrades to fp32). */
  geomUsedFp16 = false;
  apprUsedFp16 = false;

  constructor(options: BranchDecoderOptions) {
    this.options = options;
  }

  /**
   * True once a trunk run has produced a `zpack` — i.e. the bundle is region-factored.
   *
   * @returns True after a `runGeom` whose trunk emitted `zpack`; false before the first
   * run and on every pre-V8 bundle.
   */
  get regionFactored(): boolean {
    return this.lastZpack !== null;
  }

  /**
   * The `geom_uv` of the last full pass, or null before one.
   *
   * @returns The geometry map the last `runGeom` produced, or null before one has run.
   */
  get lastGeomUv(): NodeTensor | null {
    return this.lastGeom;
  }

  /**
   * Both terminal outputs of the last full pass, or null before one.
   *
   * @returns `geom_uv` and `color_uv` together, or null until both a `runGeom` and a
   * `runAppearance` have produced one.
   */
  uvOutputs(): BranchUvs | null {
    if (!this.lastGeom || !this.lastColor) return null;
    return { geom_uv: this.lastGeom, color_uv: this.lastColor };
  }

  async init(): Promise<void> {
    const o = this.options;
    const gpuIo = o.gpuBufferIo;
    const trunk = o.trunk;
    const fused = !trunk;

    if (trunk) {
      const built = await createResolvedDecoder({
        kind: 'geom',
        label: `${o.label}.trunk`,
        // No fp16 trunk asset ships — it is a tiny [1,D] -> [1,256,8,8] graph.
        want16: false,
        getFp32: () => Promise.resolve(trunk.bytes),
        ort: o.ort,
        providers: o.providers,
        spec: {
          inputs: [{ port: 'rig_params', ortName: 'rig_params' }],
          outputs: [
            { port: 'code', ortName: 'code', cache: true, gpuBuffer: gpuIo },
            // Deliberately NOT gpu-buffer-hinted: ~256 floats, so the upload is noise
            // next to the ConvTranspose ladder, and keeping it on the CPU means one
            // Float32Array can feed several branch sessions with no cross-device copy.
            { port: 'zpack', ortName: 'zpack', cache: true, optional: true },
          ],
        },
        extra: gpuIo ? { preferredOutputLocation: { code: 'gpu-buffer' } } : {},
      });
      this.trunk = built.session;
    }

    const geomInput = fused ? 'rig_params' : 'code';
    const geomSpec = (): DecoderSessionOptions => ({
      inputs: [
        { port: geomInput, ortName: geomInput },
        // Region-factored branches only, resolved PER SESSION: one bundle can mix a
        // FiLM branch (head) with a composite one that takes `code` alone.
        ...(fused ? [] : [{ port: 'zpack', ortName: 'zpack', optional: true }]),
      ],
      outputs: [
        ...(fused ? [{ port: 'code', ortName: 'code', cache: true, gpuBuffer: gpuIo }] : []),
        { port: 'geom_uv', ortName: 'geom_uv', gpuBuffer: gpuIo },
      ],
    });
    const geomExtra = gpuIo
      ? {
          preferredOutputLocation: fused
            ? { code: 'gpu-buffer', geom_uv: 'gpu-buffer' }
            : { geom_uv: 'gpu-buffer' },
        }
      : {};
    const apprSpec: DecoderSessionOptions = {
      inputs: [
        { port: 'code', ortName: 'code' },
        { port: 'plucker', ortName: 'plucker' },
        { port: 'zpack', ortName: 'zpack', optional: true },
      ],
      outputs: [{ port: 'color_uv', ortName: 'color_uv', gpuBuffer: gpuIo }],
      // The appr back-pressure queue: a camera burst must not stack runs.
      serialize: true,
    };

    this.buildGeom = (want16: boolean) =>
      createResolvedDecoder({
        kind: 'geom',
        label: `${o.label}.geom`,
        want16: want16 && !!o.geom.fp16Bytes,
        fp16Src: o.geom.fp16Bytes,
        onWebgpu: o.providers[0] === 'webgpu',
        getFp32: fp32Getter(o.geom, `${o.label}.geom`),
        ort: o.ort,
        providers: o.providers,
        spec: geomSpec(),
        extra: geomExtra,
        onDowngrade: o.onDowngrade,
      });
    const geomBuilt = await this.geomPrecisions.get(o.preferFp16, this.buildGeom);
    this.geom = geomBuilt.session;
    this.geomUsedFp16 = geomBuilt.usedFp16;

    this.buildAppr = (want16: boolean) =>
      createResolvedDecoder({
        kind: 'appr',
        label: `${o.label}.appr`,
        want16: want16 && !!o.appr.fp16Bytes,
        fp16Src: o.appr.fp16Bytes,
        onWebgpu: o.providers[0] === 'webgpu',
        getFp32: fp32Getter(o.appr, `${o.label}.appr`),
        ort: o.ort,
        providers: o.providers,
        spec: apprSpec,
        extra: gpuIo ? { preferredOutputLocation: { color_uv: 'gpu-buffer' } } : {},
        onDowngrade: o.onDowngrade,
      });
    const apprBuilt = await this.apprPrecisions.get(o.preferFp16, this.buildAppr);
    this.appr = apprBuilt.session;
    this.apprUsedFp16 = apprBuilt.usedFp16;
    if (this.downloadOutputs) this.setDownloadOutputs(true);
  }

  /**
   * Rig-dirty path: decode geometry and cache the `code` latent for appearance reuse.
   *
   * @param rig The branch's `rig_params` tensor, fed to the trunk — or straight to geom
   * on a FUSED branch that has no trunk ONNX.
   * @returns The `geom_uv` map for this rig. `code` (and `zpack`, on a region-factored
   * bundle) is cached as a side effect for the next `runAppearance`.
   */
  async runGeom(rig: NodeTensor): Promise<NodeTensor> {
    if (!this.geom) throw new Error('BranchDecoders: init() has not run');
    if (this.trunk) {
      const tOut: Partial<Record<string, NodeTensor>> = await this.trunk.run({ rig_params: rig });
      const code = tOut.code;
      if (!code) throw new Error('BranchDecoders: the trunk produced no "code"');
      this.lastCode = code;
      // Passed through unconditionally: whether `zpack` is CONSUMED is the geom/appr
      // session's call, since its own graph declares the input or does not.
      this.lastZpack = tOut.zpack ?? null;
      if (this.lastZpack && !this.reportedRegion) {
        this.reportedRegion = true;
        console.info(
          `[character] ${this.options.label}: region-factored assets (the trunk emits \`zpack\`) — geom/appr FiLM is live`,
        );
      }
      const feeds: Record<string, NodeTensor> = { code };
      if (this.lastZpack) feeds.zpack = this.lastZpack;
      const gOut = await this.geom.run(feeds);
      this.lastGeom = gOut.geom_uv;
      return gOut.geom_uv;
    }
    const out: Partial<Record<string, NodeTensor>> = await this.geom.run({ rig_params: rig });
    // A FUSED geom emits `code` alongside `geom_uv`; a trunk-fed one does not, and the
    // appearance pass needs whichever of the two produced it.
    this.lastCode = out.code ?? null;
    this.lastGeom = out.geom_uv ?? null;
    if (!this.lastGeom) throw new Error('BranchDecoders: the geom decoder produced no "geom_uv"');
    return this.lastGeom;
  }

  /**
   * Camera-dirty path: reuse the cached `code`; only plücker + appr re-run.
   *
   * @param plucker The camera's plücker-ray tensor for this frame.
   * @returns The `color_uv` map. Throws when no `runGeom` has cached a `code` yet.
   */
  async runAppearance(plucker: NodeTensor): Promise<NodeTensor> {
    if (!this.appr) throw new Error('BranchDecoders: init() has not run');
    if (!this.lastCode) throw new Error('BranchDecoders: runAppearance before runGeom');
    const feeds: Record<string, NodeTensor> = { code: this.lastCode, plucker };
    if (this.lastZpack) feeds.zpack = this.lastZpack;
    const out: Partial<Record<string, NodeTensor>> = await this.appr.run(feeds);
    const color = out.color_uv;
    if (!color) throw new Error('BranchDecoders: the appr decoder produced no "color_uv"');
    this.lastColor = color;
    return color;
  }

  /**
   * Swap both decoders' precision without a reload. Drops the cached `code` latent so
   * the next `runGeom` recomputes it against the new decoders. The caller must ensure
   * no `session.run()` is in flight.
   *
   * @param preferFp16 True to run both decoders' fp16-internal variants where the
   * bundle ships them and the EP allows; false to force fp32. A no-op before `init`.
   */
  async setPrecision(preferFp16: boolean): Promise<void> {
    if (!this.buildGeom || !this.buildAppr) return;
    // Through the same warm cache and the same builders `init` used: fp16 and fp32
    // share fp32 IO, so a swap only exchanges internal weights and the lift, plücker,
    // rig and device are untouched. The first switch to a precision builds it; every
    // switch after is a reference swap.
    const geomBuilt = await this.geomPrecisions.get(preferFp16, this.buildGeom);
    const apprBuilt = await this.apprPrecisions.get(preferFp16, this.buildAppr);
    this.geom = geomBuilt.session;
    this.geomUsedFp16 = geomBuilt.usedFp16;
    this.appr = apprBuilt.session;
    this.apprUsedFp16 = apprBuilt.usedFp16;
    // A precision swap installs a DIFFERENT DecoderSession, and `downloadOutputs` is
    // per session and defaults to false. On a demoted device that would silently
    // re-arm gpu-buffer outputs while the lifter lives elsewhere, and the next lift
    // would copy a foreign GPUBuffer — a validation error, dead avatar.
    if (this.downloadOutputs) this.setDownloadOutputs(true);
    this.lastCode = null;
    this.lastZpack = null;
    this.lastGeom = null;
    this.lastColor = null;
  }

  /**
   * Build + cache a precision WITHOUT activating it, so a later swap is instant.
   *
   * @param preferFp16 The precision to warm in both {@link PrecisionCache}s. The live
   * sessions are untouched. A no-op before `init`.
   */
  async prebuild(preferFp16: boolean): Promise<void> {
    if (!this.buildGeom || !this.buildAppr) return;
    await this.geomPrecisions.get(preferFp16, this.buildGeom);
    await this.apprPrecisions.get(preferFp16, this.buildAppr);
  }

  /**
   * Demote every session's gpu-buffer outputs to CPU. The hints are baked in at
   * create time, so a device mismatch discovered afterwards can only be repaired by
   * downloading. STICKY — remembered so a later precision swap cannot quietly re-arm
   * gpu-buffer outputs on a device the lifter cannot read.
   *
   * @param on True to download every session's outputs to the CPU. Remembered, and
   * re-applied after `init` and after every precision swap.
   */
  setDownloadOutputs(on: boolean): void {
    this.downloadOutputs = on;
    for (const s of this.sessions()) s.setDownloadOutputs(on);
  }

  /**
   * Every live session behind this branch, in run order.
   *
   * @returns The trunk, geom and appr sessions, skipping any not built — a FUSED
   * branch has no trunk, and nothing is built before `init`.
   */
  sessions(): DecoderSession[] {
    return [this.trunk, this.geom, this.appr].filter((s): s is DecoderSession => !!s);
  }

  dispose(): void {
    this.trunk?.dispose();
    this.geomPrecisions.dispose();
    this.apprPrecisions.dispose();
    this.trunk = null;
    this.geom = null;
    this.appr = null;
    this.lastCode = null;
    this.lastZpack = null;
    this.lastGeom = null;
    this.lastColor = null;
  }
}
