/**
 * `PlayerView` — one player's replication state and what is waiting for them.
 */
import type { CameraState, Command } from '@gameable/sdk';

import { RowFlag } from '../../protocol/constants.js';
import type { RowSource } from '../../protocol/types.js';
import type { BodyStates } from './BodyStates.js';
import { KnownEntities } from './KnownEntities.js';
import { OwnBody } from './OwnBody.js';
import type { RoomView, ViewMessage } from './RoomGame.js';
import { RowList } from './RowList.js';

const POSE = RowFlag.POSITION | RowFlag.ROTATION;

/**
 * What one player knows and has yet to be told.
 *
 * The replicator writes into it once per simulation step ({@link Replicator});
 * the room takes it once per room tick (`viewFor`), which swaps the commands
 * and messages gathered since the last take out, so a take covers every step
 * in between and the next take starts empty. Rows are not gathered per step:
 * {@link PlayerView.takeRows} compares each known record's `poseSerial` with
 * the tick of the last rows taken, so a slow `sendHz` misses no movement.
 *
 * @example
 * ```ts
 * import { PlayerView } from 'gameable/net/server';
 *
 * const view = new PlayerView(2);
 * view.commands.length; // 0 until the replicator collects a step
 * ```
 */
export class PlayerView implements RoomView {
  /** Entities this player has been told of. */
  readonly known = new KnownEntities();
  /** The tick the commands are up to date to: the last collected step. */
  lastSentTick = 0;
  /** The tick of the last rows taken. */
  lastRowsTick = 0;
  /** Where the player last was, for relevancy while they have no entity. */
  readonly origin = new Float32Array(3);
  /** Whether {@link PlayerView.origin} has ever been set. */
  hasOrigin = false;
  /** The per-player camera last sent. */
  lastCamera: CameraState | undefined = undefined;
  /** The per-player HUD last sent. */
  lastHud: string | undefined = undefined;
  /** The room's body rows, for the trailer; null writes none (a room without physics). */
  bodies: BodyStates | null = null;

  private frameValue = 0;
  private entityValue = 0;
  private building: Command[] = [];
  private taken: Command[] = [];
  private buildingMessages: ViewMessage[] = [];
  private takenMessages: ViewMessage[] = [];
  private readonly rows = new RowList();
  private readonly own = new OwnBody();

  /** @param player The player id. */
  constructor(readonly player: number) {}

  /** @returns The authority's tick at the end of the steps the last take covers. */
  get frame(): number {
    return this.frameValue;
  }

  /** @returns The entity this player controls as of the last take, or 0: "your entity". */
  get entity(): number {
    return this.entityValue;
  }

  /** @returns The commands of the last take, in order; good until the next take. */
  get commands(): readonly Command[] {
    return this.taken;
  }

  /** @returns The messages of the last take, in order; good until the next take. */
  get messages(): readonly ViewMessage[] {
    return this.takenMessages;
  }

  /** @returns The list commands go into for the next take (for bulk pushes). */
  get pending(): Command[] {
    return this.building;
  }

  /**
   * Queue a message for the next take.
   *
   * @param name The message name.
   * @param payload The payload JSON.
   */
  message(name: string, payload: string): void {
    this.buildingMessages.push({ name, payload });
  }

  /**
   * One step has been collected into this view.
   *
   * @param tick The step's tick.
   */
  collected(tick: number): void {
    this.lastSentTick = tick;
  }

  /**
   * Hand the gathered commands and messages over; start the next take empty.
   *
   * @param frame The authority's tick now.
   * @param entity The entity the player controls now, or 0.
   * @returns This view, as the room reads it.
   */
  take(frame: number, entity: number): this {
    this.frameValue = frame;
    this.entityValue = entity;
    const commands = this.building;
    this.building = this.taken;
    this.building.length = 0;
    this.taken = commands;
    const messages = this.buildingMessages;
    this.buildingMessages = this.takenMessages;
    this.buildingMessages.length = 0;
    this.takenMessages = messages;
    return this;
  }

  /**
   * The rows whose pose changed since the last rows taken, read straight from
   * the records, and move the watermark. Position and rotation always travel
   * together; scale only when it differs from the scale last sent. A teleport
   * since the last rows sets `TELEPORT`; a hidden entity shown since sets
   * `VISIBLE`. The player's own entity's body, when it has one, rides along
   * as the trailer (`rows.player`). Allocates nothing.
   *
   * @returns The rows, good until the next call.
   */
  takeRows(): RowSource {
    const rows = this.rows;
    rows.reset();
    const since = this.lastRowsTick;
    const mine = this.entityValue === 0 ? undefined : this.known.get(this.entityValue);
    if (
      mine !== undefined &&
      this.bodies !== null &&
      this.own.fill(mine.record, this.bodies, since)
    ) {
      rows.player = this.own;
    }
    const list = this.known.list;
    for (let i = 0; i < list.length; i += 1) {
      const known = list[i];
      const record = known.record;
      let flags = 0;
      if (record.poseSerial > since) {
        flags = POSE;
        const s = record.scale;
        const was = known.scale;
        if (s[0] !== was[0] || s[1] !== was[1] || s[2] !== was[2]) {
          flags |= RowFlag.SCALE;
          was.set(s);
        }
      }
      if (record.teleportedAt > since) flags |= RowFlag.TELEPORT;
      if (known.showPending) {
        flags |= RowFlag.VISIBLE;
        known.showPending = false;
      }
      if (flags !== 0) rows.push(record, flags);
    }
    this.lastRowsTick = this.lastSentTick;
    return rows;
  }

  /**
   * Start over from a welcome snapshot taken at `tick`: forget what the
   * player knew and everything queued.
   *
   * @param tick The authority's tick of the snapshot.
   */
  reset(tick: number): void {
    this.known.clear();
    this.building.length = 0;
    this.taken.length = 0;
    this.buildingMessages.length = 0;
    this.takenMessages.length = 0;
    this.lastSentTick = tick;
    this.lastRowsTick = tick;
    this.frameValue = tick;
    this.lastCamera = undefined;
    this.lastHud = undefined;
  }
}
