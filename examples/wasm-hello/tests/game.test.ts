/** Guest command routing, including lifecycle and silent steady-state frames. */
import { createGuest, type GameEvent, type Guest } from 'gameable';
import {
  createFrameInput,
  createGameConfig,
  createInputState,
  createMockHost,
  endFrame,
  type MutableInputState,
} from 'gameable/test';
import { describe, expect, it } from 'vitest';

import game from '../src/game';

/** The entity `init` mints; ids start at 1. */
const GREETER = 1;

/** What {@link boot} hands back. */
interface Harness {
  guest: Guest;
  input: MutableInputState;
  /** Every command the guest has emitted since `boot`, newest last. */
  commands: { tag: string; val: unknown }[];
  /** The HUD JSON the guest last sent, or undefined before the first one. */
  hud: string | undefined;
  step(frames?: number, events?: GameEvent[]): void;
  frame: number;
}

/**
 * Start the game.
 *
 * Nothing here has a physics body, so the fake world is a zero-row body buffer
 * and the harness does not have to integrate anything.
 *
 * @returns The harness.
 */
function boot(): Harness {
  const host = createMockHost({
    seed: 0x5eed,
    nowMs: () => 0,
    assets: ['char.greeter'],
    raycast: () => null,
  });
  const guest = createGuest(host, game);
  guest.init(createGameConfig({ seed: 0x5eedn, fixedHz: 60 }));

  const input = createInputState();
  const commands: { tag: string; val: unknown }[] = [];
  const bodies = new Float32Array(0);
  const harness: Harness = { guest, input, commands, hud: undefined, frame: 0, step };

  /**
   * Run `frames` fixed steps.
   *
   * @param frames How many. Defaults to one.
   * @returns Nothing.
   */
  function step(frames = 1, events: GameEvent[] = []): void {
    const dt = 1 / 60;
    for (let i = 0; i < frames; i += 1) {
      const output = guest.tick(
        createFrameInput({
          frame: harness.frame,
          dt,
          elapsed: harness.frame * dt,
          input,
          bodies,
          events: i === 0 ? events : [],
        }),
      );
      for (const command of output.commands) {
        commands.push({ tag: command.tag, val: structuredClone(command.val) });
      }
      if (output.hud !== undefined) harness.hud = output.hud;
      endFrame(input);
      harness.frame += 1;
    }
  }

  // The commands `init` queued are carried into frame 0.
  step(1);
  return harness;
}

describe('the greeter', () => {
  it('asks the host for one character, by id', () => {
    const harness = boot();
    const spawns = harness.commands.filter((c) => c.tag === 'spawn-character');
    expect(spawns).toHaveLength(1);
    expect((spawns[0].val as { entity: number }).entity).toBe(GREETER);
    // The id was resolved to a handle during `init`; a URL never crosses.
    expect((spawns[0].val as { bundle: number }).bundle).toBeGreaterThan(0);
  });

  it('starts idle without repeating animation commands', () => {
    const harness = boot();
    harness.step(60);
    const weights = harness.commands.filter((c) => c.tag === 'set-clip-weights');
    expect(weights).toHaveLength(1);
    const command = weights[0].val as {
      entity: number;
      clips: string[];
      weights: ArrayLike<number>;
      timeScale: number;
    };
    expect(command.entity).toBe(GREETER);
    expect([...command.clips]).toEqual(['idle', 'wave']);
    expect(Array.from(command.weights)).toEqual([1, 0]);
    expect(command.timeScale).toBe(1);
  });

  it('sends nothing per frame once it has started', () => {
    const harness = boot();
    const before = harness.commands.length;
    harness.step(60);
    // Sixty steps, no commands: the host owns the animation from here.
    expect(harness.commands.length).toBe(before);
  });

  it('routes conversation input only within a started session', () => {
    const harness = boot();
    const event = (kind: 'status' | 'input', text: string, entity = GREETER): GameEvent => ({
      tag: 'conversation-event',
      val: { entity, kind, text },
    });
    harness.step(1, [event('input', 'ignored'), event('status', 'start', 99)]);
    expect(harness.commands.filter((c) => c.tag === 'conversation')).toHaveLength(0);
    harness.step(1, [
      event('status', 'start'),
      event('input', 'Hello'),
      event('status', 'microphone-on'),
      event('status', 'interrupt'),
      event('status', 'microphone-off'),
      event('status', 'end'),
      event('input', 'ignored'),
    ]);
    const commands = harness.commands
      .filter((c) => c.tag === 'conversation')
      .map((c) => c.val as { action: string; text: string });
    expect(commands.map((c) => c.action)).toEqual([
      'start',
      'ask',
      'microphone-on',
      'interrupt',
      'microphone-off',
      'end',
    ]);
    expect(commands[1].text).toBe('Hello');
  });

  it('waves on request then returns to idle once', () => {
    const harness = boot();
    harness.step(1, [
      { tag: 'conversation-event', val: { entity: GREETER, kind: 'status', text: 'wave' } },
    ]);
    harness.step(180);
    const weights = harness.commands
      .filter((c) => c.tag === 'set-clip-weights')
      .map((c) => Array.from((c.val as { weights: number[] }).weights));
    expect(weights).toEqual([
      [1, 0],
      [0, 1],
      [1, 0],
    ]);
  });
});
