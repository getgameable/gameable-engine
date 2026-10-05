/**
 * The game, driven headlessly.
 *
 * No browser, no renderer, no Jolt: `gameable/test` supplies a mock
 * host and `createGuest` runs the very same systems the wasm component runs.
 * That makes gameplay a unit-test loop rather than a click-and-look loop.
 *
 * The mock host does not simulate physics, so `moveCharacter` produces no
 * motion on its own; these tests integrate the requested velocity themselves
 * by writing the body rows the host would have written, and apply
 * `set-body-transform` the way the host would. That is the contract the guest
 * actually depends on, and it is deterministic.
 */
import { arenaSpawns as packedSpawns } from 'gameable/placeholder';
import {
  BODY_STRIDE,
  createGuest,
  featuresOf,
  Transform,
  type Command,
  type Guest,
  type HostFrameInput,
} from 'gameable';
import {
  createFrameInput,
  createGameConfig,
  createInputState,
  createMockHost,
  endFrame,
  hashTransforms,
  press,
  release,
  type MockHost,
  type MutableInputState,
} from 'gameable/test';
import { describe, expect, it } from 'vitest';

import game from '../src/game';
import { arenaSpawns } from '../src/arena';
import { CHEST_CENTRE, DOOR_CENTRE, NPC_CENTRE, interactables } from '../src/prefabs';
import { FALL, IDLE, JUMP, RUN, WALK, locomotionState } from '../src/systems/locomotion';
import { interactState, questState } from '../src/systems/interact';
import {
  PHASE_ANSWER,
  PHASE_LINES,
  PHASE_QUESTION,
  dialogueState,
  scripts,
} from '../src/systems/dialogue';

/** The entity the declarative `player` block spawns; ids start at 1. */
const HERO = 1;
/** The declarative `spawns` list, in order, starting after the hero. */
const GUIDE = 2;
const WANDERER = 3;
const KEY_CHEST = 4;
const EMPTY_CHEST = 5;
const DOOR = 6;

/** Metres per second squared the fake world pulls characters down at. */
const GRAVITY = 9.81;

/** Upward speed the fake host answers a `jump` request with. */
const JUMP_SPEED = 5;

