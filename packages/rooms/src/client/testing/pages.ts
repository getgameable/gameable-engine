/**
 * Pages for the client tests: a `multiplayer()` page over an explicit
 * `ColyseusConnection`, what a page has applied, and an input with W held.
 * Not exported.
 */
import { encodeInput, INPUT_FRAME_BYTES, type MutableInputSnapshot } from '@gameable/net';
import type { FramedRowSink } from '@gameable/net/client';
import type { Command } from '@gameable/sdk';
import { KEY_WORDS, keyIndex, writeKeyBit } from '@gameable/sdk/keycodes';

import {
  type ColyseusConnection,
  type ColyseusConnectionOptions,
  createColyseusConnection,
} from '../ColyseusConnection.js';
import {
  MemoryStorage,
  openPage,
  type TestPage,
  waitFor,
  type WasmRooms,
} from './wasmRoomServer.js';

/** A page and the connection under it. */
export interface LinkedPage extends TestPage {
  readonly link: ColyseusConnection;
}

/** Every page a test file opened, to dispose after each test. */
export const opened: TestPage[] = [];

/**
 * @param rooms The server.
 * @param connection Options for the connection (`url`, `game`, the origin header and a fresh storage are filled in).
 * @param name The player's name.
 * @param room The room code to join.
 * @returns A started page over an explicit `ColyseusConnection`.
 */
export async function linkedPage(
  rooms: WasmRooms,
  connection: Partial<ColyseusConnectionOptions>,
  name: string,
  room?: string,
): Promise<LinkedPage> {
  const link = createColyseusConnection({
    url: rooms.url,
    game: 'tiny',
    headers: { origin: 'http://game.test' },
    storage: new MemoryStorage(),
    ...connection,
  });
  const page = await openPage(rooms, {
    connection: link,
    name,
    ...(room === undefined ? {} : { room }),
  });
  opened.push(page);
  return { ...page, link };
}

/** Dispose every opened page (consented leaves), so the rooms go. */
export function closePages(): void {
  for (const page of opened.splice(0)) page.module.dispose();
}

/**
 * @param page A page that must reach `joined`.
 * @returns Once it has.
 */
export const joined = (page: TestPage): Promise<void> =>
  waitFor(() => page.net.state === 'joined', 'the welcome');

/**
 * @param page A joined page.
 * @returns Its SDK room.
 */
export function sdkRoomOf(page: LinkedPage): NonNullable<ColyseusConnection['colyseusRoom']> {
  const room = page.link.colyseusRoom;
  if (room === null) throw new Error('no room');
  return room;
}

/** What one page has applied: the entities it was told to spawn, and the entities it got rows for. */
export class Applied {
  readonly spawned = new Set<number>();
  readonly rowsFor = new Set<number>();
  private readonly sink: FramedRowSink = {
    position: new Float32Array(3),
    rotation: new Float32Array(4),
    scale: new Float32Array(3),
    row: (entity) => this.rowsFor.add(entity),
  };

  /** @param page Drain its queues, as a fixed step does. */
  drain(page: TestPage): void {
    page.net.drainCommands((command: Command) => {
      if (command.tag === 'spawn') this.spawned.add(command.val.entity);
    });
    page.net.drainRows(this.sink);
  }
}

/** @returns An input snapshot with W held. */
export function holdingW(): MutableInputSnapshot {
  const snapshot: MutableInputSnapshot = {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
    focused: true,
  };
  writeKeyBit(snapshot.down, keyIndex('KeyW'), true);
  return snapshot;
}

/**
 * @param seq The frame's seq.
 * @returns One INPUT frame's bytes, W held.
 */
export function inputFrame(seq: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(INPUT_FRAME_BYTES));
  const length = encodeInput(view, seq, holdingW());
  return new Uint8Array(view.buffer, 0, length);
}
