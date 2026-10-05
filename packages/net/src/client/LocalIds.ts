/**
 * `LocalIds` — a client-role guest's own entities and sounds, moved into an
 * id range the authority's never reaches.
 *
 * A client guest mints entity and sound ids from 1, exactly like the
 * authority, and both land on the same page adapter. So every id a client
 * guest emits is shifted: an entity `e` becomes `entityBase + e`, where
 * `entityBase` is the game's `world.maxEntities` (an authority entity id is a
 * component-array index, so it is always below that), and a sound `s` becomes
 * `LOCAL_SOUND_BASE + s` (sound ids are map keys, so the high range costs
 * nothing). The page's events about local ids are shifted back before the
 * guest sees them, and events about the authority's entities and sounds are
 * not the client guest's business, so they are dropped.
 *
 * Commands are rewritten into pooled copies, never in place: the guest owns
 * its command objects. A step allocates nothing once the pools have grown.
 */
import { TRANSFORM_STRIDE, type CameraState, type Command, type GameEvent } from '@gameable/sdk';

/** Added to a client guest's sound ids. */
export const LOCAL_SOUND_BASE = 0x40000000;

type Tag = Command['tag'];

/** Pooled copies of one command tag. */
interface Pool {
  list: Command[];
  used: number;
}

/** Shifts a client guest's ids out of the authority's range. */
export class LocalIds {
  private readonly pools = new Map<Tag, Pool>();
  /** The same pools as a list, so `begin` walks them without an iterator. */
  private readonly all: Pool[] = [];
  private readonly camera: CameraState;

  /** @param entityBase The first local entity id minus one: the game's `world.maxEntities`. */
  constructor(readonly entityBase: number) {
    this.camera = {} as CameraState;
  }

  /** The client guest's transform rows with their entity lane shifted; valid until the next `mapTransforms`. */
  rows = new Float32Array(TRANSFORM_STRIDE * 16);

  /**
   * Copy a client guest's packed transforms into {@link LocalIds.rows}, each
   * row's entity shifted. A row for entity 0 (the "nothing moved" row) is kept as 0.
   *
   * @param packed Stride-12 rows, as the guest packs them.
   * @returns The row count.
   */
  mapTransforms(packed: Float32Array): number {
    const count = (packed.length / TRANSFORM_STRIDE) | 0;
    if (this.rows.length < packed.length) {
      let size = this.rows.length;
      while (size < packed.length) size *= 2;
      this.rows = new Float32Array(size);
    }
    const rows = this.rows;
    // Index copy: `subarray` would make a view object per step.
    for (let i = 0; i < count * TRANSFORM_STRIDE; i += 1) rows[i] = packed[i];
    for (let row = 0; row < count; row += 1) {
      const o = row * TRANSFORM_STRIDE;
      this.rows[o] = this.entity(this.rows[o] | 0);
    }
    return count;
  }

  /** Start a step: the pooled copies are free again. */
  begin(): void {
    const all = this.all;
    for (let i = 0; i < all.length; i += 1) all[i].used = 0;
  }

  /**
   * @param entity A client guest's entity, or 0.
   * @returns The page's id for it (0 stays 0).
   */
  entity(entity: number): number {
    return entity === 0 ? 0 : this.entityBase + entity;
  }

  /**
   * @param command One client guest command.
   * @returns The command with its ids shifted (a pooled copy, valid this step),
   *   the command itself when it names no id, or null for one a client must
   *   not apply: physics, which the authority owns.
   */
  map(command: Command): Command | null {
    switch (command.tag) {
      case 'add-body':
      case 'remove-body':
      case 'set-body-transform':
      case 'set-body-velocity':
      case 'apply-impulse':
      case 'set-body-enabled':
      case 'move-character':
        return null;
      case 'despawn': {
        const out = this.copy(command) as typeof command;
        out.val = this.entity(command.val);
        return out;
      }
      case 'spawn':
      case 'set-parent': {
        const out = this.copy(command) as typeof command;
        out.val.entity = this.entity(command.val.entity);
        out.val.parent =
          command.val.parent === undefined ? undefined : this.entity(command.val.parent);
        return out;
      }
      case 'play-sound': {
        const out = this.copy(command) as typeof command;
        out.val.sound = LOCAL_SOUND_BASE + command.val.sound;
        out.val.entity =
          command.val.entity === undefined ? undefined : this.entity(command.val.entity);
        return out;
      }
      case 'stop-sound': {
        const out = this.copy(command) as typeof command;
        out.val.sound = LOCAL_SOUND_BASE + command.val.sound;
        return out;
      }
      case 'set-asset':
      case 'set-anim':
      case 'set-material-param':
      case 'spawn-character':
      case 'set-character-state':
      case 'set-clip-weights':
      case 'set-expression':
      case 'look-at':
      case 'say':
      case 'conversation': {
        const out = this.copy(command) as { tag: Tag; val: { entity: number } };
        out.val.entity = this.entity(command.val.entity);
        return out as Command;
      }
      case 'set-player-camera': {
        const out = this.copy(command) as typeof command;
        out.val.camera = this.mapCamera(command.val.camera);
        return out;
      }
      default:
        return command;
    }
  }

  /**
   * @param camera The client guest's camera.
   * @returns It with `follow` shifted (a reused copy), or itself when it follows nothing.
   */
  mapCamera(camera: CameraState): CameraState {
    if (camera.follow === undefined || camera.follow === 0) return camera;
    const out = Object.assign(this.camera, camera);
    out.follow = this.entity(camera.follow);
    return out;
  }

  /**
   * Keep the page's events about this guest's own ids, shifted back; drop
   * those about the authority's. Edits the list in place.
   *
   * @param events The page adapter's event queue.
   */
  filterEvents(events: GameEvent[]): void {
    let kept = 0;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (this.localise(event)) events[kept++] = event;
    }
    events.length = kept;
  }

  /**
   * @param event One page event (the page made it; it may be edited).
   * @returns False when it is about the authority's world.
   */
  private localise(event: GameEvent): boolean {
    switch (event.tag) {
      case 'conversation-event':
      case 'character-ready':
      case 'anim-event':
        if (event.val.entity <= this.entityBase) return false;
        event.val.entity -= this.entityBase;
        return true;
      case 'sound-ended':
        if (event.val.sound <= LOCAL_SOUND_BASE) return false;
        event.val.sound -= LOCAL_SOUND_BASE;
        return true;
      default:
        return true;
    }
  }

  /**
   * @param command A command to copy.
   * @returns A pooled command of the same tag with the same fields (shallow).
   */
  private copy(command: Command): Command {
    const tag = command.tag;
    let pool = this.pools.get(tag);
    if (pool === undefined) {
      pool = { list: [], used: 0 };
      this.pools.set(tag, pool);
      this.all.push(pool);
    }
    let out = pool.list.at(pool.used);
    if (out === undefined) {
      out = { tag, val: typeof command.val === 'object' ? {} : command.val } as Command;
      pool.list.push(out);
    }
    pool.used += 1;
    if (typeof command.val !== 'object') {
      (out as { val: unknown }).val = command.val;
      return out;
    }
    // Clear what the copy's last use set, so an optional field the guest left
    // out this time (a spawn's `parent`, a say's `audio`) is not carried over.
    const val = out.val as unknown as Record<string, unknown>;
    for (const key in val) val[key] = undefined;
    Object.assign(val, command.val);
    return out;
  }
}
