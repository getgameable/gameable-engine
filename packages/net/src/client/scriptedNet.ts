/**
 * Test doubles for the client loop's inputs: a `NetService` the test fills
 * by hand, and a `RoomConnection` whose server side the test speaks for.
 * Not exported from the package.
 */
import type { Command } from '@gameable/sdk';

import { encodeRows } from '../protocol/rowsFunctions.js';
import type { PlayerSummary, RowSource } from '../protocol/types.js';
import type {
  FramedRowSink,
  NetMessageSink,
  NetService,
  NetState,
  NetStats,
} from './NetService.js';
import type {
  ConnectionState,
  JoinRequest,
  RoomConnection,
  RoomConnectionEvents,
} from './RoomConnection.js';
import { RowQueue } from './RowQueue.js';
import { emptyNetStats } from './netStats.js';

/** One test row: an entity at a position. */
export interface TestRow {
  entity: number;
  flags: number;
  position: [number, number, number];
}

/**
 * @param frame The rows frame's authority frame.
 * @param rows Its rows.
 * @returns The encoded frame.
 */
export function rowsFrame(frame: number, rows: readonly TestRow[]): Uint8Array {
  const source: RowSource = {
    count: rows.length,
    entity: (i) => rows[i].entity,
    flags: (i) => rows[i].flags,
    position: (i) => rows[i].position,
    rotation: () => [0, 0, 0, 1],
    scale: () => [1, 1, 1],
  };
  const out = new DataView(new ArrayBuffer(64 + rows.length * 40));
  const bytes = encodeRows(out, frame, 0, source);
  return new Uint8Array(out.buffer.slice(0, bytes));
}

/** A `net` service whose frames the test queues itself. */
export class ScriptedNet implements NetService {
  state: NetState = 'connecting';
  room: string | null = null;
  closeReason = '';
  lastWarning = '';
  localPlayer = -1;
  localEntity = 0;
  players: readonly PlayerSummary[] = [];
  rtt = 0;
  ack = 0;
  frame = 0;
  welcomes = 0;
  maxPlayers = 4;
  sendHz = 20;
  readonly stats: NetStats = emptyNetStats();
  /** How many times `start` was called. */
  starts = 0;
  /** What the loop sent up. */
  readonly sent: { name: string; json: string }[] = [];
  /** The seq of every INPUT the loop sent. */
  readonly inputs: number[] = [];
  private commands: Command[] = [];
  private messages: { from: number; name: string; payload: string }[] = [];
  private readonly rows = new RowQueue();

  /**
   * A welcome: the world starts again with `commands`.
   *
   * @param player This page's seat.
   * @param commands The welcome's world, as commands.
   */
  welcome(player: number, commands: Command[] = []): void {
    this.localPlayer = player;
    this.state = 'joined';
    this.welcomes += 1;
    this.commands = [...commands];
    this.messages = [];
  }

  /** @param commands Commands of one `cmd` frame. */
  cmd(...commands: Command[]): void {
    this.commands.push(...commands);
  }

  /**
   * @param from The sender.
   * @param name The message name.
   * @param payload Its JSON.
   */
  msg(from: number, name: string, payload: string): void {
    this.messages.push({ from, name, payload });
  }

  /**
   * @param frame The authority frame.
   * @param rows The rows.
   */
  pushRows(frame: number, rows: readonly TestRow[]): void {
    this.rows.push(rowsFrame(frame, rows));
  }

  /** @param bytes One encoded rows frame, queued as received. */
  pushFrame(bytes: Uint8Array): void {
    this.rows.push(bytes);
  }

  send(name: string, payload: unknown): boolean {
    return this.sendJson(name, JSON.stringify(payload));
  }
  sendJson(name: string, json: string): boolean {
    this.sent.push({ name, json });
    return true;
  }
  sendInput(seq: number): boolean {
    if (this.state !== 'joined') return false;
    this.inputs.push(seq);
    return true;
  }
  ping(): void {}
  start(): void {
    this.starts += 1;
  }
  onChange(): () => void {
    return () => undefined;
  }
  drainCommands(sink: (command: Command) => void): void {
    const queue = this.commands;
    this.commands = [];
    for (const command of queue) sink(command);
  }
  drainRows(sink: FramedRowSink): void {
    this.rows.drain(sink);
  }
  drainMessages(sink: NetMessageSink): void {
    const queue = this.messages;
    this.messages = [];
    for (const m of queue) sink(m.from, m.name, m.payload);
  }
  leave(): void {
    this.state = 'closed';
  }
}

/** A connection whose server side the test speaks for. */
export class FakeConnection implements RoomConnection {
  state: ConnectionState = 'idle';
  room: string | null = null;
  events: RoomConnectionEvents | null = null;
  readonly texts: string[] = [];
  /** Copies of every INPUT frame sent. */
  readonly inputs: Uint8Array[] = [];
  /** The reason of every `reconnect` asked for. */
  readonly reconnects: string[] = [];

  join(_request: JoinRequest, events: RoomConnectionEvents): void {
    this.events = events;
    this.state = 'connecting';
  }
  sendInput(bytes: Uint8Array): void {
    this.inputs.push(bytes.slice());
  }
  sendText(text: string): void {
    this.texts.push(text);
  }
  reconnect(reason: string): void {
    this.reconnects.push(reason);
    this.state = 'reconnecting';
    this.events?.onState('reconnecting', reason);
  }
  leave(): void {
    this.state = 'closed';
  }

  /** @param frame A server text frame, as an object, delivered as JSON text. */
  text(frame: object): void {
    this.events?.onText(JSON.stringify(frame));
  }

  /** @param bytes A binary frame. */
  rows(bytes: Uint8Array): void {
    this.events?.onRows(bytes);
  }
}
