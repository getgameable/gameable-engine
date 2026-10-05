// Parser for the multi_region character `scene.json`.
//
// Ported from aos-threejs-poc/src/ogs/assets/sceneManifest.ts @ cdd63b10, plus the two
// fields the engine adds: `rig` and `expression_space` (see ./characterManifest.ts,
// which layers them on rather than editing this parser — the branch half of the
// schema is the exporter's and must keep parsing a legacy bundle byte for byte).

export interface BranchSpec {
  name: string;
  geom: string;
  appr: string;
  /** Absent on a FUSED branch — see `fused`. */
  trunk?: string;
  /** Geom takes `rig_params` directly and emits `code`. Must be EXPLICIT. */
  fused?: boolean;
  /** Absent on a gaze-conditioned branch, which has polar-chart statics instead. */
  meshJson?: string;
  meshBin?: string;
  uvRes: number;
  rigDim: number;
  /**
   * Additive constant on the decoder's log-scale, applied by the lift. The trainer
   *  adds `log(scale_base) + log(scale_ref_res / uv_res)` AFTER the geom decoder, so
   *  it is NOT in the ONNX and a bundle that omits it renders splats off by e^bias.
   *  0 (the default) is what every pre-v5 bundle needs — their bases were 1 at the
   *  reference res, which is why nothing carried it until now.
   */
  scaleLogBias: number;
  /**
   * Ceiling on the BIASED log-scale, applied by the lift. The trainer's own geometry
   *  guard (`MeshBranch.forward`) clamps here so a decoder texel that spikes cannot
   *  become an Inf covariance — it has been seen reach log-scale ~38, i.e. e^38. Like
   *  the bias it lives outside the ONNX, so the web has to apply it or a spiking
   *  checkpoint renders a splat the trainer never drew.
   */
  scaleLogMax: number;
  /**
   * `--sigma_max` for this branch: the BOUNDED scale map (myra v8+). When it is
   *  > 0 the trainer replaces the unbounded `exp(raw + scale_log_bias)` with
   *
   *      sigma = sigma_max * sigmoid(raw + sigmaOffset)
   *
   *  and `scaleLogBias` MUST NOT also be added — the bias is folded into
   *  sigmaOffset and applying both applies it twice. 0 = the unbounded map.
   *
   *  This is not a constant offset, it is a different function, and the two
   *  agree EXACTLY at raw = 0 (the offset is solved to make the map the
   *  identity at initialisation). So a bundle whose map the lifter ignores
   *  looks right at the neutral scale and inflates everything above it — on
   *  myra v10 a texel one unit above init renders 1.4–1.9x too big, three
   *  units above 5–10x, and the ceiling goes from sigma_max (1.9–9.4 m) to
   *  exp(scale_log_max) (20–55 m). That is the oversized-splat artefact, and
   *  no amount of ONNX verification can see it: the map runs after the decoder.
   */
  sigmaMax: number;
  /**
   * The logit the trainer solved so the bounded map is the identity at init:
   *  `sigmoid(sigmaOffset) = exp(scale_log_bias) / sigma_max`.
   *
   *  Carried as the number the trainer used rather than re-derived here, for the
   *  reason branchScaleLogBias documents — a second copy of a trainer formula
   *  goes stale silently. Meaningless when sigmaMax is 0.
   */
  sigmaOffset: number;
  /**
   * Triangle-bounded splat clamp — `kappa` in `--tri_size_cap`. A splat's world
   *  extent is projected down so it cannot exceed `triKappa` x its host
   *  triangle's bound. 0 (the default) is OFF and lifts byte-identically to a
   *  pre-clamp bundle.
   *
   *  Same contract as scaleLogBias/scaleLogMax above and for the same reason:
   *  the trainer applies this in `MeshBranch.forward`, AFTER the decoder, so it
   *  is not in the ONNX and a bundle that omits it renders splats the trained
   *  model never had. Unlike those two there is no sane fallback constant to
   *  guess — a wrong kappa is a different model — so an undeclared value means
   *  OFF, never a copied trainer number.
   */
  triKappa: number;
  /**
   * Sliver rejection — `--sliver_min_quality` for this branch. Faces whose
   *  shape quality sqrt(area)/(0.658*longest_edge) falls below this host no
   *  Gaussian, and `triangleBound` derates over [q, 5q]. 0 = OFF.
   *
   *  PER BRANCH because the quality distributions differ by a lot: measured p50
   *  is 0.722 head / 0.734 body / 0.686 clothes but 0.402 hair, whose cards are
   *  legitimately elongated strips. One global threshold either misses slivers
   *  on skin or derates a fifth of the hair.
   */
  sliverQMin: number;
  /**
   * Training's --{branch}_uv_erode radius, 0 when absent.
   *
   *  The lifter min-pools the RAW validity mask by this before pass 2's keep
   *  test, and leaves pass 1's identity-Jacobian test on the raw mask — the two
   *  are different masks in training and collapsing them measurably corrupts
   *  chart-edge splats.
   */
  uvErode: number;
  rig2mesh?: string; // per-branch live rig→verts ONNX
  /**
   * The branch's RIG PARAMS file (`rig_params_<branch>.npy`): the training-frame rig
   *  vectors, one row per pose. Row 0 is the reference pose the branch's
   *  `neutral_vertices` were exported at, and therefore the only rig that decodes a
   *  neutral — an all-zero vector is not one (see BranchAssets.referenceRig).
   *
   *  NOT the rig board's pose presets (`rigBoardSource.presets`, the top-level
   *  `scene.rig_presets` the pose player reads). These are per-branch decoder inputs, and
   *  the two must not be conflated — the bundle just happens to spell the per-branch key
   *  `rig_presets` too.
   */
  rigParams?: string;
  /** Eyes: cond is gaze + head pose, never a mesh branch. No renderer ships for it. */
  gazeConditioned?: boolean;
  statics?: EyeStaticsFiles;
  /** The eyeball mesh whose surface IS the Gaussian positions; the mount refuses if absent. */
  eyeMesh?: { glb: string; json: string };
}

