// The exact MetaHuman rig in the browser: OpenRigLogic (Epic) compiled to wasm
// evaluates controls -> joint transforms + blendshape weights, and `./deform.ts`
// applies the blendshapes + linear-blend skinning to produce vertices.
//
// Units: the DNA and the baked pack are in CENTIMETRES. This module returns cm —
// callers convert at their own boundary.
//
// Ported from aos-threejs-poc/src/lib/orl/orlRig.js @ cdd63b10. The UI-facing half
// (`guiToRaw` / `rawToGui` / `rawToControls` / `drivableRaw`, the rig-board
// readout) is DROPPED: it exists to make RigLogic's raw control layer editable in
// an authoring panel, and a game has no such panel. `detectControlSpace` stays,
// because a bundle solved against the raw layer resolves 0 of 263 controls through
// the GUI map and the error that produces blames the DNA when the DNA is correct.

import createRigLogicModule from './vendor/riglogic.js';
import type { RigLogicModule } from './vendor/riglogic.js';

import { ORL_PACK_FILE, ORL_REQUIRED_MEMBERS, orlAssetName } from './bundleFiles.js';
import { createDeformer, type OrlBuffers, type OrlDeformer, type OrlManifest } from './deform.js';
import type { BlendshapeTarget } from './csr.js';
import { parseOrlPack, type OrlPack } from './orlPack.js';

/**
 * The one ORL artifact that ships with the engine rather than with a character:
 * identity-INDEPENDENT code. Every baked rig is character data and comes from that
 * character's assets.
 *
 * `new URL(..., import.meta.url)` rather than an `?url` import because node
 * understands it natively — the tests import this module outside any bundler.
 */
export const ORL_WASM_URL = new URL('./vendor/riglogic.wasm', import.meta.url).href;

/** Where the behaviour DNA is staged for RigLogic's stream reader. */
const DNA_MEMFS_PATH = '/head.dna';

/**
 * MetaHuman control names are `CTRL_C_jaw.translateY`; DNA GUI names are `CTRL_C_jaw.ty`.
 *
 * @param name A control name in either spelling.
 * @returns The DNA GUI spelling: a trailing `.translateX/Y/Z` becomes `.tx/.ty/.tz`,
 *   and anything else is returned unchanged.
 */
export function mhNameToDna(name: string): string {
  return name.replace(/\.translate([XYZ])$/, (_, axis: string) => '.t' + axis.toLowerCase());
}

/** Which layer a name list is written in, and how strongly. */
export interface ControlSpaceDetection {
  space: 'gui' | 'raw';
  nRaw: number;
  nGui: number;
}

/**
 * WHICH OF RIGLOGIC'S TWO CONTROL LAYERS a name list is written in.
 *
 * Every MetaHuman DNA carries both, and they are disjoint NAMESPACES rather than
 * two spellings of one thing (measured on a real DNA):
 *
 *   GUI  174 names over 161 widgets  `CTRL_L_brow_down.ty`         the animator rig
 *   RAW  263 names                   `CTRL_expressions.browDownL`  what RigLogic evaluates
 *                                    (251 expressions + 12 head/neck pose quaternions)
 *
 * `mapGUIToRawControls` bridges GUI -> RAW and does NOT invert, so a list is in one
 * layer or the other and matching across them resolves ZERO. A bundle solved
 * against the raw layer resolves 0 of 263 through the GUI map, and the error that
 * produces blames the DNA for having diverged when the DNA is correct and the
 * namespaces simply do not overlap. That misdiagnosis is the whole reason this
 * exists.
 *
 * Decided by COUNTING MATCHES in each layer, not by a flag: the names are already
 * unambiguous, and a flag is one more thing that can disagree with the file it
 * describes.
 *
 * @param inputNames The bundle's control names, in its own order.
 * @param guiNames The DNA's GUI control names, from `guiControlNames()`.
 * @param rawNames The DNA's RAW control names, from `rawControlNames()`.
 * @returns The winning layer plus both match counts — `nRaw` and `nGui` are the
 *   diagnosis when the answer looks wrong.
 */
