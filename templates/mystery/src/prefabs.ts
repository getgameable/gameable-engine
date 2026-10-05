/**
 * What a player is made of: a capsule the host character controller drives,
 * wearing the sample character.
 */
import { Player, prefab } from 'gameable';

/**
 * Entity ceiling. Must match `world.maxEntities` in `src/game.ts`, because
 * `round.owner` is sized from it.
 */
export const MAX_ENTITIES = 256;

/** Crew capsule radius, metres. */
export const CREW_RADIUS = 0.35;
/** Half-height of the crew capsule's cylindrical section, metres. */
export const CREW_HALF_HEIGHT = 0.8;

/** Every player, "it" included: nobody can tell from the outside. */
export const Crew = prefab({
  name: 'crew',
  character: 'char.crew',
  body: {
    shape: 'capsule',
    dims: [CREW_RADIUS, CREW_HALF_HEIGHT],
    kind: 'character',
    mass: 75,
    layer: { player: true },
    mask: { defaultLayer: true, staticGeometry: true, player: true, character: true },
    flags: { reportContacts: true, lockRotation: true, noSleep: true },
  },
  components: [Player],
});
