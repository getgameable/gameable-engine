/**
 * The test room: the round, driven headlessly as the room's authority.
 *
 * No browser, no room server, no Jolt: `createGuest` runs the same systems the
 * authority runs, and a `createPlayersInput` tape turns each step's
 * `player-joined` / `player-left` events into the room's `players` lane and
 * follows `set-player-entity` to each player's entity. A player is
 * moved the way the authority's physics moves one: by the body row the host
 * writes into `frame-input.bodies`, which the guest copies into `Transform`.
 * (`markMoved` only works inside a tick, so a test cannot call it between
 * steps.) The mock host answers `overlapSphere` from those `Transform` lanes.
 */
import {
  BODY_STRIDE,
  createGuest,
  Transform,
  type Command,
  type FrameOutput,
  type GameEvent,
  type Guest,
  type OverlapHit,
} from 'gameable';
import {
  createFrameInput,
  createGameConfig,
  createMockHost,
  createPlayersInput,
  type MockHost,
  type MutableInputState,
} from 'gameable/test';

import game from '../src/game';

/**
 * The rules these tests were written for, the values `src/game.ts` ships with.
 * They are pinned here so that changing a rule in `src/game.ts` (the README's
 * "What to change first") leaves the tests green: they check the mechanics,
 * and `rules.test.ts` checks what each rule changes.
 */
export const SHIPPED_RULES = {
  roundSeconds: 180,
  its: 1,
  tagRadius: 0.9,
  minPlayers: 3,
  graceSeconds: 3,
  voteSeconds: 30,
} as const;

/** `game-config.options` for the room's authority. */
export const AUTHORITY = '{"net":{"role":"authority","maxPlayers":6}}';
const ASSETS = ['env.arena', 'char.crew', 'sfx.tag'];

/** A booted guest and the bookkeeping a test reads. */
export interface Room {
  guest: Guest;
  host: MockHost;
  /** Player id to the entity `definition.player` spawned for them. */
  entities: Map<number, number>;
  /**
   * Stand an entity somewhere: its body row says so from the next step on.
   *
   * @param entity The entity.
   * @param x World x.
   * @param z World z.
   */
  place(entity: number, x: number, z: number): void;
  /** Run one step; returns its whole output. */
  step(events?: readonly GameEvent[]): FrameOutput;
  /**
   * @param seat A seat.
   * @returns Its input, the same object every step; mutate it with `press`.
   */
  input(seat: number): MutableInputState;
  /**
   * Hold a seat as the room does after a dropped link: still joined (no
   * `player-left`), left out of `frame-input.players` until {@link resume}.
   *
   * @param seat The seat.
   */
  hold(seat: number): void;
  /** @param seat A held seat, listed again from the next step. */
  resume(seat: number): void;
}

/**
 * Boot the game.
 *
 * @param options `game-config.options`, or undefined for solo.
 * @param seed The run seed.
 * @param rules Rules to change from {@link SHIPPED_RULES}, as a player would.
 * @returns The room.
 */