export function detectControlSpace(
  inputNames: readonly string[],
  guiNames: readonly string[],
  rawNames: readonly string[],
): ControlSpaceDetection {
  const raw = new Set(rawNames);
  const gui = new Set(guiNames);
  let nRaw = 0;
  let nGui = 0;
  for (const n of inputNames) {
    if (raw.has(n)) nRaw++;
    if (gui.has(mhNameToDna(n))) nGui++;
  }
  return { space: nRaw > nGui ? 'raw' : 'gui', nRaw, nGui };
}

/** A control map: `forInput[i]` is the DNA index driven by input control `i`, or -1. */
export interface ControlMap {
  forInput: Int32Array;
  matched: number;
  unmatched: string[];
}

/**
 * Input control index -> DNA RAW control index, for a list already written in the
 * raw layer.
 *
 * Separate from `buildControlMap` because the failure it guards is different: a GUI
 * list legitimately leaves ~11 controls unmatched (eye aim, lipsPressD, the viewport
 * switches), while a raw list either IS this DNA's raw set or belongs to another
 * character entirely.
 *
 * @param inputNames The bundle's control names, already in the raw layer.
 * @param rawNames The DNA's RAW control names, in DNA index order.
 * @param options Match-strictness options.
 * @param options.minMatched Fewest resolved controls that still counts as this DNA.
 *   Falling short throws rather than returning a mostly-unmapped rig.
 * @returns `forInput[i]` is the DNA raw index for input control `i` (-1 when
 *   unmatched), plus the match count and the names that did not resolve.
 */
export function buildRawControlMap(
  inputNames: readonly string[],
  rawNames: readonly string[],
  { minMatched = 1 }: { minMatched?: number } = {},
): ControlMap {
  const rawIndex = new Map(rawNames.map((n, i) => [n, i]));
  const forInput = new Int32Array(inputNames.length).fill(-1);
  const unmatched: string[] = [];
  for (let i = 0; i < inputNames.length; i++) {
    const r = rawIndex.get(inputNames[i]);
    if (r === undefined) unmatched.push(inputNames[i]);
    else forInput[i] = r;
  }
  const matched = inputNames.length - unmatched.length;
  if (matched < minMatched) {
    throw new Error(
      `[orl] raw control map: only ${String(matched)}/${String(inputNames.length)} controls resolved against ` +
        `the DNA's ${String(rawNames.length)} RAW controls (expected >= ${String(minMatched)}) — wrong DNA for this bundle`,
    );
  }
  return { forInput, matched, unmatched };
}

/**
 * Map an arbitrary control-name list (MetaHuman naming) onto the DNA's GUI control
 * indices.
 *
 * Unmatched controls are NOT an error — real bundles legitimately carry controls
 * RigLogic does not expose (eye aim, lipsPressD, viewport switches) — but a caller
 * that matches almost nothing has a real problem, so `minMatched` throws.
 *
 * @param inputNames The bundle's control names, in MetaHuman spelling.
 * @param guiNames The DNA's GUI control names, in DNA index order.
 * @param options Match-strictness options.
 * @param options.minMatched Fewest resolved controls that still counts as agreement
 *   between the DNA and the name list. Falling short throws.
 * @returns `forInput[i]` is the DNA GUI index for input control `i` (-1 when
 *   unmatched), plus the match count and the names that did not resolve.
 */
export function buildControlMap(
  inputNames: readonly string[],
  guiNames: readonly string[],
  { minMatched = 1 }: { minMatched?: number } = {},
): ControlMap {
  const guiIndex = new Map(guiNames.map((n, i) => [n, i]));
  const forInput = new Int32Array(inputNames.length).fill(-1);
  const unmatched: string[] = [];
  for (let i = 0; i < inputNames.length; i++) {
    const g = guiIndex.get(mhNameToDna(inputNames[i]));
    if (g === undefined) unmatched.push(inputNames[i]);
    else forInput[i] = g;
  }
  const matched = inputNames.length - unmatched.length;
  if (matched < minMatched) {
    throw new Error(
      `[orl] control map regressed: only ${String(matched)}/${String(inputNames.length)} controls resolved ` +
        `against the DNA's ${String(guiNames.length)} GUI controls (expected >= ${String(minMatched)}). ` +
        'The DNA and the control-name list have diverged — the face would barely move.',
    );
  }
  return { forInput, matched, unmatched };
}

