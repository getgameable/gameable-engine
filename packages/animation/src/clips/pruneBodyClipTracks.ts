// Ported from aos-threejs-poc/src/lib/pruneBodyClipTracks.js @ cdd63b10
/**
 * pruneBodyClipTracks — strip tracks that can't (or shouldn't) bind to the rig
 * skeleton from a loaded body AnimationClip. Pure (string ops + a Set membership
 * check, no three import) so the pelvis `.position` keep/drop gate is unit
 * testable.
 */

/** The minimum shape a track needs for the prune decision. */
export interface PrunableTrack {
  /** `"<nodePath>.<property>"`, e.g. `"Armature/pelvis.position"`. */
  name: string;
  /** Keyframe times; only the length is read, to classify active vs static. */
  times?: ArrayLike<number>;
}

/** The minimum shape a clip needs for the prune decision. */
export interface PrunableClip {
  /** Tracks, replaced in place with the kept subset. */
  tracks: PrunableTrack[];
}

/**
 * The `aosGeneratedMotion` extras a generated clip carries.
 *
 * Present with `keepRootMotion !== true` → the clip opted out of root motion,
 * so its pelvis `.position` is stripped too (play in place). Present with
 * `keepRootMotion === true` → the authored relative-travel track is kept.
 * Absent → pelvis `.position` is kept, the behaviour stock and arbitrary custom
 * uploads have always had.
 */
export interface GeneratedMotionMarker {
  /** Whether the authored pelvis travel track survives the prune. */
  keepRootMotion?: boolean;
}

/** What a prune did, for logging and for tests. */
export interface PruneReport {
  /** Track count before the prune. */
  tracks: number;
  /** Tracks kept, i.e. bound to a node present on the rig. */
  bound: number;
  /** Bound tracks with more than {@link ACTIVE_KEY_THRESHOLD} keys. */
  active: number;
  /** Tracks dropped because their node is absent from the rig. */
  unbound: number;
  /** Up to five node paths from the unbound set, for a readable warning. */
  samples: string[];
}

/** Options for {@link pruneBodyClipTracks}. */
export interface PruneOptions {
  /** The clip's `aosGeneratedMotion` extras, or null for a non-generated clip. */
  generatedMarker?: GeneratedMotionMarker | null;
}

/** Nodes whose tracks are dropped whatever the property is. */
const STRIP_ALL: ReadonlySet<string> = new Set(['root', 'Armature']);

/** Above this many keys a bound track counts as animated rather than a static pose. */
export const ACTIVE_KEY_THRESHOLD = 10;

/**
 * Drop every track of `clip` that cannot (or should not) bind to `sceneNodes`.
 *
 * `pelvis.scale` is always stripped — it is the rig's metres/centimetres scale
 * defence, and a stationary avatar never needs it. `pelvis.position` is kept by
 * default; a generated motion that opted OUT of root motion strips it too so
 * the clip plays in place.
 *
 * @param clip Clip whose `tracks` array is replaced in place with the kept subset.
 * @param sceneNodes Leaf node names present on the rig.
 * @param options Prune options; see {@link PruneOptions}.
 *
 * @returns A {@link PruneReport} describing what was kept and dropped.
 */
export function pruneBodyClipTracks(
  clip: PrunableClip,
  sceneNodes: ReadonlySet<string>,
  options: PruneOptions = {},
): PruneReport {
  const generatedMarker = options.generatedMarker ?? null;

  const stripPelvis = new Set<string>(['scale']);
  if (generatedMarker !== null && generatedMarker.keepRootMotion !== true) {
    stripPelvis.add('position');
  }

  const original = clip.tracks.length;
  const kept: PrunableTrack[] = [];
  const samples: string[] = [];
  let unbound = 0;
  let active = 0;

  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    const nodePath = dot >= 0 ? track.name.substring(0, dot) : track.name;
    const prop = dot >= 0 ? track.name.substring(dot + 1) : '';
    const leaf = nodePath.split('/').pop() ?? nodePath;
    if (STRIP_ALL.has(leaf)) continue;
    if (leaf === 'pelvis' && stripPelvis.has(prop)) continue;
    if (sceneNodes.has(leaf)) {
      kept.push(track);
      if ((track.times?.length ?? 0) > ACTIVE_KEY_THRESHOLD) active += 1;
    } else {
      unbound += 1;
      if (samples.length < 5) samples.push(nodePath);
    }
  }

  clip.tracks = kept;
  return { tracks: original, bound: kept.length, active, unbound, samples };
}
