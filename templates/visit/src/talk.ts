/**
 * Talking: the hello world's conversation and lip-sync wiring
 * (examples/wasm-hello/src/talk.ts), pointed at the page's own relay.
 *
 * Microphone capture and speech-to-text, the relay's socket, spoken replies and
 * the face that moves with them all stay here in the page; only semantic
 * events cross into the game (`start`, `end`, what the visitor said) and only
 * `conversation.command` comes back. The game decides when talking is allowed.
 */
import { conversation, createSpeechPlayer } from 'gameable/conversation';
import type { Engine } from 'gameable/core';
import type { ConversationCmd, GameEvent } from 'gameable';
import { voice } from 'gameable/voice';
import type { CharacterBridge } from 'gameable/host/characters';
import vadUrl from '@gameable/voxy/models/silero_vad.onnx?url';
import noiseUrl from '@gameable/voxy/wasm/rnnoise.wasm?url';
import type { VisitUi } from './ui';

/** The character's entity: the first thing the game spawns. */
export const CHARACTER = 1;

/** What the talk wiring needs from the page's inputs. */
export interface TalkConfig {
  talk: string;
  id: string;
  name: string;
}

/**
 * Wire the relay, the microphone and the speech player to the page's controls.
 *
 * @param engine The booted engine (its audio module plays the replies).
 * @param characters The character bridge (the face and gestures).
 * @param ui The page's controls.
 * @param config Where the relay is and what it calls the character.
 * @returns The page's side of the conversation.
 */
export function createTalk(
  engine: Engine,
  characters: CharacterBridge,
  ui: VisitUi,
  config: TalkConfig,
) {
  const audio = engine.get('audio');
  const base = new URL(config.talk);
  const socketUrl = new URL(`conversation?character=${config.id}`, base);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  let enqueue: ((event: GameEvent) => void) | undefined;
  let pendingMic = false;
  let disposed = false;
  const emit = (kind: 'input' | 'status', text: string): void => {
    enqueue?.({ tag: 'conversation-event', val: { entity: CHARACTER, kind, text } });
  };
  const player = createSpeechPlayer(
    audio.context,
    {
      subtitle(text) {
        if (text) ui.message(config.name, text);
      },
      expression(weights) {
        characters.setExpression(CHARACTER, 'arkit52', weights);
      },
      gesture(id) {
        // Only play a clip that this rig actually carries.
        const entry = characters.entryOf(CHARACTER);
        if (entry?.clips.includes(id)) entry.animator?.gesture.play(id);
      },
      speaking(active) {
        mic.speaking(active);
        ui.speaking(active);
      },
      reset() {
        characters.entryOf(CHARACTER)?.animator?.gesture.stop();
      },
    },
    audio.buses.voice,
  );
  const interviews = conversation({
    characters: { visit: { storyId: config.id, url: socketUrl.href } },
    player,
    onStory() {},
    onStatus(state) {
      ui.connection(state);
      if (state === 'closed') {
        mic.setTranscribing(false);
        mic.stop();
      } else if (state === 'ready') mic.setTranscribing(true);
    },
    onError() {
      ui.error(`Could not reach ${config.name}. Start talking again to retry.`);
    },
  });
  const mic = voice({
    playbackEchoGuardMs: 700,
    async createCapture() {
      const { VoxyCore } = await import('@gameable/voxy/core');
      const capture = new VoxyCore({
        sampleRate: 16000,
        modelUrl: vadUrl,
        noiseSuppressionUrl: noiseUrl,
      });
      capture.on('vad-frame', ({ amplitude }) => ui.level(amplitude));
      return capture;
    },
    async transcribe(pcm, signal) {
      const response = await fetch(new URL('transcribe', base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm,
        signal,
      });
      if (!response.ok) throw new Error('Listening is not available right now');
      const data = (await response.json()) as { text?: unknown };
      if (typeof data.text !== 'string') throw new Error('Listening is not available right now');
      return data.text;
    },
    onText(text) {
      if (ui.active) emit('input', text);
    },
    onInterrupt() {
      interviews.interrupt();
    },
    onStatus(state) {
      ui.mic(state);
    },
    onError(message) {
      ui.error(message);
    },
  });
  mic.setTranscribing(false);
  /** Every control first unlocks audio: a browser plays sound only after a tap. */
  const activate = (action: string): void => {
    ui.error('');
    void audio.context
      .resume()
      .then(() => {
        if (!disposed) emit('status', action);
      })
      .catch(() => ui.error('Sound could not start. Try the button again.'));
  };
  ui.connect.onclick = () => activate(ui.active ? 'end' : 'start');
  ui.wave.onclick = () => activate('wave');
  ui.interrupt.onclick = () => activate('interrupt');
  ui.microphone.onclick = () => {
    if (pendingMic) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      ui.error('The microphone needs a secure page. You can still type.');
      return;
    }
    activate(ui.micActive ? 'microphone-off' : 'microphone-on');
  };
  ui.form.onsubmit = (event) => {
    event.preventDefault();
    const text = ui.input.value.trim();
    if (!text || ui.input.disabled) return;
    ui.error('');
    void audio.context
      .resume()
      .then(() => {
        if (!disposed) {
          emit('input', text);
          ui.input.value = '';
        }
      })
      .catch(() => ui.error('Sound could not start. Try Send again.'));
  };
  return {
    /** Where status lines and what the visitor said go: the game's event queue. */
    bind(sink: (event: GameEvent) => void) {
      enqueue = sink;
    },
    /** A status line for the game, from the page (not from a control). */
    tell(text: string) {
      emit('status', text);
    },
    /** What the game asked for. */
    command(command: ConversationCmd) {
      if (disposed || command.entity !== CHARACTER) return;
      if (command.action === 'start') interviews.start('visit');
      else if (command.action === 'end') {
        mic.stop();
        interviews.end();
      } else if (command.action === 'ask') {
        if (interviews.ask(command.text)) ui.message('You', command.text);
        else ui.error('Wait for the connection, then send your message again.');
      } else if (command.action === 'interrupt') interviews.interrupt();
      else if (command.action === 'microphone-off') mic.stop();
      else if (command.action === 'microphone-on' && !pendingMic) {
        pendingMic = true;
        ui.mic('STARTING');
        void mic.start().finally(() => {
          pendingMic = false;
        });
      }
    },
    update() {
      interviews.update?.(0, 0);
    },
    dispose() {
      disposed = true;
      mic.dispose();
      interviews.dispose();
      ui.connect.onclick = ui.microphone.onclick = ui.interrupt.onclick = ui.wave.onclick = null;
      ui.form.onsubmit = null;
    },
  };
}
