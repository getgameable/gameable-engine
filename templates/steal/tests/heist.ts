/**
 * The test heist: the game, driven headlessly as a room's authority through
 * `simulatePlayers`, with a real `RoomData` over a memory store between the
 * guest and its documents, the way a room has one.
 *
 * No browser, no room server, no Jolt. A join loads the player's document
 * from the store (`join` is async, as a room's is); the guest's saves and
 * exchanges go to the `RoomData`, and its exchange results come back on the
 * tape. A body stands where its row in `frame-input.bodies` says, so a test
 * moves a thief with `place`.
 */
import { memoryStore, RoomData, type PlayerStore } from 'gameable/net/server';
import {
  BODY_STRIDE,
  createGuest,
  defineGame,
  type Command,
  type FrameOutput,
  type GameContext,
  type HostFrameInput,
} from 'gameable';
import {
  createGameConfig,
  createMockHost,
  createPlayersInput,
  simulatePlayers,
  type PlayersInput,
  type PlayersScript,
} from 'gameable/test';

import game from '../src/game';
import { readWallet, type Wallet } from '../src/wallet';

/** `game-config.options` for a six-seat room's authority. */
const AUTHORITY = '{"net":{"role":"authority","maxPlayers":6}}';
const ASSETS = ['env.arena', 'char.thief', 'sfx.grab', 'sfx.steal'];
const DT = 1 / 60;
/** The store's name for this game. */
export const GAME = 'steal';

/** A booted heist and what a test reads and does. */
export interface TestHeist {
  /** The seats. Join and leave through the heist, so the store hears about it; message on it. */
  tape: PlayersInput;
  store: PlayerStore;
  /** Every store refusal or failure the room logged. */
  logs: string[];
  /** Every command the guest sent, copied, across every run. */
  commands: Command[];
  /** Load `key`'s document and seat them at `seat` from the next step. */
  join(seat: number, key: string): Promise<void>;
  /** Free the seat on the next step and flush its document, as a room does. */
  leave(seat: number): Promise<void>;
  /** Run `frames` steps (the clock carries on from the last call). */
  run(frames: number, script?: PlayersScript): void;
  /** Let the store's promises settle; exchange results land on the next step. */
  settle(): Promise<void>;
  /** Stand a seat's thief at `x, z`; its body row says so from the next step on. */
  place(seat: number, x: number, z: number): void;
  /** @returns The seat's wallet as the authority holds it. */
  wallet(seat: number): Wallet;
  /** @returns `key`'s wallet as the store holds it. */
  stored(key: string): Promise<Wallet | null>;
}

/** Let every settled promise run its callbacks. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/**
 * Boot the game as a room's authority over a store.
 *
 * @param options Rules to override, the store, and the server's clock.
 * @param options.rules Rules to override, such as a short belt for a test.
 * @param options.store The store; a fresh memory store by default.
 * @param options.now The server's clock the room stamps on joins; `Date.now` by default.
 * @returns The heist.
 */
export function bootHeist(
  options: { rules?: Record<string, unknown>; store?: PlayerStore; now?: () => number } = {},
): TestHeist {
  const store = options.store ?? memoryStore();
  const logs: string[] = [];
  const tape = createPlayersInput(16);
  const data = new RoomData({
    store,
    game: GAME,
    now: options.now,
    push: (event) => {
      tape.push(event);
    },
    log: (line) => logs.push(line),
  });
  // One more system, last, keeps the context so a test can read the wallets.
  let last: GameContext | null = null;
  const definition = defineGame({
    ...game,
    rules: { ...game.rules, ...options.rules },
    systems: [...(game.systems ?? []), { run: (ctx) => void (last = ctx), on: 'authority' }],
  });
  const host = createMockHost({ seed: 0x5eed, nowMs: () => 0, assets: ASSETS });
  const guest = createGuest(host, definition);
  guest.init(createGameConfig({ seed: BigInt(0x5eed), fixedHz: 60, options: AUTHORITY }));
  /** Body rows the fake physics reports, by entity. */
  const rows = new Map<number, { body: number; x: number; y: number; z: number }>();
  const buffer = new Float32Array(64 * BODY_STRIDE);
  const commands: Command[] = [];
  let frame = 0;
  const pack = (): Float32Array => {
    const sorted = [...rows.values()].sort((a, b) => a.body - b.body);
    sorted.forEach((r, i) => {
      buffer.fill(0, i * BODY_STRIDE, (i + 1) * BODY_STRIDE);
      buffer.set([r.body, r.x, r.y, r.z, 0, 0, 0, 1], i * BODY_STRIDE);
      buffer[i * BODY_STRIDE + 14] = 1; // grounded
    });
    return buffer.subarray(0, sorted.length * BODY_STRIDE);
  };
  // What a room's adapter does with the guest's output: bodies, saves, exchanges.
  const route = (out: FrameOutput): void => {
    for (const c of out.commands) {
      commands.push(structuredClone(c));
      if (c.tag === 'despawn') rows.delete(c.val);
      else if (c.tag === 'save-player-data') data.savePlayer(c.val.player, c.val.data);
      else if (c.tag === 'exchange') data.exchange(c.val);
      else if (c.tag === 'add-body' && c.val.kind === 'character') {
        const { body, entity, position } = c.val;
        rows.set(entity, { body, x: position.x, y: position.y, z: position.z });
      }
    }
  };
  const tickable = {
    tick(input: HostFrameInput): FrameOutput {
      const out = guest.tick({
        ...input,
        frame: BigInt(frame),
        elapsed: frame * DT,
        bodies: pack(),
      });
      frame += 1;
      route(out);
      return out;
    },
  };
  const heist: TestHeist = {
    tape,
    store,
    logs,
    commands,
    async join(seat, key) {
      const envelope = await data.join(seat, key);
      tape.join(seat, key, envelope);
    },
    async leave(seat) {
      tape.leave(seat);
      heist.run(1);
      await data.leave(seat);
    },
    run(frames, script) {
      simulatePlayers(tickable, { frames, players: tape, script });
    },
    settle: flush,
    place(seat, x, z) {
      const row = rows.get(tape.entityOf(seat));
      if (row) Object.assign(row, { x, z });
    },
    wallet(seat) {
      return readWallet(last?.players.get(seat)?.data ?? null);
    },
    async stored(key) {
      const doc = await store.load(GAME, key);
      return doc === null ? null : readWallet(JSON.parse(doc.data));
    },
  };
  return heist;
}
