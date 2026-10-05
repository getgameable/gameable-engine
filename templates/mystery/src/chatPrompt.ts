/**
 * The page's chat prompt: Enter on the page (not on a focused button or
 * field) opens a one-line input, Enter again sends it
 * to the authority as a `chat` message, Escape closes it. The authority
 * cleans the line, caps it and echoes it to everyone; it comes back in this
 * player's HUD as a text row, never as HTML.
 *
 * Host code, split out of `src/main.ts`. While the input has focus the input
 * module ignores the keyboard (it releases held keys when a field takes
 * focus), so typing "r" or "1" never readies or votes.
 */
import type { NetService } from 'gameable/net/client';

import { CHAT_MAX_CHARS, chatPayload } from './chat';
import { Chat } from './messages';

/**
 * Wire the prompt to the page's room.
 *
 * @param net The engine's `net` service.
 * @param field The page's chat input, hidden until Enter.
 * @returns A function that removes the listeners.
 */
export function installChatPrompt(net: NetService, field: HTMLInputElement): () => void {
  field.maxLength = CHAT_MAX_CHARS;

  /** Show the field and give it the keyboard. */
  const open = (): void => {
    field.value = '';
    field.classList.add('visible');
    // A locked pointer keeps steering the camera while you type.
    if (document.pointerLockElement !== null) document.exitPointerLock();
    field.focus();
  };

  /** Hide the field; a click on the canvas takes the pointer back. */
  const close = (): void => {
    field.classList.remove('visible');
    field.blur();
  };

  const onPageKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.isComposing || event.target === field) return;
    // Enter on a focused button (Browse rooms, Join) or field is that control's; only the
    // page itself or the canvas opens chat.
    const target = event.target;
    if (target instanceof Element && target !== document.body && target.tagName !== 'CANVAS') {
      return;
    }
    event.preventDefault();
    open();
  };

  const onFieldKey = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const payload = chatPayload(field.value);
    if (payload !== null) net.send(Chat.name, payload);
    close();
  };

  window.addEventListener('keydown', onPageKey);
  field.addEventListener('keydown', onFieldKey);
  field.addEventListener('blur', close);
  return () => {
    window.removeEventListener('keydown', onPageKey);
    field.removeEventListener('keydown', onFieldKey);
    field.removeEventListener('blur', close);
  };
}
