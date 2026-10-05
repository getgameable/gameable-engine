import { describe, expect, it } from 'vitest';

import { defineMessage } from './messages';
import { payloads, rig, roomFrame } from './netTesting';
import { PHASE_MESSAGE } from '../wire';
import type { GameContext } from '../defineGame';
import type { SendCmd } from '../types';

const AUTHORITY = '{"net":{"role":"authority"}}';
const CLIENT = '{"net":{"role":"client","localPlayer":1}}';

/**
 * Boot a guest whose one system sets the phase to `words[frame]` each tick.
 *
 * @param options `game-config.options`, or undefined for solo.
 * @param words The word to set on each frame.
 * @returns The sends of every tick, one list per tick.
 */
function run(options: string | undefined, words: readonly string[]): string[][] {
  let frame = 0;
  let ran = 0;
  const { guest } = rig(
    {
      systems: [
        {
          on: 'both',
          run: (ctx: GameContext) => {
            ran += 1;
            ctx.net.setPhase(words[frame]);
          },
        },
      ],
    },
    options,
  );
  const out: string[][] = [];
  for (; frame < words.length; frame += 1) {
    // Commands are pooled: read each tick's before the next.
    const sends = payloads<SendCmd>(guest.tick(roomFrame(frame)).commands, 'send');
    out.push(sends.map((s) => `${s.to === undefined ? '*' : String(s.to)} ${s.name} ${s.payload}`));
  }
  expect(ran).toBe(words.length);
  return out;
}

describe('ctx.net.setPhase', () => {
  it('sends the reserved aos:phase message on a change, and nothing for the same word again', () => {
    const ticks = run(AUTHORITY, ['lobby', 'lobby', 'playing', 'voting', 'voting']);
    expect(ticks).toEqual([
      [`* ${PHASE_MESSAGE} "lobby"`],
      [],
      [`* ${PHASE_MESSAGE} "playing"`],
      [`* ${PHASE_MESSAGE} "voting"`],
      [],
    ]);
  });

  it('refuses a word that is not 1 to 32 letters, digits or dashes, and counts it unsent', () => {
    let unsent = 0;
    const { guest, host } = rig(
      {
        systems: [
          {
            on: 'both',
            run: (ctx: GameContext) => {
              ctx.net.setPhase('');
              ctx.net.setPhase('x'.repeat(33));
              ctx.net.setPhase('two words');
              ctx.net.setPhase('café');
              ctx.net.setPhase('round-2');
              unsent = ctx.net.stats.unsent;
            },
          },
        ],
      },
      AUTHORITY,
    );
    const sends = payloads<SendCmd>(guest.tick(roomFrame(0)).commands, 'send');
    expect(sends.map((s) => s.payload)).toEqual(['"round-2"']);
    expect(unsent).toBe(4);
    expect(host.lines.some((l) => l.includes('setPhase'))).toBe(true);
  });

  it('does nothing on a client or in a game with no room', () => {
    expect(run(CLIENT, ['lobby']).flat()).toEqual([]);
    expect(run(undefined, ['lobby']).flat()).toEqual([]);
  });
});

describe('the reserved aos: prefix', () => {
  it('cannot be defined as a game message', () => {
    rig({});
    expect(() => defineMessage('aos:phase', (p): p is string => typeof p === 'string')).toThrow(
      /aos:/,
    );
    expect(() => defineMessage('aos:mine', (p): p is null => p === null)).toThrow(/reserved/);
  });

  it('cannot be sent by bare name: a game cannot forge the phase', () => {
    let unsent = 0;
    const { guest } = rig(
      {
        systems: [
          {
            on: 'both',
            run: (ctx: GameContext) => {
              ctx.net.send(PHASE_MESSAGE, 'forged');
              unsent = ctx.net.stats.unsent;
            },
          },
        ],
      },
      AUTHORITY,
    );
    expect(payloads<SendCmd>(guest.tick(roomFrame(0)).commands, 'send')).toEqual([]);
    expect(unsent).toBe(1);
  });
});
