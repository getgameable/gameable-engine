import logoUrl from '../../../docs/public/brand/icon-mint.png?url';
import { FrameRate, watchKeyboard } from './presentation';
import './style.css';

/** The small example's DOM; no service credentials or game logic live here. */
export function createUi() {
  const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const connect = element<HTMLButtonElement>('connect');
  const microphone = element<HTMLButtonElement>('microphone');
  const interrupt = element<HTMLButtonElement>('interrupt');
  const wave = element<HTMLButtonElement>('wave');
  const form = element<HTMLFormElement>('question');
  const input = element<HTMLInputElement>('question-text');
  const send = element<HTMLButtonElement>('send');
  const status = element('talk-status');
  const error = element('talk-error');
  const history = element('history');
  const meter = element('mic-wave');
  const micStatus = element('mic-status');
  const fps = element('fps');
  const canvas = element<HTMLCanvasElement>('waveform');
  const pen = canvas.getContext('2d');
  const amplitude = new Float32Array(100);
  let cursor = 0;
  let micActive = false;
  let ready = false;
  let active = false;
  const rate = new FrameRate();
  const unwatchKeyboard = watchKeyboard();
  if (pen) {
    pen.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--mint').trim();
    pen.lineWidth = 2;
  }
  element<HTMLImageElement>('gameable-logo').src = logoUrl;
  element<HTMLLinkElement>('favicon').href = logoUrl;
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
    characterReady() {
      ready = true;
      connect.disabled = false;
      wave.disabled = false;
    },
    connection(state: string) {
      active = state !== 'closed';
      connect.disabled = !ready;
      connect.textContent = active ? 'End conversation' : 'Start conversation';
      const canAsk =
        state === 'ready' || state === 'thinking' || state === 'waiting for interrupted response';
      send.disabled = input.disabled = microphone.disabled = !canAsk;
      input.placeholder = active
        ? 'Say hello, or ask a question…'
        : 'Start a conversation, then say hello…';
      status.textContent =
        state === 'ready'
          ? 'Ready to listen'
          : state === 'closed'
            ? 'Say hello to your character'
            : state === 'thinking'
              ? 'Thinking…'
              : state === 'waiting for interrupted response'
                ? 'Finishing the previous turn…'
                : 'Connecting…';
    },
    speaking(value: boolean) {
      interrupt.hidden = !value;
      if (value) status.textContent = 'Speaking · interrupt to take a turn';
      else if (active) status.textContent = 'Ready to listen';
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
            ? 'Echo guard · interrupt to speak'
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
      const name = document.createElement('strong');
      name.textContent = speaker;
      row.append(name, document.createTextNode(text));
      history.append(row);
      while (history.childElementCount > 32) history.firstElementChild?.remove();
      history.scrollTop = history.scrollHeight;
    },
    error(message: string) {
      error.textContent = message;
      error.hidden = message === '';
    },
    frame(now: number) {
      const next = rate.sample(now);
      if (next !== null) fps.textContent = String(next);
      if (!micActive || !pen) return;
      pen.clearRect(0, 0, 600, 36);
      pen.beginPath();
      for (let i = 0; i < amplitude.length; i++) {
        const height = Math.max(1, amplitude[(cursor + i) % amplitude.length] * 16);
        pen.moveTo(i * 6, 18 - height);
        pen.lineTo(i * 6, 18 + height);
      }
      pen.stroke();
    },
    dispose: unwatchKeyboard,
  };
}

export type HelloUi = ReturnType<typeof createUi>;
