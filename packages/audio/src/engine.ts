/**
 * The WebAudio engine behind `gameable/audio`.
 *
 * A four-bus gain graph, pooled voices, an id-keyed decode cache and a
 * listener driven from a position and a quaternion. It knows nothing about
 * entities, the ECS or the wasm boundary: the host maps `play-sound`,
 * `stop-sound` and `set-listener` commands onto these calls and turns the
 * `ended` pool back into `sound-ended` events.
 */

/** A world-space position, as a plain `[x, y, z]` array. */
export type Vec3 = readonly [number, number, number];

/** A rotation, as a plain `[x, y, z, w]` quaternion (three.js / Jolt order). */
export type Quat = readonly [number, number, number, number];

/** The buses a voice can be routed to. `master` is the sum of the other three. */
export type BusName = 'master' | 'sfx' | 'music' | 'voice';

/** The bus gain nodes, keyed by name. */
export interface AudioBuses {
  /** Sums `sfx`, `music` and `voice`; connected to `context.destination`. */
  readonly master: GainNode;
  /** One-shot gameplay sounds. */
  readonly sfx: GainNode;
  /** Music beds. */
  readonly music: GainNode;
  /** Dialogue and `say` lines. */
  readonly voice: GainNode;
}

/** Options for {@link createAudioEngine}. */
export interface AudioEngineOptions {
  /**
   * An existing context to drive. When omitted a new `AudioContext` is
   * constructed, which requires a DOM environment. Pass one in tests.
   */
  context?: AudioContext;
  /** Linear gain on the master bus, 0..1. Defaults to 1. */
  masterVolume?: number;
}

/** One call to {@link AudioEngine.play}. */
export interface PlayArgs {
  /** Guest-minted sound handle. Replaces any sound already using this handle. */
  id: number;
  /** The decoded buffer to play, normally from {@link AudioEngine.decode}. */
  buffer: AudioBuffer;
  /** World position. When given the voice gets an HRTF `PannerNode`. */
  pos?: Vec3;
  /** Linear gain, 0..1. Defaults to 1. */
  volume?: number;
  /** Loop until stopped. Looping voices never end on their own. Defaults to false. */
  loop?: boolean;
  /** Bus to route through. Defaults to `'sfx'`. */
  bus?: BusName;
}

/** The audio service: everything the host needs to run a frame of sound. */
export interface AudioEngine {
  /** The context the graph lives on. */
  readonly context: AudioContext;
  /** The bus gain nodes. Adjust `bus.gain.value` for mixer sliders. */
  readonly buses: AudioBuses;
  /**
   * Handles of sounds that **ran to their natural end** since the host last
   * cleared this array. {@link AudioEngine.update} appends to it; the host
   * turns each entry into a `sound-ended` event and then clears it with
   * `ended.length = 0`.
   *
   * A voice the game stopped itself — {@link AudioEngine.stop}, or a
   * {@link AudioEngine.play} reusing a live handle — is **not** listed: the
   * game already knows, and reporting it would claim a completion that never
   * happened. Capped at 256 entries so a host that never drains it cannot grow
   * the array without bound.
   */
  readonly ended: number[];
  /**
   * Decode encoded audio bytes, memoised by `id`.
   *
   * @param id Manifest asset id, the cache key.
   * @param data Encoded bytes.
   * @returns The decoded buffer. Repeat calls with the same id share a promise.
   */
  decode(id: string, data: ArrayBuffer): Promise<AudioBuffer>;
  /**
   * Start a voice.
   *
   * @param args What to play, where and how loud.
   */
  play(args: PlayArgs): void;
  /**
   * Stop a voice now. Nothing is added to {@link AudioEngine.ended}: the
   * caller asked for this, so it is not a completion.
   *
   * @param id The handle passed to {@link AudioEngine.play}. Unknown ids are ignored.
   */
  stop(id: number): void;
  /**
   * Move the listener.
   *
   * @param pos World position.
   * @param rotQuat Orientation; forward is local -Z, up is local +Y.
   */
  setListener(pos: Vec3, rotQuat: Quat): void;
  /**
   * Change a playing voice's gain.
   *
   * @param id The sound handle. Unknown ids are ignored.
   * @param v Linear gain, 0..1.
   */
  setVolume(id: number, v: number): void;
  /**
   * Retire every voice whose buffer has run out and drain them into `ended`.
   *
   * Timing comes from `context.currentTime`, the clock the voices themselves
   * run on, not from the caller's frame delta: a long frame, a background tab
   * or a `timeScale` change cannot drift the two apart. A suspended context
   * does not advance, and neither does playback, so nothing ends early.
   */
  update(): void;
  /**
   * Resume a context the browser suspended. Safe to call repeatedly.
   *
   * @returns Resolves once the context is running.
   */
  resume(): Promise<void>;
  /** Stop everything, drop the graph, and close a context this engine created. */
  dispose(): void;
}

