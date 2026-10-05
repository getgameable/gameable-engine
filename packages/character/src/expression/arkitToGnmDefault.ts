// ARKit-52 -> GNM `head_ext`, hand-authored. A STOPGAP, and it says so everywhere.
//
// WHY IT EXISTS. Face clips are authored in ARKit-52 and `gameable/animation` blends
// them there; a GNM head consumes 383 (or a truncated view of) standardised latent
// coefficients with no names and no published semantics. The real table will ship as
// `arkit_to_gnm.json` in the bundle, produced by the team retraining the decoders on GNM
// topology — that map will come out of a fit against paired data, which is the only way
// to get one that is actually right.
//
// WHERE THESE NUMBERS CAME FROM. `scripts/rank-gnm-coefficients.mjs` treats each basis
// row as a per-vertex displacement field, cuts anatomical regions out of the neutral mesh
// (the eye joints give the eyes; the brow, mouth-corner and jaw bands are offsets from
// them), and ranks every coefficient by how far it moves those vertices and in which
// direction. The entries below are the top-ranked coefficient for each behaviour on
// myra's head, reviewed by eye in `examples/character-showcase`, with a gain chosen so a
// weight of 1.0 moves the region by roughly 2-3 mm.
//
// WHAT IT IS NOT. It is not fitted, it is not per-identity, and it is not symmetric in
// any guaranteed way — a few of the ranked "smile" coefficients turned out to be a
// LATERAL mouth shift, which is why `MouthLeft`/`MouthRight` are in the table and
// `MouthSmile*` leans on a weaker but cleaner mode. Expect a real map to disagree with
// every number here.
//
// THE ENTRIES ARE REGION-RELATIVE (`{ region, index }`), not absolute coefficient
// indices, and that is load-bearing: a truncated pack (`gnm_pack.py --trunc-exp`) keeps a
// PREFIX OF EACH REGION and renumbers everything after it, so an absolute index would
// silently point at a different mode. Every index below sits inside the 64-coefficient
// reduced view, so the same table drives both the full and the truncated pack.

import { ARKIT_NAMES } from '../rig/arkit/arkitNames.js';
import { regionSlices, type HeadExtLayout } from '../rig/gnm/gnmPack.js';

/** One coefficient an ARKit channel drives. */
export interface ArkitGnmTerm {
  /** `head_ext` region: `left_eye`, `right_eye`, `lower_face`, `tongue` or `pupils`. */
  region: string;
  /** Coefficient index WITHIN that region. */
  index: number;
  /** Coefficient units per unit of ARKit weight. Signed. */
  gain: number;
}

/** The table: ARKit-52 channel name -> the coefficients it drives. */
export type ArkitGnmTable = Readonly<Record<string, readonly ArkitGnmTerm[]>>;

/**
 * The default ARKit-52 -> GNM table.
 *
 * Covers the channels a face clip actually moves in a shipped idle: blink, squint, wide,
 * the brows, the jaw, the smile/frown pair, the lateral mouth shift and the tongue.
 * Channels with no entry contribute nothing rather than being approximated by a
 * neighbouring mode, because a wrong mode is worse than a still one.
 *
 * @example
 * ```ts
 * import { ARKIT_TO_GNM_DEFAULT } from 'gameable/character';
 *
 * console.log(ARKIT_TO_GNM_DEFAULT.JawOpen[0].region); // 'lower_face'
 * ```
 */
