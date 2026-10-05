/**
 * The page's words and controls. No game rules and no service keys live here:
 * the game says whether talking is open (`near`), the talk wiring says what
 * the connection and the microphone are doing, and this shows it.
 */
import logoUrl from '../public/brand/icon-mint.png?url';
import type { VisitMode } from './visit';
import './style.css';

/** What each mode tells the visitor to do. */
const HINTS: Record<VisitMode, (name: string, touch: boolean) => string> = {
  chat: (name) => `Say hello to ${name}. Drag to look around.`,
  hangout: (name, touch) =>
    touch
      ? `Walk with the stick, or tap the floor. Come close to ${name} to talk.`
      : `Walk with WASD, or click the floor. Come close to ${name} to talk.`,
  show: (name) => `${name} is putting on a show. Say hello any time.`,
};

/** Ignore browser toolbar motion: only a keyboard-sized inset moves the chat. */
export function keyboardInset(
  layoutHeight: number,
  visibleHeight: number,
  offsetTop: number,
): number {
  const inset = Math.round(layoutHeight - visibleHeight - offsetTop);
  return inset >= 120 ? inset : 0;
}

/** Keep the stage still while a phone keyboard raises only the conversation. */
function watchKeyboard(): () => void {
  const viewport = window.visualViewport;
  if (!viewport || navigator.maxTouchPoints === 0) return () => {};
  const root = document.documentElement;
  const update = (): void => {
    const editing = document.activeElement?.id === 'question-text';
    const inset = editing
      ? keyboardInset(window.innerHeight, viewport.height, viewport.offsetTop)
      : 0;
    root.style.setProperty('--keyboard-inset', `${String(inset)}px`);
    root.toggleAttribute('data-keyboard', inset > 0);
    if (editing && inset > 0 && window.scrollY !== 0) window.scrollTo(0, 0);
  };
  viewport.addEventListener('resize', update);
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', update);
  return () => {
    viewport.removeEventListener('resize', update);
    document.removeEventListener('focusin', update);
    document.removeEventListener('focusout', update);
  };
}

/**
 * Find the page's controls.
 *
 * @param name The character's name.
 * @param mode The owner's mode.
 * @param touch Whether this is a touch screen.
 * @returns The controls and the calls that update them.
 */
