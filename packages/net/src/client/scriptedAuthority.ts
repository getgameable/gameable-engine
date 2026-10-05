/**
 * The prediction tests' scripted server: a second Jolt world that runs the
 * walker's body from the same moves, one step per input seq, and answers
 * with rows frames that carry only the player trailer, some steps late; and
 * a page on a `ScriptedNet` that predicts against it. Not exported.
 */
import type { EngineModule } from '@gameable/core';
import { createHeadlessEngine, type HeadlessEngine } from '@gameable/core/headless';
import {
  createPhysicsWorld,
  loadJolt,
  type PhysicsService,
  type PhysicsWorld,
} from '@gameable/physics-jolt';
import type { Command } from '@gameable/sdk';
import { createGameSlot, type Sandbox } from '@gameable/wasm-host';
import { createServerAdapter, type ServerAdapter } from '@gameable/wasm-host/server';

import { PlayerRowFlag, RowFlag } from '../protocol/constants.js';
import { encodeRows } from '../protocol/rowsFunctions.js';
import type { PlayerRowSource, RowSource } from '../protocol/types.js';
import { createClientLoop } from './ClientLoop.js';
import {
  bodyAdapter,
  fakeInput,
  pagePhysics,
  WALK,
  WALKER_BODY,
  WalkerStub,
} from './predictTesting.js';
import { ScriptedNet } from './scriptedNet.js';

/** The authority's entity for the page's player. */
export const ME = 40;

/** Where the authority had the body after one seq. */
export interface Truth {
  position: [number, number, number];
  velocity: [number, number, number];
  flags: number;
}

/** The scripted authority: the walker's body in its own world. */
export class TruthServer {
  /** By seq. */
  readonly truths = new Map<number, Truth>();
  private readonly forward: ServerAdapter;
  private readonly pose = new Float32Array(7);
  private readonly rows = new Float32Array(15 * 4);
  private teleportNext = false;

  private constructor(readonly world: PhysicsWorld) {
    this.forward = createServerAdapter(world as PhysicsService, { warn: () => undefined });
    this.forward.addBody(WALKER_BODY(1, 1));
  }

  /** @returns A server whose body starts where the walker's does. */
  static async create(): Promise<TruthServer> {
    return new TruthServer(createPhysicsWorld(await loadJolt(), { maxBodies: 16 }));
  }

  /**
   * One step of one seq.
   *
   * @param seq The page's input seq.
   * @param walking W held in it.
   */
  step(seq: number, walking: boolean): void {
    this.forward.moveCharacter(1, { x: 0, y: 0, z: walking ? -WALK : 0 }, false, false, 45);
    this.world.step(1 / 60);
    this.world.readBodies(this.rows);
    const r = this.rows;
    const flags =
      (r[14] === 1 ? PlayerRowFlag.GROUNDED : 0) | (this.teleportNext ? PlayerRowFlag.TELEPORT : 0);
    this.teleportNext = false;
    this.truths.set(seq, { position: [r[1], r[2], r[3]], velocity: [r[8], r[9], r[10]], flags });
  }

  /**
   * Move the body by hand, as a server-side push or a respawn would.
   *
   * @param dx Metres along x.
   * @param teleport Say so in the next trailer.
   */
  shift(dx: number, teleport = false): void {
    this.world.readBodyPose(1, this.pose, 0);
    const p = this.pose;
    this.world.setTransform(1, [p[0] + dx, p[1], p[2]], [p[3], p[4], p[5], p[6]], false);
    this.teleportNext = teleport;
  }

  /**
   * @param frame The rows frame's authority frame.
   * @param seq The seq the trailer answers.
   * @param truth What it says (default: the truth at that seq).
   * @returns A rows frame whose only content is the trailer (and the entity's TELEPORT row when it says so).
   */
  frame(frame: number, seq: number, truth = this.truths.get(seq) as Truth): Uint8Array {
    const player: PlayerRowSource = { entity: ME, ...truth };
    const teleport = (truth.flags & PlayerRowFlag.TELEPORT) !== 0;
    const source: RowSource = {
      count: teleport ? 1 : 0,
      entity: () => ME,
      flags: () => RowFlag.POSITION | RowFlag.ROTATION | RowFlag.TELEPORT,
      position: () => truth.position,
      rotation: () => [0, 0, 0, 1],
      scale: () => [1, 1, 1],
      player,
    };
    const out = new DataView(new ArrayBuffer(128));
    return new Uint8Array(out.buffer.slice(0, encodeRows(out, frame, seq, source)));
  }

  dispose(): void {
    this.world.dispose();
  }
}

/** The player's spawn, as the welcome sends it. */
const SPAWN_ME: Command = {
  tag: 'spawn',
  val: {
    entity: ME,
    asset: undefined,
    position: { x: 0, y: 1, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
  },
};

/** A predicting page on a scripted room. */
export class PredictPage {
  /** Fixed steps run (step k sent seq k). */
  steps = 0;
  private t = 0;

  private constructor(
    readonly engine: HeadlessEngine,
    readonly net: ScriptedNet,
    readonly adapter: ReturnType<typeof bodyAdapter>,
    readonly input: ReturnType<typeof fakeInput>,
  ) {}

  /**
   * @param guest The client guest; the walker stand-in by default.
   * @param extra More page modules.
   * @returns The page, welcomed as player 0 controlling {@link ME}.
   */
  static async open(
    guest: Sandbox = new WalkerStub(),
    extra: EngineModule[] = [],
  ): Promise<PredictPage> {
    const input = fakeInput();
    const slot = createGameSlot();
    const engine = await createHeadlessEngine({
      modules: [input, pagePhysics(), ...extra, slot.module],
      fixedHz: 60,
    });
    const adapter = bodyAdapter(() => engine.get('physics'));
    const net = new ScriptedNet();
    await slot.attach(createClientLoop(engine, adapter, net, guest, { predict: true }), engine.ctx);
    engine.step(0);
    const page = new PredictPage(engine, net, adapter, input);
    page.welcome();
    return page;
  }

  /** A (new) welcome: player 0, controlling {@link ME}. */
  welcome(): void {
    this.net.welcome(0, [SPAWN_ME]);
    this.net.localEntity = ME;
    this.steps = 0;
  }

  /** One fixed step. */
  frame(): void {
    this.t += 1000 / 60;
    this.engine.step(this.t);
    this.steps += 1;
  }

  /**
   * @param back Steps ago (0: this step).
   * @returns The position the page last drew {@link ME} at, as of that step.
   */
  drawn(back = 0): number[] {
    const begins = this.adapter.log.filter((l) => l === 'begin').length - back;
    const rows = this.adapter.rows.filter(
      (r) => r.entity === ME && r.step <= begins && (r.flags & RowFlag.POSITION) !== 0,
    );
    return rows.at(-1)?.position ?? [Number.NaN, Number.NaN, Number.NaN];
  }

  async close(): Promise<void> {
    await this.engine.dispose();
  }
}