/** Bodies the fake physics integrates, in body-id order. */
interface FakeBody {
  body: number;
  entity: number;
  /** True for a `character` body: it falls, and it jumps. */
  character: boolean;
  /** The height it may not sink below. The floor, as far as this fake knows. */
  floorY: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** What {@link boot} hands back. */
interface Harness {
  guest: Guest;
  host: MockHost;
  input: MutableInputState;
  bodies: FakeBody[];
  /** Every command the guest has emitted since `boot`, newest last. */
  commands: { tag: string; val: unknown }[];
  /** The HUD JSON the guest last sent, or undefined before the first one. */
  hud: string | undefined;
  step(frames?: number): void;
  /** Press a key, run a step, release it, run another. */
  tap(key: string): void;
  /** Put the hero's body somewhere, the way physics would have. */
  placeHero(x: number, y: number, z: number): void;
  frame: number;
}

/**
 * Start the game and stand in for the host physics.
 *
 * @returns The harness.
 */
function boot(): Harness {
  const host = createMockHost({
    seed: 0xa11c3,
    nowMs: () => 0,
    assets: ['env.arena', 'char.hero', 'char.guide', 'sfx.key', 'sfx.door', 'sfx.talk', 'sfx.step'],
    raycast: () => null,
  });
  const guest = createGuest(host, game);
  guest.init(createGameConfig({ seed: 0xa11c3n, fixedHz: 60 }));

  const input = createInputState();
  const bodies: FakeBody[] = [];
  const commands: { tag: string; val: unknown }[] = [];
  const buffer = new Float32Array(64 * BODY_STRIDE);
  const harness: Harness = {
    guest,
    host,
    input,
    bodies,
    commands,
    hud: undefined,
    frame: 0,
    step,
    tap,
    placeHero,
  };

  /**
   * Mirror the guest's body commands.
   *
   * @param output The frame the guest just produced.
   * @returns Nothing.
   */
  function applyCommands(output: { commands: readonly Command[] }): void {
    for (const command of output.commands) {
      commands.push({ tag: command.tag, val: command.val });
      if (command.tag === 'add-body') {
        const c = command.val;
        bodies.push({
          body: c.body,
          entity: c.entity,
          character: c.kind === 'character',
          floorY: c.position.y,
          x: c.position.x,
          y: c.position.y,
          z: c.position.z,
          vx: 0,
          vy: 0,
          vz: 0,
        });
      } else if (command.tag === 'remove-body') {
        const index = bodies.findIndex((b) => b.body === command.val);
        if (index >= 0) bodies.splice(index, 1);
      } else if (command.tag === 'move-character') {
        const c = command.val;
        const record = bodies.find((b) => b.body === c.body);
        if (record) {
          // The real character controller owns the vertical axis: the guest's
          // `y` is ignored and a jump is answered with an upward speed. This
          // fake does the same, so `grounded` means something here.
          record.vx = c.desiredVelocity.x;
          record.vz = c.desiredVelocity.z;
          if (c.jump) record.vy = JUMP_SPEED;
        }
      } else if (command.tag === 'set-body-transform') {
        const c = command.val;
        const record = bodies.find((b) => b.body === c.body);
        if (record) {
          record.x = c.position.x;
          record.y = c.position.y;
          record.z = c.position.z;
        }
      }
    }
  }

  /**
   * Integrate the fake bodies and pack them the way the host would.
   *
   * @param dt Seconds.
   * @returns The row count.
   */
  function packBodies(dt: number): number {
    bodies.sort((a, b) => a.body - b.body);
    for (const [index, record] of bodies.entries()) {
      if (record.character) record.vy -= GRAVITY * dt;
      record.x += record.vx * dt;
      record.y += record.vy * dt;
      record.z += record.vz * dt;
      if (record.character && record.y <= record.floorY) {
        record.y = record.floorY;
        record.vy = 0;
      }
      const base = index * BODY_STRIDE;
      buffer[base] = record.body;
      buffer[base + 1] = record.x;
      buffer[base + 2] = record.y;
      buffer[base + 3] = record.z;
      buffer[base + 4] = 0;
      buffer[base + 5] = 0;
      buffer[base + 6] = 0;
      buffer[base + 7] = 1;
      buffer[base + 8] = record.vx;
      buffer[base + 9] = record.vy;
      buffer[base + 10] = record.vz;
      buffer[base + 11] = 0;
      buffer[base + 12] = 0;
      buffer[base + 13] = 0;
      buffer[base + 14] = record.character ? (record.y <= record.floorY ? 1 : 4) : 0;
    }
    return bodies.length;
  }

  /**
   * Run `frames` fixed steps.
   *
   * @param frames How many. Defaults to one.
   * @returns Nothing.
   */
  function step(frames = 1): void {
    const dt = 1 / 60;
    for (let i = 0; i < frames; i += 1) {
      const rows = packBodies(dt);
      const frameInput: HostFrameInput = createFrameInput({
        frame: harness.frame,
        dt,
        elapsed: harness.frame * dt,
        input,
        bodies: buffer.subarray(0, rows * BODY_STRIDE),
      });
      const output = guest.tick(frameInput);
      applyCommands(output);
      if (output.hud !== undefined) harness.hud = output.hud;
      endFrame(input);
      harness.frame += 1;
    }
  }

  /**
   * Press a key for one step and let it go.
   *
   * Interact and dialogue act on the press edge, so a held key does one thing
   * and then nothing.
   *
   * @param key A key name.
   * @returns Nothing.
   */
  function tap(key: string): void {
    press(input, key);
    step(1);
    release(input, key);
    step(1);
  }

  /**
   * Teleport the hero's fake body, as the character controller would have.
   *
   * @param x World x.
   * @param y World y.
   * @param z World z.
   * @returns Nothing.
   */
  function placeHero(x: number, y: number, z: number): void {
    const record = bodies.find((b) => b.entity === HERO);
    if (!record) throw new Error('the hero has no body');
    record.x = x;
    record.y = y;
    record.z = z;
    record.floorY = y;
    record.vx = 0;
    record.vy = 0;
    record.vz = 0;
    step(1);
  }

  // The commands `init` queued — the hero, two NPCs, two chests and a door —
  // are carried into frame 0, so one tick puts every body in the fake world.
  step(1);
  return harness;
}

/**
 * The HUD model the guest last sent.
 *
 * `hud.set` only crosses the boundary on the frames the model changed, so a
 * test that ticks and then looks at *that* frame's output usually sees nothing.
 * The harness keeps the last payload instead, which is what the host's HUD
 * renderer has on screen.
 *
 * @param harness The harness.
 * @returns The parsed model, or null when nothing has been sent at all.
 */
function hudModel(harness: Harness): {
  text?: Record<string, string>;
  message?: string;
} | null {
  harness.step(1);
  if (harness.hud === undefined) return null;
  return JSON.parse(harness.hud) as { text?: Record<string, string>; message?: string };
}

describe('the arena', () => {
  it('still agrees with the placeholder pack it was laid out in', () => {
    expect(arenaSpawns.hero.position).toEqual(packedSpawns.player.position);
    expect(arenaSpawns.bounds).toEqual(packedSpawns.bounds);
  });

  it('turns the guide towards the hero, under the +Z yaw convention', () => {
    const guide = arenaSpawns.npcs[0].position;
    const hero = arenaSpawns.hero.position;
    // Yaw 0 faces +Z, so "look at that" is atan2(dx, dz).
    const wanted = Math.atan2(hero[0] - guide[0], hero[2] - guide[2]);
    expect(arenaSpawns.npcs[0].yaw).toBeCloseTo(wanted, 3);
  });

  it('keeps every prop inside the playable volume', () => {
    const { min, max } = arenaSpawns.bounds;
    const points = [arenaSpawns.hero, ...arenaSpawns.npcs, ...arenaSpawns.chests, arenaSpawns.door];
    for (const point of points) {
      expect(point.position[0]).toBeGreaterThanOrEqual(min[0]);
      expect(point.position[0]).toBeLessThanOrEqual(max[0]);
      expect(point.position[2]).toBeGreaterThanOrEqual(min[2]);
      expect(point.position[2]).toBeLessThanOrEqual(max[2]);
    }
  });

  it('spawns a hero, two people, two chests and a door', () => {
    const harness = boot();
    // Hero + guide + wanderer + two chests + door, each with a body.
    expect(harness.bodies).toHaveLength(6);
    expect(Transform.z[HERO]).toBeCloseTo(arenaSpawns.hero.position[2], 5);
    expect(Transform.y[GUIDE]).toBeCloseTo(arenaSpawns.npcs[0].position[1] + NPC_CENTRE, 5);
    expect(Transform.y[KEY_CHEST]).toBeCloseTo(arenaSpawns.chests[0].position[1] + CHEST_CENTRE, 5);
    expect(Transform.y[DOOR]).toBeCloseTo(arenaSpawns.door.position[1] + DOOR_CENTRE, 5);
    expect(interactables.kind[EMPTY_CHEST]).toBeGreaterThan(0);
  });
});

describe('locomotion', () => {
  it('stands still with nothing held', () => {
    const harness = boot();
    harness.step(10);
    expect(locomotionState.state).toBe(IDLE);
    expect(locomotionState.speed).toBeCloseTo(0, 5);
  });

  it('walks at the walk speed and runs at the run speed', () => {
    const harness = boot();
    press(harness.input, 'W');
    harness.step(30);
    expect(locomotionState.state).toBe(WALK);
    // The speeds the rig's walk and run clips were baked around.
    expect(locomotionState.speed).toBeCloseTo(1.6, 3);

    press(harness.input, 'Shift');
    harness.step(30);
    expect(locomotionState.state).toBe(RUN);
    expect(locomotionState.speed).toBeCloseTo(4, 3);

    release(harness.input, 'Shift');
    release(harness.input, 'W');
    harness.step(20);
    expect(locomotionState.state).toBe(IDLE);
  });

  it('walks forward, which is away from the camera', () => {
    const harness = boot();
    const before = Transform.z[HERO] ?? 0;
    press(harness.input, 'W');
    harness.step(60);
    release(harness.input, 'W');
    // Forward is -Z at a yaw of zero, and the walk speed is 1.6 m/s.
    expect(Transform.z[HERO] ?? 0).toBeLessThan(before - 1.2);
  });

  it('turns the hero towards the way it is walking, without snapping', () => {
    const harness = boot();
    // The hero starts with its back to the camera: facing -Z, which is pi.
    expect(locomotionState.facing).toBeCloseTo(Math.PI, 5);

    // Strafe right. Forward is -Z, so D is +X: the body has to swing a quarter
    // turn, from pi to pi/2.
    press(harness.input, 'D');
    harness.step(1);
    const afterOneStep = locomotionState.facing;
    // 12 rad/s over one 60 Hz step is 0.2 rad, so a quarter turn cannot be done
    // in one frame. A snap would land on pi/2 immediately.
    expect(Math.abs(afterOneStep - Math.PI)).toBeLessThan(0.25);
    expect(afterOneStep).toBeLessThan(Math.PI);

    harness.step(30);
    release(harness.input, 'D');
    expect(locomotionState.facing).toBeCloseTo(Math.PI / 2, 2);
    // And it reached the transform, as a rotation about +Y and nothing else.
    const half = locomotionState.facing / 2;
    expect(Transform.qy[HERO] ?? 0).toBeCloseTo(Math.sin(half), 4);
    expect(Transform.qw[HERO] ?? 0).toBeCloseTo(Math.cos(half), 4);
    expect(Transform.qx[HERO] ?? 0).toBe(0);
    expect(Transform.qz[HERO] ?? 0).toBe(0);
  });

  it('leaves the facing alone while the hero is standing still', () => {
    const harness = boot();
    press(harness.input, 'W');
    harness.step(20);
    release(harness.input, 'W');
    const facing = locomotionState.facing;
    harness.step(30);
    expect(locomotionState.facing).toBe(facing);
  });

  it('does not allow an apex or unsupported zero velocity to become grounded', () => {
    const harness = boot();
    const hero = harness.bodies.find((body) => body.entity === HERO)!;
    hero.y = hero.floorY + 2;
    hero.vy = GRAVITY / 60; // Integration produces exactly zero at the apex.
    press(harness.input, 'Space');
    harness.step();
    expect(locomotionState.grounded).toBe(false);
    const move = harness.commands.filter((command) => command.tag === 'move-character').at(-1)!;
    expect((move.val as { jump: boolean }).jump).toBe(false);
  });

  it('reports jump on the press and fall on the way down', () => {
    const harness = boot();
    press(harness.input, 'Space');
    harness.step(1);
    release(harness.input, 'Space');
    expect(locomotionState.state).toBe(JUMP);
    expect(locomotionState.grounded).toBe(false);

    // Up for about half a second, then down: the fake host answers the jump
    // with 5 m/s and lets gravity have it back.
    harness.step(40);
    expect(locomotionState.state).toBe(FALL);

    harness.step(40);
    expect(locomotionState.state).toBe(IDLE);
    expect(locomotionState.grounded).toBe(true);
  });

  it('tells the animator what the hero is doing', () => {
    const harness = boot();
    press(harness.input, 'W');
    harness.step(20);
    release(harness.input, 'W');
    const states = harness.commands.filter((c) => c.tag === 'set-character-state');
    expect(states.length).toBeGreaterThan(0);
    const last = states[states.length - 1].val as {
      entity: number;
      state: string;
      velocity: { z: number };
      grounded: boolean;
    };
    expect(last.entity).toBe(HERO);
    expect(last.state).toBe(WALK);
    expect(last.velocity.z).toBeCloseTo(-1.6, 3);
    expect(last.grounded).toBe(true);
  });
});

describe('the camera', () => {
  it('rides a spring arm behind the hero', () => {
    const harness = boot();
    const output = harness.guest.tick(
      createFrameInput({ frame: 900, input: harness.input, bodies: new Float32Array(0) }),
    );
    expect(output.camera.mode).toBe('third-person');
    expect(output.camera.follow).toBe(HERO);
    expect(output.camera.armLength).toBeCloseTo(4.5, 3);
    expect(output.camera.offset.y).toBeCloseTo(0.4, 3);
    // The pivot is the hero, lifted by the rig height. The host owns the arm.
    expect(output.camera.position.x).toBeCloseTo(Transform.x[HERO] ?? 0, 3);
    expect(output.camera.position.z).toBeCloseTo(Transform.z[HERO] ?? 0, 3);
  });

  it('follows the hero as it walks', () => {
    const harness = boot();
    press(harness.input, 'W');
    harness.step(60);
    release(harness.input, 'W');
    const output = harness.guest.tick(
      createFrameInput({ frame: 901, input: harness.input, bodies: new Float32Array(0) }),
    );
    expect(output.camera.position.z).toBeCloseTo(
      (Transform.z[HERO] ?? 0) + 0, // the pivot tracks the hero exactly
      3,
    );
    expect(output.camera.position.z).toBeLessThan(arenaSpawns.hero.position[2]);
  });
});

describe('interacting', () => {
  it('prompts when a chest is in front of the hero, and not when it is behind', () => {
    const harness = boot();
    harness.placeHero(0, 1.15, 1.5);
    expect(interactState.target).toBe(KEY_CHEST);
    expect(interactState.prompt).toBe('E: open chest');

    // The same chest, but now the hero is past it and facing away.
    harness.placeHero(0, 1.15, -1.5);
    expect(interactState.prompt).toBe('');
  });

  it('puts the prompt on the HUD', () => {
    const harness = boot();
    harness.placeHero(0, 1.15, 1.5);
    const model = hudModel(harness);
    expect(model?.text?.prompt).toBe('E: open chest');
  });

  it('opens a chest, which coughs up a key the hero can take', () => {
    const harness = boot();
    harness.placeHero(0, 1.15, 1.5);
    harness.tap('E');
    expect(questState.chestsOpened).toBe(1);
    expect(questState.keys).toBe(0);
    // The key is now the nearest thing worth pressing E at.
    expect(interactState.prompt).toBe('E: take key');

    harness.tap('E');
    expect(questState.keys).toBe(1);
    const model = hudModel(harness);
    expect(model?.text?.keys).toBe('1');
  });

  it('finds nothing in the empty chest', () => {
    const harness = boot();
    const chest = arenaSpawns.chests[1].position;
    harness.placeHero(chest[0], 1.15, chest[2] + 1.5);
    expect(interactState.target).toBe(EMPTY_CHEST);
    harness.tap('E');
    expect(questState.chestsOpened).toBe(1);
    expect(questState.keys).toBe(0);
    expect(interactState.message).toContain('Empty');
  });

  it('refuses the door without the key and opens it with one', () => {
    const harness = boot();
    const door = arenaSpawns.door.position;
    harness.placeHero(door[0], 1.15, door[2] + 1.5);
    expect(interactState.prompt).toBe('E: door is locked');
    harness.tap('E');
    expect(interactables.used[DOOR]).toBe(0);
    expect(questState.escaped).toBe(false);

    // Go and fetch the key, then come back.
    harness.placeHero(0, 1.15, 1.5);
    harness.tap('E');
    harness.tap('E');
    expect(questState.keys).toBe(1);

    harness.placeHero(door[0], 1.15, door[2] + 1.5);
    expect(interactState.prompt).toBe('E: open door');
    harness.tap('E');
    expect(interactables.used[DOOR]).toBe(1);

    // 2.4 m at 1.6 m/s is 1.5 s; a hundred steps is plenty.
    harness.step(100);
    expect(questState.escaped).toBe(true);
    expect(Transform.x[DOOR] ?? 0).toBeGreaterThan(arenaSpawns.door.position[0] + 2);

    const model = hudModel(harness);
    expect(model?.message).toBe('You escaped');
  });
});

describe('dialogue', () => {
  /**
   * Walk up to the guide and start talking.
   *
   * @returns The harness, mid-conversation.
   */
  function talkToTheGuide(): Harness {
    const harness = boot();
    const guide = arenaSpawns.npcs[0].position;
    harness.placeHero(guide[0], 1.15, guide[2] + 1.2);
    expect(interactState.target).toBe(GUIDE);
    expect(interactState.prompt).toBe('E: talk');
    harness.tap('E');
    return harness;
  }

  it('reads its lines out of src/dialogue.json', () => {
    expect(scripts.guide.lines.length).toBeGreaterThan(1);
    expect(scripts.guide.question).toBeDefined();
    expect(scripts.wanderer.question).toBeUndefined();
  });

  it('freezes the hero while somebody is talking', () => {
    const harness = talkToTheGuide();
    expect(dialogueState.active).toBe(true);
    expect(dialogueState.speaker).toBe('Guide');

    const before = Transform.z[HERO] ?? 0;
    press(harness.input, 'W');
    harness.step(30);
    release(harness.input, 'W');
    expect(Transform.z[HERO] ?? 0).toBeCloseTo(before, 2);
    expect(locomotionState.state).toBe(IDLE);
  });

  it('walks the lines and then takes the yes branch', () => {
    const harness = talkToTheGuide();
    expect(dialogueState.phase).toBe(PHASE_LINES);
    expect(dialogueState.text).toBe(scripts.guide.lines[0].text);

    harness.tap('E');
    expect(dialogueState.text).toBe(scripts.guide.lines[1].text);

    harness.tap('E');
    expect(dialogueState.phase).toBe(PHASE_QUESTION);
    expect(dialogueState.text).toBe(scripts.guide.question?.text);

    harness.tap('1');
    expect(dialogueState.phase).toBe(PHASE_ANSWER);
    expect(dialogueState.answer).toBe('yes');
    expect(dialogueState.text).toBe(scripts.guide.question?.yes.text);

    harness.tap('E');
    expect(dialogueState.active).toBe(false);
  });

  it('takes the no branch on 2', () => {
    const harness = talkToTheGuide();
    harness.tap('E');
    harness.tap('E');
    expect(dialogueState.phase).toBe(PHASE_QUESTION);
    harness.tap('2');
    expect(dialogueState.answer).toBe('no');
    expect(dialogueState.text).toBe(scripts.guide.question?.no.text);
  });

  it('gives the wanderer its own, shorter script', () => {
    const harness = boot();
    const wanderer = arenaSpawns.npcs[1].position;
    // Approach from +X, looking down -X.
    harness.placeHero(wanderer[0], 1.15, wanderer[2] + 1.2);
    harness.tap('E');
    expect(dialogueState.npc).toBe(WANDERER);
    expect(dialogueState.script).toBe('wanderer');
    harness.tap('E');
    harness.tap('E');
    // No question at the end: the second E ends it.
    expect(dialogueState.active).toBe(false);
  });
});

describe('the character commands', () => {
  it('asks the host to spawn a character for the hero and both NPCs', () => {
    const harness = boot();
    const spawns = harness.commands.filter((c) => c.tag === 'spawn-character');
    expect(spawns).toHaveLength(3);
    const entities = spawns.map((c) => (c.val as { entity: number }).entity).sort((a, b) => a - b);
    expect(entities).toEqual([HERO, GUIDE, WANDERER]);
    expect((spawns[0].val as { bundle: number }).bundle).toBeGreaterThan(0);
  });

  it('spawns each NPC already turned to its arena yaw', () => {
    boot();
    const half = arenaSpawns.npcs[0].yaw / 2;
    expect(Transform.qy[GUIDE] ?? 0).toBeCloseTo(Math.sin(half), 4);
    expect(Transform.qw[GUIDE] ?? 0).toBeCloseTo(Math.cos(half), 4);
  });

  it('sets an expression and a gaze when a line is shown', () => {
    const harness = boot();
    const guide = arenaSpawns.npcs[0].position;
    harness.placeHero(guide[0], 1.15, guide[2] + 1.2);
    const before = harness.commands.length;
    harness.tap('E');

    const since = harness.commands.slice(before);
    const expressions = since.filter((c) => c.tag === 'set-expression');
    const gazes = since.filter((c) => c.tag === 'look-at');
    expect(expressions.length).toBeGreaterThan(0);
    expect(gazes.length).toBeGreaterThan(0);

    const expression = expressions[0].val as {
      entity: number;
      space: string;
      weights: ArrayLike<number>;
    };
    expect(expression.entity).toBe(GUIDE);
    expect(expression.space).toBe('arkit52');
    expect(expression.weights).toHaveLength(52);
    // A smile: MouthSmileLeft is ARKit channel 23.
    expect(expression.weights[23]).toBeGreaterThan(0);

    const gaze = gazes[0].val as { entity: number; target?: { z: number } };
    expect(gaze.entity).toBe(GUIDE);
    expect(gaze.target?.z).toBeCloseTo(Transform.z[HERO] ?? 0, 3);
  });

  it('drops the expression and releases the gaze when the talking stops', () => {
    const harness = boot();
    const wanderer = arenaSpawns.npcs[1].position;
    harness.placeHero(wanderer[0], 1.15, wanderer[2] + 1.2);
    harness.tap('E');
    harness.tap('E');
    const before = harness.commands.length;
    harness.tap('E');
    expect(dialogueState.active).toBe(false);

    const since = harness.commands.slice(before);
    const released = since.find((c) => c.tag === 'look-at');
    expect(released).toBeDefined();
    expect((released?.val as { target?: unknown }).target).toBeUndefined();
  });
});

describe('determinism', () => {
  it('produces the same transforms twice from the same seed and inputs', () => {
    /**
     * Run a scripted round and hash what came out.
     *
     * @returns A hash of the final transform buffer.
     */
    const run = (): number => {
      const harness = boot();
      press(harness.input, 'W');
      harness.step(45);
      release(harness.input, 'W');
      harness.step(1);
      press(harness.input, 'D');
      harness.step(45);
      release(harness.input, 'D');
      const output = harness.guest.tick(
        createFrameInput({ frame: 400, input: harness.input, bodies: new Float32Array(0) }),
      );
      return hashTransforms(output.transforms);
    };
    expect(run()).toBe(run());
  });
});

it('declares the characters feature, and as shipped nothing else', () => {
  const features = featuresOf(game);
  expect(features).toMatchObject({ characters: {} });
  // The play-with-friends recipe adds `multiplayer`; anything else is a change to the template.
  expect(Object.keys(features).filter((name) => name !== 'multiplayer')).toEqual(['characters']);
});
