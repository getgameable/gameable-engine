/**
 * A dependency-free fake `AudioContext`, enough of one to run
 * `gameable/audio` under vitest's node environment.
 *
 * It records every node it creates and every connection made between them, so
 * a test can assert on routing and parameter values instead of on sound. It is
 * exported from `gameable/audio/testing` so other packages' tests can drive
 * the audio module without a browser.
 */

/** A recorded `AudioParam`. Only `value` matters to the engine. */
export interface FakeAudioParam {
  /** Current value. */
  value: number;
  /**
   * Schedule a value. Recorded, then applied immediately.
   *
   * @param value The value to set.
   * @param when Context time, recorded only.
   * @returns This param, matching the WebAudio fluent API.
   */
  setValueAtTime(value: number, when: number): FakeAudioParam;
}

/** What kind of node a {@link FakeAudioNode} is. */
export type FakeNodeKind = 'destination' | 'gain' | 'panner' | 'source';

/** The common node surface: a kind tag and a record of outgoing connections. */
export interface FakeAudioNode {
  /** Discriminant. */
  readonly kind: FakeNodeKind;
  /** Nodes this one is currently connected to, in connection order. */
  readonly outputs: FakeAudioNode[];
  /**
   * Connect to another node.
   *
   * @param destination The node to feed.
   * @returns `destination`, matching the WebAudio chaining API.
   */
  connect(destination: FakeAudioNode): FakeAudioNode;
  /** Drop every outgoing connection. */
  disconnect(): void;
}

/** A fake `GainNode`. */
export interface FakeGainNode extends FakeAudioNode {
  /** Discriminant. */
  readonly kind: 'gain';
  /** Linear gain. */
  readonly gain: FakeAudioParam;
}

/** A fake `PannerNode`. */
export interface FakePannerNode extends FakeAudioNode {
  /** Discriminant. */
  readonly kind: 'panner';
  /** Set to `'HRTF'` by the engine for every positional voice. */
  panningModel: string;
  /** Distance attenuation curve. */
  distanceModel: string;
  /** World x. */
  readonly positionX: FakeAudioParam;
  /** World y. */
  readonly positionY: FakeAudioParam;
  /** World z. */
  readonly positionZ: FakeAudioParam;
}

/** A fake `AudioBufferSourceNode`. */
export interface FakeBufferSourceNode extends FakeAudioNode {
  /** Discriminant. */
  readonly kind: 'source';
  /** The buffer handed to it, or null. */
  buffer: AudioBuffer | null;
  /** Whether it loops. */
  loop: boolean;
  /** End-of-playback handler; the engine clears it before stopping a voice. */
  onended: (() => void) | null;
  /** How many times `start` was called. */
  startCount: number;
  /** How many times `stop` was called. */
  stopCount: number;
  /**
   * Begin playback.
   *
   * @param when Context time, recorded only.
   */
  start(when?: number): void;
  /**
   * End playback. Does not fire `onended`; call it yourself to simulate the
   * browser's asynchronous notification.
   *
   * @param when Context time, recorded only.
   */
  stop(when?: number): void;
  /** Fire `onended`, as the browser would when the buffer runs out. */
  end(): void;
}

/** A fake `AudioListener`, as nine plain params. */
export interface FakeAudioListener {
  /** World x. */
  readonly positionX: FakeAudioParam;
  /** World y. */
  readonly positionY: FakeAudioParam;
  /** World z. */
  readonly positionZ: FakeAudioParam;
  /** Forward x. */
  readonly forwardX: FakeAudioParam;
  /** Forward y. */
  readonly forwardY: FakeAudioParam;
  /** Forward z. */
  readonly forwardZ: FakeAudioParam;
  /** Up x. */
  readonly upX: FakeAudioParam;
  /** Up y. */
  readonly upY: FakeAudioParam;
  /** Up z. */
  readonly upZ: FakeAudioParam;
}

/** Options for {@link createFakeAudioContext}. */
export interface FakeAudioContextOptions {
  /** Initial `state`. Defaults to `'suspended'`, like a real page. */
  state?: AudioContextState;
  /** Duration, in seconds, of buffers produced by `decodeAudioData`. Defaults to 1. */
  decodedDuration?: number;
}

/** The fake context, plus the inspection surface tests actually use. */
export interface FakeAudioContext {
  /** Playback state. */
  state: AudioContextState;
  /** Context clock, seconds. Advance it yourself if a test cares. */
  currentTime: number;
  /** The graph sink. */
  readonly destination: FakeAudioNode;
  /** The listener. */
  readonly listener: FakeAudioListener;
  /** Every gain node created, in creation order. */
  readonly gains: FakeGainNode[];
  /** Every panner created, in creation order. */
  readonly panners: FakePannerNode[];
  /** Every buffer source created, in creation order. */
  readonly sources: FakeBufferSourceNode[];
  /** Every buffer handed to `decodeAudioData`, in call order. */
  readonly decodeCalls: ArrayBuffer[];
  /** How many times `resume` was called. */
  resumeCount: number;
  /** Whether `close` was called. */
  closed: boolean;
  /**
   * Create a gain node.
   *
   * @returns The new node, also pushed onto `gains`.
   */
  createGain(): FakeGainNode;
  /**
   * Create a buffer source.
   *
   * @returns The new node, also pushed onto `sources`.
   */
  createBufferSource(): FakeBufferSourceNode;
  /**
   * Create a panner.
   *
   * @returns The new node, also pushed onto `panners`.
   */
  createPanner(): FakePannerNode;
  /**
   * Pretend to decode.
   *
   * @param data Encoded bytes; recorded on `decodeCalls`.
   * @returns A fake buffer of `options.decodedDuration` seconds.
   */
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  /**
   * Move to `'running'`.
   *
   * @returns Resolves immediately.
   */
  resume(): Promise<void>;
  /**
   * Move to `'closed'`.
   *
   * @returns Resolves immediately.
   */
  close(): Promise<void>;
}

