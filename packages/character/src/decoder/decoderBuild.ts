// The ONE place a character's ONNX decoder session is born.
//
// Three things every decoder build needs, in one place so no call site can skip one
// (a bundle's shipped fp16 decoders are unreachable without all three):
//   1. the ORT env assert (wasmPaths / numThreads / proxy=false),
//   2. the fp16-preferred -> fp32-fallback resolve (../inference/decoderResolve.ts),
//   3. the warm per-precision session cache.
//
// `ensureCharacterOrtEnv` runs INSIDE the gated create callback on purpose: `ort.env`
// is a shared singleton and another consumer of the same runtime may set
// `proxy = true` for a worker offload. ORT captures `proxy` per session AT CREATE
// TIME, so re-asserting it immediately before each create — while holding the gate,
// so no other create can interleave — is strictly safer than a single init-time
// assert.
//
// Ported from aos-threejs-poc/src/ogs/graph/decoderBuild.ts @ cdd63b10

import { DecoderSession, type DecoderSessionOptions, type OrtLike } from './DecoderSession.js';
import type { OrtLike as OrtSessionLike } from './ortSession.js';
import { withOrtGate } from './ortGate.js';
import { resolveDecoderSession } from '../inference/decoderResolve.js';

/** The slice of `ort.env` this module asserts. */
export type OrtEnvLike = {
  env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
};

/**
 * Where the ORT `.wasm` / `.mjs` runtime files are served from, when the host says. Unset (the
 * default), ORT finds them beside its own module, which is where a bundler (Vite) puts them; the
 * old default `/onnxruntime/` was a directory nothing served, so every decoder 404'd in a Vite app.
 */
export let ortWasmPaths: string | undefined;

/**
 * Point ORT at a runtime directory of the host's own (a CDN, the engine's asset route).
 *
 * @param path Directory the `.wasm` / `.mjs` runtime files are served from, with its
 * trailing slash — ORT concatenates the file name onto it.
 */
export function setOrtWasmPaths(path: string): void {
  ortWasmPaths = path;
}

/**
 * Assert the character ORT env. Idempotent, cheap; call before every session create.
 *
 * @param ort The shared ORT module whose `env.wasm` singleton is overwritten:
 * `wasmPaths` to {@link ortWasmPaths} when the host set one, `numThreads` to 1, `proxy` to false.
 */
export function ensureCharacterOrtEnv(ort: OrtEnvLike): void {
  if (ortWasmPaths !== undefined) ort.env.wasm.wasmPaths = ortWasmPaths;
  // Single-threaded: the threaded build needs crossOriginIsolated (COOP/COEP),
  // which a game's host page cannot be assumed to enable.
  ort.env.wasm.numThreads = 1;
  // Main thread, not the proxy worker: the proxy rejects preferredOutputLocation
  // outright, and a worker-owned GPUDevice can't share gpu-buffers with the
  // main-thread renderer. The whole gpu-buffer path depends on this.
  ort.env.wasm.proxy = false;
}

export type DecoderKind = 'geom' | 'appr';
export type Precision = 'fp16' | 'fp32';

export interface CreateResolvedDecoderArgs {
  kind: DecoderKind; // decoderResolve's downgrade taxonomy
  label?: string; // 'head.geom' — logs only, not the taxonomy
  want16: boolean; // caller pre-gates on EP + ogsGpuFlags + the node's precision pick
  fp16Src?: string | Uint8Array;
  onWebgpu?: boolean;
  getFp32: () => Promise<string | Uint8Array>;
  ort: OrtEnvLike & OrtLike & OrtSessionLike;
  providers: string[];
  spec: DecoderSessionOptions;
  extra?: Record<string, unknown>; // preferredOutputLocation + profiler options
  onDowngrade?: (kind: DecoderKind, reason: string) => void;
}

/**
 * Build one decoder at the best precision it can actually run: fp16-internal
 *  when asked for and buildable, else fp32 (fetched lazily) with a REPORTED
 *  downgrade — never a silent fallback.
 *
 * @param args The build request: the fp16/fp32 sources, the ORT module, the provider
 * list, the session spec and the downgrade callback.
 * @returns The built {@link DecoderSession} and `usedFp16`, the precision it ACTUALLY
 * built at — which is what `args.label` is logged with.
 */
