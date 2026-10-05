// The two fields the engine adds to a bundle's `scene.json`, and the defaults that
// make every LEGACY bundle parse as if they had always been there.
//
// `./sceneManifest.ts` is the exporter's schema and stays untouched — the branch half
// must keep parsing a shipped bundle byte for byte. These two are the engine's:
//
//   rig               { backend, pack, control_names, vertex_count }
//                     WHICH rig drives the branches, decided by the BUNDLE rather
//                     than by a URL flag as the POC decided it. A game has no URL to
//                     carry a flag in, and "which rig posed this face" is the first
//                     question asked of a wrong-looking one — so the bundle states it
//                     and the answer is the same on every machine.
//
//   expression_space  { kind, dim, names, segments, arkit_map? }
//                     WHAT the animation layer is supposed to send. ARKit-52 for an
//                     ORL bundle, `head_ext` (387) or its reduced view (68) for a GNM
//                     one. Without this the animator has to guess from the control
//                     count, and the two spaces that happen to share a width would be
//                     indistinguishable.
//
// DEFAULTS FOR A LEGACY BUNDLE, which is every bundle shipped so far:
//
//   rig.backend       'orl'. The alternative was `rig2mesh`, the distilled per-branch
//                     ONNX the POC defaulted to; it is not ported (it cost ~74 MB PER
//                     BRANCH and the exact rig replaces it), so a bundle that ships
//                     only a `rig2mesh` renders at its neutral pose and says so.
//   rig.control_names the bundle's own `rig_names.json`.
//   expression_space  `arkit52`, mapped through the isaac gather
//                     (`rig/arkit/rigGatherFromNames.ts`) — which is exactly what the
//                     POC did for every live-driven character.

import type { SceneManifest } from './sceneManifest.js';

/** Which rig backend drives this bundle's branches. */
export type RigBackendKind = 'orl' | 'gnm' | 'none';

/** The `rig` block. */
export interface RigManifest {
  /** `orl` (OpenRigLogic from the character's own DNA) or `gnm` (a baked `.aosrig`). */
  backend: RigBackendKind;
  /** Bundle-relative pack filename: `orl_pack.bin` or `<name>.aosrig`. */
  pack: string | null;
  /** The control-name list, in the order `setRig` takes values. */
  controlNames: string[];
  /** Expected vertex count of the rig's output; 0 when the bundle does not state one. */
  vertexCount: number;
}

/** How a caller addresses this character's face. */
export type ExpressionKind = 'arkit52' | 'gnm' | 'gnm68';

/** One named contiguous run inside the expression vector. */
export interface ExpressionSegment {
  name: string;
  start: number;
  count: number;
}

/** The `expression_space` block. */
export interface ExpressionSpace {
  kind: ExpressionKind;
  /** Vector width the animation layer sends. */
  dim: number;
  /** One name per slot. Empty when the space is implied by `kind` alone. */
  names: string[];
  /** Named runs — ARKit has none; GNM has left_eye / right_eye / lower_face / tongue / pupils / gaze. */
  segments: ExpressionSegment[];
  /**
   * For a `gnm` space driven from ARKit: slot index per ARKit channel, or -1.
   * Absent until the ARKit -> GNM map is trained; a caller sending ARKit to a GNM
   * bundle without it gets a loud refusal rather than a face that moves wrongly.
   */
  arkitMap?: number[];
}

/** The engine-side manifest: the exporter's scene plus the two blocks above. */
export interface CharacterManifest {
  scene: SceneManifest;
  rig: RigManifest;
  expressionSpace: ExpressionSpace;
  /** `rig_names.json`, when the bundle ships one. */
  rigNames: string[] | null;
}

/** ARKit-52 carries no segments: every channel is its own expression. */
const ARKIT_DIM = 52;

/** The GNM `head_ext` segments, mirroring `aosrig.head.block.REGIONS`. */
export const GNM_SEGMENTS: ExpressionSegment[] = [
  { name: 'left_eye', start: 0, count: 100 },
  { name: 'right_eye', start: 100, count: 100 },
  { name: 'lower_face', start: 200, count: 150 },
  { name: 'tongue', start: 350, count: 32 },
  { name: 'pupils', start: 382, count: 1 },
  { name: 'gaze', start: 383, count: 4 },
];

/** `head_ext` width: 383 expression + 4 gaze. */
export const GNM_DIM = 387;

/** The reduced ML view: 64 expression (per-region truncation) + 4 gaze. */
export const GNM_REDUCED_DIM = 68;

/**
 * A JSON value as a string list, when it really is one.
 *
 * @param value The raw field off the parsed `scene.json`.
 * @returns The same array, typed, when every element is a string; null for anything
 * else, so a caller can fall back rather than trust a half-valid list.
 */
function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === 'string') ? value : null;
}

