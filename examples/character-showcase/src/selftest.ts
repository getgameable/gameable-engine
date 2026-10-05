/**
 * `?selftest=1` — the S4 acceptance, run in the browser.
 *
 * THE CLAIM. `wgsl/gnm_blend.wgsl` on a real GPU produces the same vertices as
 * `gnmReference.ts` on the CPU, which `packages/character/test/gnm.test.ts` has already
 * held to the python model. Chaining those two is what makes "the browser reproduces the
 * baked head" a measured statement rather than an intention.
 *
 * TWO MEASUREMENTS, and they answer different questions:
 *
 *   gpuVsCpu    the GPU's `vertsBuffer` against `gnmPose` over the SAME pack. This is the
 *               shader's own correctness: both sides read the same fp16 basis, so
 *               quantisation cancels exactly and what is left is the arithmetic. This is
 *               the number that has to pass.
 *   packVsModel `gnmForward` over this pack against the python model's own vertices, for
 *               the vertices the reference recorded. This is what the PACK costs —
 *               fp16 quantisation plus, on the truncated pack, the coefficients that were
 *               dropped. It is reported, not gated, because truncation is a deliberate
 *               choice with a size on the other side of it.
 *
 * THE READBACK IS DELIBERATE AND ONE-OFF. A `copyBufferToBuffer` into a `MAP_READ` buffer
 * and a `mapAsync` stalls the queue; it happens ten times, at startup, in a mode nothing
 * but this test uses. The per-frame path never reads a vertex back — that is the whole
 * design of `RigBackend`.
 */
import {
  gnmForward,
  gnmPose,
  regionSlices,
  type AosRigPack,
  type RigPreview,
} from 'gameable/character';

/** The reference JSON `tools/gnm_reference.py --json` writes. */
export interface ReferenceFrames {
  oracle: string;
  seed: number;
  frames: number;
  headExtDim: number;
  vertexCount: number;
  totalVertexCount: number;
  units: string;
  stage: string;
  vertexIds: number[];
  headExt: number[][];
  vertices: number[][];
}

/** What `?selftest=1` publishes. */
export interface SelfTestReport {
  /** Whether `gpuVsCpuMaxErrorM` came in under `toleranceM`. */
  pass: boolean;
  /** Frames compared. */
  frames: number;
  /** Vertices per frame on the GPU side (the whole head). */
  vertices: number;
  /** Max absolute per-component error, GPU vs the TypeScript CPU reference, in metres. */
  gpuVsCpuMaxErrorM: number;
  /** Mean absolute error of the same comparison. */
  gpuVsCpuMeanErrorM: number;
  /** The gate: the pack's recorded fp16 bound plus 1e-5 m. */
  toleranceM: number;
  /** The pack's own recorded fp16 requantisation bound, in metres. */
  quantisationBoundM: number;
  /** Max error of this pack's model against the python oracle, over the recorded subset. */
  packVsModelMaxErrorM: number;
  /** Which oracle produced the reference frames: `gnm` or `numpy`. */
  oracle: string;
  /** The pack under test. */
  pack: { file: string; coefficients: number; truncatedFrom: number | null };
  /** Per-frame errors, for a failure that needs looking at. */
  perFrame: { frame: number; gpuVsCpuMaxErrorM: number; packVsModelMaxErrorM: number }[];
}

/** Absolute slack on top of the pack's own quantisation bound, in metres (10 µm). */
const SLACK_M = 1e-5;

/**
 * Widen a full-model `head_ext` vector onto the layout a (possibly truncated) pack uses.
 *
 * A truncated pack keeps a PREFIX OF EACH REGION and renumbers what follows, so frame
 * data recorded against the full 383-coefficient model has to be gathered, not sliced.
 * The pack records the exact coefficient ids it kept, which is what makes this exact
 * rather than a reconstruction of the packer's rule.
 *
 * @param pack The parsed pack under test.
 * @param full One reference frame's `head_ext`, in the FULL model's layout.
 * @param fullExprDim The full model's expression dimension (383).
 * @returns A `head_ext` vector in this pack's layout.
 */
export function gatherHeadExt(
  pack: AosRigPack,
  full: readonly number[],
  fullExprDim: number,
): Float32Array {
  const layout = pack.header.headExt;
  const out = new Float32Array(layout.dim);
  const source = pack.header.source as
    { truncatedExpression?: { coefficientIds?: number[] } | null } | undefined;
  const ids = source?.truncatedExpression?.coefficientIds;
  if (ids && ids.length === layout.exprDim) {
    for (let i = 0; i < ids.length; i++) out[i] = full[ids[i]];
  } else {
    for (let i = 0; i < layout.exprDim; i++) out[i] = full[i];
  }
  for (let g = 0; g < layout.gazeDim; g++) out[layout.exprDim + g] = full[fullExprDim + g];
  return out;
}

/** What {@link runSelfTest} needs. */
export interface SelfTestOptions {
  device: GPUDevice;
  preview: RigPreview;
  pack: AosRigPack;
  packFile: string;
  reference: ReferenceFrames;
}

