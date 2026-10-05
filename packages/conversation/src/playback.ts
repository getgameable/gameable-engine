/** Face frames use ARKit-52 ordering, with seconds relative to their audio chunk. */
export interface FaceFrame {
  timeCode: number;
  blendshapeWeights: readonly number[];
}
/** One bounded speech performance, already decoded from the service wire format. */
export interface SpeechChunk {
  pcm: Uint8Array;
  text: string;
  frames: readonly FaceFrame[];
  gesture?: string;
}
/** Presentation callbacks run on the audio clock. */
export interface SpeechPresentation {
  subtitle(text: string): void;
  expression(weights: Float32Array): void;
  gesture(id: string): void;
  speaking(active: boolean): void;
  reset(): void;
}
interface Scheduled {
  source: AudioBufferSourceNode;
  start: number;
  end: number;
  chunk: SpeechChunk;
  announced: boolean;
  cursor: number;
}
/** Audio-clock speech queue; update reuses a single facial vector. */
export interface SpeechPlayer {
  enqueue(chunk: SpeechChunk): void;
  update(): void;
  stop(): void;
  dispose(): void;
}
/**
 * Build a bounded PCM player. The caller creates/resumes the context in a user gesture.
 *
 * @param context Shared or dedicated audio clock.
 * @param presentation Subtitles, gestures and facial rig.
 * @param destination Voice bus; defaults to the context destination.
 * @returns A player which owns only its sources, not the context.
 */
export function createSpeechPlayer(
  context: AudioContext,
  presentation: SpeechPresentation,
  destination: AudioNode = context.destination,
): SpeechPlayer {
  const queue: Scheduled[] = [];
  const weights = new Float32Array(52);
  let end = 0;
  let active = false;
  let disposed = false;
  const stop = (): void => {
    for (const item of queue) {
      item.source.onended = null;
      item.source.stop();
      item.source.disconnect();
    }
    queue.length = 0;
    end = context.currentTime;
    weights.fill(0);
    presentation.expression(weights);
    presentation.subtitle('');
    presentation.reset();
    if (active) presentation.speaking(false);
    active = false;
  };
  return {
    enqueue(chunk) {
      if (disposed) throw new Error('Speech player disposed');
      if (
        chunk.pcm.length === 0 ||
        chunk.pcm.length % 2 !== 0 ||
        chunk.pcm.length > 960000 ||
        chunk.frames.length > 1800 ||
        chunk.text.length > 8192
      )
        throw new Error('Invalid speech chunk');
      const duration = chunk.pcm.length / 32000;
      const start = Math.max(context.currentTime + 0.02, end);
      if (queue.length >= 64 || start + duration - context.currentTime > 30)
        throw new Error('Speech buffer full');
      let previous = -1;
      for (const frame of chunk.frames) {
        if (
          !Number.isFinite(frame.timeCode) ||
          frame.timeCode < previous ||
          frame.timeCode < 0 ||
          frame.timeCode > 30 ||
          frame.blendshapeWeights.length !== 52 ||
          frame.blendshapeWeights.some((v) => !Number.isFinite(v))
        )
          throw new Error('Invalid facial track');
        previous = frame.timeCode;
      }
      const buffer = context.createBuffer(1, chunk.pcm.length / 2, 16000);
      const channel = buffer.getChannelData(0);
      const view = new DataView(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength);
      for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      try {
        source.start(start);
      } catch (error) {
        source.disconnect();
        throw error;
      }
      end = start + duration;
      queue.push({ source, start, end, chunk, announced: false, cursor: 0 });
    },
    update() {
      const now = context.currentTime;
      while (queue.length > 0 && queue[0].end <= now) {
        queue[0].source.disconnect();
        queue.shift();
      }
      const item = queue.at(0);
      if (item === undefined) {
        if (active) {
          weights.fill(0);
          presentation.expression(weights);
          presentation.subtitle('');
          presentation.reset();
          presentation.speaking(false);
          active = false;
        }
        return;
      }
      if (now < item.start) return;
      if (!item.announced) {
        item.announced = true;
        presentation.subtitle(item.chunk.text);
        if (item.chunk.gesture !== undefined) presentation.gesture(item.chunk.gesture);
        if (!active) {
          active = true;
          presentation.speaking(true);
        }
      }
      const frames = item.chunk.frames;
      const time = now - item.start;
      if (frames.length === 0) {
        weights.fill(0);
        presentation.expression(weights);
        return;
      }
      while (item.cursor + 1 < frames.length && frames[item.cursor + 1].timeCode <= time)
        item.cursor++;
      const a = frames[item.cursor];
      const b = frames[Math.min(item.cursor + 1, frames.length - 1)];
      const mix =
        b.timeCode > a.timeCode
          ? Math.max(0, Math.min(1, (time - a.timeCode) / (b.timeCode - a.timeCode)))
          : 0;
      for (let i = 0; i < 52; i++)
        weights[i] = Math.max(
          0,
          Math.min(
            1,
            a.blendshapeWeights[i] + (b.blendshapeWeights[i] - a.blendshapeWeights[i]) * mix,
          ),
        );
      presentation.expression(weights);
    },
    stop,
    dispose() {
      stop();
      disposed = true;
    },
  };
}
