/**
 * The test camp: the game, driven headlessly as a room's authority through
 * `simulatePlayers`.
 *
 * No browser, no room server, no Jolt. The guest runs the systems the
 * authority runs; a players tape seats people and sends their messages. A
 * body stands where its row in `frame-input.bodies` says, so a test moves
 * one with `place` (the authority's physics would, from `move-character`).
 * The guest is wrapped so that the clock keeps running across several
 * `run` calls: each step gets the next frame number and its elapsed time.
 */
import {
  BODY_STRIDE,
  createGuest,
  defineGame,
  RigidBody,
  type Command,
  type FrameOutput,
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

/** `game-config.options` for a six-seat room's authority. */
const AUTHORITY = '{"net":{"role":"authority","maxPlayers":6}}';
const ASSETS = ['env.arena', 'char.survivor', 'char.creature', 'sfx.chop', 'sfx.hit'];
const DT = 1 / 60;

/** One `run`: what `simulatePlayers` reports, and a copy of every step's commands. */
export interface CampRun extends SimulatePlayersResult {
  /** `commands[frame]`, copied: a guest reuses its output and its command objects. */
  commands: Command[][];
}

/** A booted camp and what a test reads and does. */
export interface TestCamp {
  /** The seats: join, leave and message on it. */
  tape: PlayersInput;
  /** Run `frames` steps (the clock carries on from the last call). */
  run(frames: number, script?: PlayersScript): CampRun;
  /** Stand an entity at `x, z`; its body row says so from the next step on. */
  place(entity: number, x: number, z: number): void;
  /** @returns Where an entity's body stands now. */
  where(entity: number): { x: number; z: number };
}

/**
 * Boot the game as a room's authority.
 *
 * @param rules Rules to override, such as a short day for a test.
 * @param seed The run seed.
 * @returns The camp.
 */
export function bootCamp(rules: Record<string, unknown> = {}, seed = 0x5eed): TestCamp {
  const definition = defineGame({ ...game, rules: { ...game.rules, ...rules } });
  const host = createMockHost({ seed, nowMs: () => 0, assets: ASSETS });
  const guest = createGuest(host, definition);
  guest.init(createGameConfig({ seed: BigInt(seed), fixedHz: 60, options: AUTHORITY }));
  /** Body rows the fake physics reports, by entity. */
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
  const track = (out: FrameOutput): void => {
    for (const c of out.commands) {
      if (c.tag === 'despawn') rows.delete(c.val);
      if (c.tag !== 'add-body' || c.val.kind !== 'character') continue;
      const { body, entity, position } = c.val;
      rows.set(entity, { body, x: position.x, y: position.y, z: position.z });
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
      track(out);
      log.push(structuredClone(out.commands) as Command[]);
      return out;
    },
  };
  const tape = createPlayersInput(16);
  return {
    tape,
    run(frames, script) {
      log = [];
      const result = simulatePlayers(tickable, { frames, players: tape, script });
      return { ...result, commands: log };
    },
    place(entity, x, z) {
      const row = rows.get(entity);
      if (row) Object.assign(row, { x, z });
    },
    where(entity) {
      const row = rows.get(entity);
      return { x: row?.x ?? NaN, z: row?.z ?? NaN };
    },
  };
}

/**
 * @param result A run.
 * @param name A message name.
 * @returns Every `send` with that name, with its `to` and parsed payload.
 */
export function sends(
  result: CampRun,
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

/**
 * @param result A run.
 * @param entity A creature.
 * @returns The last velocity the authority asked its body for.
 */
export function lastMove(result: CampRun, entity: number): { x: number; z: number } | undefined {
  const body = RigidBody.handle[entity];
  let last: { x: number; z: number } | undefined;
  for (const commands of result.commands) {
    for (const c of commands) {
      if (c.tag !== 'move-character' || c.val.body !== body) continue;
      last = { x: c.val.desiredVelocity.x, z: c.val.desiredVelocity.z };
    }
  }
  return last;
}
