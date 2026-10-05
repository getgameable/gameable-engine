/**
 * Pressing `E` at things.
 *
 * One system, three verbs. Every frame it finds the nearest `Interactable`
 * inside a cone in front of the hero and publishes a prompt for the HUD; when
 * `E` goes down it does whatever that thing does:
 *
 * | Kind  | `E` does                                                  |
 * | ----- | --------------------------------------------------------- |
 * | chest | opens it; one of the two has the key in it                 |
 * | key   | picks it up                                               |
 * | npc   | hands over to `src/systems/dialogue.ts`                   |
 * | door  | slides open, but only if you are carrying the key         |
 *
 * The cone rather than a sphere is deliberate: an adventure game where `E`
 * opens the chest behind you is an adventure game people complain about. The
 * whole search is a loop over the handful of tagged entities with no query per
 * candidate, because `interactables.kind` was filled in once during `init`.
 *
 * In a room (Play Solo included) every player does this for themselves, on the
 * authority, from their own hero, camera and keys. The world is shared: an
 * opened chest is open for everyone, and the door opens for all. What a player
 * carries, their prompt and their notices are their own.
 */
import { Transform, hasComponent, query, type GameContext } from 'gameable';

import {
  Chest,
  Door,
  HoldsKey,
  Interactable,
  KEY_HEIGHT,
  KIND_CHEST,
  KIND_DOOR,
  KIND_KEY,
  KIND_NONE,
  KIND_NPC,
  Key,
  KeyPrefab,
  KEY_COLOUR,
  Npc,
  interactables,
  tint,
} from '../prefabs';
import { eachActor, type Actor } from './actors';
import { beginDialogue, dialogueFor } from './dialogue';
import { slideDoor } from './door';
import {
  interactState,
  pockets,
  questState,
  seats,
  type InteractSeat,
  type Pocket,
} from './interactSeats';

export {
  interactFor,
  interactState,
  questState,
  resetInteract,
  type InteractSeat,
  type Pocket,
} from './interactSeats';

/** Query terms, hoisted: a fresh array every frame is a per-frame allocation. */
const CANDIDATES = [Interactable, Transform];

/** Reused spawn position for a dropped key. */
const drop = { x: 0, y: 0, z: 0 };

/**
 * Work out what each interactable is, once, from its tags.
 *
 * Tags are how a prefab says what a thing is, and asking bitecs four questions
 * per candidate per frame would be silly. So the answer is cached into a flat
 * lane the moment the level exists — which is `init`, after the declarative
 * `spawns` have run.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
export function classifyInteractables(ctx: GameContext): void {
  const entities = query(ctx.world, CANDIDATES);
  for (let i = 0; i < entities.length; i += 1) {
    const e = entities[i] ?? 0;
    if (e === 0) continue;
    interactables.kind[e] = hasComponent(ctx.world, e, Chest)
      ? KIND_CHEST
      : hasComponent(ctx.world, e, Door)
        ? KIND_DOOR
        : hasComponent(ctx.world, e, Npc)
          ? KIND_NPC
          : hasComponent(ctx.world, e, Key)
            ? KIND_KEY
            : KIND_NONE;
    if (interactables.kind[e] === KIND_DOOR) interactState.door = e;
  }
}

/**
 * Put a line on one player's HUD for a moment.
 *
 * @param ctx The frame context.
 * @param seat Whose screen.
 * @param text What to say.
 * @returns Nothing.
 */
function notify(ctx: GameContext, seat: InteractSeat, text: string): void {
  seat.message = text;
  seat.messageFrames = Math.round(Number(ctx.rules.messageSeconds ?? 2.5) / ctx.dt);
}

/**
 * The prompt for one candidate.
 *
 * @param kind One of the `KIND_*` constants.
 * @param used Whether it has already been used.
 * @param hasKey Whether the hero is carrying the key.
 * @returns The line to draw, or `''` when there is nothing to say.
 */
function promptFor(kind: number, used: boolean, hasKey: boolean): string {
  if (kind === KIND_CHEST) return used ? '' : 'E: open chest';
  if (kind === KIND_KEY) return 'E: take key';
  if (kind === KIND_NPC) return 'E: talk';
  if (kind === KIND_DOOR) {
    if (used) return '';
    return hasKey ? 'E: open door' : 'E: door is locked';
  }
  return '';
}

/**
 * Find the nearest thing in front of one player's hero.
 *
 * @param ctx The frame context.
 * @param who The player.
 * @param seat Their interact state, written.
 * @param hasKey Whether they carry the key.
 * @returns Nothing.
 */
