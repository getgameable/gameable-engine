/**
 * The page's keys, on a client guest: R is ready, G is the host's start, 1-6
 * vote for that seat. Chat is typed into the page (`src/chatPrompt.ts`), not
 * read by the guest.
 */
import { createGuest } from 'gameable';
import {
  createFrameInput,
  createGameConfig,
  createInputState,
  createMockHost,
  press,
} from 'gameable/test';
import { describe, expect, it } from 'vitest';

import { chatPayload } from '../src/chat';
import game from '../src/game';
import { sends } from './room';

const CLIENT = '{"net":{"role":"client","localPlayer":1,"maxPlayers":6}}';

/**
 * @param key The key pressed on this frame.
 * @returns The client's commands for that frame.
 */
function pressing(key: string): ReturnType<ReturnType<typeof createGuest>['tick']>['commands'] {
  const assets = ['env.arena', 'char.crew', 'sfx.tag'];
  const guest = createGuest(createMockHost({ seed: 1, nowMs: () => 0, assets }), game);
  guest.init(createGameConfig({ fixedHz: 60, options: CLIENT }));
  const input = createInputState();
  press(input, key);
  // A client reads its own player's lane, as the client loop fills it.
  return guest.tick(createFrameInput({ frame: 0, players: [{ player: 1, seq: 0, input }] }))
    .commands;
}

describe('the keys', () => {
  it('R sends ready', () => {
    expect(sends(pressing('KeyR'), 'ready')).toEqual([{ to: undefined, payload: null }]);
  });

  it('G sends start', () => {
    expect(sends(pressing('KeyG'), 'start')).toEqual([{ to: undefined, payload: null }]);
  });

  it('1 to 6 vote for seats 0 to 5', () => {
    expect(sends(pressing('Digit1'), 'vote')).toEqual([{ to: undefined, payload: { for: 0 } }]);
    expect(sends(pressing('Digit6'), 'vote')).toEqual([{ to: undefined, payload: { for: 5 } }]);
    expect(sends(pressing('Digit7'), 'vote')).toEqual([]);
  });

  it('Enter sends nothing from the guest: the page opens the chat prompt', () => {
    const commands = pressing('Enter');
    expect(commands.filter((c) => c.tag === 'send')).toEqual([]);
  });
});

describe('the chat prompt', () => {
  it('sends trimmed text, and nothing for an empty line', () => {
    expect(chatPayload('  hi there ')).toEqual({ text: 'hi there' });
    expect(chatPayload('   ')).toBeNull();
  });
});
