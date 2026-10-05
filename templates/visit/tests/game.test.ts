/** The visit's rules, run headless: greeting, talking gates, the show routine, the walker. */
import { createGuest, featuresOf, type GameEvent, type Guest } from 'gameable';
import {
  createFrameInput,
  createGameConfig,
  createInputState,
  createMockHost,
  endFrame,
} from 'gameable/test';
import { describe, expect, it } from 'vitest';

import game, { rules } from '../src/game';

/** The character: the first entity `init` mints. */
const CHARACTER = 1;

interface Harness {
  guest: Guest;
  commands: { tag: string; val: Record<string, unknown> }[];
  hud: Record<string, unknown> | undefined;
  step(frames?: number, events?: GameEvent[]): void;
  frame: number;
}

const say = (text: string, kind: 'status' | 'input' = 'status'): GameEvent => ({
  tag: 'conversation-event',
  val: { entity: CHARACTER, kind, text },
});

function boot(): Harness {
  const host = createMockHost({
    seed: 0x5eed,
    nowMs: () => 0,
    assets: ['char.visit'],
    raycast: () => null,
  });
  const guest = createGuest(host, game);
  guest.init(createGameConfig({ seed: 0x5eedn, fixedHz: 60 }));
  const input = createInputState();
  const bodies = new Float32Array(0);
  const harness: Harness = { guest, commands: [], hud: undefined, frame: 0, step };
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
      for (const command of output.commands)
        harness.commands.push({
          tag: command.tag,
          val: structuredClone(command.val) as unknown as Record<string, unknown>,
        });
      if (output.hud !== undefined) harness.hud = JSON.parse(output.hud) as Record<string, unknown>;
      endFrame(input);
      harness.frame += 1;
    }
  }
  step(1);
  return harness;
}

/** The page's opening lines, then the character arrives. */
function arrive(h: Harness, mode: string, view = 'half', clips = 'idle,wave'): void {
  h.step(1, [
    say(`setup:${mode},${view},0`),
    say('greeting:Hello there'),
    say('aspect:1.6,0.2,0.04'),
  ]);
  h.step(1, [say(`clips:${clips}`), say('ready:1.6')]);
}

const clipsPlayed = (h: Harness): string[] =>
  h.commands.filter((c) => c.tag === 'set-clip-weights').map((c) => (c.val.clips as string[])[0]);

describe('the visit', () => {
  it('spawns one character, by id, idle', () => {
    const h = boot();
    const spawns = h.commands.filter((c) => c.tag === 'spawn-character');
    expect(spawns).toHaveLength(1);
    expect(spawns[0].val.entity).toBe(CHARACTER);
    expect(clipsPlayed(h)).toEqual(['idle']);
  });

  it('chat: greets with a wave and the greeting once the character is on screen', () => {
    const h = boot();
    arrive(h, 'chat');
    expect(h.commands.some((c) => c.tag === 'say')).toBe(false);
    h.step(Math.ceil(rules.greetAfter * 60) + 2);
    const lines = h.commands.filter((c) => c.tag === 'say');
    expect(lines).toHaveLength(1);
    expect(lines[0].val.text).toBe('Hello there');
    expect(clipsPlayed(h)).toContain('wave');
    expect(h.hud).toEqual({ near: 1 });
    // Back to idle after the wave.
    h.step(Math.ceil(rules.waveFor * 60) + 2);
    expect(clipsPlayed(h).at(-1)).toBe('idle');
  });

  it('passes what the visitor says to the relay only while talking', () => {
    const h = boot();
    arrive(h, 'chat');
    h.step(1, [say('ignored', 'input')]);
    expect(h.commands.filter((c) => c.tag === 'conversation')).toHaveLength(0);
    h.step(1, [
      say('start'),
      say('Hi!', 'input'),
      say('interrupt'),
      say('end'),
      say('late', 'input'),
    ]);
    const actions = h.commands
      .filter((c) => c.tag === 'conversation')
      .map((c) => `${String(c.val.action)}:${String(c.val.text)}`);
    expect(actions).toEqual(['start:', 'ask:Hi!', 'interrupt:', 'end:']);
  });

  it('show: performs the clips the rig carries, in order, skipping the rest', () => {
    const h = boot();
    arrive(h, 'show', 'room', 'idle,wave,ual_dance,ual_celebration');
    h.step(60 * 20);
    const played = clipsPlayed(h).filter((c) => c !== 'idle');
    // The greeting's wave, then the routine from its second entry: dance, celebration, wave, ...
    expect(played.slice(0, 4)).toEqual(['wave', 'ual_dance', 'ual_celebration', 'wave']);
  });

  it('show: stops performing while the visitor talks', () => {
    const h = boot();
    arrive(h, 'show', 'room', 'idle,wave,ual_dance');
    h.step(60 * 2, [say('start')]);
    const before = clipsPlayed(h).length;
    h.step(60 * 15);
    expect(
      clipsPlayed(h)
        .slice(before)
        .filter((c) => c !== 'idle'),
    ).toEqual([]);
  });

  it('hangout: a walker steps in, talking stays shut while far, and a tap walks them', () => {
    const h = boot();
    arrive(h, 'hangout', 'room');
    h.step(5);
    const bodies = h.commands.filter((c) => c.tag === 'add-body');
    expect(bodies).toHaveLength(1);
    // The room view stands further back than talking distance: no greeting, no talking yet.
    expect(h.hud).toEqual({ near: 0 });
    h.step(1, [say('start'), say('Hi', 'input')]);
    expect(
      h.commands.filter((c) => c.tag === 'conversation' && c.val.action === 'ask'),
    ).toHaveLength(0);
    expect(h.commands.some((c) => c.tag === 'say')).toBe(false);
    // A tap on the character walks the visitor toward talking distance.
    h.step(2, [say('goto:0,0')]);
    const moves = h.commands.filter((c) => c.tag === 'move-character');
    const last = moves.at(-1)?.val as { desiredVelocity: { x: number; z: number } };
    expect(last.desiredVelocity.z).toBeLessThan(0);
    expect(Math.abs(last.desiredVelocity.x)).toBeLessThan(1e-6);
  });
});

it('declares the characters feature', () => {
  expect(featuresOf(game)).toEqual({ characters: {} });
});
