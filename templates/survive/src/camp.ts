/**
 * The camp: the clock, each player's wood and nights, who is down, and the
 * creatures and walls in the world. Authority state only.
 *
 * Flat lanes indexed by player id, sized once, so the systems read and write
 * numbers and a tick allocates nothing.
 */
import { MAX_ENTITIES } from './prefabs';

/** Seats in a room: `features.multiplayer.maxPlayers` in `src/game.ts`. */
export const MAX_PLAYERS = 6;
/** Highest player id + 1 the camp tracks. Seats start at 0; six fit with room to spare. */
export const MAX_SEATS = 16;
/** The most creatures alive at once, however long the night count grows. */
export const MAX_CREATURES = 24;
/** The most walls standing at once. */
export const MAX_WALLS = 32;

/** The sun is up: gather and build. */
export const PHASE_DAY = 0;
/** Creatures are out. */
export const PHASE_NIGHT = 1;

/** A fixed-capacity list of entities. Removing swaps the last one in. */
export class EntityList {
  /** The entities, `0..count`. */
  readonly items: Int32Array;
  /** How many are set. */
  count = 0;

  /** @param capacity The most it holds. */
  constructor(capacity: number) {
    this.items = new Int32Array(capacity);
  }

  /**
   * @param entity An entity.
   * @returns False when the list is full.
   */
  add(entity: number): boolean {
    if (this.count >= this.items.length) return false;
    this.items[this.count] = entity;
    this.count += 1;
    return true;
  }

  /** @param index A slot, `0..count`. */
  removeAt(index: number): void {
    this.count -= 1;
    this.items[index] = this.items[this.count];
  }

  /** Forget everything. */
  clear(): void {
    this.count = 0;
  }
}

/** The one camp a room plays. */
export class Camp {
  /** `PHASE_DAY` or `PHASE_NIGHT`. */
  phase = PHASE_DAY;
  /** `ctx.elapsed` when this phase began. */
  phaseStartedAt = 0;
  /** Nights begun in this room; the first night is 1. */
  night = 0;
  /** Wood each player holds. */
  readonly wood = new Int32Array(MAX_SEATS);
  /** 1 for a player at 0 health: frozen, ignored by creatures, up at dawn. */
  readonly downed = new Uint8Array(MAX_SEATS);
  /**
   * Nights each player saw out on their feet, across visits: saved in the
   * player's document (`ctx.data`, `{ nightsSurvived }`) at each dawn, and
   * read back when they join (`seats`).
   */
  readonly nightsSurvived = new Int32Array(MAX_SEATS);
  /** Seconds until each creature may hit again, by entity. */
  readonly cooldown = new Float32Array(MAX_ENTITIES);
  /** The creatures alive. */
  readonly creatures = new EntityList(MAX_CREATURES);
  /** The walls standing. */
  readonly walls = new EntityList(MAX_WALLS);

  /** Back to the first morning. Call from `defineGame({ init })`. */
  reset(): void {
    this.phase = PHASE_DAY;
    this.phaseStartedAt = 0;
    this.night = 0;
    this.wood.fill(0);
    this.downed.fill(0);
    this.nightsSurvived.fill(0);
    this.cooldown.fill(0);
    this.creatures.clear();
    this.walls.clear();
  }

  /**
   * A seat was left or taken: whoever sits there starts with nothing.
   *
   * @param player The player id.
   */
  clearSeat(player: number): void {
    if (player < 0 || player >= MAX_SEATS) return;
    this.wood[player] = 0;
    this.downed[player] = 0;
    this.nightsSurvived[player] = 0;
  }
}

/** This guest's camp. */
export const camp = new Camp();