export interface EyeStaticsFiles {
  leftJson: string;
  leftBin: string;
  rightJson: string;
  rightBin: string;
  meta: string;
}

export interface SceneManifest {
  schemaVersion: string;
  subject: string;
  mode: string;
  numPoses: number;
  order: string[]; // deterministic branch order
  branches: Record<string, BranchSpec>;
  /** "head": every branch consumes the SAME live rig vector. Absent: driven independently. */
  bodyRig?: 'head';
  /** Valid rig-control domain; outside it the decoders extrapolate. Legacy default [-3, 3]. */
  rigRange: [number, number];
  /** Bundle verts → scene metres (isaac V2 trains in cm → 0.01). Default 1. */
  worldScale: number;
  /** appr's plücker moment scale: 1 = full, 0 = direction-only (the default). */
  momentScale: number;
  /**
   * Scene placement of the splat, metres. Composes with ANY momentScale: the
   *  plücker paths subtract it from the camera before applying originScale, so
   *  the moment is formed in the splat's local frame (inference/plucker.ts).
   *  It used to require momentScale 0 — direction-only is translation-invariant,
   *  which hid the missing subtraction until eyeline V10-C shipped a non-zero
   *  offset WITH momentScale 1.
   */
  worldOffset: [number, number, number];
  /**
   * Orientation of the TRAINING frame relative to the scene's, XYZ Euler
   *  degrees — undone at render time so the avatar stands upright (myra_v5
   *  trains 180° about Z and renders upside down without it). Applied by
   *  render/worldRotation.ts to BOTH the SplatMesh and, inverted, the plücker
   *  camera. Default [0,0,0] = render in the trained frame.
   */
  worldRotation: [number, number, number];
}

// Canonical order; a branch not listed here is appended in its object-key order.
export const BRANCH_ORDER = ['head', 'body', 'teeth', 'clothes', 'eyes'];

// The trainer's geometry-guard ceilings on the biased log-scale
// (multi_part_gaussian_model.py's _SCALE_LOG_MAX / _CLOTHES_SCALE_LOG_MAX). Clothes is
// tighter because its decoder was the one seen spiking.
const SCALE_LOG_MAX = 4.0;
const CLOTHES_SCALE_LOG_MAX = 3.0;

/**
 * The bias to add to this branch's decoder log-scale, 0 (a no-op) when undeclared.
 *
 *  Carried as the DERIVED number the trainer used, not as scale_base + a formula the web
 *  would have to re-derive from uv_res — the eye specular learned what a stale second
 *  copy of a trainer formula costs. A malformed value falls back to the no-op rather than
 *  to NaN, which would make exp() NaN and drop every splat in the branch.
 *
 * @param rawBranch The branch's raw snake_case `scene.json` entry.
 * @returns The declared `scale_log_bias`, or 0 when the key is absent or is not a
 * finite number.
 */
