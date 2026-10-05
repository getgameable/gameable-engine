import { describe, expect, it, vi } from 'vitest';
import { voice, type CaptureEvents, type VoiceCapture } from './voice';
import { wavToPcm16 } from './pcm';
class Capture implements VoiceCapture {
  handlers = new Map<keyof CaptureEvents, (value: unknown) => void>();
  started = false;
  on<K extends keyof CaptureEvents>(key: K, handler: (value: CaptureEvents[K]) => void): void {
    this.handlers.set(key, handler as (value: unknown) => void);
  }
  off(key: keyof CaptureEvents): void {
    this.handlers.delete(key);
  }
  emit<K extends keyof CaptureEvents>(key: K, value: CaptureEvents[K]): void {
    this.handlers.get(key)?.(value);
  }
  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }
  stop(): void {
    this.started = false;
  }
  isStarted(): boolean {
    return this.started;
  }
  avatarSpeaking(): void {
    /* fake capture */
  }
  avatarIdle(): void {
    /* fake capture */
  }
}
function wav(): ArrayBuffer {
  const bytes = new ArrayBuffer(48);
  const v = new DataView(bytes);
  for (const [offset, text] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const)
    for (let i = 0; i < text.length; i++) v.setUint8(offset + i, text.charCodeAt(i));
  v.setUint32(4, 40, true);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  v.setUint32(40, 4, true);
  v.setInt16(44, -32768, true);
  v.setInt16(46, 32767, true);
  return bytes;
}
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
describe('voice', () => {
  it('rejects speaker echo, its tail and utterances straddling the guard, then accepts fresh speech', async () => {
    vi.useFakeTimers();
    try {
      const c = new Capture();
      const transcribe = vi.fn(() => Promise.resolve('real question'));
      const onInterrupt = vi.fn();
      const onText = vi.fn();
      const mod = voice({
        createCapture: () => c,
        transcribe,
        onInterrupt,
        onText,
        onStatus: vi.fn(),
        onError: vi.fn(),
        playbackEchoGuardMs: 700,
      });
      await mod.start();
      const start = (sequenceId: number): void => {
        c.emit('barge-in', { sequenceId });
        c.emit('speech-start', { sequenceId });
      };
      const end = (sequenceId: number): void => {
        c.emit('utterance-audio', { sequenceId, audio: new Blob([wav()]), durationMs: 100 });
      };
      mod.speaking(true);
      start(1);
      end(1);
      mod.speaking(false);
      await vi.advanceTimersByTimeAsync(600);
      start(2);
      await vi.advanceTimersByTimeAsync(101);
      end(2); // Echo that starts inside the tail is still rejected outside it.
      await vi.advanceTimersByTimeAsync(0);
      expect(transcribe).not.toHaveBeenCalled();
      expect(onInterrupt).not.toHaveBeenCalled();
      start(3);
      end(3);
      await vi.advanceTimersByTimeAsync(0);
      expect(transcribe).toHaveBeenCalledOnce();
      expect(onText).toHaveBeenCalledWith('real question');
      mod.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps VAD warm while gating exploration, in-flight turns and speech spanning interview switches', async () => {
    const c = new Capture();
    const createCapture = vi.fn(() => c);
    const onText = vi.fn();
    const onInterrupt = vi.fn();
    let finish!: (text: string) => void;
    const transcribe = vi.fn<(pcm: Uint8Array, signal: AbortSignal) => Promise<string>>(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const mod = voice({
      createCapture,
      transcribe,
      onText,
      onInterrupt,
      onStatus: vi.fn(),
      onError: vi.fn(),
    });
    const start = (sequenceId: number): void => {
      c.emit('speech-start', { sequenceId });
    };
    const end = (sequenceId: number): void => {
      c.emit('utterance-audio', { audio: new Blob([wav()]), sequenceId, durationMs: 1 });
    };
    mod.setTranscribing(false);
    await mod.start();
    start(1);
    end(1);
    c.emit('barge-in', { sequenceId: 2 });
    await settle();
    expect(transcribe).not.toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();
    start(2);
    mod.setTranscribing(true);
    end(2);
    await settle();
    expect(transcribe).not.toHaveBeenCalled();
    start(3);
    end(3);
    await settle();
    expect(transcribe).toHaveBeenCalledOnce();
    mod.setTranscribing(true); // Switch suspect without rebuilding capture.
    expect(transcribe.mock.calls[0][1].aborted).toBe(true);
    finish('wrong suspect');
    await settle();
    expect(onText).not.toHaveBeenCalled();
    start(4);
    mod.setTranscribing(true);
    end(4);
    await settle();
    expect(transcribe).toHaveBeenCalledOnce();
    start(5);
    end(5);
    await settle();
    finish('fresh question');
    await settle();
    expect(onText).toHaveBeenCalledWith('fresh question');
    await mod.start();
    expect(createCapture).toHaveBeenCalledOnce();
    expect(c.started).toBe(true);
    mod.dispose();
    expect(c.started).toBe(false);
  });
  it('validates and extracts exact little endian PCM, rejecting stereo and truncation', () => {
    expect([...wavToPcm16(wav())]).toEqual([0, 128, 255, 127]);
    const stereo = wav();
    new DataView(stereo).setUint16(22, 2, true);
    expect(() => wavToPcm16(stereo)).toThrow('mono');
    expect(() => wavToPcm16(wav().slice(0, 46))).toThrow();
  });
  it('is inert until start, coalesces starts and releases capture across interviews', async () => {
    const captures: Capture[] = [];
    const createCapture = vi.fn(() => {
      const c = new Capture();
      captures.push(c);
      return c;
    });
    const mod = voice({
      createCapture,
      transcribe: vi.fn(),
      onText: vi.fn(),
      onInterrupt: vi.fn(),
      onStatus: vi.fn(),
      onError: vi.fn(),
    });
    expect(createCapture).not.toHaveBeenCalled();
    const one = mod.start();
    expect(mod.start()).toBe(one);
    await one;
    mod.stop();
    expect(captures[0].handlers.size).toBe(0);
    expect(captures[0].started).toBe(false);
    await mod.start();
    expect(captures).toHaveLength(2);
    mod.dispose();
    await expect(mod.start()).rejects.toThrow('disposed');
  });
  it('drops a transcript completed after interruption or stopping', async () => {
    const c = new Capture();
    let finish: (text: string) => void = () => {};
    const onText = vi.fn();
    const onInterrupt = vi.fn();
    const transcribe = vi.fn<(pcm: Uint8Array, signal: AbortSignal) => Promise<string>>(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const mod = voice({
      createCapture: () => c,
      transcribe,
      onText,
      onInterrupt,
      onStatus: vi.fn(),
      onError: vi.fn(),
    });
    await mod.start();
    c.emit('utterance-audio', { audio: new Blob([wav()]), sequenceId: 1, durationMs: 1 });
    await settle();
    c.emit('barge-in', { sequenceId: 2 });
    finish('stale');
    await settle();
    expect(onText).not.toHaveBeenCalled();
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(transcribe.mock.calls[0][1].aborted).toBe(true);
    mod.dispose();
  });
  it('stops capture whose factory resolves after disposal', async () => {
    const c = new Capture();
    let resolve!: (c: Capture) => void;
    const mod = voice({
      createCapture: () =>
        new Promise<VoiceCapture>((r) => {
          resolve = r;
        }),
      transcribe: vi.fn(),
      onText: vi.fn(),
      onInterrupt: vi.fn(),
      onStatus: vi.fn(),
      onError: vi.fn(),
    });
    const start = mod.start();
    await Promise.resolve();
    mod.dispose();
    resolve(c);
    await start;
    expect(c.started).toBe(false);
    expect(c.handlers.size).toBe(0);
  });
  it('bounds uninterrupted capture and releases the microphone after thirty seconds', async () => {
    vi.useFakeTimers();
    try {
      const c = new Capture();
      const onError = vi.fn();
      const mod = voice({
        createCapture: () => c,
        transcribe: vi.fn(),
        onText: vi.fn(),
        onInterrupt: vi.fn(),
        onStatus: vi.fn(),
        onError,
      });
      await mod.start();
      c.emit('speech-start', { sequenceId: 1 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(c.started).toBe(false);
      expect(c.handlers.size).toBe(0);
      expect(onError).toHaveBeenCalledOnce();
      mod.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it('reports microphone denial without starting transcription', async () => {
    const onError = vi.fn();
    const transcribe = vi.fn();
    const mod = voice({
      createCapture: () => {
        throw new Error('permission denied');
      },
      transcribe,
      onText: vi.fn(),
      onInterrupt: vi.fn(),
      onStatus: vi.fn(),
      onError,
    });
    await mod.start();
    expect(onError).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
  });
});