export const ARKIT_TO_GNM_DEFAULT: ArkitGnmTable = Object.freeze({
  // The lids. `left_eye+2` is the strongest downward upper-lid mode (-0.22 mm per unit
  // over the lid band, focus 13x the whole-head mean); `+5` adds the lash-line roll.
  EyeBlinkLeft: [
    { region: 'left_eye', index: 2, gain: 3.5 },
    { region: 'left_eye', index: 5, gain: 2 },
  ],
  EyeBlinkRight: [
    { region: 'right_eye', index: 2, gain: 3.5 },
    { region: 'right_eye', index: 5, gain: 2 },
  ],
  // The lower lid rising, which is a different mode from the upper lid falling.
  EyeSquintLeft: [{ region: 'left_eye', index: 1, gain: 2.5 }],
  EyeSquintRight: [{ region: 'right_eye', index: 1, gain: 2.5 }],
  // Wide is a blink run backwards. Coarse, and visibly so past about 0.5.
  EyeWideLeft: [{ region: 'left_eye', index: 2, gain: -2.5 }],
  EyeWideRight: [{ region: 'right_eye', index: 2, gain: -2.5 }],

  // The brows. `+0` of each eye region is by far the strongest vertical brow mode
  // (+1.54 mm per unit, focus ~20x), and brow-down is the same mode negated — GNM has no
  // separate upper-face region, so there is no independent frown mode to find.
  BrowInnerUp: [
    { region: 'left_eye', index: 0, gain: 1.5 },
    { region: 'right_eye', index: 0, gain: 1.5 },
  ],
  BrowOuterUpLeft: [{ region: 'left_eye', index: 0, gain: 2 }],
  BrowOuterUpRight: [{ region: 'right_eye', index: 0, gain: 2 }],
  BrowDownLeft: [{ region: 'left_eye', index: 0, gain: -2 }],
  BrowDownRight: [{ region: 'right_eye', index: 0, gain: -2 }],

  // The jaw. `lower_face+9` drops the chin band with the tightest focus (5.6x);
  // `lower_face+1` is the big lips-apart mode and carries the rest of the opening.
  JawOpen: [
    { region: 'lower_face', index: 9, gain: 3 },
    { region: 'lower_face', index: 1, gain: 1.5 },
  ],
  MouthClose: [{ region: 'lower_face', index: 1, gain: -1.5 }],

  // The smile. `lower_face+0` lifts both corners (+1.6 / +1.8 mm per unit) but also
  // pushes the mouth forward, which is the compromise this table cannot avoid without a
  // fit; `+8` and `+12` add the per-side lift.
  MouthSmileLeft: [
    { region: 'lower_face', index: 0, gain: 1.2 },
    { region: 'lower_face', index: 8, gain: 1.5 },
  ],
  MouthSmileRight: [
    { region: 'lower_face', index: 0, gain: 1.2 },
    { region: 'lower_face', index: 12, gain: 1.5 },
  ],
  MouthFrownLeft: [{ region: 'lower_face', index: 3, gain: 1.5 }],
  MouthFrownRight: [{ region: 'lower_face', index: 3, gain: 1.5 }],

  // `lower_face+2` moves BOTH corners toward character-left: a lateral shift, not a
  // smile. The ranking found it as the top "smile" candidate, which is exactly the kind
  // of mistake a signed per-side score catches and an unsigned magnitude does not.
  MouthLeft: [{ region: 'lower_face', index: 2, gain: 2 }],
  MouthRight: [{ region: 'lower_face', index: 2, gain: -2 }],

  TongueOut: [{ region: 'tongue', index: 1, gain: 2 }],
});

/** Options for {@link createArkitToGnmMap}. */
export interface ArkitToGnmOptions {
  /** Replace the default table. */
  table?: ArkitGnmTable;
  /**
   * Also fill the four gaze angles from the `EyeLook*` channels. Default true.
   *
   * The gaze half of `head_ext` is angles in radians, not coefficients, so it is not in
   * the table: `EyeLookUp/Down/In/Out` are converted here at {@link GAZE_FULL_SCALE}
   * radians per unit weight.
   */
  gaze?: boolean;
  /** Clamp on every produced coefficient. Default 4. */
  clamp?: number;
}

/**
 * Radians of gaze per unit ARKit `EyeLook*` weight — 20 degrees at full deflection.
 *
 * @example
 * ```ts
 * import { GAZE_FULL_SCALE } from 'gameable/character';
 *
 * console.log((GAZE_FULL_SCALE * 180) / Math.PI); // 20
 * ```
 */
export const GAZE_FULL_SCALE = (20 * Math.PI) / 180;

/** Index of each ARKit channel, by name, built once. */
const ARKIT_INDEX = new Map(ARKIT_NAMES.map((name, i) => [name, i]));

/** One resolved term: an absolute `head_ext` slot and the ARKit channel that drives it. */
interface ResolvedTerm {
  arkit: number;
  slot: number;
  gain: number;
}

/**
 * Build an `ExpressionSpace.map` for a pack's layout.
 *
 * The returned function is what `gameable/animation`'s `createAnimator` calls every
 * frame, so it ALLOCATES NOTHING: the table is resolved to absolute slots here, once, and
 * the per-frame path is a loop over a flat array.
 *
 * Terms that fall outside the layout — a coefficient a truncated pack dropped, a region
 * that pack does not declare — are discarded at build time and reported, rather than
 * being clamped into a neighbouring coefficient.
 *
 * @param layout The pack's `header.headExt`.
 * @param options See {@link ArkitToGnmOptions}.
 * @returns The mapper plus what it resolved: `dim` to size the output with, the terms it
 *   kept, and the entries it dropped with the reason.
 *
 * @example
 * ```ts
 * import { createArkitToGnmMap, parseAosRig } from 'gameable/character';
 *
 * const pack = parseAosRig(bytes);
 * const { dim, map } = createArkitToGnmMap(pack.header.headExt);
 * const animator = createAnimator({ root, expressionSpace: { kind: 'gnm', dim, map } });
 * ```
 */