function branchScaleLogBias(rawBranch: Record<string, unknown>): number {
  const declared = rawBranch.scale_log_bias;
  return typeof declared === 'number' && Number.isFinite(declared) ? declared : 0;
}

/**
 * `tri_size_cap` / `sliver_min_quality` for one branch, 0 (OFF) when absent.
 *
 *  NO trainer-constant fallback, deliberately — unlike branchScaleLogMax, which
 *  can fall back because its constant is an anti-Inf backstop that only ever
 *  catches pathological spikes. These two SELECT AND RESIZE the splat set, so a
 *  guessed value is a silently different model. Absent means the bundle was
 *  exported from a checkpoint trained without the flags, and OFF is then the
 *  bit-identical answer.
 *
 *  Typed check, not a coercion, for the reason branchScaleLogMax documents:
 *  Number(null) is 0 and would read as a deliberate OFF rather than as garbage.
 *
 * @param rawBranch The branch's raw snake_case `scene.json` entry.
 * @param key Which clamp to read: `tri_size_cap`, `sliver_min_quality`, `sigma_max`
 * or `uv_erode`.
 * @returns The declared value when it is a finite number above 0; 0 — meaning the
 * clamp is off — for anything else, including a declared 0 or null.
 */
function branchTriClamp(rawBranch: Record<string, unknown>, key: string): number {
  const declared = rawBranch[key];
  return typeof declared === 'number' && Number.isFinite(declared) && declared > 0 ? declared : 0;
}

/**
 * `sigma_offset`, or 0 when undeclared.
 *
 *  0 is a LEGITIMATE value (myra v10's hair solves to 0.00033), so this cannot
 *  use branchTriClamp's `> 0` test. It is only ever read when sigmaMax > 0, and
 *  a bundle that declares sigma_max without an offset is malformed — 0 then
 *  means "no offset", which is the identity map about sigma_max/2 rather than a
 *  silent NaN.
 *
 * @param rawBranch The branch's raw snake_case `scene.json` entry.
 * @returns The declared `sigma_offset`, including a deliberate 0; 0 when the key is
 * absent or is not a finite number.
 */
function branchSigmaOffset(rawBranch: Record<string, unknown>): number {
  const declared = rawBranch.sigma_offset;
  return typeof declared === 'number' && Number.isFinite(declared) ? declared : 0;
}

/**
 * The ceiling on this branch's biased log-scale.
 *
 *  THE FALLBACK IS NO CEILING, and that is a compatibility rule, not an oversight: every
 *  bundle shipped before the bias existed lifted unclamped, so defaulting to the trainer
 *  constant would start shrinking splats in isaac / eyeline / myra-ogs — a silent change
 *  to characters nobody touched. A ceiling only applies when the bundle asks for one:
 *  `scale_log_max` if declared, else the trainer's value for a branch that declares a
 *  `scale_log_bias` (that key is what marks a v5-era export, and those ARE the exports
 *  training clamped). Declaring the ceiling explicitly is better than relying on the
 *  constant here — a copied trainer number goes stale silently.
 *
 *  Typed check, not a coercion: `Number(null)` is 0, which is finite, and a ceiling of 0
 *  would clamp EVERY splat to e^0 — so a bundle with `"scale_log_max": null` would render
 *  a uniform field of unit splats rather than fall back.
 *
 * @param name The branch name; only `clothes` takes the tighter trainer ceiling.
 * @param rawBranch The branch's raw snake_case `scene.json` entry.
 * @returns The declared `scale_log_max`, else the trainer constant for a v5-era
 * branch (one that declares a `scale_log_bias`), else `Infinity` — no ceiling.
 */
function branchScaleLogMax(name: string, rawBranch: Record<string, unknown>): number {
  const declared = rawBranch.scale_log_max;
  if (typeof declared === 'number' && Number.isFinite(declared)) return declared;
  if (typeof rawBranch.scale_log_bias !== 'number') return Infinity;
  return name === 'clothes' ? CLOTHES_SCALE_LOG_MAX : SCALE_LOG_MAX;
}

