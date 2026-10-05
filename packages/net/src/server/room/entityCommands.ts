/**
 * Commands rebuilt from a world record: what a client must apply to have an
 * entity as the authority has it.
 *
 * These are the reliable path, and they build plain objects for
 * `JSON.stringify`: that allocation is accepted (the plan's ruling); the row
 * path is the one that allocates nothing. Arrays the record owns (weights,
 * clip names) are copied, since the record overwrites them in place.
 */
import type { Command, MaterialValue, Vec3 } from '@gameable/sdk';
import type { EntityRecord } from '@gameable/wasm-host/server';

/**
 * @param lanes Three lanes.
 * @returns Them as a `Vec3`.
 */
function vec(lanes: ArrayLike<number>): Vec3 {
  return { x: lanes[0], y: lanes[1], z: lanes[2] };
}

/**
 * @param value A material value the record owns.
 * @returns A copy that does not alias it.
 */
function copyValue(value: MaterialValue): MaterialValue {
  switch (value.tag) {
    case 'color':
      return { tag: 'color', val: { ...value.val } };
    case 'vector':
      return { tag: 'vector', val: { ...value.val } };
    default:
      return { ...value };
  }
}

/**
 * The `spawn` that recreates a record as it is now.
 *
 * @param record The live record.
 * @param parent The parent to name: the record's, when the player knows it.
 * @returns The command.
 */
export function spawnCommand(record: EntityRecord, parent: number | undefined): Command {
  const r = record.rotation;
  return {
    tag: 'spawn',
    val: {
      entity: record.entity,
      ...(record.asset === undefined ? {} : { asset: record.asset }),
      position: vec(record.position),
      rotation: { x: r[0], y: r[1], z: r[2], w: r[3] },
      scale: vec(record.scale),
      ...(parent === undefined ? {} : { parent }),
      visible: record.visible,
      ...(record.name === undefined ? {} : { name: record.name }),
    },
  };
}

/**
 * @param record A record with an animation.
 * @returns Its `set-anim`. The record keeps no fade or weight: 0 ms and 1.
 */
export function setAnimCommand(record: EntityRecord): Command | null {
  const anim = record.anim;
  if (anim === null) return null;
  const { clip, looping, speed } = anim;
  return { tag: 'set-anim', val: { entity: record.entity, clip, looping, speed, fadeMs: 0, weight: 1 } };
}

/**
 * @param record A record with a character.
 * @returns Its `spawn-character`, at the record's pose.
 */
export function spawnCharacterCommand(record: EntityRecord): Command | null {
  const character = record.character;
  if (character === null || character.bundle === 0) return null;
  const r = record.rotation;
  return {
    tag: 'spawn-character',
    val: {
      entity: record.entity,
      bundle: character.bundle,
      position: vec(record.position),
      rotation: { x: r[0], y: r[1], z: r[2], w: r[3] },
    },
  };
}

/**
 * @param record A record with a character.
 * @returns Its `set-character-state`, with the recorded velocity (a client's
 *   animator picks idle, walk or run from it).
 */
export function characterStateCommand(record: EntityRecord): Command | null {
  const character = record.character;
  if (character === null) return null;
  return {
    tag: 'set-character-state',
    val: {
      entity: record.entity,
      state: character.state,
      velocity: { x: character.velocity.x, y: character.velocity.y, z: character.velocity.z },
      grounded: character.grounded,
    },
  };
}

/**
 * Push the visual entries that changed after `since` (every entry, for `-1`).
 *
 * @param record The live record.
 * @param since The tick the player was last brought up to date to.
 * @param out Where the commands go.
 */
export function pushVisualCommands(record: EntityRecord, since: number, out: Command[]): void {
  const visual = record.visual;
  const entity = record.entity;
  for (const m of visual.materials) {
    if (m.serial <= since) continue;
    out.push({ tag: 'set-material-param', val: { entity, name: m.name, value: copyValue(m.value) } });
  }
  for (const e of visual.expressions) {
    if (e.serial <= since) continue;
    out.push({ tag: 'set-expression', val: { entity, space: e.space, weights: e.weights.slice() } });
  }
  const look = visual.lookAt;
  if (look !== null && look.serial > since) {
    const target = look.target === undefined ? {} : { target: { ...look.target } };
    out.push({ tag: 'look-at', val: { entity, ...target, weight: look.weight } });
  }
  const clips = visual.clipWeights;
  if (clips !== null && clips.serial > since) {
    out.push({
      tag: 'set-clip-weights',
      val: { entity, clips: clips.clips.slice(), weights: clips.weights.slice(), timeScale: clips.timeScale },
    });
  }
}

/**
 * Push everything a player needs to see a record they have never seen:
 * `spawn`, then `spawn-character`, `set-anim`, `set-character-state`, and
 * every visual entry.
 *
 * @param record The live record.
 * @param parent The parent to name in the spawn.
 * @param out Where the commands go.
 */
export function pushIntroduction(record: EntityRecord, parent: number | undefined, out: Command[]): void {
  out.push(spawnCommand(record, parent));
  const character = spawnCharacterCommand(record);
  if (character !== null) out.push(character);
  const anim = setAnimCommand(record);
  if (anim !== null) out.push(anim);
  const state = characterStateCommand(record);
  if (state !== null) out.push(state);
  pushVisualCommands(record, -1, out);
}
