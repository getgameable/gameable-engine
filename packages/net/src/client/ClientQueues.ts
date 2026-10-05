/**
 * `ClientQueues` — what the authority sent since the last fixed step: its
 * commands, rows frames and messages, held for the client loop's drain.
 *
 * The queues are bounded. A page that runs no fixed steps (a hidden tab)
 * still receives frames, and rows are deltas, so an old frame cannot simply
 * be dropped. Past a cap the queues are dropped whole, nothing more is queued,
 * and the owner asks the room for a fresh welcome.
 */
import type { Command } from '@gameable/sdk';

import type { FramedRowSink, NetMessageSink } from './NetService.js';
import { RowQueue } from './RowQueue.js';

/**
 * Seconds of frames the queues hold before they overflow. Three seconds is
 * 60 rows frames at the default 20 Hz and 180 `cmd` frames at the room's 60 Hz
 * tick: far more than a visible page ever has between two fixed steps (a 3 s
 * hitch already freezes the game), and at about 1 KB a rows frame for 30
 * moving entities, about 60 KB of rows instead of 12 MB after 10 minutes.
 */
export const QUEUE_SECONDS = 3;

/** The room's simulation rate, which is how often it sends a `cmd` frame. */
const ROOM_TICK_HZ = 60;

/** Messages held at most: 256 at the 2,048-byte payload cap is 512 KB. */
export const MAX_QUEUED_MESSAGES = 256;

/** One authority message, queued. */
interface Inbox {
  from: number;
  name: string;
  payload: string;
}

/** How full the queues are. */
export interface QueuedCounts {
  /** Rows frames waiting. */
  rows: number;
  /** `cmd` frames whose commands are waiting. */
  commandFrames: number;
  /** Messages waiting. */
  messages: number;
}

/** The client's inbound queues. Owned by `NetClient`. */
export class ClientQueues {
  readonly rows = new RowQueue();
  /** True from an overflow until the next welcome: nothing is queued meanwhile. */
  overflowed = false;

  private readonly commands: Command[] = [];
  private readonly inbox: Inbox[] = [];
  private commandFrames = 0;
  private readonly maxRows: number;
  private readonly maxCommandFrames = Math.ceil(ROOM_TICK_HZ * QUEUE_SECONDS);

  /**
   * @param sendHz Rows frames per second the room sends.
   * @param onOverflow Called once per overflow, after the queues were dropped.
   */
  constructor(
    sendHz: number,
    private readonly onOverflow: () => void,
  ) {
    this.maxRows = Math.ceil(sendHz * QUEUE_SECONDS);
  }

  /** @returns How many of each are waiting. */
  get counts(): QueuedCounts {
    return {
      rows: this.rows.length,
      commandFrames: this.commandFrames,
      messages: this.inbox.length,
    };
  }

  /**
   * A welcome: the world starts again at `frame`, so whatever was queued
   * belongs to the world it replaces, messages included.
   *
   * @param frame The welcome's frame.
   * @returns The command queue, for the welcome's world.
   */
  restart(frame: number): Command[] {
    this.drop();
    this.overflowed = false;
    this.rows.reset(frame);
    return this.commands;
  }

  /** @param commands One `cmd` frame's commands. */
  pushCommands(commands: readonly Command[]): void {
    if (this.overflowed) return;
    this.commandFrames += 1;
    for (const command of commands) this.commands.push(command);
    if (this.commandFrames > this.maxCommandFrames) this.overflow();
  }

  /** @param bytes One rows frame. */
  pushRows(bytes: Uint8Array): void {
    if (this.overflowed) return;
    this.rows.push(bytes);
    if (this.rows.length > this.maxRows) this.overflow();
  }

  /** @param message One authority message. */
  pushMessage(message: Inbox): void {
    if (this.overflowed) return;
    this.inbox.push(message);
    if (this.inbox.length > MAX_QUEUED_MESSAGES) this.overflow();
  }

  /** @param sink Where every queued command goes, in order, once. */
  drainCommands(sink: (command: Command) => void): void {
    const queue = this.commands;
    try {
      for (let i = 0; i < queue.length; i += 1) sink(queue[i]);
    } finally {
      queue.length = 0;
      this.commandFrames = 0;
    }
  }

  /** @param sink Where every queued rows frame is decoded. */
  drainRows(sink: FramedRowSink): void {
    this.rows.drain(sink);
  }

  /** @param sink Where every queued message goes, in order, once. */
  drainMessages(sink: NetMessageSink): void {
    const inbox = this.inbox;
    try {
      for (let i = 0; i < inbox.length; i += 1)
        sink(inbox[i].from, inbox[i].name, inbox[i].payload);
    } finally {
      inbox.length = 0;
    }
  }

  private drop(): void {
    this.commands.length = 0;
    this.commandFrames = 0;
    this.inbox.length = 0;
    this.rows.clear();
  }

  private overflow(): void {
    this.drop();
    this.overflowed = true;
    this.onOverflow();
  }
}