/** Only what a schema_version 1 bundle can state; scale/offset/plücker are NOT derivable. */
export interface SingleRegionSceneOptions {
  uvRes: number;
  rigDim: number;
  subject?: string;
  hasRig2Mesh?: boolean;
}

/**
 * A single-region bundle as a one-branch fused scene, in RAW snake_case json.
 *
 * @param options What a schema_version 1 bundle can actually state about itself.
 * @returns A synthetic `scene.json` document — a single fused `head` branch over
 * `geom.onnx` / `appr.onnx` / `mesh.json` / `mesh.bin` — ready for
 * {@link parseSceneManifest}, which is what the rest of the loader consumes.
 */
export function singleRegionScene(options: SingleRegionSceneOptions): Record<string, unknown> {
  const { uvRes, rigDim } = options;
  if (!Number.isFinite(uvRes) || uvRes <= 0)
    throw new Error(`singleRegionScene: bad uv_res ${String(uvRes)}`);
  if (!Number.isFinite(rigDim) || rigDim <= 0)
    throw new Error(`singleRegionScene: bad rig_dim ${String(rigDim)}`);
  return {
    schema_version: '2',
    subject: options.subject ?? 'single-region',
    mode: 'multi_region',
    body_rig: 'head',
    rig_dim: rigDim,
    num_poses: 0,
    branches: {
      head: {
        fused: true,
        geom: 'geom.onnx',
        appr: 'appr.onnx',
        mesh_json: 'mesh.json',
        mesh_bin: 'mesh.bin',
        uv_res: uvRes,
        rig_dim: rigDim,
        // A schema_version 1 bundle cannot state a scale_log_bias (same reason it
        // omits world_scale); the parser's 0 default is the pre-v5 behaviour.
        ...(options.hasRig2Mesh ? { rig2mesh: 'rig2mesh.onnx' } : {}),
      },
    },
  };
}

/**
 * Polar-chart statics and an eyeball mesh, no mesh atlas; rigDim 0 — it is not rig-driven.
 *
 * @param name The branch name, used in every error message this raises.
 * @param rawBranch The branch's raw snake_case `scene.json` entry.
 * @param models The decoder filenames already required off that entry.
 * @param models.geom The geometry decoder ONNX.
 * @param models.appr The view-dependent appearance decoder ONNX.
 * @param models.trunk The shared trunk ONNX, absent on a fused branch.
 * @returns The branch spec, with `gazeConditioned` set, `rigDim` 0, the five
 * required chart statics, and the eyeball mesh pair when both files are declared.
 */
function gazeConditionedBranch(
  name: string,
  rawBranch: Record<string, unknown>,
  models: { geom: string; appr: string; trunk?: string },
): BranchSpec {
  const uvRes = Number(rawBranch.uv_res);
  if (!Number.isFinite(uvRes)) throw new Error(`scene.json branch '${name}' bad uv_res`);
  const glb = rawBranch.mesh_glb;
  const json = rawBranch.mesh_json;
  return {
    name,
    ...models,
    uvRes,
    rigDim: 0,
    // Inert here — the eye branch lifts off a polar chart, never this UV atlas, and its
    // scale comes from eye_meta. Resolved by the same rule anyway, so there is one.
    scaleLogBias: branchScaleLogBias(rawBranch),
    scaleLogMax: branchScaleLogMax(name, rawBranch),
    sigmaMax: branchTriClamp(rawBranch, 'sigma_max'),
    sigmaOffset: branchSigmaOffset(rawBranch),
    triKappa: branchTriClamp(rawBranch, 'tri_size_cap'),
    sliverQMin: branchTriClamp(rawBranch, 'sliver_min_quality'),
    uvErode: branchTriClamp(rawBranch, 'uv_erode'),
    gazeConditioned: true,
    eyeMesh: typeof glb === 'string' && typeof json === 'string' ? { glb, json } : undefined,
    statics: eyeStatics(name, rawBranch.statics),
  };
}

// All five are required: a chart the lift cannot read renders nothing at all.
/**
 * The eye branch's polar-chart statics, every file required.
 *
 * @param name The branch name, for the error naming the missing key.
 * @param raw The branch's `statics` object, or anything at all — a non-object is
 * treated as empty and so fails on the first required key.
 * @returns The five filenames: the left and right chart json/bin pairs and the
 * shared `eye_meta`.
 */
