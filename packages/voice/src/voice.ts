import type { EngineModule } from '@gameable/core';
import { wavToPcm16 } from './pcm';

/** The Voxy events consumed by this module. */
export interface CaptureEvents {
  'utterance-audio': { audio: Blob; sequenceId: number; durationMs: number };
  'barge-in': { sequenceId: number };
  'speech-start': { sequenceId: number };
  'state-change': { to: string; from: string | null };
  error: { code: string; message: string };
}
/** Structural port implemented by VoxyCore; permits injected capture in tests. */
export interface VoiceCapture {
  on<K extends keyof CaptureEvents>(event: K, handler: (value: CaptureEvents[K]) => void): void;
  off<K extends keyof CaptureEvents>(event: K, handler: (value: CaptureEvents[K]) => void): void;
  start(): Promise<void>;
  stop(): void;
  isStarted(): boolean;
  avatarSpeaking(): void;
  avatarIdle(): void;
}
/** Host callbacks, never called across the guest boundary. */
export interface VoiceOptions {
  /** Speaker-safe mode: suppress captured speech during playback and for this many milliseconds afterward. Omit for hands-free barge-in with headphones. */
  playbackEchoGuardMs?: number;
  /** Create a fresh VoxyCore configured with sampleRate: 16000. Called only by start. */
  createCapture(): VoiceCapture | Promise<VoiceCapture>;
  /** Send complete raw PCM to a credential-holding relay. */
  transcribe(pcm: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string>;
  onText(text: string): void;
  onInterrupt(): void;
  onStatus(status: string): void;
  onError(message: string): void;
}
/** Microphone lifecycle with independent transcription routing. */
export interface VoiceService {
  start(): Promise<void>;
  stop(): void;
  /** Keep VAD running, but cancel pending work and require a new utterance before routing audio. */
  setTranscribing(enabled: boolean): void;
  speaking(active: boolean): void;
}
/** Optional module with no capture, network or audio access until start. */
export interface VoiceModule extends EngineModule, VoiceService {}

/**
 * Build a Voxy lifecycle adapter. Each start after stop receives a new capture instance.
 *
 * @param options Capture factory, relay and presentation callbacks.
 * @returns A host module with explicit start/stop controls.
 */
export function voice(options: VoiceOptions): VoiceModule {
  let capture: VoiceCapture | undefined;
  let epoch = 0;
  let request: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let disposed = false;
  let speaking = false;
  let transcribing = true;
  let requireSpeechStart = options.playbackEchoGuardMs !== undefined;
  let sequence: number | undefined;
  let echoUntil = 0;
  const echoGuarded = (): boolean =>
    options.playbackEchoGuardMs !== undefined && (speaking || performance.now() < echoUntil);
  let turn = 0;
  let utteranceTimer: ReturnType<typeof setTimeout> | undefined;
  const clearUtteranceTimer = (): void => {
    clearTimeout(utteranceTimer);
    utteranceTimer = undefined;
  };
  const cancel = (): void => {
    turn++;
    request?.abort();
    request = undefined;
  };
  const speechStart = (value: CaptureEvents['speech-start']): void => {
    cancel();
    sequence = transcribing && !echoGuarded() ? value.sequenceId : undefined;
    clearUtteranceTimer();
    utteranceTimer = setTimeout(() => {
      stop();
      options.onError('Utterance exceeds 30 seconds; enable the microphone to retry');
    }, 30_000);
  };
  const interrupt = (): void => {
    cancel();
    if (transcribing && !echoGuarded()) options.onInterrupt();
  };
  const status = (value: CaptureEvents['state-change']): void => {
    options.onStatus(echoGuarded() && value.to === 'USER_SPEAKING' ? 'ECHO_GUARD' : value.to);
  };
  const error = (value: CaptureEvents['error']): void => {
    options.onError(value.message);
  };
  const utterance = (value: CaptureEvents['utterance-audio']): void => {
    clearUtteranceTimer();
    if (!transcribing || echoGuarded() || (requireSpeechStart && sequence !== value.sequenceId))
      return;
    sequence = undefined;
    cancel();
    const ownEpoch = epoch;
    const ownTurn = turn;
    const controller = new AbortController();
    request = controller;
    if (value.audio.size > 960128) {
      options.onError('Utterance exceeds 30 seconds');
      return;
    }
    void value.audio
      .arrayBuffer()
      .then(async (wav) => {
        if (epoch !== ownEpoch || turn !== ownTurn) return;
        const text = await options.transcribe(wavToPcm16(wav), controller.signal);
        if (
          epoch === ownEpoch &&
          turn === ownTurn &&
          !controller.signal.aborted &&
          text.trim() !== ''
        )
          options.onText(text.trim());
      })
      .catch(() => {
        if (epoch === ownEpoch && turn === ownTurn && !controller.signal.aborted)
          options.onError('Transcription failed; typed questions are still available');
      });
  };
  const stop = (): void => {
    clearUtteranceTimer();
    sequence = undefined;
    epoch++;
    cancel();
    pending = undefined;
    const old = capture;
    capture = undefined;
    if (old !== undefined) {
      old.off('speech-start', speechStart);
      old.off('barge-in', interrupt);
      old.off('state-change', status);
      old.off('error', error);
      old.off('utterance-audio', utterance);
      old.stop();
    }
    options.onStatus('IDLE');
  };
  const service: VoiceModule = {
    id: 'voice',
    init() {
      return service;
    },
    start() {
      if (disposed) return Promise.reject(new Error('Voice module disposed'));
      if (pending !== undefined) return pending;
      if (capture?.isStarted() === true) return Promise.resolve();
      const ownEpoch = ++epoch;
      pending = Promise.resolve()
        .then(() => options.createCapture())
        .then(async (fresh) => {
          if (epoch !== ownEpoch) {
            fresh.stop();
            return;
          }
          capture = fresh;
          fresh.on('speech-start', speechStart);
          fresh.on('barge-in', interrupt);
          fresh.on('state-change', status);
          fresh.on('error', error);
          fresh.on('utterance-audio', utterance);
          await fresh.start();
          if (epoch !== ownEpoch) {
            fresh.stop();
            return;
          }
          if (!fresh.isStarted()) {
            stop();
            options.onError('Microphone unavailable; typed questions are still available');
            return;
          }
          if (speaking) fresh.avatarSpeaking();
        })
        .catch(() => {
          if (epoch === ownEpoch) {
            stop();
            options.onError('Microphone unavailable; typed questions are still available');
          }
        })
        .finally(() => {
          if (epoch === ownEpoch) pending = undefined;
        });
      return pending;
    },
    stop,
    setTranscribing(enabled) {
      transcribing = enabled;
      requireSpeechStart = true;
      sequence = undefined;
      cancel();
    },
    speaking(active) {
      if (options.playbackEchoGuardMs !== undefined) {
        if (active) {
          sequence = undefined;
          cancel();
        } else if (speaking) {
          echoUntil = performance.now() + Math.max(0, options.playbackEchoGuardMs);
        }
      }
      speaking = active;
      if (active) capture?.avatarSpeaking();
      else capture?.avatarIdle();
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
  return service;
}
