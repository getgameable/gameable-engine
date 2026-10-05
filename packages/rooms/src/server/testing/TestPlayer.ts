/**
 * `TestPlayer` — one player over `@colyseus/sdk`, for tests: join, our INPUT
 * and text frames out through `room.sendBytes`, our frames in through
 * {@link TestSerializer} into a {@link TestReplica}.
 */
import {
  encodeInput,
  INPUT_FRAME_BYTES,
  type MutableInputSnapshot,
  PROTOCOL_VERSION,
} from '@gameable/net';
import { KEY_WORDS, keyIndex, writeKeyBit } from '@gameable/sdk/keycodes';
import { Client, type Room } from '@colyseus/sdk';

import { IDENTITY_TYPE, INPUT_TYPE, TEXT_TYPE } from '../../channels.js';
import { TestReplica } from './TestReplica.js';
import { TestSerializer } from './TestSerializer.js';

/**
 * One connected test player. Every join sends `v: PROTOCOL_VERSION`, and a
 * join that names its room (`create`, `join`, `joinOrCreate`) also sends
 * `game`, as `ColyseusConnection` does; `joinById` names no room, so its
 * options carry `game` themselves. A test's own options win over both.
 */
export class TestPlayer {
  readonly replica = new TestReplica();
  /** The close code of the last leave, once the room has closed on us. */
  leftWith: number | null = null;
  /** Every device token the room handed this player (`IDENTITY_TYPE`), in order. */
  readonly identityTokens: string[] = [];
  private seq = 0;
  private readonly out = new DataView(new ArrayBuffer(INPUT_FRAME_BYTES));
  private readonly encoder = new TextEncoder();
  private readonly held = new Set<string>();
  private readonly snapshot: MutableInputSnapshot = {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
    focused: true,
  };

  private constructor(
    private readonly sdk: Client,
    public room: Room,
  ) {
    this.bind(room);
  }

  /**
   * @param endpoint `ws://host:port`.
   * @param name The room name.
   * @param options Join options (`name`).
   * @param headers HTTP and upgrade headers (`origin`), for a server that checks them.
   * @returns A joined player.
   */
  static async joinOrCreate(
    endpoint: string,
    name: string,
    options: object,
    headers?: Record<string, string>,
  ): Promise<TestPlayer> {
    const sdk = new Client(endpoint, { headers });
    return new TestPlayer(
      sdk,
      await sdk.joinOrCreate(name, { v: PROTOCOL_VERSION, game: name, ...options }),
    );
  }

  /**
   * @param endpoint `ws://host:port`.
   * @param name The room name.
   * @param options Join options (`name`).
   * @param headers HTTP and upgrade headers (`origin`).
   * @returns A player in a room it just created.
   */
  static async create(
    endpoint: string,
    name: string,
    options: object,
    headers?: Record<string, string>,
  ): Promise<TestPlayer> {
    const sdk = new Client(endpoint, { headers });
    return new TestPlayer(
      sdk,
      await sdk.create(name, { v: PROTOCOL_VERSION, game: name, ...options }),
    );
  }

  /**
   * @param endpoint `ws://host:port`.
   * @param roomId A room id.
   * @param options Join options: `game` names the room's game, as a page does.
   * @param headers HTTP and upgrade headers (`origin`).
   * @returns A player in that room.
   */
  static async joinById(
    endpoint: string,
    roomId: string,
    options: object,
    headers?: Record<string, string>,
  ): Promise<TestPlayer> {
    const sdk = new Client(endpoint, { headers });
    return new TestPlayer(sdk, await sdk.joinById(roomId, { v: PROTOCOL_VERSION, ...options }));
  }

  /**
   * @param endpoint `ws://host:port`.
   * @param name The room name.
   * @param options Join options, `code` among them.
   * @param headers HTTP and upgrade headers (`origin`).
   * @returns A player in the room the matchmaker found for those options.
   */
  static async join(
    endpoint: string,
    name: string,
    options: object,
    headers?: Record<string, string>,
  ): Promise<TestPlayer> {
    const sdk = new Client(endpoint, { headers });
    return new TestPlayer(
      sdk,
      await sdk.join(name, { v: PROTOCOL_VERSION, game: name, ...options }),
    );
  }

  /** @returns The seq of the last INPUT frame sent. */
  get sentSeq(): number {
    return this.seq;
  }

  /** @param token `room.reconnectionToken` from before the drop. */
  async reconnect(token: string): Promise<void> {
    this.room = await this.sdk.reconnect(token);
    this.seq = 0; // the held seat let go of its input; the count starts over
    this.leftWith = null;
    this.bind(this.room);
  }

  /** @param keys DOM codes held from now on (`KeyW`...). */
  hold(keys: readonly string[]): void {
    const next = new Set(keys);
    for (const key of new Set([...this.held, ...next])) {
      const index = keyIndex(key);
      const was = this.held.has(key);
      const now = next.has(key);
      writeKeyBit(this.snapshot.down, index, now);
      if (now && !was) writeKeyBit(this.snapshot.pressed, index, true);
      if (was && !now) writeKeyBit(this.snapshot.released, index, true);
    }
    this.held.clear();
    for (const key of next) this.held.add(key);
  }

  /** Send one INPUT frame and clear the edges. */
  sendInput(): void {
    this.seq += 1;
    const bytes = encodeInput(this.out, this.seq, this.snapshot);
    this.room.sendBytes(INPUT_TYPE, new Uint8Array(this.out.buffer.slice(0, bytes)));
    this.snapshot.pressed.fill(0);
    this.snapshot.released.fill(0);
  }

  /** @param text A client text frame, sent as is (it may be one the server refuses). */
  sendText(text: string): void {
    this.room.sendBytes(TEXT_TYPE, this.encoder.encode(text));
  }

  /**
   * @param bytes A raw Colyseus frame (its protocol byte first), sent past the SDK's own API.
   */
  sendRaw(bytes: Uint8Array): void {
    this.room.connection.send(bytes);
  }

  /** Leave for good (consented). */
  async leave(): Promise<void> {
    if (this.leftWith === null) await this.room.leave(true);
  }

  private bind(room: Room): void {
    room.reconnection.enabled = false;
    room.onLeave((code) => {
      this.leftWith = code;
    });
    room.onMessage(IDENTITY_TYPE, (token: unknown) => {
      if (typeof token === 'string') this.identityTokens.push(token);
    });
    const serializer: unknown = room.serializer;
    if (!(serializer instanceof TestSerializer))
      throw new Error('room is not using our serializer');
    serializer.attach(this.replica);
  }
}