function eyeStatics(name: string, raw: unknown): EyeStaticsFiles {
  const declared = (raw ?? {}) as Record<string, unknown>;
  const requireFile = (key: string) => {
    const value = declared[key];
    if (typeof value !== 'string' || !value) {
      throw new Error(`scene.json branch '${name}' missing statics.${key}`);
    }
    return value;
  };
  return {
    leftJson: requireFile('left_json'),
    leftBin: requireFile('left_bin'),
    rightJson: requireFile('right_json'),
    rightBin: requireFile('right_bin'),
    meta: requireFile('meta'),
  };
}

/**
 * A scene-level string field, or "" when it is not one.
 *
 * @param raw The field off the parsed `scene.json`.
 * @returns The string itself, or "" — never `String(raw)`, so an object-valued
 * `schema_version` cannot stringify into something that reads like a real version.
 */
function readString(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

/**
 * A scene-level 3-vector field (world_offset / world_rotation), or `fallback`
 *  when it isn't three finite numbers — a malformed one is not half-applied.
 *
 * @param raw The field off the parsed `scene.json`.
 * @param fallback The value to use when `raw` is not three finite numbers; `[0,0,0]`
 * at both call sites, meaning no offset and no rotation.
 * @returns The three components — metres for `world_offset`, XYZ Euler degrees for
 * `world_rotation` — or `fallback` untouched.
 */
function readTriple(raw: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 3) return fallback;
  if (!raw.every((component) => Number.isFinite(Number(component)))) return fallback;
  return [Number(raw[0]), Number(raw[1]), Number(raw[2])];
}

/**
 * Whether a parsed `scene.json` is a multi-region manifest this parser can read.
 *
 * @param json The raw document, typically straight out of `JSON.parse`.
 * @returns True when it declares `mode: "multi_region"` and carries a `branches`
 * object. A schema_version 1 bundle has neither and must go through
 * {@link singleRegionScene} first.
 */
export function isMultiRegionScene(json: unknown): boolean {
  const scene = json as { mode?: string; branches?: unknown } | null;
  return (
    !!scene &&
    scene.mode === 'multi_region' &&
    !!scene.branches &&
    typeof scene.branches === 'object'
  );
}

/**
 * Validate a bundle's `scene.json` into the camelCase manifest the runtime uses.
 *
 * Throws on a document that is not multi-region, and on any branch missing a file
 * the lift chain needs — a branch that cannot be built renders nothing, so this
 * refuses at load rather than leaving a character short one region.
 *
 * @param json The raw `scene.json`, or {@link singleRegionScene}'s synthetic stand-in.
 * @returns The manifest: branches keyed by name in {@link BRANCH_ORDER} order (with
 * anything unlisted appended), plus the scene-level `rig_range`, `world_scale`
 * (the bundle's cm to m factor), `moment_scale`, `world_offset` in metres and
 * `world_rotation` in XYZ Euler degrees.
 */
