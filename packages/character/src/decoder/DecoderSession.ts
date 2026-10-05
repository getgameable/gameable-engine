// One ONNX decoder session + its run lifecycle. The `ort` module is injected so
// tests can drive the output-wrapping / code-cache / gpu-buffer dispose lifecycle
// with a fake session (real ONNX parity is an end-to-end concern).
//
// Declare the ORT input/output names, which outputs stay on a gpu-buffer, and which
// output is cached across runs (the `code` latent, reused while only the camera
// moves).
//
// Ported from aos-threejs-poc/src/ogs/graph/DecoderSession.ts @ cdd63b10

import { createSession, type OrtLike as OrtSessionLike } from './ortSession.js';
import { withOrtGate } from './ortGate.js';
import type { NodeTensor } from './types.js';

export interface DecoderOutputSpec {
  port: string; // graph-facing output port
  ortName: string; // ONNX output tensor name
  gpuBuffer?: boolean; // hinted onto the shared device (kept, disposed next run)
  cache?: boolean; // reused across runs until the next run replaces it (the `code`)
  // Present only in SOME exports of this decoder — skipped when the loaded graph
  // does not declare it (the region-factored trunk's `zpack`). Resolved against
  // the ORT session's own outputNames, never a flag or a manifest field, so
  // nothing can disagree with the asset that actually loaded. A graph that DOES
  // declare it and then fails to produce it still throws.
  optional?: boolean;
  // Some exported graphs name their sole output something other than the spec'd
  // name (rig2mesh's `vertices`). Accept the ONE output that came back, warning
  // once — the runner path did this inline (`res.vertices ?? Object.values(res)[0]`).
  // Deliberately narrow: it never fires when the session has several outputs, so
  // a genuinely missing output still fails loudly.
  soleOutputFallback?: boolean;
}

export interface DecoderInputSpec {
  port: string; // graph-facing input port
  ortName: string; // ONNX input tensor name
  // Fed only when the loaded graph declares it. Region-factored (V8+) bundles
  // add a `zpack` input to geom/appr for their baked mask-gated FiLM, and within
  // ONE such bundle some branches still take `code` alone — eyeline V9's `body`
  // is a per-texel composite of single-content regions, which carry no FiLM. So
  // this is resolved PER SESSION from inputNames, not per bundle. A graph that
  // declares the input and is handed no tensor still throws.
  optional?: boolean;
}

export interface DecoderSessionOptions {
  inputs: DecoderInputSpec[];
  outputs: DecoderOutputSpec[];
  serialize?: boolean; // per-session run queue (the appr apprQueue back-pressure)
}

/** The slice of the ORT module a session needs to build feeds. */
export type OrtLike = {
  Tensor: new (type: string, data: Float32Array, dims: readonly number[]) => unknown;
};
/**
 * One output tensor as this wrapper reads it — every field optional, because a
 *  gpu-buffer output and a CPU one carry different halves.
 */
interface OrtOutput {
  data?: Float32Array;
  dims?: readonly number[];
  location?: string;
  gpuBuffer?: GPUBuffer;
  dispose?: () => void;
  getData?: (release?: boolean) => Promise<unknown>;
}

/** The slice of an `InferenceSession` this wrapper drives. */
export type OrtSession = {
  run: (feeds: Record<string, unknown>) => Promise<Record<string, unknown>>;
  release?: () => void | Promise<void>;
  // ORT-Web reports the loaded graph's own IO names. Absent on the bare `{ run }`
  // stubs tests inject, which is why declaresIo() falls back rather than throws.
  inputNames?: readonly string[];
  outputNames?: readonly string[];
};

export class DecoderSession {
  private live = new Map<string, { dispose?: () => void }>(); // gpu-buffer outputs awaiting dispose
  private cache = new Map<string, NodeTensor>(); // cached outputs (the code latent)
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ort: OrtLike;
  private readonly session: OrtSession;
  private readonly opts: DecoderSessionOptions;
  // Demote path: the gpu-buffer output HINTS are baked in at session create, so
  // when the device ORT actually built turns out to fail the lifter's limits the
  // only remedy is to download each output and hand the consumer a CPU array —
  // a cross-device GPUBuffer would throw. See gpuDevice.resolveOgsLiftDevice.
  private downloadOutputs = false;
  private warnedSoleOutput = new Set<string>();
  /** One reused CPU feed buffer per input port; see `toOrtTensor`. */
  private readonly feedBuffers = new Map<string, Float32Array>();
  private disposed = false;

  constructor(ort: OrtLike, session: OrtSession, opts: DecoderSessionOptions) {
    this.ort = ort;
    this.session = session;
    this.opts = opts;
  }

  // Build the session via the shared factory, then wrap it.
  static async create(
    ort: OrtLike & OrtSessionLike,
    url: string | Uint8Array,
    providers: string[],
    opts: DecoderSessionOptions,
    extra: Record<string, unknown> = {},
  ): Promise<DecoderSession> {
    const session = await withOrtGate(() => createSession(ort, url, providers, extra));
    return new DecoderSession(ort, session as OrtSession, opts);
  }

