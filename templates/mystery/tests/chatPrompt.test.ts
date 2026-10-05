// @vitest-environment jsdom
/**
 * The page's chat prompt: Enter on the page opens it, but Enter on a focused
 * button (Browse rooms, Join, the badge's) presses that button instead.
 */
import type { NetService } from 'gameable/net/client';
import { afterEach, describe, expect, it } from 'vitest';

import { installChatPrompt } from '../src/chatPrompt';

const net = { send: () => undefined } as unknown as NetService;
// jsdom has no pointer lock.
document.exitPointerLock = () => undefined;
let remove: (() => void) | null = null;

afterEach(() => {
  remove?.();
  remove = null;
  document.body.innerHTML = '';
});

/**
 * @param target Where the key goes.
 * @returns The keydown, after it was dispatched.
 */
function enter(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('the chat prompt', () => {
  it('opens on Enter when nothing in particular has focus', () => {
    const field = document.createElement('input');
    document.body.append(field);
    remove = installChatPrompt(net, field);
    const event = enter(document.body);
    expect(field.classList.contains('visible')).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Enter on a focused button to the button: no chat, the click still happens', () => {
    const field = document.createElement('input');
    const browse = document.createElement('button');
    browse.textContent = 'Browse rooms';
    document.body.append(field, browse);
    remove = installChatPrompt(net, field);
    browse.focus();
    const event = enter(browse);
    expect(field.classList.contains('visible')).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