export function parseSceneManifest(json: unknown): SceneManifest {
  const scene = json as Record<string, unknown>;
  if (!isMultiRegionScene(scene)) throw new Error('scene.json is not a multi_region manifest');
  const rawBranches = scene.branches as Record<string, Record<string, unknown>>;
  // Maps, not index signatures: TS types `record[key]` as present, so the "declares no
  // rig_dim of its own" report below would read as dead code — and the rig WIDTH is per
  // branch, so inheriting the top-level one silently is exactly what needs saying.
  const rigDims = new Map(Object.entries((scene.rig_dims ?? {}) as Record<string, number>));
  const trunks = new Map(Object.entries((scene.trunks ?? {}) as Record<string, unknown>));

  const declared = Object.keys(rawBranches);
  const order = [
    ...BRANCH_ORDER.filter((branch) => declared.includes(branch)),
    ...declared.filter((branch) => !BRANCH_ORDER.includes(branch)),
  ];

  const branches: Record<string, BranchSpec> = {};
  for (const name of order) {
    const rawBranch = rawBranches[name];
    const requireString = (key: string) => {
      const value = rawBranch[key];
      if (typeof value !== 'string' || !value) {
        throw new Error(`scene.json branch '${name}' missing '${key}'`);
      }
      return value;
    };
    // Two per-branch declaration sites: `branch.trunk` and the scene-level
    // `trunks` map. Some schema_version 2 bundles (eyeline_v6) carry ONLY the
    // map, and reading just the per-branch key rejects them outright
    // ("scene.json branch 'head' missing 'trunk'"). Same rule as the streaming
    // server's server/scene_schema.py:resolve_branch_trunk — keep them in step
    // (tests/fixtures/scene-trunk-cases.json is driven from both suites).
    // The legacy singular top-level `scene.trunk` (write_manifest.py) is read by
    // neither; add it to both together if a bundle ever needs it.
    // A FUSED branch has no trunk by construction (its geom takes rig_params and
    // emits `code` itself). Only an explicit marker gets the exemption, so a
    // manifest that merely forgot its trunk still fails loudly.
    const requireTrunk = (): string | undefined => {
      const own = rawBranch.trunk;
      if (typeof own === 'string' && own) return own;
      const shared = trunks.get(name);
      if (typeof shared === 'string' && shared) return shared;
      if (rawBranch.fused === true) return undefined;
      throw new Error(
        `scene.json branch '${name}' missing 'trunk' (neither branch.trunk nor trunks['${name}'])`,
      );
    };
    if (rawBranch.gaze_conditioned === true) {
      branches[name] = gazeConditionedBranch(name, rawBranch, {
        geom: requireString('geom'),
        appr: requireString('appr'),
        trunk: requireTrunk(),
      });
      continue;
    }
    branches[name] = {
      name,
      geom: requireString('geom'),
      appr: requireString('appr'),
      trunk: requireTrunk(),
      fused: rawBranch.fused === true,
      meshJson: requireString('mesh_json'),
      meshBin: requireString('mesh_bin'),
      uvRes: Number(rawBranch.uv_res),
      // The rig width is PER BRANCH (myra_v10: head 168, the rest 2397). A
      // shared-rig export writes ONE top-level scalar instead, which is still
      // read — isaac V2 ships that way and is genuinely shared — but in a
      // multi-branch scene it is a guess inherited from whichever branch the
      // exporter had in mind, so it is reported. loadBranch overrides it from
      // the branch's own rig params, which is the only per-branch ground truth.
      rigDim: Number(rawBranch.rig_dim ?? rigDims.get(name) ?? scene.rig_dim),
      scaleLogBias: branchScaleLogBias(rawBranch),
      scaleLogMax: branchScaleLogMax(name, rawBranch),
      sigmaMax: branchTriClamp(rawBranch, 'sigma_max'),
      sigmaOffset: branchSigmaOffset(rawBranch),
      triKappa: branchTriClamp(rawBranch, 'tri_size_cap'),
      sliverQMin: branchTriClamp(rawBranch, 'sliver_min_quality'),
      uvErode: branchTriClamp(rawBranch, 'uv_erode'),
      rig2mesh: typeof rawBranch.rig2mesh === 'string' ? rawBranch.rig2mesh : undefined,
      rigParams: typeof rawBranch.rig_presets === 'string' ? rawBranch.rig_presets : undefined,
    };
    if (!Number.isFinite(branches[name].uvRes))
      throw new Error(`scene.json branch '${name}' bad uv_res`);
    if (!Number.isFinite(branches[name].rigDim))
      throw new Error(`scene.json branch '${name}' bad rig_dim`);
    const declaresOwnRigDim = rawBranch.rig_dim !== undefined || rigDims.has(name);
    if (!declaresOwnRigDim && order.length > 1) {
      console.warn(
        `[ogs] scene.json branch '${name}' declares no rig_dim and no rig_dims['${name}'] ` +
          `— inheriting the top-level ${String(branches[name].rigDim)}. Rig width is per branch; verify it.`,
      );
    }
  }

  const rawRigRange = scene.rig_range;
  const rigRange: [number, number] =
    Array.isArray(rawRigRange) &&
    rawRigRange.length === 2 &&
    Number.isFinite(Number(rawRigRange[0])) &&
    Number.isFinite(Number(rawRigRange[1]))
      ? [Number(rawRigRange[0]), Number(rawRigRange[1])]
      : [-3, 3];
  const worldScale =
    Number.isFinite(Number(scene.world_scale)) && Number(scene.world_scale) > 0
      ? Number(scene.world_scale)
      : 1;
  // Default 0 (direction-only); 0 is also a VALID declared value, so never a falsy check.
  const momentScale = Number.isFinite(Number(scene.moment_scale)) ? Number(scene.moment_scale) : 0;
  const worldOffset = readTriple(scene.world_offset, [0, 0, 0]);
  const worldRotation = readTriple(scene.world_rotation, [0, 0, 0]);
  return {
    // `??` then a typed narrow, not `String(unknown)`: a `schema_version` that arrived
    // as an object would stringify to "[object Object]" and read as a real version.
    schemaVersion: readString(scene.schema_version),
    subject: readString(scene.subject),
    mode: readString(scene.mode),
    numPoses: Number(scene.num_poses ?? 0),
    order,
    branches,
    bodyRig: scene.body_rig === 'head' ? 'head' : undefined,
    rigRange,
    worldScale,
    momentScale,
    worldOffset,
    worldRotation,
  };
}

