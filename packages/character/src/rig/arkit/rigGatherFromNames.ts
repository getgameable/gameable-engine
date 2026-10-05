// Derive a character's ARKit gather from its bundle's `rig_names.json`.
//
// A splat character's live lip-sync path is ARKit-52 -> `arkitToMh` (188 MetaHuman
// controls) -> gather the N controls the character's decoders were trained on. Which
// N controls — and their order — is declared by the bundle's own `rig_names.json`
// (60 on one character, 174 on another), so the gather is derived from the bundle at
// load time instead of being a hardcoded per-character build artifact. A control
// space the 188 ordering cannot express THROWS — the caller reports "no lip-sync"
// rather than decoding garbage.
//
// Ported from aos-threejs-poc/src/ogs/rig/rigGatherFromNames.js @ cdd63b10

import { MH_RIG_NAMES } from './rigNamesMh.js';

let _indexOfName: Map<string, number> | null = null;
/**
 * The canonical 188-control name -> index lookup, built once on first use.
 *
 * @returns A map from MetaHuman control name to its index in `MH_RIG_NAMES`.
 */
function indexOfName(): Map<string, number> {
  if (!_indexOfName) _indexOfName = new Map(MH_RIG_NAMES.map((n, i) => [n, i]));
  return _indexOfName;
}

/**
 * @param rigNames The bundle's `rig_names.json` (N control names).
 * @returns N indices into the 188-control `arkitToMh` output.
 * @throws {Error} When `rigNames` is not a non-empty string array, or any name is missing
 *   from the canonical 188 ordering.
 */
export function gatherFromRigNames(rigNames: string[]): number[] {
  if (!Array.isArray(rigNames) || rigNames.length === 0) {
    throw new Error('rig_names.json is not a non-empty array');
  }
  const idx = indexOfName();
  const missing: string[] = [];
  const gather = rigNames.map((name) => {
    const i = idx.get(name);
    if (i === undefined) {
      missing.push(name);
      return -1;
    }
    return i;
  });
  if (missing.length) {
    const shown = missing.slice(0, 5).join(', ');
    throw new Error(
      `rig_names.json has ${String(missing.length)} control(s) not in the 188 MH ordering: ${shown}${missing.length > 5 ? ', …' : ''}`,
    );
  }
  return gather;
}