  // As create(), but WITHOUT the ORT gate — for callers that already hold it
  // (decoderBuild wraps the whole fp16→fp32 resolve in one withOrtGate, and
  // nesting the gate would deadlock its chain-every-op semantics).
  static async createFrom(
    ort: OrtLike & OrtSessionLike,
    url: string | Uint8Array,
    providers: string[],
    opts: DecoderSessionOptions,
    extra: Record<string, unknown> = {},
  ): Promise<DecoderSession> {
    const session = await createSession(ort, url, providers, extra);
    return new DecoderSession(ort, session as OrtSession, opts);
  }

  // A cached output (e.g. `code`) from the last run, or null.
  cached(port: string): NodeTensor | null {
    return this.cache.get(port) ?? null;
  }

  /**
   * Does the LOADED graph declare this ORT input / output name?
   *
   *  The authority for an `optional` spec. Undefined when the session does not
   *  report its IO names (a `{ run }` test stub) — callers then fall back to
   *  what is actually present in the feeds / results, which keeps injected
   *  stubs working without letting a real session guess.
   *
   * @param kind Which side of the graph to look at: its inputs or its outputs.
   * @param name The ORT tensor name from the spec, not the graph-facing port name.
   * @returns True or false when the session reports its IO names, `undefined` when it
   * does not.
   */
  private declaresIo(kind: 'inputs' | 'outputs', name: string): boolean | undefined {
    const names = kind === 'inputs' ? this.session.inputNames : this.session.outputNames;
    return names ? names.includes(name) : undefined;
  }

  /**
   * ORT input names of the loaded graph, or null when the session doesn't report
   *  them. Exposed so a caller can see whether a region-factored graph took its
   *  `zpack` input, without reaching into the session.
   *
   * @returns The loaded graph's ORT input names, or null on a session that does not
   * report them (a `{ run }` test stub).
   */
  get ortInputNames(): readonly string[] | null {
    return this.session.inputNames ?? null;
  }

  /**
   * ORT output names of the loaded graph, or null. `outputNames.includes("zpack")`
   *  is how region-factored assets are DETECTED — from the trunk that loaded.
   *
   * @returns The loaded graph's ORT output names, or null on a session that does not
   * report them.
   */
  get ortOutputNames(): readonly string[] | null {
    return this.session.outputNames ?? null;
  }

  /**
   * Force every gpu-buffer output back to CPU (the demote path). Loud once:
   *  this is a real performance cliff, never a silent degradation.
   *
   * @param on True to download every gpu-buffer output and release it each run. A
   * repeat of the current setting is ignored, so the warning is printed once.
   */
  setDownloadOutputs(on: boolean): void {
    if (on === this.downloadOutputs) return;
    this.downloadOutputs = on;
    if (on) {
      console.warn(
        '[character] DecoderSession: demoting gpu-buffer outputs to CPU — the device ORT ' +
          'built cannot be shared with the lifter (outputs are downloaded every run)',
      );
    }
  }

  async run(
    feeds: Readonly<Partial<Record<string, NodeTensor>>>,
  ): Promise<Record<string, NodeTensor>> {
    const job = this.queue.then(() => this._run(feeds));
    if (this.opts.serialize) this.queue = job.catch(() => {}); // keep the queue alive on error
    return job;
  }

