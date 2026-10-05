/**
 * The template as a room's authority, with a fake physics world: players
 * join, each with their own input, and the test reads each player's own HUD
 * (`set-player-hud`) and body. The single-player harness is in
 * `game.test.ts`; this one only adds seats.
 */
import { BODY_STRIDE, createGuest, type Command, type GameEvent, type PlayerInput } from 'gameable';
import {
  createFrameInput,
  createGameConfig,
  createInputState,
  createMockHost,
  endFrame,
  press,
  release,
  type MutableInputState,
} from 'gameable/test';

import game from '../src/game';

const AUTHORITY = '{"net":{"role":"authority"}}';
const ASSETS = [
  'env.arena',
  'char.hero',
  'char.guide',
  'sfx.key',
  'sfx.door',
  'sfx.talk',
  'sfx.step',
];

/** A body the fake world moves: it follows `move-character` and `set-body-transform`. */
interface FakeBody {
  body: number;
  entity: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
}

/** One player's HUD model, as the authority last sent it to them. */
export interface PlayerHud {
  text?: Record<string, string>;
  message?: string;
}

/** What {@link bootRoom} hands back. */
export interface RoomHarness {
  /** Each seat's input, by player id. */
  inputs: MutableInputState[];
  /** Run fixed steps. */
  step(frames?: number): void;
  /** Press a key for one player for a step, then let it go for a step. */
  tap(player: number, key: string): void;
  /** Put a player's hero somewhere, as physics would have. */
  place(player: number, x: number, y: number, z: number): void;
  /** The entity a player controls. */
  entityOf(player: number): number;
  /** The last horizontal velocity asked for a player's hero. */
  velocityOf(player: number): { x: number; z: number };
  /** A player's HUD, or null before the first one. */
  hudOf(player: number): PlayerHud | null;
  /** Every command since boot. */
  commands: Command[];
}

/**
 * Boot the template as an authority and seat players `0..seats-1`.
 *
 * @param seats How many players join on the first frame.
 * @returns The harness, a few steps after the join.
 */
export function bootRoom(seats: number): RoomHarness {
  const host = createMockHost({ seed: 7, nowMs: () => 0, assets: ASSETS, raycast: () => null });
  const guest = createGuest(host, game);
  guest.init(createGameConfig({ fixedHz: 60, options: AUTHORITY }));
  const inputs = Array.from({ length: seats }, () => createInputState());
  const players: PlayerInput[] = inputs.map((input, player) => ({ player, seq: 0, input }));
  const joins: GameEvent[] = inputs.map((_, player) => ({
    tag: 'player-joined',
    val: { player, name: `p${String(player)}` },
  }));
  const bodies: FakeBody[] = [];
  const entities = new Map<number, number>();
  const huds = new Map<number, string>();
  const commands: Command[] = [];
  const buffer = new Float32Array(64 * BODY_STRIDE);
  let frame = 0;

  const bodyOf = (entity: number): FakeBody | undefined => bodies.find((b) => b.entity === entity);

  /** @param list One step's commands. */
  function apply(list: readonly Command[]): void {
    for (const c of list) {
      commands.push(c);
      if (c.tag === 'add-body') {
        const { body, entity, position } = c.val;
        bodies.push({ body, entity, x: position.x, y: position.y, z: position.z, vx: 0, vz: 0 });
      } else if (c.tag === 'remove-body') {
        const index = bodies.findIndex((b) => b.body === c.val);
        if (index >= 0) bodies.splice(index, 1);
      } else if (c.tag === 'move-character') {
        const record = bodies.find((b) => b.body === c.val.body);
        if (record) {
          record.vx = c.val.desiredVelocity.x;
          record.vz = c.val.desiredVelocity.z;
        }
      } else if (c.tag === 'set-body-transform') {
        const record = bodies.find((b) => b.body === c.val.body);
        if (record) Object.assign(record, c.val.position);
      } else if (c.tag === 'set-player-entity') entities.set(c.val.player, c.val.entity);
      else if (c.tag === 'set-player-hud') huds.set(c.val.player, c.val.hud);
    }
  }

  /** @returns The row count, after one step of integration. */
  function pack(): number {
    bodies.sort((a, b) => a.body - b.body);
    for (const [index, b] of bodies.entries()) {
      b.x += b.vx / 60;
      b.z += b.vz / 60;
      const base = index * BODY_STRIDE;
      buffer.fill(0, base, base + BODY_STRIDE);
      buffer[base] = b.body;
      buffer[base + 1] = b.x;
      buffer[base + 2] = b.y;
      buffer[base + 3] = b.z;
      buffer[base + 7] = 1;
      buffer[base + 8] = b.vx;
      buffer[base + 10] = b.vz;
      buffer[base + 14] = 1;
    }
    return bodies.length;
  }

  const harness: RoomHarness = {
    inputs,
    commands,
    step(frames = 1) {
      for (let i = 0; i < frames; i += 1) {
        const rows = pack();
        const out = guest.tick(
          createFrameInput({
            frame,
            events: frame === 0 ? joins : [],
            players,
            bodies: buffer.subarray(0, rows * BODY_STRIDE),
          }),
        );
        apply(out.commands);
        for (const input of inputs) endFrame(input);
        frame += 1;
      }
    },
    tap(player, key) {
      press(inputs[player], key);
      harness.step(1);
      release(inputs[player], key);
      harness.step(1);
    },
    place(player, x, y, z) {
      const record = bodyOf(harness.entityOf(player));
      if (!record) throw new Error(`player ${String(player)} has no body`);
      Object.assign(record, { x, y, z, vx: 0, vz: 0 });
      harness.step(1);
    },
    entityOf: (player) => entities.get(player) ?? 0,
    velocityOf(player) {
      const record = bodyOf(harness.entityOf(player));
      return { x: record?.vx ?? 0, z: record?.vz ?? 0 };
    },
    hudOf(player) {
      const json = huds.get(player);
      return json === undefined ? null : (JSON.parse(json) as PlayerHud);
    },
  };
  harness.step(3);
  return harness;
}