/** A pooled voice. The `AudioBufferSourceNode` is per-playback; the rest is reused. */
interface Voice {
  id: number;
  readonly gain: GainNode;
  panner: PannerNode | undefined;
  source: AudioBufferSourceNode | undefined;
  /** `context.currentTime` the buffer runs out at; `Infinity` while looping. */
  endsAt: number;
  /** Set by `onended`, or by `endsAt` passing. */
  finished: boolean;
}

/**
 * Most handles {@link AudioEngine.ended} holds before it stops growing.
 *
 * The host drains it every frame. A host that never does has either not
 * registered the audio module's event pump or has stopped ticking, and neither
 * is worth a megabyte of retained handles.
 */
const MAX_ENDED = 256;

/** Local forward axis, before the listener rotation is applied. */
const LOCAL_FORWARD: Vec3 = [0, 0, -1];

/** Local up axis, before the listener rotation is applied. */
const LOCAL_UP: Vec3 = [0, 1, 0];

/**
 * Rotate `v` by the unit quaternion `q`, writing into `out`.
 *
 * Uses `v + 2w(u x v) + 2(u x (u x v))` with `u = q.xyz`, so it allocates
 * nothing and can be called from the frame loop.
 *
 * @param q Unit quaternion, xyzw.
 * @param v Vector to rotate.
 * @param out Destination, may not alias `v`; it is mutated in place.
 */
function rotateVec3(q: Quat, v: Vec3, out: number[]): void {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  const vx = v[0];
  const vy = v[1];
  const vz = v[2];

  // t = 2 * (q.xyz x v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
}

/**
 * The `AudioContext` constructor, or `undefined` outside a DOM environment.
 *
 * @returns The constructor when the host provides one.
 */
function globalAudioContext(): typeof AudioContext | undefined {
  const g: Partial<typeof globalThis> = globalThis;
  return g.AudioContext;
}

/**
 * Create the audio engine.
 *
 * The graph is `voice -> [panner] -> bus -> master -> destination`. Nothing is
 * allocated per frame: voices are pooled, the listener basis is written into
 * scratch arrays, and `ended` is reused.
 *
 * @param options Context to adopt and initial master gain.
 * @returns The engine, which is also the `'audio'` module's service.
 *
 * @example
 * ```ts
 * import { createAudioEngine } from 'gameable/audio';
 *
 * const engine = createAudioEngine({ masterVolume: 0.8 });
 * const buffer = await engine.decode('pistol', bytes);
 *
 * engine.play({ id: 1, buffer, pos: [3, 0, -4], bus: 'sfx' });
 * engine.update();
 * for (const id of engine.ended) console.log('ended', id);
 * engine.ended.length = 0;
 * ```
 */