/**
 * The fp16 sibling of a decoder filename, or null when it isn't an .onnx. Idempotent.
 *
 * @param file A decoder filename off the manifest, possibly absent.
 * @returns The `_fp16.onnx` name, the same name back when it already ends that way,
 * or null for anything that is not an `.onnx`.
 */
export function fp16NameFor(file: string | undefined | null): string | null {
  if (typeof file !== 'string' || !file.endsWith('.onnx')) return null;
  const stem = file.slice(0, -'.onnx'.length);
  if (stem.endsWith('_fp16')) return file;
  return `${stem}_fp16.onnx`;
}

/**
 * The per-branch fp16 decoders; a bundle without them loads fp32, no warning.
 *
 * @param sceneJson The raw `scene.json`, re-parsed here.
 * @returns The fp16 `geom` and `appr` names for every branch, deduped — an OPTIONAL
 * fetch list, since a bundle that ships none simply runs the fp32 decoders.
 */
export function multiRegionOptionalFileList(sceneJson: unknown): string[] {
  const manifest = parseSceneManifest(sceneJson);
  const files: string[] = [];
  for (const name of manifest.order) {
    const branch = manifest.branches[name];
    appendFiles(files, [fp16NameFor(branch.geom), fp16NameFor(branch.appr)]);
  }
  return files;
}

/**
 * The per-branch rig params (`rig_params_<branch>.npy`), whose row 0 is the rest pose the
 *  neutral decode needs. Kept apart from the fp16 list because that one also decides
 *  `preferFp16`, and fetched eagerly rather than lazily: they must be RESIDENT in the pack
 *  mount before loadMultiRegionScene reads them, and a mount miss is a 404 that silently
 *  drops the branch back to a zero rig.
 *
 * @param sceneJson The raw `scene.json`, re-parsed here.
 * @returns Every branch's declared `rig_presets` filename, deduped; empty when no
 * branch ships one.
 */
export function multiRegionRigParamsList(sceneJson: unknown): string[] {
  const manifest = parseSceneManifest(sceneJson);
  const files: string[] = [];
  for (const name of manifest.order) appendFiles(files, [manifest.branches[name].rigParams]);
  return files;
}

/**
 * The REQUIRED eager fetch set. Excludes frame_vertices: the live rig supplies verts.
 *
 * A branch's `rig2mesh` is never REQUIRED. The exact MetaHuman rig (OpenRigLogic
 * + the character's own DNA, ONE asset for the whole head) can replace the distilled
 * per-branch ONNX, which cost ~74 MB EACH and was the largest thing in a bundle.
 * It survives as the FALLBACK rig — for a character that ships no DNA, and for a
 * branch whose exact rig fails to build — so it is an OPTIONAL fetch, listed by
 * rig2MeshFileNames and resolved by the loader's rig mode. A character with a
 * pack downloads none of it.
 *
 * @param sceneJson The raw `scene.json`, re-parsed here.
 * @returns `scene.json` and `export_manifest.json` followed by every branch's mesh
 * pair, trunk and two decoders plus any eye statics, deduped — the set that must be
 * resident before a character can be built.
 */
export function multiRegionFileList(sceneJson: unknown): string[] {
  const manifest = parseSceneManifest(sceneJson);
  const files = ['scene.json', 'export_manifest.json'];
  for (const name of manifest.order) {
    const branch = manifest.branches[name];
    appendFiles(files, [
      branch.meshJson,
      branch.meshBin,
      branch.trunk,
      branch.geom,
      branch.appr,
      ...eyeStaticsFiles(branch),
    ]);
  }
  return files;
}