  // `Partial<Record<…>>`, not `Record<…>`: the feeds are built per branch and an
  // absent port is the ORDINARY case (a pre-V8 bundle has no `zpack`), so the checks
  // below must be live code rather than something TS proves unreachable.
  private async _run(
    feeds: Readonly<Partial<Record<string, NodeTensor>>>,
  ): Promise<Record<string, NodeTensor>> {
    const ortFeeds: Record<string, unknown> = {};
    for (const inp of this.opts.inputs) {
      const t = feeds[inp.port];
      if (inp.optional) {
        // The graph decides. When it declares the input we REQUIRE the tensor —
        // running a FiLM graph without its `zpack` would either throw deep in ORT
        // or, worse, modulate with whatever ORT defaults to.
        const declared = this.declaresIo('inputs', inp.ortName);
        if (declared === false) continue;
        if (!t) {
          if (declared === undefined) continue; // stub session: absent means unused
          throw new Error(
            `DecoderSession: graph declares input "${inp.ortName}" but no "${inp.port}" tensor was supplied`,
          );
        }
        ortFeeds[inp.ortName] = this.toOrtTensor(t, inp.port);
        continue;
      }
      if (!t) throw new Error(`DecoderSession: missing input "${inp.port}"`);
      ortFeeds[inp.ortName] = this.toOrtTensor(t, inp.port);
    }
    const res = await withOrtGate(() => this.session.run(ortFeeds));

    const out: Record<string, NodeTensor> = {};
    for (const spec of this.opts.outputs) {
      // An optional output the loaded graph doesn't declare simply isn't there
      // (a pre-V8 trunk has no `zpack`). Checked BEFORE the sole-output fallback,
      // which would otherwise hand a one-output graph's only tensor to it.
      if (spec.optional) {
        const declared = this.declaresIo('outputs', spec.ortName);
        if (declared === false) continue;
        if (declared === undefined && !res[spec.ortName]) continue;
      }
      let t = (res as Partial<Record<string, OrtOutput>>)[spec.ortName];
      if (!t && spec.soleOutputFallback) {
        const entries = Object.entries(res);
        // Deliberately narrow: it never fires when the session has several outputs, so a
        // genuinely missing output still fails loudly.
        if (entries.length === 1) {
          const [onlyName, onlyValue] = entries[0];
          if (!this.warnedSoleOutput.has(spec.ortName)) {
            this.warnedSoleOutput.add(spec.ortName);
            console.warn(
              `[character] DecoderSession: no output named "${spec.ortName}" — using the ` +
                `session's sole output "${onlyName}"`,
            );
          }
          t = onlyValue as OrtOutput;
        }
      }
      if (!t) throw new Error(`DecoderSession: session produced no "${spec.ortName}"`);
      // Demoted: download the gpu-buffer output and release it right away — the
      // consumer is on a device that can't read this buffer.
      if (this.downloadOutputs && t.location === 'gpu-buffer' && t.getData !== undefined) {
        const data = (await t.getData(true)) as Float32Array;
        out[spec.port] = { loc: 'cpu', data, dims: t.dims ?? [] };
        if (spec.cache) this.cache.set(spec.port, out[spec.port]);
        continue;
      }
      const nt: NodeTensor =
        t.location === 'gpu-buffer'
          ? { loc: 'gpu-buffer', tensor: t as never, dims: t.dims ?? [] }
          : { loc: 'cpu', data: t.data as Float32Array, dims: t.dims ?? [] };
      // ORT-Web doesn't auto-free gpu-buffer outputs — dispose the prior frame's
      // (already consumed downstream) before keeping this one.
      if (nt.loc === 'gpu-buffer') {
        const prior = this.live.get(spec.ortName);
        if (prior && prior !== (t as never)) prior.dispose?.();
        this.live.set(spec.ortName, t);
      }
      out[spec.port] = nt;
      if (spec.cache) this.cache.set(spec.port, nt);
    }
    return out;
  }

  /**
   * Release the ORT session + every tensor it still owns. ORT-Web does not
   *  auto-free gpu-buffer outputs, and an OGS character switch tears down eight
   *  sessions — leaking them leaks decoder VRAM for the rest of the page.
   */
  dispose(): void {
    // IDEMPOTENT. Two owners legitimately dispose the same session (OGSDecoder
    // holds the active one AND the PrecisionCache holds every built one), and
    // ORT-Web's release() REJECTS on a second call ("cannot release session.
    // invalid session id") — an async rejection a sync try/catch cannot catch,
    // so it surfaced as an uncaught rejection per decoder on every teardown.
    if (this.disposed) return;
    this.disposed = true;
    const disp = (t: { dispose?: () => void } | undefined) => {
      try {
        t?.dispose?.();
      } catch {
        /* best-effort */
      }
    };
    for (const t of this.live.values()) disp(t);
    this.live.clear();
    for (const t of this.cache.values()) if (t.loc === 'gpu-buffer') disp(t.tensor);
    this.cache.clear();
    // release() is async: swallow the rejection too, not just a sync throw.
    try {
      void Promise.resolve(this.session.release?.()).catch(() => {
        /* best-effort */
      });
    } catch {
      /* best-effort */
    }
  }

  /**
   * A feed as ORT wants it, copied into this port's own reused buffer.
   *
   * THE COPY IS NOT OPTIONAL — the caller owns `t.data` and refills it next frame,
   * and the demote path hands back ORT's own output array — but ALLOCATING it was:
   * `new Float32Array(t.data)` per feed per run is 13.5 MB per branch per frame on
   * the demote path, straight into the nursery.
   *
   * Reuse is safe because runs are serialised. Every `session.run` goes through
   * `withOrtGate`, which lets exactly one ORT operation be in flight across the whole
   * runtime, and `_run` awaits it — so the next call that could overwrite this buffer
   * cannot start until ORT has finished reading it.
   *
   * @param t The feed, on the CPU or already on a gpu-buffer.
   * @param port The graph-facing port name, which keys the reused buffer: two ports of
   *   one session have different widths and must not share one.
   * @returns The ORT tensor to feed — a fresh wrapper over the reused array, or the
   *   gpu-buffer tensor untouched.
   */
  private toOrtTensor(t: NodeTensor, port: string): unknown {
    if (t.loc === 'gpu-buffer') return t.tensor;
    let buffer = this.feedBuffers.get(port);
    if (!buffer || buffer.length !== t.data.length) {
      buffer = new Float32Array(t.data.length);
      this.feedBuffers.set(port, buffer);
    }
    buffer.set(t.data);
    return new this.ort.Tensor('float32', buffer, t.dims);
  }
}
