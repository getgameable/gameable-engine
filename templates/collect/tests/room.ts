/**
 * The test room: the game, driven headlessly as a room's authority through
 * `simulatePlayers`, with the room's real data path behind it: `RoomData` on
 * a `MemoryStore`, the same pair a room server without `GAMEABLE_PG_URL` runs.
 *
 * A join loads the player's document from the store first, as a room does,
 * and hands it over in `player-joined`. Every `save-player-data` and
 * `exchange` the guest emits goes to `RoomData`; its `exchange-result` comes
 * back on a later step. `settle()` waits for the store's promises.
 *
 * No browser, no room server, no Jolt. A body stands where its row in
 * `frame-input.bodies` says, so a test moves one with `place`.
 */
import { memoryStore, RoomData, type MemoryStore } from 'gameable/net/server';
import {
  BODY_STRIDE,
  createGuest,
  defineGame,
  type Command,
  type FrameOutput,
  type GameEvent,
  type HostFrameInput,
} from 'gameable';
import {
  createGameConfig,
  createMockHost,
  createPlayersInput,
  simulatePlayers,
  type PlayersInput,
  type PlayersScript,
  type SimulatePlayersResult,
} from 'gameable/test';

import game from '../src/game';
import type { CollectDoc } from '../src/pets';

/** The store's name for this game. */
export const GAME = 'collect';
const AUTHORITY = '{"net":{"role":"authority","maxPlayers":8}}';
const ASSETS = ['env.arena', 'char.collector', 'sfx.coin', 'sfx.hatch'];
const DT = 1 / 60;

/** One `run`: what `simulatePlayers` reports, and a copy of every step's commands. */
export interface RoomRun extends SimulatePlayersResult {
  /** `commands[frame]`, copied: a guest reuses its output and its command objects. */
  commands: Command[][];
}

/** A booted room and what a test reads and does. */
export interface TestRoom {
  /** The seats. */
  tape: PlayersInput;
  /** The room's store. */
  store: MemoryStore;
  /** Load `key`'s document from the store and seat them, as a room's join does. */
  join(seat: number, key: string): Promise<void>;
  /** Free a seat, run the step, and wait for the leaver's document to be written. */
  leave(seat: number): Promise<void>;
  /** Run `frames` steps (the clock carries on from the last call). */
  run(frames: number, script?: PlayersScript): RoomRun;
  /** Wait for the store: saves written, exchange results queued for the next step. */
  settle(): Promise<void>;
  /** Stand an entity at `x, z`; its body row says so from the next step on. */
  place(entity: number, x: number, z: number): void;
  /** @returns What the store holds for `key`, parsed, or null. */
  stored(key: string): Promise<CollectDoc | null>;
}

/**
 * Boot the game as a room's authority over a memory store.
 *
 * @param rules Rules to override, such as a short hatch for a test.
 * @param seed The run seed.
 * @returns The room.
 */
export function bootRoom(rules: Record<string, unknown> = {}, seed = 0x5eed): TestRoom {
  const definition = defineGame({ ...game, rules: { ...game.rules, ...rules } });
  const host = createMockHost({ seed, nowMs: () => 0, assets: ASSETS });
  const guest = createGuest(host, definition);
  guest.init(createGameConfig({ seed: BigInt(seed), fixedHz: 60, options: AUTHORITY }));
  const store = memoryStore();
  const arrived: GameEvent[] = [];
  const data = new RoomData({
    store,
    game: GAME,
    throttleMs: 0,
    push: (event) => arrived.push(event),
    log: () => undefined,
  });
  const tape = createPlayersInput(16);
  const rows = new Map<number, { body: number; x: number; y: number; z: number }>();
  const buffer = new Float32Array(64 * BODY_STRIDE);
  let frame = 0;
  let log: Command[][] = [];
  const pack = (): Float32Array => {
    const sorted = [...rows.values()].sort((a, b) => a.body - b.body);
    sorted.forEach((r, i) => {
      buffer.fill(0, i * BODY_STRIDE, (i + 1) * BODY_STRIDE);
      buffer.set([r.body, r.x, r.y, r.z, 0, 0, 0, 1], i * BODY_STRIDE);
      buffer[i * BODY_STRIDE + 14] = 1; // grounded
    });
    return buffer.subarray(0, sorted.length * BODY_STRIDE);
  };
  const route = (out: FrameOutput): void => {
    for (const c of out.commands) {
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
      log.push(structuredClone(out.commands) as Command[]);
      return out;
    },
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const room: TestRoom = {
    tape,
    store,
    async join(seat, key) {
      const envelope = await data.join(seat, key);
      tape.join(seat, key, envelope ?? undefined);
    },
    async leave(seat) {
      tape.leave(seat);
      room.run(1);
      await data.leave(seat);
    },
    run(frames, script) {
      log = [];
      for (const event of arrived.splice(0)) tape.push(event);
      const result = simulatePlayers(tickable, { frames, players: tape, script });
      return { ...result, commands: log };
    },
    settle,
    place(entity, x, z) {
      const row = rows.get(entity);
      if (row) Object.assign(row, { x, z });
    },
    async stored(key) {
      await settle();
      const doc = await store.load(GAME, key);
      return doc === null ? null : (JSON.parse(doc.data) as CollectDoc);
    },
  };
  return room;
}

/**
 * @param result A run.
 * @param name A message name.
 * @returns Every `send` with that name, with its `to` and parsed payload.
 */
export function sends(
  result: RoomRun,
  name: string,
): { to: number | undefined; payload: unknown }[] {
  const out: { to: number | undefined; payload: unknown }[] = [];
  for (const commands of result.commands) {
    for (const c of commands) {
      if (c.tag !== 'send' || c.val.name !== name) continue;
      out.push({ to: c.val.to ?? undefined, payload: JSON.parse(c.val.payload) });
    }
  }
  return out;
}