export function createAudioEngine(options: AudioEngineOptions = {}): AudioEngine {
  const provided = options.context;
  let context: AudioContext;
  if (provided) {
    context = provided;
  } else {
    const Ctor = globalAudioContext();
    if (!Ctor) {
      throw new Error(
        'createAudioEngine: no global AudioContext; pass one as options.context (see @gameable/audio/testing)',
      );
    }
    context = new Ctor();
  }
  const ownsContext = provided === undefined;

  const master = context.createGain();
  master.gain.value = options.masterVolume ?? 1;
  master.connect(context.destination);

  const buses: AudioBuses = {
    master,
    sfx: context.createGain(),
    music: context.createGain(),
    voice: context.createGain(),
  };
  buses.sfx.connect(master);
  buses.music.connect(master);
  buses.voice.connect(master);

  /** Voices currently playing, in no particular order. */
  const active: Voice[] = [];
  /** Retired voices, ready to be handed back out. */
  const pool: Voice[] = [];
  /** Handle -> voice, for `stop` and `setVolume`. */
  const byId = new Map<number, Voice>();
  /** Decoded buffers, keyed by manifest asset id. */
  const decoded = new Map<string, Promise<AudioBuffer>>();
  /** Handles the host has not consumed yet. */
  const ended: number[] = [];

  /** Scratch listener basis; reused so `setListener` allocates nothing. */
  const forward = [0, 0, -1];
  const up = [0, 1, 0];

  /** Last listener pose written, as `[x, y, z, qx, qy, qz, qw]`. */
  const lastListener = new Float64Array(7);
  /** Whether {@link lastListener} holds a pose that was actually written. */
  let listenerSeeded = false;

  let disposed = false;

  /**
   * Take a voice from the pool, or build one.
   *
   * @returns A voice with a connected-nothing gain node.
   */
  function acquire(): Voice {
    const reused = pool.pop();
    if (reused) return reused;
    return {
      id: 0,
      gain: context.createGain(),
      panner: undefined,
      source: undefined,
      endsAt: 0,
      finished: false,
    };
  }

  /**
   * Disconnect a voice and return it to the pool. Its `PannerNode`, if it ever
   * had one, stays attached to the voice so positional replays reuse it.
   *
   * @param voice The voice to retire.
   */
  function release(voice: Voice): void {
    const source = voice.source;
    if (source) {
      source.onended = null;
      source.disconnect();
      voice.source = undefined;
    }
    voice.gain.disconnect();
    voice.panner?.disconnect();
    voice.finished = false;
    voice.endsAt = 0;
    pool.push(voice);
  }

  /**
   * Stop a voice's source without emitting anything.
   *
   * @param voice The voice to silence.
   */
  function silence(voice: Voice): void {
    const source = voice.source;
    if (!source) return;
    source.onended = null;
    // No guard: `stop()` only throws `InvalidStateError` for a source that was
    // never started, and a source whose `start()` threw is released on the
    // spot and never reaches a voice. Stopping twice, or after the buffer ran
    // out, is explicitly a no-op in the Web Audio specification.
    source.stop();
  }

  /**
   * Remove `active[index]` and pool it, reporting it as ended only when it got
   * there on its own.
   *
   * @param index Position in `active`.
   * @param emit Whether to queue the handle for a `sound-ended` event. False
   *   for a stop the game asked for, which is not a completion.
   */
  function finishAt(index: number, emit: boolean): void {
    const voice = active[index];
    if (emit && ended.length < MAX_ENDED) ended.push(voice.id);
    byId.delete(voice.id);
    active[index] = active[active.length - 1];
    active.pop();
    release(voice);
  }

  /**
   * Point a panner at a world position.
   *
   * @param panner The voice's panner.
   * @param pos World position.
   */
  function placePanner(panner: PannerNode, pos: Vec3): void {
    panner.positionX.value = pos[0];
    panner.positionY.value = pos[1];
    panner.positionZ.value = pos[2];
  }

  /**
   * Decode encoded audio bytes, memoised by `id`.
   *
   * @param id Manifest asset id, the cache key.
   * @param data Encoded bytes.
   * @returns The decoded buffer.
   */
  function decode(id: string, data: ArrayBuffer): Promise<AudioBuffer> {
    const hit = decoded.get(id);
    if (hit) return hit;
    const pending = context.decodeAudioData(data);
    decoded.set(id, pending);
    // A failed decode must not poison the cache for the rest of the run.
    void pending.catch(() => {
      decoded.delete(id);
    });
    return pending;
  }

  /**
   * Start a voice.
   *
   * @param args What to play, where and how loud.
   */
  function play(args: PlayArgs): void {
    if (disposed) return;
    stop(args.id);

    const voice = acquire();
    voice.id = args.id;
    voice.finished = false;

    const source = context.createBufferSource();
    source.buffer = args.buffer;
    source.loop = args.loop ?? false;
    voice.source = source;
    voice.endsAt = source.loop ? Infinity : context.currentTime + args.buffer.duration;

    voice.gain.gain.value = args.volume ?? 1;
    source.connect(voice.gain);

    const bus = buses[args.bus ?? 'sfx'];
    const pos = args.pos;
    if (pos) {
      let panner = voice.panner;
      if (!panner) {
        panner = context.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        voice.panner = panner;
      }
      placePanner(panner, pos);
      voice.gain.connect(panner);
      panner.connect(bus);
    } else {
      voice.gain.connect(bus);
    }

    source.onended = (): void => {
      // Guard against a handler that outlived its voice being recycled.
      if (voice.source === source) voice.finished = true;
    };
    try {
      source.start();
    } catch (err) {
      // A context that is closing, or a node the browser refused to schedule.
      // The voice never played, so it must not be left in `active` holding a
      // gain node nobody will ever disconnect.
      source.onended = null;
      release(voice);
      throw err;
    }

    byId.set(args.id, voice);
    active.push(voice);
  }

  /**
   * Stop a voice now and queue its `sound-ended`.
   *
   * @param id The sound handle. Unknown ids are ignored.
   */
  function stop(id: number): void {
    const voice = byId.get(id);
    if (!voice) return;
    silence(voice);
    const index = active.indexOf(voice);
    if (index >= 0) finishAt(index, false);
  }

  /**
   * Move the listener.
   *
   * @param pos World position.
   * @param rotQuat Orientation; forward is local -Z, up is local +Y.
   */
  function setListener(pos: Vec3, rotQuat: Quat): void {
    // The host calls this every frame with the camera's pose, which usually
    // has not moved. Nine `AudioParam` writes and two quaternion rotations for
    // an unchanged listener are pure waste.
    if (
      lastListener[0] === pos[0] &&
      lastListener[1] === pos[1] &&
      lastListener[2] === pos[2] &&
      lastListener[3] === rotQuat[0] &&
      lastListener[4] === rotQuat[1] &&
      lastListener[5] === rotQuat[2] &&
      lastListener[6] === rotQuat[3] &&
      listenerSeeded
    ) {
      return;
    }
    lastListener[0] = pos[0];
    lastListener[1] = pos[1];
    lastListener[2] = pos[2];
    lastListener[3] = rotQuat[0];
    lastListener[4] = rotQuat[1];
    lastListener[5] = rotQuat[2];
    lastListener[6] = rotQuat[3];
    listenerSeeded = true;

    rotateVec3(rotQuat, LOCAL_FORWARD, forward);
    rotateVec3(rotQuat, LOCAL_UP, up);

    const listener = context.listener;
    listener.positionX.value = pos[0];
    listener.positionY.value = pos[1];
    listener.positionZ.value = pos[2];
    listener.forwardX.value = forward[0];
    listener.forwardY.value = forward[1];
    listener.forwardZ.value = forward[2];
    listener.upX.value = up[0];
    listener.upY.value = up[1];
    listener.upZ.value = up[2];
  }

  /**
   * Change a playing voice's gain.
   *
   * @param id The sound handle. Unknown ids are ignored.
   * @param v Linear gain, 0..1.
   */
  function setVolume(id: number, v: number): void {
    const voice = byId.get(id);
    if (voice) voice.gain.gain.value = v;
  }

  /**
   * Retire every voice whose buffer has run out and drain them into `ended`.
   */
  function update(): void {
    // One clock read for the whole sweep: `currentTime` is a live audio-thread
    // value and reading it per voice both costs more and can straddle a tick.
    const now = context.currentTime;
    for (let i = active.length - 1; i >= 0; i -= 1) {
      const voice = active[i];
      if (!voice.finished) {
        if (now < voice.endsAt) continue;
        voice.finished = true;
      }
      silence(voice);
      finishAt(i, true);
    }
  }

  /**
   * Resume a context the browser suspended.
   *
   * @returns Resolves once the context is running.
   */
  async function resume(): Promise<void> {
    if (disposed) return;
    if (context.state === 'suspended') await context.resume();
  }

  /**
   * Stop everything, drop the graph, and close a context this engine created.
   */
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (let i = active.length - 1; i >= 0; i -= 1) {
      silence(active[i]);
      release(active[i]);
      active.pop();
    }
    byId.clear();
    pool.length = 0;
    decoded.clear();
    ended.length = 0;
    listenerSeeded = false;
    buses.sfx.disconnect();
    buses.music.disconnect();
    buses.voice.disconnect();
    master.disconnect();
    if (ownsContext) void context.close();
  }

  return {
    context,
    buses,
    ended,
    decode,
    play,
    stop,
    setListener,
    setVolume,
    update,
    resume,
    dispose,
  };
}