/**
 * Parse the `rig` block, or infer it for a legacy bundle.
 *
 * A bundle that declares nothing gets `orl` with its own `rig_names.json`, which is
 * what every shipped bundle actually runs. `backend: 'none'` is a real, reportable
 * outcome — a fused single-region geom takes `rig_params` straight in and animates
 * with no rig -> verts step at all — and must not be confused with a missing asset.
 *
 * @param sceneJson The bundle's raw `scene.json`; only its `rig` block is read.
 * @param rigNames The bundle's `rig_names.json`, used as the control names whenever
 * the block declares none.
 * @param defaults What the bundle's file list implies for a legacy bundle.
 * @param defaults.hasOrlPack Whether `orl_pack.bin` is present, which is what makes
 * the inferred backend `orl` rather than `none`.
 * @param defaults.needsRig Whether any branch actually consumes skinned vertices; a
 * fused single-region bundle does not and infers `none`.
 * @returns Which backend drives the branches, its pack filename, the control order
 * `setRig` takes values in, and the declared vertex count (0 when unstated).
 */
export function parseRigManifest(
  sceneJson: unknown,
  rigNames: string[] | null,
  defaults: { hasOrlPack: boolean; needsRig: boolean },
): RigManifest {
  const raw = (sceneJson as { rig?: Record<string, unknown> } | null)?.rig;
  if (raw && typeof raw === 'object') {
    const backend = raw.backend;
    if (backend !== 'orl' && backend !== 'gnm' && backend !== 'none') {
      throw new Error(
        `scene.json rig.backend is '${String(backend)}'; expected 'orl', 'gnm' or 'none'`,
      );
    }
    return {
      backend,
      pack: typeof raw.pack === 'string' ? raw.pack : null,
      controlNames: readStringArray(raw.control_names) ?? rigNames ?? [],
      vertexCount: Number.isFinite(Number(raw.vertex_count)) ? Number(raw.vertex_count) : 0,
    };
  }
  if (!defaults.needsRig) {
    return { backend: 'none', pack: null, controlNames: rigNames ?? [], vertexCount: 0 };
  }
  return {
    backend: defaults.hasOrlPack ? 'orl' : 'none',
    pack: defaults.hasOrlPack ? 'orl_pack.bin' : null,
    controlNames: rigNames ?? [],
    vertexCount: 0,
  };
}

/**
 * Parse the `expression_space` block, or infer it.
 *
 * Inferred from the RIG BACKEND, not from the control width: an ORL bundle is driven
 * from ARKit-52 through the 188-control gather, and a GNM bundle from `head_ext`.
 * Guessing from the width would make two different spaces that happen to share one
 * indistinguishable, and the failure is a face that moves — wrongly.
 *
 * @param sceneJson The bundle's raw `scene.json`; only its `expression_space` block
 * is read.
 * @param rig The already-parsed rig block, which decides the inferred space when the
 * bundle declares none.
 * @returns The space the animation layer must send: its kind, its vector width, per
 * slot names when stated, the named runs inside it, and the ARKit channel map when
 * a GNM bundle ships one.
 */
export function parseExpressionSpace(sceneJson: unknown, rig: RigManifest): ExpressionSpace {
  const raw = (sceneJson as { expression_space?: Record<string, unknown> } | null)
    ?.expression_space;
  if (raw && typeof raw === 'object') {
    const kind = raw.kind;
    if (kind !== 'arkit52' && kind !== 'gnm' && kind !== 'gnm68') {
      throw new Error(
        `scene.json expression_space.kind is '${String(kind)}'; expected 'arkit52', 'gnm' or 'gnm68'`,
      );
    }
    const declaredDim = Number(raw.dim);
    const names = readStringArray(raw.names) ?? [];
    const dim = Number.isFinite(declaredDim) && declaredDim > 0 ? declaredDim : names.length;
    if (!dim) throw new Error('scene.json expression_space declares neither `dim` nor `names`');
    const segments = Array.isArray(raw.segments)
      ? (raw.segments as Record<string, unknown>[]).map((s) => ({
          name: String(s.name),
          start: Number(s.start),
          count: Number(s.count),
        }))
      : defaultSegments(kind);
    const arkitMap = Array.isArray(raw.arkit_map)
      ? (raw.arkit_map as unknown[]).map((v) => Number(v))
      : undefined;
    return { kind, dim, names, segments, arkitMap };
  }
  if (rig.backend === 'gnm') {
    return { kind: 'gnm', dim: GNM_DIM, names: [], segments: GNM_SEGMENTS };
  }
  return { kind: 'arkit52', dim: ARKIT_DIM, names: [], segments: [] };
}

/**
 * The segments a space has when `scene.json` lists none.
 *
 * @param kind The expression space's kind.
 * @returns The {@link GNM_SEGMENTS} runs for a full `gnm` space; an empty list otherwise,
 * because ARKit-52 has no runs and `gnm68`'s truncated layout must be stated.
 */
function defaultSegments(kind: ExpressionKind): ExpressionSegment[] {
  return kind === 'gnm' ? GNM_SEGMENTS : [];
}
