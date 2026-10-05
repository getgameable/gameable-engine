// Pure decision for building a decoder session: prefer the quantized (fp16)
// variant, fall back to fp32 (fetched lazily) on any build failure or a
// non-WebGPU EP, and report the automatic downgrade. Kept pure so the branchy
// prefer→fallback→throw logic is unit testable with fake
// create/getFp32/onDowngrade callbacks (no ORT).
//
// Ported from aos-threejs-poc/src/ogs/inference/decoderResolve.ts @ cdd63b10

export interface ResolveDecoderArgs<S> {
  kind: 'geom' | 'appr';
  want16: boolean; // caller already gated on EP + ?fp16 flags
  fp16Src?: string | Uint8Array;
  onWebgpu: boolean;
  // fp32 source, resolved lazily so an fp16-preferred bundle never fetches it up front.
  getFp32: () => Promise<string | Uint8Array>;
  create: (src: string | Uint8Array) => Promise<S>;
  onDowngrade?: (kind: 'geom' | 'appr', reason: string) => void;
}

/**
 * Build a decoder session, preferring the quantized fp16 variant and falling back to fp32.
 *
 * The fallback is silent to the caller but reported through `onDowngrade`, so a device that
 * cannot run the quantized asset still gets a working decoder instead of a failed load.
 *
 * @param args The kind, the candidate sources, and the create/downgrade callbacks; see
 *   {@link ResolveDecoderArgs}.
 * @returns The built session, and `usedFp16` saying which of the two variants it came from.
 */
export async function resolveDecoderSession<S>(
  args: ResolveDecoderArgs<S>,
): Promise<{ session: S; usedFp16: boolean }> {
  const { kind, want16, fp16Src, onWebgpu, getFp32, create, onDowngrade } = args;
  if (want16 && fp16Src) {
    try {
      return { session: await create(fp16Src), usedFp16: true };
    } catch (e) {
      // The fp16 .onnx fails to build on adapters without shader-f16 — automatic.
      console.warn(`resolveDecoderSession: ${kind} fp16 session failed — falling back to fp32`, e);
      onDowngrade?.(kind, 'fp16-build-failed');
    }
  } else if (fp16Src && !onWebgpu) {
    // A quantized asset exists but this device can't run it (no WebGPU) — automatic.
    onDowngrade?.(kind, 'no-webgpu');
  }
  // getFp32 throws loudly when no fp32 source is available (never a silent stub).
  return { session: await create(await getFp32()), usedFp16: false };
}