function findTarget(ctx: GameContext, who: Actor, seat: InteractSeat, hasKey: boolean): void {
  const range = Number(ctx.rules.interactRange ?? 2);
  const facing = Number(ctx.rules.interactFacing ?? 0.3);
  const rangeSquared = range * range;

  // Forward is where the camera is pointing, because that is the direction the
  // hero walks in and the direction the player believes they are facing.
  const fx = -Math.sin(who.yaw);
  const fz = -Math.cos(who.yaw);

  const hero = who.entity;
  const hx = Transform.x[hero] ?? 0;
  const hy = Transform.y[hero] ?? 0;
  const hz = Transform.z[hero] ?? 0;

  let best = 0;
  let bestKind = KIND_NONE;
  let bestPrompt = '';
  let bestDistance = rangeSquared;

  const entities = query(ctx.world, CANDIDATES);
  for (let i = 0; i < entities.length; i += 1) {
    const e = entities[i] ?? 0;
    if (e === 0 || e === hero) continue;
    const kind = interactables.kind[e] ?? KIND_NONE;
    if (kind === KIND_NONE) continue;
    const prompt = promptFor(kind, interactables.used[e] === 1, hasKey);
    if (prompt === '') continue;

    const dx = (Transform.x[e] ?? 0) - hx;
    const dy = (Transform.y[e] ?? 0) - hy;
    const dz = (Transform.z[e] ?? 0) - hz;
    const planar = dx * dx + dz * dz;
    if (planar > bestDistance) continue;
    // A chest on the floor below a hero on a ramp is not within reach.
    if (Math.abs(dy) > range) continue;

    const length = Math.sqrt(planar);
    if (length > 0 && (dx / length) * fx + (dz / length) * fz < facing) continue;

    best = e;
    bestKind = kind;
    bestPrompt = prompt;
    bestDistance = planar;
  }

  seat.target = best;
  seat.kind = bestKind;
  seat.prompt = bestPrompt;
}

/**
 * Act on whatever one player pressed `E` at.
 *
 * @param ctx The frame context.
 * @param who The player.
 * @param seat Their interact state.
 * @param pocket Their pocket.
 * @returns Nothing.
 */
function activate(ctx: GameContext, who: Actor, seat: InteractSeat, pocket: Pocket): void {
  const entity = seat.target;
  const kind = seat.kind;
  if (kind === KIND_CHEST) {
    interactables.used[entity] = 1;
    questState.chestsOpened += 1;
    ctx.audio.play('sfx.key', { entity, volume: 0.7 });
    if (hasComponent(ctx.world, entity, HoldsKey)) {
      drop.x = Transform.x[entity] ?? 0;
      drop.y = (Transform.y[entity] ?? 0) + KEY_HEIGHT;
      drop.z = Transform.z[entity] ?? 0;
      const key = ctx.spawn(KeyPrefab, drop);
      interactables.kind[key] = KIND_KEY;
      tint(key, KEY_COLOUR);
      notify(ctx, seat, 'A key. Of course it was this one.');
    } else {
      notify(ctx, seat, 'Empty. Someone got here first.');
    }
    return;
  }

  if (kind === KIND_KEY) {
    pocket.keys += 1;
    ctx.audio.play('sfx.key', { entity: who.entity, volume: 0.9 });
    ctx.despawn(entity);
    interactables.kind[entity] = KIND_NONE;
    notify(ctx, seat, 'Key taken.');
    return;
  }

  if (kind === KIND_NPC) {
    beginDialogue(ctx, entity, dialogueFor(who), who.entity);
    return;
  }

  if (kind === KIND_DOOR) {
    if (pocket.keys <= 0) {
      notify(ctx, seat, 'Locked. One of the chests has the key.');
      return;
    }
    interactables.used[entity] = 1;
    ctx.audio.play('sfx.door', { entity, volume: 0.8 });
    notify(ctx, seat, 'The door grinds sideways.');
  }
}

/**
 * One player's step: their notice ticks down, then what `E` would do, and
 * whether they pressed it.
 *
 * @param ctx The frame context.
 * @param who The player.
 * @returns Nothing.
 */
function interactAs(ctx: GameContext, who: Actor): void {
  const seat = seats.of(who);
  const pocket = pockets.of(who);
  if (seat.messageFrames > 0) {
    seat.messageFrames -= 1;
    if (seat.messageFrames === 0) seat.message = '';
  }

  // Mid-conversation there is nothing to interact with: `E` belongs to the
  // dialogue system, which runs next.
  if (dialogueFor(who).active) {
    seat.target = 0;
    seat.kind = KIND_NONE;
    seat.prompt = '';
    return;
  }

  findTarget(ctx, who, seat, pocket.keys > 0);

  if (!who.input.pressed('E')) return;
  if (seat.target === 0) return;
  activate(ctx, who, seat, pocket);
}

/**
 * Slide the door, then look for something to do for every player, and do it
 * when their `E` says so.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
export function interactSystem(ctx: GameContext): void {
  slideDoor(ctx, interactState, questState);
  eachActor(ctx, interactAs);
}
