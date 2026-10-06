/**
 * The `welcome` snapshot as the commands that build it: what a player who was
 * there all along would have been sent, in the same order the authority's
 * replicator introduces an entity (spawn, character, animation, state, visual
 * state), parents first because the snapshot lists them first.
 *
 * Runs once per welcome, so it allocates freely.
 */
import type {
  CameraState,
  Command,
  Entity,
  ExpressionSpace,
  MaterialValue,
  ShapeKind,
  Vec3,
} from '@gameable/sdk';

/** One entity as the welcome carries it (`EntitySnapshot` from `@gameable/wasm-host/server`). */
interface SnapshotEntity {
  entity: Entity;
  asset?: number;
  parent?: Entity;
  visible: boolean;
  name?: string;
  position: number[];
  rotation: number[];
  scale: number[];
  anim: { clip: string; looping: boolean; speed: number } | null;
  character: { bundle: number; state: string; grounded: boolean; velocity: Vec3 } | null;
  body?: number;
  bodyShape?: { kind: ShapeKind; halfExtents: Vec3 } | null;
  visual?: {
    materials: { name: string; value: MaterialValue }[];
    expressions: { space: ExpressionSpace; weights: number[] }[];
    lookAt: { target?: Vec3; weight: number } | null;
    clipWeights: { clips: string[]; weights: number[]; timeScale: number } | null;
  };
}

/** The welcome snapshot's shape (`WelcomeSnapshot` on the server). */
interface Snapshot {
  entities?: SnapshotEntity[];
  camera?: CameraState;
  hud?: string;
}

/**
 * @param lanes Three numbers.
 * @returns Them as a vector.
 */
function vec(lanes: readonly number[]): Vec3 {
  return { x: lanes[0] ?? 0, y: lanes[1] ?? 0, z: lanes[2] ?? 0 };
}

/**
 * @param e One snapshot entity.
 * @param out Where its introduction goes.
 */
function introduce(e: SnapshotEntity, out: Command[]): void {
  const r = e.rotation;
  const rotation = { x: r[0] ?? 0, y: r[1] ?? 0, z: r[2] ?? 0, w: r[3] ?? 1 };
  out.push({
    tag: 'spawn',
    val: {
      entity: e.entity,
      ...(e.asset === undefined ? {} : { asset: e.asset }),
      position: vec(e.position),
      rotation,
      scale: vec(e.scale),
      ...(e.parent === undefined ? {} : { parent: e.parent }),
      visible: e.visible,
      ...(e.name === undefined ? {} : { name: e.name }),
    },
  });
  const entity = e.entity;
  const character = e.character;
  if (character !== null && character.bundle !== 0) {
    const position = vec(e.position);
    out.push({
      tag: 'spawn-character',
      val: { entity, bundle: character.bundle, position, rotation },
    });
  }
  if (e.anim !== null) {
    const { clip, looping, speed } = e.anim;
    out.push({ tag: 'set-anim', val: { entity, clip, looping, speed, fadeMs: 0, weight: 1 } });
  }
  if (character !== null) {
    const { state, grounded, velocity } = character;
    out.push({ tag: 'set-character-state', val: { entity, state, velocity, grounded } });
  }
  const shape = e.bodyShape;
  if (e.asset === undefined && character === null && shape != null) {
    out.push({
      tag: 'add-body',
      val: {
        body: 0, // draw-only: the page makes no body for it
        entity,
        kind: 'fixed',
        shape: { kind: shape.kind, halfExtents: { ...shape.halfExtents } },
        position: vec(e.position),
        rotation,
        mass: 0,
        friction: 0,
        restitution: 0,
        linearDamping: 0,
        angularDamping: 0,
        layer: {},
        mask: {},
        flags: {},
      },
    });
  }
  const visual = e.visual;
  if (visual === undefined) return;
  for (const m of visual.materials) {
    out.push({ tag: 'set-material-param', val: { entity, name: m.name, value: m.value } });
  }
  for (const x of visual.expressions) {
    out.push({ tag: 'set-expression', val: { entity, space: x.space, weights: x.weights } });
  }
  if (visual.lookAt !== null) {
    const { target, weight } = visual.lookAt;
    out.push({
      tag: 'look-at',
      val: { entity, ...(target === undefined ? {} : { target }), weight },
    });
  }
  if (visual.clipWeights !== null) {
    out.push({ tag: 'set-clip-weights', val: { entity, ...visual.clipWeights } });
  }
}

/**
 * The commands that build a welcome's world for `player`, appended to `out`.
 *
 * @param snapshot The welcome's `snapshot` field (unchecked JSON).
 * @param player The receiving player: their camera and HUD become
 *   `set-player-camera` / `set-player-hud` for that id.
 * @param out Where the commands go.
 * @returns How many entities it named.
 */
export function welcomeCommands(snapshot: unknown, player: number, out: Command[]): number {
  if (typeof snapshot !== 'object' || snapshot === null) return 0;
  const world = snapshot as Snapshot;
  const entities = Array.isArray(world.entities) ? world.entities : [];
  for (const e of entities) introduce(e, out);
  if (world.camera !== undefined)
    out.push({ tag: 'set-player-camera', val: { player, camera: world.camera } });
  if (typeof world.hud === 'string')
    out.push({ tag: 'set-player-hud', val: { player, hud: world.hud } });
  return entities.length;
}