/**
 * True when this bundle has a rig→vertices STEP at all — i.e. whether a missing
 *  rig means a frozen head or means nothing.
 *
 *  Asked STRUCTURALLY, about the branch's own shape, not about whether it
 *  declares a `rig2mesh`. That distinction is the whole point now: rig2mesh used
 *  to be the only rig, so "declares one" and "needs one" were the same question —
 *  but the exact MetaHuman rig makes a bundle exported WITHOUT any rig2mesh a
 *  normal, desirable thing (it is the ~74 MB per branch this change deletes).
 *  Keyed on the declaration, such a bundle answers "needs no rig", so a character
 *  with no DNA would render a frozen head and show no pill, and rigMode would
 *  explain it as a fused geom that needs none — while the branch is not fused at
 *  all. Keyed on the structure, both stay right no matter what the bundle ships.
 *
 *  The structure is exactly this: a FUSED branch takes `rig_params` straight into
 *  geom and emits `code`, so the controls reach the decoder with no rig→verts
 *  step in between and the character animates perfectly well with no DNA. Every
 *  other branch has that step and needs something to fill it. A single-region
 *  bundle is fused (singleRegionScene sets it), which is why it must never be
 *  told its head is frozen — a warning that fires on a working avatar teaches
 *  people to ignore the warning.
 *
 *  Tolerant by design: this only decides whether to show a warning, so a
 *  malformed manifest answers "no" rather than throwing and taking the whole
 *  bundle load down with it. A genuinely broken scene fails loudly elsewhere.
 *
 * @param sceneJson The raw `scene.json`; read structurally, never parsed, so a
 * malformed document answers rather than throws.
 * @returns True when any branch is not `fused` and therefore has a rig → vertices
 * step to fill; false for an all-fused bundle, which animates from `rig_params`
 * alone and must never be warned about a frozen head.
 */
export function sceneNeedsRigDeform(sceneJson: unknown): boolean {
  const branches = (sceneJson as { branches?: Record<string, unknown> } | null)?.branches;
  if (!branches || typeof branches !== 'object') return false;
  return Object.values(branches).some(
    (b) => !!b && typeof b === 'object' && (b as Record<string, unknown>).fused !== true,
  );
}

/**
 * Branch name -> its rig2mesh ONNX, for the branches that declare a LOADABLE
 *  one. The fallback rig's fetch list.
 *
 *  Reads the parsed `rig2mesh` field, so it lists only what this app can
 *  actually load. isaac-ogs-facepalm declares `rig2mesh_hp`, a high-pass
 *  compressed basis (HPBASIS1) there has never been a loader for: that bundle
 *  still NEEDS a rig (sceneNeedsRigDeform says so from its branch shape, which is
 *  why that test no longer looks at these names at all) but cannot be given this
 *  one, and listing the file would download ~74 MB to build a session that
 *  throws.
 *
 * @param sceneJson The raw `scene.json`, re-parsed here.
 * @returns One entry per branch that declares a loadable `rig2mesh`, pairing the
 * branch name with its ONNX filename; branches with none are dropped.
 */
export function rig2MeshFileNames(sceneJson: unknown): { name: string; file: string }[] {
  const manifest = parseSceneManifest(sceneJson);
  return manifest.order
    .map((name) => ({ name, file: manifest.branches[name].rig2mesh }))
    .filter((b): b is { name: string; file: string } => !!b.file);
}

// Deduped: branches share trunks and decoders, and each file is fetched once.
/**
 * Append the candidates that are real filenames and not already listed.
 *
 * @param files The fetch list, appended to in place.
 * @param candidates Filenames off a branch spec; absent ones are skipped rather
 * than being an error, since most branch fields are optional.
 */
function appendFiles(files: string[], candidates: (string | undefined | null)[]): void {
  for (const candidate of candidates) {
    if (candidate && !files.includes(candidate)) files.push(candidate);
  }
}

/**
 * A gaze-conditioned branch's chart statics plus its eyeball mesh; empty for every other.
 *
 * @param branch The parsed branch spec.
 * @returns The five chart statics followed by the eyeball `.glb` and `.json` when
 * the branch declares them; an empty list for a branch with no `statics` at all.
 */
function eyeStaticsFiles(branch: BranchSpec): string[] {
  const { statics, eyeMesh } = branch;
  const files = statics
    ? [statics.leftJson, statics.leftBin, statics.rightJson, statics.rightBin, statics.meta]
    : [];
  if (eyeMesh) files.push(eyeMesh.glb, eyeMesh.json);
  return files;
}