export function createArkitToGnmMap(
  layout: HeadExtLayout,
  options: ArkitToGnmOptions = {},
): {
  dim: number;
  map: (arkit: Float32Array, out: Float32Array) => void;
  terms: number;
  dropped: string[];
} {
  const table = options.table ?? ARKIT_TO_GNM_DEFAULT;
  const clamp = options.clamp ?? 4;
  const withGaze = options.gaze ?? true;
  const slices = regionSlices(layout);

  const resolved: ResolvedTerm[] = [];
  const dropped: string[] = [];
  for (const [name, terms] of Object.entries(table)) {
    const arkit = ARKIT_INDEX.get(name);
    if (arkit === undefined) {
      dropped.push(`${name}: not an ARKit-52 channel name`);
      continue;
    }
    for (const term of terms) {
      // `regionSlices` is a plain index signature, so the type says every key is present
      // and only the runtime knows otherwise — a pack with no `tongue` region is exactly
      // what a narrower bake looks like.
      const slice = slices[term.region] as { start: number; end: number } | undefined;
      if (slice === undefined) {
        dropped.push(`${name}: this pack has no "${term.region}" region`);
        continue;
      }
      const slot = slice.start + term.index;
      if (slot >= slice.end) {
        dropped.push(
          `${name}: ${term.region}+${String(term.index)} was truncated away (this pack keeps ` +
            `${String(slice.end - slice.start)})`,
        );
        continue;
      }
      resolved.push({ arkit, slot, gain: term.gain });
    }
  }

  // Flat arrays, so the per-frame loop touches three typed arrays and nothing else.
  const srcIndex = Int32Array.from(resolved.map((t) => t.arkit));
  const dstIndex = Int32Array.from(resolved.map((t) => t.slot));
  const gains = Float32Array.from(resolved.map((t) => t.gain));

  const look = (name: string): number => ARKIT_INDEX.get(name) ?? -1;
  const lookUpL = look('EyeLookUpLeft');
  const lookDownL = look('EyeLookDownLeft');
  const lookInL = look('EyeLookInLeft');
  const lookOutL = look('EyeLookOutLeft');
  const lookUpR = look('EyeLookUpRight');
  const lookDownR = look('EyeLookDownRight');
  const lookInR = look('EyeLookInRight');
  const lookOutR = look('EyeLookOutRight');
  const gazeBase = layout.exprDim;
  // Every one of the eight has to be present. `look()` answers -1 for a name this
  // ARKit table does not carry, and `arkit[-1]` is `undefined`, so one missing
  // channel turned the whole gaze block into NaN — which reaches the rig as a
  // rotation the shader cannot normalise and collapses the eyeballs.
  const gazeResolved =
    Math.min(lookUpL, lookDownL, lookInL, lookOutL, lookUpR, lookDownR, lookInR, lookOutR) >= 0;

  return {
    dim: layout.dim,
    terms: resolved.length,
    dropped,
    map(arkit: Float32Array, out: Float32Array): void {
      out.fill(0);
      for (let i = 0; i < dstIndex.length; i++) {
        const slot = dstIndex[i];
        const next = out[slot] + arkit[srcIndex[i]] * gains[i];
        out[slot] = next > clamp ? clamp : next < -clamp ? -clamp : next;
      }
      if (!withGaze || !gazeResolved || out.length < gazeBase + layout.gazeDim) return;
      // Pitch > 0 looks DOWN, yaw > 0 looks toward character-LEFT (gnmPack.ts). ARKit's
      // "in" is toward the nose, so it is +yaw for the RIGHT eye and -yaw for the left.
      out[gazeBase] = (arkit[lookDownL] - arkit[lookUpL]) * GAZE_FULL_SCALE;
      out[gazeBase + 1] = (arkit[lookOutL] - arkit[lookInL]) * GAZE_FULL_SCALE;
      out[gazeBase + 2] = (arkit[lookDownR] - arkit[lookUpR]) * GAZE_FULL_SCALE;
      out[gazeBase + 3] = (arkit[lookInR] - arkit[lookOutR]) * GAZE_FULL_SCALE;
    },
  };
}