export function boot(options?: string, seed = 0x5eed, rules: Record<string, unknown> = {}): Room {
  const entities = new Map<number, number>();
  const hits: OverlapHit[] = [];
  const host = createMockHost({
    // `ctx.rng` is seeded from the host's `env.seed()`, not from `game-config.seed`.
    seed,
    nowMs: () => 0,
    assets: ASSETS,
    overlapSphere: (center, radius, filter) => {
      hits.length = 0;
      for (const entity of entities.values()) {
        if (entity === filter.excludeEntity) continue;
        const dx = Transform.x[entity] - center.x;
        const dy = Transform.y[entity] - center.y;
        const dz = Transform.z[entity] - center.z;
        const d = Math.hypot(dx, dy, dz);
        if (d <= radius) hits.push({ body: entity, entity, point: center, depth: radius - d });
      }
      return hits;
    },
  });
  const guest = createGuest(host, {
    ...game,
    rules: { ...game.rules, ...SHIPPED_RULES, ...rules },
  });
  guest.init(createGameConfig({ seed: BigInt(seed), fixedHz: 60, options }));
  let frame = 0;
  const tape = createPlayersInput(16);
  const held = new Set<number>();
  /** Body rows the fake physics reports, one per player body, by entity. */
  const rows = new Map<number, { body: number; x: number; y: number; z: number }>();
  const buffer = new Float32Array(16 * BODY_STRIDE);
  /** @returns The packed rows for this step. */
  const pack = (): Float32Array => {
    const sorted = [...rows.values()].sort((a, b) => a.body - b.body);
    sorted.forEach((r, i) => {
      buffer.fill(0, i * BODY_STRIDE, (i + 1) * BODY_STRIDE);
      buffer.set([r.body, r.x, r.y, r.z, 0, 0, 0, 1], i * BODY_STRIDE);
      buffer[i * BODY_STRIDE + 14] = 1; // grounded
    });
    return buffer.subarray(0, sorted.length * BODY_STRIDE);
  };
  return {
    guest,
    host,
    entities,
    place(entity, x, z) {
      const row = rows.get(entity);
      if (row) Object.assign(row, { x, y: 1, z });
    },
    input: (seat) => tape.input(seat),
    hold(seat) {
      held.add(seat);
    },
    resume(seat) {
      held.delete(seat);
    },
    step(events = []) {
      for (const e of events) tape.push(e);
      const lanes = tape.frame();
      const players = lanes.players.filter((p) => !held.has(p.player));
      const out = guest.tick(
        createFrameInput({ frame, events: lanes.events, players, bodies: pack() }),
      );
      frame += 1;
      tape.observe(out.commands);
      tape.endFrame();
      for (const c of out.commands) {
        if (c.tag === 'despawn') rows.delete(c.val);
        if (c.tag !== 'add-body') continue;
        const add = c.val;
        rows.set(add.entity, {
          body: add.body,
          x: add.position.x,
          y: add.position.y,
          z: add.position.z,
        });
      }
      // Each seated player's entity, as the authority's `set-player-entity` says.
      entities.clear();
      for (const seat of tape.joined()) {
        if (tape.entityOf(seat) !== 0) entities.set(seat, tape.entityOf(seat));
      }
      return out;
    },
  };
}

/**
 * @param player The id.
 * @returns A `player-joined` event.
 */
export function joined(player: number): GameEvent {
  return { tag: 'player-joined', val: { player, name: `p${String(player)}`, data: undefined } };
}

/**
 * @param player The sender.
 * @param name The message name.
 * @param payload The payload, before JSON; `null` by default.
 * @returns A `message` event.
 */
export function message(player: number, name: string, payload: unknown = null): GameEvent {
  return { tag: 'message', val: { player, name, payload: JSON.stringify(payload) } };
}

/**
 * @param commands A step's commands.
 * @returns Each `set-player-hud` with its model parsed.
 */
export function huds(
  commands: readonly Command[],
): { player: number; model: { text?: Record<string, string>; message?: string } }[] {
  return commands
    .filter((c) => c.tag === 'set-player-hud')
    .map((c) => {
      const val = c.val;
      return {
        player: val.player,
        model: JSON.parse(val.hud) as { text?: Record<string, string> },
      };
    });
}

/**
 * @param player The id.
 * @returns A `player-left` event.
 */
export function left(player: number): GameEvent {
  return { tag: 'player-left', val: { player, reason: 'left' } };
}

/**
 * @param commands A step's commands.
 * @param name A message name.
 * @returns The parsed payloads of the `send`s with that name, with their `to`.
 */
export function sends(
  commands: readonly Command[],
  name: string,
): { to: number | undefined; payload: Record<string, unknown> }[] {
  const out: { to: number | undefined; payload: Record<string, unknown> }[] = [];
  for (const c of commands) {
    if (c.tag !== 'send' || c.val.name !== name) continue;
    out.push({ to: c.val.to, payload: JSON.parse(c.val.payload) as Record<string, unknown> });
  }
  return out;
}

/**
 * Spread the given players along x, 6 m apart, so nobody touches anybody.
 *
 * @param room The room.
 * @param ids The players.
 */
export function spread(room: Room, ids: readonly number[]): void {
  ids.forEach((id, i) => {
    room.place(room.entities.get(id) ?? 0, i * 6 - 6, 0);
  });
}

/**
 * Put one player's body right beside another's.
 *
 * @param room The room.
 * @param mover Who moves.
 * @param onto Who they touch.
 */
export function touch(room: Room, mover: number, onto: number): void {
  const target = room.entities.get(onto) ?? 0;
  room.place(room.entities.get(mover) ?? 0, Transform.x[target] + 0.3, 0);
}
