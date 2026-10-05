/**
 * One message name's list for the current tick: refilled from the frame's
 * `message` events the first time it is read in a tick, into pooled entries,
 * so a tick allocates no list and no entry.
 */
import { MAX_PAYLOAD_BYTES } from '../wire';
import { utf8Length } from './utf8';
import type { GameEvent } from '../types';
import type { MessageDef } from './messages';

/**
 * Counters a game or the debug overlay can read.
 *
 * @example
 * ```ts
 * ctx.hud.set({ dropped: ctx.net.stats.dropped, received: ctx.net.stats.received });
 * ```
 */
export interface NetStats {
  /**
   * Messages read and dropped: over their `maxBytes`, not JSON, or failing
   * their `defineMessage` check. A payload over 2,048 bytes is dropped by the
   * room before it reaches the guest, and is not counted here.
   */
  dropped: number;
  /** Messages read and handed to a system. */
  received: number;
  /**
   * `ctx.net.send` calls since `init` that sent nothing: the payload failed its
   * check, did not serialise, or was over the cap. Never thrown, because a
   * throw fails the tick and enough of them kill the guest for the room.
   */
  unsent: number;
}

/** A pooled `{ player, payload }`. */
interface Entry {
  player: number;
  payload: unknown;
}

/** What `parse` returns for a payload that is dropped. */
const DROP: unique symbol = Symbol('drop');

/** One name's reusable result list. */
export class MessageInbox {
  /** The definition that validates this name, or null for the untyped read. */
  def: MessageDef<unknown> | null = null;
  /** The tick serial this list was filled for. */
  private serial = -1;
  /** What the last fill counted, so a re-fill in the same tick can take it back. */
  private filledReceived = 0;
  private filledDropped = 0;
  /** This tick's messages; entries come from `pool`. */
  readonly list: Entry[] = [];
  private readonly pool: Entry[] = [];

  /** @param name The message name. */
  constructor(readonly name: string) {}

  /**
   * Bind the definition that validates this name. The next read refills; if
   * this tick's list was already filled by a bare read, that fill's counts
   * are taken back first, so no message is counted twice.
   *
   * @param def The definition.
   * @param serial The facade's tick serial now.
   * @param stats The counters the fill bumped.
   */
  bind(def: MessageDef<unknown>, serial: number, stats: NetStats): void {
    if (this.serial === serial) {
      stats.received -= this.filledReceived;
      stats.dropped -= this.filledDropped;
    }
    this.def = def;
    this.serial = -1;
  }

  /**
   * The list for tick `serial`, filling it on the first read of that tick.
   *
   * @param serial The facade's tick serial.
   * @param events This tick's host events.
   * @param stats The counters to bump.
   * @returns The list, in arrival order.
   */
  read(serial: number, events: readonly GameEvent[], stats: NetStats): readonly Entry[] {
    if (this.serial === serial) return this.list;
    this.serial = serial;
    const list = this.list;
    list.length = 0;
    const received = stats.received;
    const dropped = stats.dropped;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event.tag !== 'message' || event.val.name !== this.name) continue;
      const payload = this.parse(event.val.payload);
      if (payload === DROP) {
        stats.dropped += 1;
        continue;
      }
      stats.received += 1;
      let entry = this.pool[list.length] as Entry | undefined;
      if (entry === undefined) {
        entry = { player: 0, payload: null };
        this.pool.push(entry);
      }
      entry.player = event.val.player;
      entry.payload = payload;
      list.push(entry);
    }
    this.filledReceived = stats.received - received;
    this.filledDropped = stats.dropped - dropped;
    return list;
  }

  /**
   * Turn one payload into a value, or drop it: over the cap, not JSON, or
   * failing (or throwing in) the definition's check.
   *
   * @param json The JSON payload.
   * @returns The parsed value, or `DROP`.
   */
  private parse(json: string): unknown {
    const def = this.def;
    if (utf8Length(json) > (def === null ? MAX_PAYLOAD_BYTES : def.maxBytes)) return DROP;
    let value: unknown;
    try {
      value = JSON.parse(json) as unknown;
      if (def !== null && !def.check(value)) return DROP;
    } catch {
      return DROP;
    }
    return value;
  }
}
