import { conversation, createSpeechPlayer } from 'gameable/conversation';
import type { Engine } from 'gameable/core';
import type { ConversationCmd, GameEvent } from 'gameable';
import { voice } from 'gameable/voice';
import type { CharacterBridge } from 'gameable/host/characters';
import vadUrl from '@gameable/voxy/models/silero_vad.onnx?url';
import noiseUrl from '@gameable/voxy/wasm/rnnoise.wasm?url';
import type { HelloConfig } from './config';
import type { HelloUi } from './ui';

/** Voxy input and Convorcher audio/face playback stay in the host. */
export function createTalkHost(
  engine: Engine,
  characters: CharacterBridge,
  ui: HelloUi,
  config: HelloConfig,
) {
  const audio = engine.get('audio');
  const base = new URL(config.talk);
  const socketUrl = new URL(`conversation?character=${config.id}`, base);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  let enqueue: ((event: GameEvent) => void) | undefined;
  let pendingMic = false;
  let disposed = false;
  const emit = (kind: 'input' | 'status', text: string): void => {
    enqueue?.({ tag: 'conversation-event', val: { entity: 1, kind, text } });
  };
  const player = createSpeechPlayer(
    audio.context,
    {
      subtitle(text) {
        if (text) ui.message(config.name, text);
      },
      expression(weights) {
        characters.setExpression(1, 'arkit52', weights);
      },
      gesture(id) {
        // Only play a clip that this exported rig actually provides.
        const entry = characters.entryOf(1);
        if (entry?.clips.includes(id)) entry.animator?.gesture.play(id);
      },
      speaking(active) {
        mic.speaking(active);
        ui.speaking(active);
      },
      reset() {
        characters.entryOf(1)?.animator?.gesture.stop();
      },
    },
    audio.buses.voice,
  );
  const interviews = conversation({
    characters: { greeter: { storyId: 'engine-hello', url: socketUrl.href } },
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
      ui.error('Could not connect to the character. Start the conversation again to retry.');
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
      if (!response.ok) throw new Error('Transcription unavailable');
      const data = (await response.json()) as { text?: unknown };
      if (typeof data.text !== 'string') throw new Error('Invalid transcript');
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
  const activate = (action: string): void => {
    ui.error('');
    void audio.context
      .resume()
      .then(() => {
        if (!disposed) emit('status', action);
      })
      .catch(() => ui.error('Audio could not start. Try the button again.'));
  };
  ui.connect.onclick = () => activate(ui.active ? 'end' : 'start');
  ui.wave.onclick = () => emit('status', 'wave');
  ui.interrupt.onclick = () => activate('interrupt');
  ui.microphone.onclick = () => {
    if (pendingMic) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      ui.error('Open this page over HTTPS or localhost to use the microphone. You can still type.');
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
      .catch(() => ui.error('Audio could not start. Try Send again.'));
  };
  return {
    bind(sink: (event: GameEvent) => void) {
      enqueue = sink;
    },
    command(command: ConversationCmd) {
      if (disposed || command.entity !== 1) return;
      if (command.action === 'start') interviews.start('greeter');
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