/**
 * Build a param.
 *
 * @param initial Starting value.
 * @returns A fake param.
 */
function param(initial: number): FakeAudioParam {
  const p: FakeAudioParam = {
    value: initial,
    setValueAtTime(value: number): FakeAudioParam {
      p.value = value;
      return p;
    },
  };
  return p;
}

/**
 * Build the connection-recording half of a node.
 *
 * @param kind Node discriminant.
 * @returns A bare node.
 */
function node(kind: FakeNodeKind): FakeAudioNode {
  const outputs: FakeAudioNode[] = [];
  return {
    kind,
    outputs,
    connect(destination: FakeAudioNode): FakeAudioNode {
      outputs.push(destination);
      return destination;
    },
    disconnect(): void {
      outputs.length = 0;
    },
  };
}

/**
 * A stand-in `AudioBuffer` of a fixed duration.
 *
 * @param duration Seconds.
 * @param sampleRate Samples per second. Defaults to 48000.
 * @returns A buffer the engine can hand to a source node.
 *
 * @example
 * ```ts
 * import { createFakeAudioBuffer } from 'gameable/audio/testing';
 *
 * const buffer = createFakeAudioBuffer(0.5);
 * ```
 */
export function createFakeAudioBuffer(duration: number, sampleRate = 48_000): AudioBuffer {
  const length = Math.max(1, Math.round(duration * sampleRate));
  const data = new Float32Array(length);
  const buffer = {
    duration,
    length,
    numberOfChannels: 1,
    sampleRate,
    getChannelData: (): Float32Array => data,
    copyFromChannel: (): void => undefined,
    copyToChannel: (): void => undefined,
  };
  return buffer as unknown as AudioBuffer;
}

/**
 * Create a fake context.
 *
 * @param options Initial state and decoded buffer duration.
 * @returns The fake; pass `asAudioContext(fake)` to `createAudioEngine`.
 *
 * @example
 * ```ts
 * import { asAudioContext, createFakeAudioContext } from 'gameable/audio/testing';
 * import { createAudioEngine } from 'gameable/audio';
 *
 * const fake = createFakeAudioContext();
 * const engine = createAudioEngine({ context: asAudioContext(fake) });
 * ```
 */
export function createFakeAudioContext(options: FakeAudioContextOptions = {}): FakeAudioContext {
  const decodedDuration = options.decodedDuration ?? 1;
  const gains: FakeGainNode[] = [];
  const panners: FakePannerNode[] = [];
  const sources: FakeBufferSourceNode[] = [];
  const decodeCalls: ArrayBuffer[] = [];

  const context: FakeAudioContext = {
    state: options.state ?? 'suspended',
    currentTime: 0,
    destination: node('destination'),
    listener: {
      positionX: param(0),
      positionY: param(0),
      positionZ: param(0),
      forwardX: param(0),
      forwardY: param(0),
      forwardZ: param(-1),
      upX: param(0),
      upY: param(1),
      upZ: param(0),
    },
    gains,
    panners,
    sources,
    decodeCalls,
    resumeCount: 0,
    closed: false,

    createGain(): FakeGainNode {
      const gain: FakeGainNode = { ...node('gain'), kind: 'gain', gain: param(1) };
      gains.push(gain);
      return gain;
    },

    createPanner(): FakePannerNode {
      const panner: FakePannerNode = {
        ...node('panner'),
        kind: 'panner',
        panningModel: 'equalpower',
        distanceModel: 'inverse',
        positionX: param(0),
        positionY: param(0),
        positionZ: param(0),
      };
      panners.push(panner);
      return panner;
    },

    createBufferSource(): FakeBufferSourceNode {
      const source: FakeBufferSourceNode = {
        ...node('source'),
        kind: 'source',
        buffer: null,
        loop: false,
        onended: null,
        startCount: 0,
        stopCount: 0,
        start(): void {
          source.startCount += 1;
        },
        stop(): void {
          source.stopCount += 1;
        },
        end(): void {
          source.onended?.();
        },
      };
      sources.push(source);
      return source;
    },

    decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
      decodeCalls.push(data);
      return Promise.resolve(createFakeAudioBuffer(decodedDuration));
    },

    resume(): Promise<void> {
      context.resumeCount += 1;
      context.state = 'running';
      return Promise.resolve();
    },

    close(): Promise<void> {
      context.closed = true;
      context.state = 'closed';
      return Promise.resolve();
    },
  };

  return context;
}

/**
 * View a fake as the DOM `AudioContext` the engine's types ask for.
 *
 * This is the one unsound cast in the package, and it lives here so no test
 * has to write it.
 *
 * @param fake The fake context.
 * @returns The same object, typed as `AudioContext`.
 *
 * @example
 * ```ts
 * import { asAudioContext, createFakeAudioContext } from 'gameable/audio/testing';
 *
 * const fake = createFakeAudioContext();
 * const context = asAudioContext(fake);
 * ```
 */
export function asAudioContext(fake: FakeAudioContext): AudioContext {
  return fake as unknown as AudioContext;
}