/** The rig's per-frame outputs. Both fields are LIVE VIEWS onto the wasm heap. */
export interface RigOutputs {
  jointOut: Float32Array;
  bsOut: Float32Array;
}

/** A booted, shared ORL rig. */
export interface OrlRig {
  /** controls -> posed vertices, cm. Returns the deformer's reused scratch. */
  evaluate(controls: Float32Array): Float32Array;
  /** The rig half only: controls -> joint transforms + blendshape weights. */
  evaluateRig(controls: Float32Array): RigOutputs;
  /** 'gui' | 'raw' — which layer this bundle's control vector is written in. */
  readonly controlSpace: 'gui' | 'raw';
  readonly deformer: OrlDeformer;
  readonly V: number;
  readonly J: number;
  readonly neutral: Float32Array;
  readonly controlNames: readonly string[];
  readonly matched: number;
  readonly unmatched: readonly string[];
  readonly manifest: OrlManifest;
  /** Drop this holder's claim; the wasm heap goes when the last one does. */
  release(): void;
}

/** Options for `createOrlRig`. */
export interface CreateOrlRigOptions {
  /** Mounted `orl_*` character assets. */
  getBytes: (name: string) => Uint8Array | undefined;
  /** Control names, in the order the caller will supply values. */
  controlNames: string[];
  wasmUrl?: string;
  /** Assert the pack's vertex count (loud mismatch). */
  expectVerts?: number;
  minMatched?: number;
  log?: (message: string) => void;
  /**
   * RigLogic module factory. Injectable for the same reason the POC's is: it is
   * what lets the sharing and teardown rules be tested without a wasm build or a
   * character's rig.
   */
  createModule?: typeof createRigLogicModule;
}

interface SharedEntry {
  refs: number;
  rig: Promise<Omit<OrlRig, 'release'>>;
}

/**
 * packBytes -> { refs, rig }. Keyed by object IDENTITY, so it holds no character
 * alive on its own once every branch has released.
 */
const SHARED = new Map<Uint8Array, SharedEntry>();

/**
 * Drop one claim on a shared rig, destroying it when the last holder lets go.
 *
 * @param packBytes The pack the entry is keyed on — the same object identity that
 *   `createOrlRig` looked it up with.
 */
function releaseShared(packBytes: Uint8Array): void {
  const shared = SHARED.get(packBytes);
  if (!shared || --shared.refs > 0) return;
  SHARED.delete(packBytes);
  // Settled by construction — nothing reaches here without having awaited it.
  void shared.rig
    .then((rig) => (rig as { destroy?: () => void }).destroy?.())
    .catch(() => {
      /* a failed build owns nothing */
    });
}

/**
 * Build the deformer from a parsed pack.
 *
 * @param pack A parsed pack that has already passed its required-member check.
 * @returns The deformer, the manifest it was built from, and the blendshape target
 *   runs — the latter two are kept because the caller reads and amends them.
 */