/**
 * Run the ten reference frames through the GPU and compare.
 *
 * @param options See {@link SelfTestOptions}.
 * @returns The report, also suitable for printing.
 */
export async function runSelfTest(options: SelfTestOptions): Promise<SelfTestReport> {
  const { device, preview, pack, reference } = options;
  const V = pack.vertexCount;
  const bytes = V * 3 * 4;

  const staging = device.createBuffer({
    label: 'selftest:readback',
    size: bytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const source = pack.header.source as { basisMaxAbsErrorM?: number } | undefined;
  const quantisationBoundM = source?.basisMaxAbsErrorM ?? 0;
  const toleranceM = quantisationBoundM + SLACK_M;
  const perFrame: SelfTestReport['perFrame'] = [];
  let worstGpu = 0;
  let sumGpu = 0;
  let countGpu = 0;
  let worstModel = 0;

  try {
    for (let f = 0; f < reference.frames; f++) {
      const headExt = gatherHeadExt(pack, reference.headExt[f], reference.headExtDim - 4);

      // 1. The GPU: solve, encode the rig pass alone, copy the vertices out.
      preview.setControls(headExt);
      const encoder = device.createCommandEncoder({ label: `selftest:frame${String(f)}` });
      preview.backend.encode(encoder);
      encoder.copyBufferToBuffer(preview.backend.vertsBuffer, 0, staging, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const gpu = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();

      // 2. The CPU, over the same pack: the full path, so stitch and skinning are in it.
      const cpu = gnmPose(pack, headExt);
      let frameWorst = 0;
      for (let i = 0; i < cpu.length; i++) {
        const error = Math.abs(gpu[i] - cpu[i]);
        if (error > frameWorst) frameWorst = error;
        sumGpu += error;
        countGpu++;
      }
      if (frameWorst > worstGpu) worstGpu = frameWorst;

      // 3. This pack's model against the python oracle, on the recorded vertices only.
      //    `gnmForward` stops where the reference does: before the seam and the skinning.
      const forward = gnmForward(pack, headExt).vertices;
      const expected = reference.vertices[f];
      let modelWorst = 0;
      for (let k = 0; k < reference.vertexIds.length; k++) {
        const v = reference.vertexIds[k];
        for (let c = 0; c < 3; c++) {
          const error = Math.abs(forward[v * 3 + c] - expected[k * 3 + c]);
          if (error > modelWorst) modelWorst = error;
        }
      }
      if (modelWorst > worstModel) worstModel = modelWorst;

      perFrame.push({
        frame: f,
        gpuVsCpuMaxErrorM: frameWorst,
        packVsModelMaxErrorM: modelWorst,
      });
    }
  } finally {
    staging.destroy();
  }

  const truncated = (
    pack.header.source as { truncatedExpression?: { fromCoefficients?: number } | null } | undefined
  )?.truncatedExpression;

  return {
    pass: worstGpu <= toleranceM,
    frames: reference.frames,
    vertices: V,
    gpuVsCpuMaxErrorM: worstGpu,
    gpuVsCpuMeanErrorM: countGpu > 0 ? sumGpu / countGpu : Number.NaN,
    toleranceM,
    quantisationBoundM,
    packVsModelMaxErrorM: worstModel,
    oracle: reference.oracle,
    pack: {
      file: options.packFile,
      coefficients: pack.coeffCount,
      truncatedFrom: truncated?.fromCoefficients ?? null,
    },
    perFrame,
  };
}

/**
 * Human-readable summary of a report, for the on-screen panel.
 *
 * @param report What {@link runSelfTest} produced.
 * @returns Lines of text.
 */
export function formatSelfTest(report: SelfTestReport): string {
  const mm = (m: number): string => `${(m * 1000).toFixed(6)} mm`;
  return [
    `self-test ${report.pass ? 'PASS' : 'FAIL'}`,
    `  pack              ${report.pack.file} (${String(report.pack.coefficients)} coefficients` +
      `${report.pack.truncatedFrom === null ? '' : ` of ${String(report.pack.truncatedFrom)}`})`,
    `  frames            ${String(report.frames)} x ${String(report.vertices)} vertices`,
    `  GPU vs CPU max    ${mm(report.gpuVsCpuMaxErrorM)}   (tolerance ${mm(report.toleranceM)})`,
    `  GPU vs CPU mean   ${mm(report.gpuVsCpuMeanErrorM)}`,
    `  pack vs ${report.oracle.padEnd(5)}     ${mm(report.packVsModelMaxErrorM)}  (fp16 + truncation)`,
  ].join('\n');
}

/**
 * Where each expression region sits in a pack's `head_ext`, for the slider panel.
 *
 * @param pack The parsed pack.
 * @returns Region name -> half-open coefficient range.
 */
export function packRegions(pack: AosRigPack): Record<string, { start: number; end: number }> {
  return regionSlices(pack.header.headExt);
}
