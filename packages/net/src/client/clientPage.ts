/**
 * The client loop tests' page: a headless engine whose game module is the
 * client loop, joined over loopback to a test room. Not exported.
 */
import type { EngineModule } from '@gameable/core';
import { createHeadlessEngine, type HeadlessEngine } from '@gameable/core/headless';
import { createGameSlot, type Sandbox } from '@gameable/wasm-host';

import { createInputCodec } from '../protocol/InputCodec.js';
import { blankInput } from '../server/room/roomTesting.js';
import { createClientLoop, type ClientLoop, type ClientLoopOptions } from './ClientLoop.js';
import {
  testClientAdapter,
  type LoopbackRoomServer,
  type TestClientAdapter,
} from './clientTesting.js';
import { createLoopbackConnection } from './LoopbackConnection.js';
import { createNetClient, type NetClient } from './NetClient.js';

/** One client page: a headless engine with the client loop as its game module. */
export class TestPage {
  t = 0;
  readonly deaths: (Error | null)[] = [];

  /** The page's client loop, once attached. */
  loop: ClientLoop | null = null;

  private constructor(
    readonly engine: HeadlessEngine,
    readonly net: NetClient,
    readonly adapter: TestClientAdapter,
  ) {}

  /**
   * @param server The room to join.
   * @param sandbox The client guest, or null for a pure replica.
   * @param adapter Where the replica is applied.
   * @param extra More modules for the page's engine.
   * @param options More client loop options (`predict`).
   * @returns The page, joining (frames land on the next flush).
   */
  static async open(
    server: LoopbackRoomServer,
    sandbox: Sandbox | null = null,
    adapter: TestClientAdapter = testClientAdapter(),
    extra: EngineModule[] = [],
    options: Omit<ClientLoopOptions, 'onDead'> = {},
  ): Promise<TestPage> {
    const connection = createLoopbackConnection({
      connect: server.connect,
      backoff: { baseMs: 5 },
    });
    const net = createNetClient(connection, { name: 'Ana', maxPlayers: 4 });
    const slot = createGameSlot();
    const engine = await createHeadlessEngine({ modules: [...extra, slot.module], fixedHz: 60 });
    const page = new TestPage(engine, net, adapter);
    const loop = createClientLoop(engine, adapter, net, sandbox, {
      ...options,
      onDead: (error) => page.deaths.push(error),
    });
    page.loop = loop;
    await slot.attach(loop, engine.ctx);
    net.start();
    engine.step(0); // the baseline: no fixed step
    return page;
  }

  /**
   * One rendered frame.
   *
   * @param ms Wall-clock milliseconds since the last frame.
   */
  frame(ms = 1000 / 60): void {
    this.adapter.log.push('frame');
    this.t += ms;
    this.engine.step(this.t);
  }

  async close(): Promise<void> {
    this.net.leave('done');
    await this.engine.dispose();
  }
}

/**
 * @param server The room.
 * @param conn The connection id.
 * @returns The seq of every INPUT frame the room has had from the page's first connection.
 */
export function inputSeqs(server: LoopbackRoomServer, conn = 'c1'): number[] {
  const codec = createInputCodec();
  const into = blankInput();
  return (server.inbound.get(conn)?.inputs ?? []).map(
    (bytes) => codec.decode(bytes, into)?.seq ?? -1,
  );
}

/**
 * @param page The page.
 * @param name A spawn's debug name.
 * @returns How many spawns with that name the page's adapter applied.
 */
export function spawned(page: TestPage, name: string): number {
  return page.adapter.by('spawn').filter((c) => (c.args[5] as { name?: string }).name === name)
    .length;
}