export function createUi(name: string, mode: VisitMode, touch: boolean) {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const connect = $<HTMLButtonElement>('connect');
  const microphone = $<HTMLButtonElement>('microphone');
  const interrupt = $<HTMLButtonElement>('interrupt');
  const wave = $<HTMLButtonElement>('wave');
  const form = $<HTMLFormElement>('question');
  const input = $<HTMLInputElement>('question-text');
  const send = $<HTMLButtonElement>('send');
  const talkStatus = $('talk-status');
  const talkError = $('talk-error');
  const history = $('history');
  const meter = $('mic-wave');
  const micStatus = $('mic-status');
  const loading = $('loading');
  const bar = $('loading-bar');
  const status = $('status');
  const hint = $('hint');
  const wavePen = $<HTMLCanvasElement>('waveform').getContext('2d');
  const amplitude = new Float32Array(100);
  let cursor = 0;
  let micActive = false;
  let ready = false;
  let active = false;
  let near = mode !== 'hangout';
  const unwatch = watchKeyboard();
  if (wavePen) {
    wavePen.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--mint');
    wavePen.lineWidth = 2;
  }
  $<HTMLImageElement>('logo').src = logoUrl;
  $<HTMLLinkElement>('favicon').href = logoUrl;
  $('name').textContent = name;
  document.title = `${name} · Made with Gameable`;

  /** Talking is open when the character is on screen and (in hangout) the visitor is near. */
  const gate = (): void => {
    connect.disabled = !ready || (!near && !active);
    wave.disabled = !ready;
    if (!active)
      talkStatus.textContent = !ready
        ? `${name} is on the way…`
        : near
          ? `Say hello to ${name}`
          : `Walk up to ${name} to talk`;
  };
  gate();

  return {
    connect,
    microphone,
    interrupt,
    wave,
    form,
    input,
    get active() {
      return active;
    },
    get micActive() {
      return micActive;
    },
    /** Download progress, 0..1; 1 hides the bar. */
    progress(share: number) {
      bar.style.width = `${String(Math.round(Math.min(1, share) * 100))}%`;
      loading.setAttribute('aria-valuenow', String(Math.round(share * 100)));
      if (share >= 1) loading.hidden = true;
    },
    /** The character is on screen. */
    characterReady() {
      ready = true;
      loading.hidden = true;
      hint.textContent = HINTS[mode](name, touch);
      gate();
    },
    /** A failure the visitor should know about. */
    fail(message: string) {
      status.textContent = message;
      status.hidden = message === '';
      if (message) hint.textContent = 'Something went wrong';
    },
    /** The game's word on whether talking is open. */
    near(value: boolean) {
      near = value;
      gate();
    },
    /** A line the character says outside a conversation (the greeting): it opens the chat. */
    say(text: string) {
      this.message(name, text);
    },
    connection(state: string) {
      active = state !== 'closed';
      connect.textContent = active ? 'Stop talking' : 'Start talking';
      const canAsk =
        state === 'ready' || state === 'thinking' || state === 'waiting for interrupted response';
      send.disabled = input.disabled = microphone.disabled = !canAsk;
      input.placeholder = active
        ? 'Say hello, or ask something…'
        : 'Start talking, then say hello…';
      if (active)
        talkStatus.textContent =
          state === 'ready'
            ? 'Listening'
            : state === 'thinking'
              ? 'Thinking…'
              : state === 'waiting for interrupted response'
                ? 'Finishing the last answer…'
                : 'Connecting…';
      gate();
    },
    speaking(value: boolean) {
      interrupt.hidden = !value;
      if (value) talkStatus.textContent = `${name} is talking · interrupt to take a turn`;
      else if (active) talkStatus.textContent = 'Listening';
    },
    mic(state: string) {
      micActive = state !== 'IDLE' && state !== 'STARTING' && state !== 'ERROR';
      microphone.setAttribute('aria-pressed', String(micActive));
      microphone.dataset.starting = String(state === 'STARTING');
      microphone.textContent =
        state === 'STARTING'
          ? 'Starting microphone…'
          : micActive
            ? 'Microphone on'
            : 'Microphone off';
      meter.hidden = !micActive;
      micStatus.textContent =
        state === 'USER_SPEAKING'
          ? 'Hearing you'
          : state === 'AVATAR_SPEAKING' || state === 'ECHO_GUARD'
            ? 'Waiting for my turn'
            : 'Listening';
      if (!micActive) amplitude.fill(0);
    },
    level(value: number) {
      amplitude[cursor] = Math.min(1, Math.max(0, value * 8));
      cursor = (cursor + 1) % amplitude.length;
    },
    message(speaker: string, text: string) {
      if (!text) return;
      const row = document.createElement('p');
      if (speaker === 'You') row.className = 'player';
      const who = document.createElement('strong');
      who.textContent = speaker;
      row.append(who, document.createTextNode(text));
      history.append(row);
      while (history.childElementCount > 32) history.firstElementChild?.remove();
      history.scrollTop = history.scrollHeight;
    },
    error(message: string) {
      talkError.textContent = message;
      talkError.hidden = message === '';
    },
    frame() {
      if (!micActive || !wavePen) return;
      wavePen.clearRect(0, 0, 600, 36);
      wavePen.beginPath();
      for (let i = 0; i < amplitude.length; i++) {
        const height = Math.max(1, amplitude[(cursor + i) % amplitude.length] * 16);
        wavePen.moveTo(i * 6, 18 - height);
        wavePen.lineTo(i * 6, 18 + height);
      }
      wavePen.stroke();
    },
    dispose: unwatch,
  };
}

export type VisitUi = ReturnType<typeof createUi>;