function deformerFromPack(pack: OrlPack): {
  deformer: OrlDeformer;
  manifest: OrlManifest;
  bsTargets: BlendshapeTarget[];
} {
  const need = (file: string): Uint8Array => {
    const b = pack.get(file);
    if (!b) throw new Error(`[orl] pack has no "${file}" (carries: ${pack.names.join(', ')})`);
    return b;
  };
  // createDeformer wants ArrayBuffers; pack members are Uint8Array views.
  const ab = (file: string): ArrayBuffer => {
    const b = need(file);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  const manifest = pack.json('manifest.json') as OrlManifest;
  const bsTargets = pack.json('bs_targets.json') as BlendshapeTarget[];
  const bufs: Record<string, ArrayBuffer> = {};
  for (const f of ORL_REQUIRED_MEMBERS) {
    if (f.endsWith('.bin')) bufs[f.replace(/\.bin$/, '')] = ab(f);
  }
  return {
    deformer: createDeformer(manifest, bufs as unknown as OrlBuffers, bsTargets),
    manifest,
    bsTargets,
  };
}

/**
 * Boot the wasm rig + geometry pack and return a synchronous evaluator.
 *
 * SHARED PER PACK, refcounted — `release()` is paired with this call, not optional.
 * A multi-region bundle asks twice (the head branch skins `head_lod0`, the
 * eyes/teeth branch drives rigid shells), and building it twice means two wasm
 * instantiations, two DNAs in two MEMFS heaps, and two dequantizations of ~2.4 M
 * int8 deltas into a ~28 MB array the shell deform never reads. Sharing is also
 * what makes teardown expressible: with one owner per instance nobody could say
 * when the module was free, so the heap survived every character switch.
 *
 * Keyed on the pack BYTES (identity, not content): one loader hands every branch
 * the same `Uint8Array`, so same-object means same rig by construction.
 *
 * @param options How to find the pack and which control vector to drive it with.
 * @returns The booted rig: a synchronous `evaluate` returning posed vertices in
 *   centimetres, the deformer and its counts, and the `release` that pairs with
 *   this call.
 */
export async function createOrlRig(options: CreateOrlRigOptions): Promise<OrlRig> {
  const {
    getBytes,
    controlNames,
    wasmUrl = ORL_WASM_URL,
    expectVerts = 0,
    minMatched = 1,
    log = () => {
      /* quiet by default */
    },
    createModule = createRigLogicModule,
  } = options;

  // ONE fetch / ONE mounted asset for the whole rig — DNA, mesh, weights and
  // blendshapes all ride in the same pack, so there is no partially-loaded state.
  const packName = orlAssetName(ORL_PACK_FILE);
  const packBytes = getBytes(packName);
  if (!packBytes) throw new Error(`[orl] ${packName} is not mounted`);

  // The IN-FLIGHT promise is cached, not just the result: the two branches are
  // built back to back and both awaits land before either resolves, so caching only
  // on completion would still build two.
  let shared = SHARED.get(packBytes);
  if (!shared) {
    shared = {
      refs: 0,
      rig: buildOrlRig({
        packBytes,
        packSource: `character assets (${packName})`,
        controlNames,
        wasmUrl,
        minMatched,
        log,
        createModule,
      }),
    };
    SHARED.set(packBytes, shared);
  }
  shared.refs++;
  let base: Omit<OrlRig, 'release'>;
  try {
    base = await shared.rig;
  } catch (e) {
    // A failed build must not stay cached as a permanently-rejecting promise: the
    // caller's own fallback re-enters here, and every retry for the life of the page
    // would replay the first error.
    if (--shared.refs <= 0) SHARED.delete(packBytes);
    throw e;
  }
  // The cache is keyed on the PACK, but the control map is built from the FIRST
  // caller's controlNames — so a second branch supplying a different order would
  // silently write its values through someone else's GUI indices, and (since
  // evaluateRig memoizes on the vector) could even be handed the other branch's
  // outputs verbatim. This makes that a checked precondition rather than a
  // coincidence, because the failure is a subtly wrong face, not an error.
  if (
    base.controlNames.length !== controlNames.length ||
    base.controlNames.some((n, i) => n !== controlNames[i])
  ) {
    releaseShared(packBytes);
    throw new Error(
      `[orl] ${packName} is already shared with a branch using a different control order ` +
        `(${String(base.controlNames.length)} vs ${String(controlNames.length)} names) — one pack serves one control space`,
    );
  }
  if (expectVerts && base.deformer.V !== expectVerts) {
    releaseShared(packBytes);
    throw new Error(
      `[orl] pack vertex count ${String(base.deformer.V)} != expected ${String(expectVerts)} — wrong identity or wrong mesh`,
    );
  }
  let released = false;
  return {
    ...base,
    /** Idempotent — a double dispose must not free a sibling's live rig. */
    release() {
      if (released) return;
      released = true;
      releaseShared(packBytes);
    },
  };
}

/**
 * Instantiate RigLogic, stage the DNA, map the controls and build the deformer.
 *
 * The unshared half of `createOrlRig`: one call per distinct pack, its promise held
 * by `SHARED` so concurrent branches await the same build.
 *
 * @param options Everything the build needs, already defaulted by `createOrlRig`.
 * @param options.packBytes The `orl_pack.bin` bytes, still to be parsed.
 * @param options.packSource Human-readable provenance, quoted in errors so a bad
 *   pack names where it came from.
 * @param options.controlNames Control names in the order the caller will supply
 *   values; the control map is built against these.
 * @param options.wasmUrl Where `locateFile` resolves `riglogic.wasm` to.
 * @param options.minMatched Fewest controls that must resolve against the DNA.
 * @param options.log Sink for the boot summary and the mixed-layer warning.
 * @param options.createModule The RigLogic module factory, injectable so the
 *   sharing and teardown rules can be tested without a wasm build.
 * @returns The rig minus `release`, plus the `destroy` that frees the wasm heap.
 */
async function buildOrlRig({
  packBytes,
  packSource,
  controlNames,
  wasmUrl,
  minMatched,
  log,
  createModule,
}: {
  packBytes: Uint8Array;
  packSource: string;
  controlNames: string[];
  wasmUrl: string;
  minMatched: number;
  log: (message: string) => void;
  createModule: typeof createRigLogicModule;
}): Promise<Omit<OrlRig, 'release'> & { destroy: () => void }> {
  const pack = parseOrlPack(packBytes);
  const missing = ORL_REQUIRED_MEMBERS.filter((f) => !pack.has(f));
  if (missing.length) {
    throw new Error(`[orl] pack from ${packSource} is missing: ${missing.join(', ')}`);
  }

  const M: RigLogicModule = await createModule({
    locateFile: (p) => (p === 'riglogic.wasm' ? wasmUrl : p),
  });

  // RigLogic reads the DNA through its own stream layer, so hand it a file in
  // MEMFS: `loadDNA()` marshals via a JS array and is markedly slower for a
  // multi-MB rig.
  const dnaBytes = pack.get('head_behavior.dna');
  // Checked above by ORL_REQUIRED_MEMBERS, so this is a parser change rather than a bad
  // pack — say which.
  if (!dnaBytes) throw new Error('[orl] pack passed its member check but has no DNA');
  M.FS.writeFile(DNA_MEMFS_PATH, dnaBytes);
  if (!M.loadDNAFromPath(DNA_MEMFS_PATH)) {
    throw new Error(`[orl] loadDNAFromPath failed — the DNA from ${packSource} is unreadable`);
  }

  const guiNames = M.guiControlNames();
  // A wasm predating the raw exports still drives everything; only the raw drive
  // path is unavailable, and it checks by name.
  const rawNames = typeof M.rawControlNames === 'function' ? M.rawControlNames() : [];

  const { space, nRaw, nGui } = detectControlSpace(controlNames, guiNames, rawNames);
  let forInput: Int32Array;
  let matched: number;
  let unmatched: string[];
  // A list should score in ONE layer — the namespaces are disjoint, so the loser
  // normally scores zero. Both scoring means the names are mixed, and the choice
  // below is then a majority vote on something that should not have been a vote:
  // whichever layer loses, those controls silently go unmapped. Say so; the counts
  // are the whole diagnosis.
  if (nRaw > 0 && nGui > 0) {
    log(
      `[orl] WARNING: rig_names matches BOTH control layers (${String(nGui)} GUI, ${String(nRaw)} RAW) — ` +
        `driving as ${space.toUpperCase()}, so the other ${String(space === 'raw' ? nGui : nRaw)} will not map`,
    );
  }
  if (space === 'raw') {
    ({ forInput, matched, unmatched } = buildRawControlMap(controlNames, rawNames, { minMatched }));
  } else {
    ({ forInput, matched, unmatched } = buildControlMap(controlNames, guiNames, { minMatched }));
  }

  const { deformer, manifest } = deformerFromPack(pack);
  // The joint names the rigid shells bind by. Read once here rather than per shell:
  // `getJointName` is an embind call and the shell bind runs over 870 joints.
  if (!manifest.jointNames && typeof M.getJointName === 'function') {
    const names: string[] = [];
    for (let j = 0; j < deformer.J; j++) names.push(M.getJointName(j));
    manifest.jointNames = names;
  }

  /** The last control vector solved. See `evaluateRig` for why only the SOLVE is cached. */
  let lastControls: Float32Array | null = null;
  const out: RigOutputs = { jointOut: new Float32Array(0), bsOut: new Float32Array(0) };
  log(
    `[orl] pack: ${String(deformer.V)} verts, ${String(deformer.J)} joints, ${String(manifest.numBlendShapeTargets)} bs targets, ` +
      `${String(matched)}/${String(controlNames.length)} ${space.toUpperCase()} controls mapped` +
      (unmatched.length ? ` (unmapped: ${unmatched.join(', ')})` : ''),
  );

  /**
   * True when `controls` matches the vector the cached outputs came from.
   *
   * @param controls The control vector about to be solved.
   * @returns True when every element equals the memoized copy, so the solve can be
   *   skipped. A NaN anywhere never compares equal and forces a re-solve.
   */
  function sameControls(controls: Float32Array): boolean {
    if (!lastControls || controls.length !== lastControls.length) return false;
    for (let i = 0; i < controls.length; i++) {
      // NaN never equals itself, so a NaN forces a re-solve rather than pinning the
      // face on the last good pose.
      if (controls[i] !== lastControls[i]) return false;
    }
    return true;
  }

  /**
   * The rig half only: controls -> joint transforms + blendshape weights.
   *
   * MEMOIZED ON THE CONTROL VECTOR, because the rig is SHARED and a multi-region
   * bundle evaluates it TWICE per frame from one input. Only the SOLVE is memoized,
   * not the arrays it produced: the getters hand back zero-copy views onto the wasm
   * heap, valid only until the next `calculate()` and DETACHED outright if the heap
   * grows, so caching one across frames would eventually hand a branch a
   * zero-length array. Re-reading them is two view constructions and no copy; the
   * 870-joint solve is what was worth skipping.
   *
   * Values pass through SIGNED: several MetaHuman controls are differences of ARKit
   * pairs and their DNA counterparts are genuinely bipolar (`CTRL_C_jaw.tx` deforms
   * symmetrically at +1 and -1), so clamping to [0,1] would silently kill half of
   * every such control's range.
   *
   * @param controls One value per name in `controlNames`, signed.
   * @returns The reused outputs holder. Both fields are fresh zero-copy views onto
   *   the wasm heap: `jointOut` is 9 floats per joint (translate in centimetres,
   *   rotate in degrees, scale delta) and `bsOut` one weight per blendshape
   *   channel. Valid only until the next call.
   */
  function evaluateRig(controls: Float32Array): RigOutputs {
    if (!sameControls(controls)) {
      if (space === 'raw') {
        // Straight into the layer RigLogic evaluates. NO mapGUIToRawControls after
        // this: that call writes GUI -> RAW and would overwrite everything just set,
        // leaving the face at whatever the (untouched) GUI controls say — neutral.
        for (let i = 0; i < forInput.length; i++) {
          const r = forInput[i];
          if (r >= 0) M.setRawControl(r, controls[i]);
        }
      } else {
        for (let i = 0; i < forInput.length; i++) {
          const g = forInput[i];
          if (g >= 0) M.setGUIControl(g, controls[i]);
        }
        M.mapGUIToRawControls(); // REQUIRED — skipping it silently yields all-zero output
      }
      M.calculate();
      // COPIED, not aliased: the caller owns `controls` and may refill the same
      // buffer next frame, which would leave the comparison checking a vector
      // against itself and pin the face on one pose forever.
      if (lastControls === null || lastControls.length !== controls.length) {
        lastControls = new Float32Array(controls.length);
      }
      lastControls.set(controls);
    }
    out.jointOut = M.getJointOutputs();
    out.bsOut = M.getBlendShapeOutputs();
    return out;
  }

  /**
   * The whole chain: controls -> rig solve -> blendshapes + skinning.
   *
   * @param controls One value per name in `controlNames`, signed.
   * @returns The deformer's reused output buffer: V posed vertices as xyz triples,
   *   in CENTIMETRES. Overwritten by the next call.
   */
  function evaluate(controls: Float32Array): Float32Array {
    const { jointOut, bsOut } = evaluateRig(controls);
    return deformer.deform(jointOut, bsOut);
  }

  /** Free the wasm heap. Called by `releaseShared` when the last holder lets go. */
  function destroy(): void {
    try {
      M.FS.unlink(DNA_MEMFS_PATH);
    } catch {
      /* already gone */
    }
  }

  return {
    evaluate,
    evaluateRig,
    controlSpace: space,
    deformer,
    V: deformer.V,
    J: deformer.J,
    neutral: deformer.neutral,
    controlNames,
    matched,
    unmatched,
    manifest,
    destroy,
  };
}