export async function createResolvedDecoder(
  args: CreateResolvedDecoderArgs,
): Promise<{ session: DecoderSession; usedFp16: boolean }> {
  const { kind, want16, fp16Src, getFp32, ort, providers, spec, extra, onDowngrade } = args;
  const res = await resolveDecoderSession<DecoderSession>({
    kind,
    want16,
    fp16Src,
    onWebgpu: args.onWebgpu ?? providers[0] === 'webgpu',
    getFp32,
    create: (src) =>
      withOrtGate(() => {
        ensureCharacterOrtEnv(ort);
        return DecoderSession.createFrom(ort, src, providers, spec, extra ?? {});
      }),
    onDowngrade,
  });
  if (args.label) {
    console.info(
      `[character] decoder '${args.label}': ${res.usedFp16 ? 'fp16' : 'fp32'} (internal weights; fp32 IO)`,
    );
  }
  return res;
}

/**
 * Warm cache of built decoder sessions keyed by RESOLVED precision.
 *
 *  Sessions are built LAZILY, so a normal boot holds exactly ONE precision — the
 *  resolved default (fp16 where the bundle ships it and the EP allows it). The second
 *  only materialises if a caller flips precision, and from then on both stay resident
 *  so further toggles are an instant reference swap — no rebuild, no network, no
 *  reload. The ~2x decoder VRAM is a cost the toggle opts into, never something a
 *  shipped session pays.
 */
export class PrecisionCache {
  private built: Partial<Record<Precision, DecoderSession>> = {};

  /**
   * Record an already-built session (the boot one) under its resolved precision.
   *
   * @param usedFp16 The precision the session ACTUALLY built at, which decides the key.
   * @param session The built session to hold for a later toggle.
   */
  seed(usedFp16: boolean, session: DecoderSession): void {
    this.built[usedFp16 ? 'fp16' : 'fp32'] = session;
  }

  has(p: Precision): boolean {
    return !!this.built[p];
  }

  /**
   * The session for `want16`, building it once via `build` on a miss. Caches
   *  under the RESOLVED precision (an fp16 request can auto-downgrade), so a
   *  device that can't build fp16 doesn't retry the build on every toggle.
   *
   * @param want16 The precision asked for: true for fp16-internal, false for fp32.
   * @param build Builds the session on a miss; called at most once per key, and its
   * `usedFp16` is believed over the request.
   * @returns The session and the precision it is really running at — `usedFp16` is
   * false whenever the fp16 key holds the aliased fp32 fallback.
   */
  async get(
    want16: boolean,
    build: (want16: boolean) => Promise<{ session: DecoderSession; usedFp16: boolean }>,
  ): Promise<{ session: DecoderSession; usedFp16: boolean }> {
    const key: Precision = want16 ? 'fp16' : 'fp32';
    const hit = this.built[key];
    // usedFp16 is the RESOLVED precision, which is only 'fp16' when the fp16 session
    // is the one under the fp16 key — a downgraded request is recorded under BOTH
    // keys (below) but is an fp32 session, so ask the session, never the key.
    if (hit) return { session: hit, usedFp16: hit === this.built.fp32 ? false : key === 'fp16' };
    const res = await build(want16);
    this.built[res.usedFp16 ? 'fp16' : 'fp32'] = res.session;
    // An fp16 request that AUTO-DOWNGRADED: alias the fallback under the
    // requested key too, otherwise every toggle back to fp16 misses the cache
    // and re-runs the whole failing fp16 build (a stall under the engine's
    // mutex, plus a repeated downgrade warning in the asset indicator).
    if (want16 && !res.usedFp16) this.built.fp16 = res.session;
    return res;
  }

  /** Release every session this cache built (pipeline teardown). */
  dispose(): void {
    // Deduped: a downgraded fp16 request aliases ONE session under both keys,
    // and ORT's release() rejects on a second call.
    for (const s of new Set(Object.values(this.built))) s.dispose();
    this.built = {};
  }
}
