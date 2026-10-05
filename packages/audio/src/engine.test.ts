import { describe, expect, it } from 'vitest';

import { createAudioEngine } from './engine';
import type { AudioEngine, Quat } from './engine';
import {
  asAudioContext,
  createFakeAudioBuffer,
  createFakeAudioContext,
} from './testing/fakeAudioContext';
import type { FakeAudioContext } from './testing/fakeAudioContext';

/** Index of each bus inside `fake.gains`, in construction order. */
const MASTER = 0;
const SFX = 1;
const MUSIC = 2;
const VOICE = 3;

/** The first voice gain node: buses are created first. */
const FIRST_VOICE_GAIN = 4;

/**
 * An engine on a fresh fake context.
 *
 * @param decodedDuration Duration of buffers produced by `decodeAudioData`.
 * @returns The fake, the engine driving it, and a clock helper.
 */
function setup(decodedDuration = 1): {
  fake: FakeAudioContext;
  engine: AudioEngine;
  advance: (seconds: number) => void;
} {
  const fake = createFakeAudioContext({ decodedDuration });
  const engine = createAudioEngine({ context: asAudioContext(fake) });
  // Voices end on the context clock, not on a frame delta, so a test that
  // wants time to pass moves the context clock and then pumps.
  const advance = (seconds: number): void => {
    fake.currentTime += seconds;
    engine.update();
  };
  return { fake, engine, advance };
}

describe('createAudioEngine: graph', () => {
  it('wires sfx, music and voice into master and master into the destination', () => {
    const { fake, engine } = setup();

    expect(fake.gains).toHaveLength(4);
    expect(fake.gains[MASTER].outputs).toEqual([fake.destination]);
    expect(fake.gains[SFX].outputs).toEqual([fake.gains[MASTER]]);
    expect(fake.gains[MUSIC].outputs).toEqual([fake.gains[MASTER]]);
    expect(fake.gains[VOICE].outputs).toEqual([fake.gains[MASTER]]);
    expect(engine.buses.master as unknown).toBe(fake.gains[MASTER]);
  });

  it('applies masterVolume', () => {
    const fake = createFakeAudioContext();
    createAudioEngine({ context: asAudioContext(fake), masterVolume: 0.25 });

    expect(fake.gains[MASTER].gain.value).toBe(0.25);
  });
});

describe('createAudioEngine: play and stop lifecycle', () => {
  it('starts a source, then stops it and reports the handle once', () => {
    const { fake, engine } = setup();
    const buffer = createFakeAudioBuffer(2);

    engine.play({ id: 7, buffer, volume: 0.5 });

    const source = fake.sources[0];
    expect(fake.sources).toHaveLength(1);
    expect(source.startCount).toBe(1);
    expect(source.buffer).toBe(buffer);
    expect(source.loop).toBe(false);
    expect(fake.gains[FIRST_VOICE_GAIN].gain.value).toBe(0.5);
    expect(engine.ended).toEqual([]);

    engine.stop(7);

    expect(source.stopCount).toBe(1);
    expect(source.onended).toBeNull();
    // The game asked for the stop, so it is not reported as a completion.
    expect(engine.ended).toEqual([]);

    // A second stop for a handle that is gone is a no-op.
    engine.stop(7);
    expect(engine.ended).toEqual([]);
    expect(source.stopCount).toBe(1);
  });

  it('setVolume retargets a live voice and ignores unknown handles', () => {
    const { fake, engine } = setup();

    engine.play({ id: 1, buffer: createFakeAudioBuffer(1) });
    engine.setVolume(1, 0.2);
    expect(fake.gains[FIRST_VOICE_GAIN].gain.value).toBe(0.2);

    expect(() => {
      engine.setVolume(999, 0.9);
    }).not.toThrow();
  });

  it('replaying the same handle stops the previous voice without completing it', () => {
    const { fake, engine } = setup();
    const buffer = createFakeAudioBuffer(1);

    engine.play({ id: 3, buffer });
    engine.play({ id: 3, buffer });

    // The first voice never finished, so claiming it completed would be a lie;
    // the restart is the game's own doing.
    expect(engine.ended).toEqual([]);
    expect(fake.sources[0].stopCount).toBe(1);
    expect(fake.sources[1].startCount).toBe(1);
  });

  it('releases the voice when start() throws instead of leaking it', () => {
    const { fake, engine, advance } = setup();
    const buffer = createFakeAudioBuffer(1);

    const gainsBefore = fake.gains.length;
    const realCreate = fake.createBufferSource.bind(fake);
    fake.createBufferSource = (): ReturnType<typeof realCreate> => {
      const source = realCreate();
      source.start = (): void => {
        throw new Error('context is closing');
      };
      return source;
    };

    expect(() => {
      engine.play({ id: 5, buffer });
    }).toThrow('context is closing');

    // Nothing is active and nothing is reported; the gain node went back to
    // the pool, so the next successful play reuses it rather than making a
    // second one.
    advance(10);
    expect(engine.ended).toEqual([]);

    fake.createBufferSource = realCreate;
    engine.play({ id: 6, buffer });
    expect(fake.gains).toHaveLength(gainsBefore + 1);
  });
});

describe('createAudioEngine: ended detection', () => {
  it('drains a voice into ended once its buffer runs out', () => {
    const { engine, advance } = setup();

    engine.play({ id: 11, buffer: createFakeAudioBuffer(0.5) });

    advance(0.25);
    expect(engine.ended).toEqual([]);

    advance(0.3);
    expect(engine.ended).toEqual([11]);

    // The pool is the host's to clear; update never re-reports a handle.
    engine.ended.length = 0;
    advance(1);
    expect(engine.ended).toEqual([]);
  });

  it('ends on the context clock, not on the frame delta it is pumped with', () => {
    const { fake, engine } = setup();

    engine.play({ id: 21, buffer: createFakeAudioBuffer(0.5) });

    // A hundred frames of pumping while the audio clock stands still — a
    // suspended context, a stalled tab — ends nothing.
    for (let i = 0; i < 100; i += 1) engine.update();
    expect(engine.ended).toEqual([]);

    // One pump, but the audio clock has jumped past the end of the buffer.
    fake.currentTime = 2;
    engine.update();
    expect(engine.ended).toEqual([21]);
  });

  it('honours the source onended callback before the buffer runs out', () => {
    const { fake, engine, advance } = setup();

    engine.play({ id: 12, buffer: createFakeAudioBuffer(10) });
    fake.sources[0].end();

    advance(1 / 60);
    expect(engine.ended).toEqual([12]);
    expect(fake.sources[0].stopCount).toBe(1);
  });

  it('never ends a looping voice on its own', () => {
    const { engine, advance } = setup();

    engine.play({ id: 13, buffer: createFakeAudioBuffer(0.1), loop: true });
    advance(60);
    expect(engine.ended).toEqual([]);

    // An explicit stop is not a completion, so it reports nothing at all.
    engine.stop(13);
    expect(engine.ended).toEqual([]);
  });

  it('caps ended when nobody drains it', () => {
    const { engine, advance } = setup();
    const buffer = createFakeAudioBuffer(0.01);

    for (let i = 0; i < 300; i += 1) {
      engine.play({ id: i + 1, buffer });
      advance(0.02);
    }

    expect(engine.ended).toHaveLength(256);
    expect(engine.ended[0]).toBe(1);
  });
});

describe('createAudioEngine: bus routing', () => {
  it('routes a non-positional voice straight to its bus', () => {
    const { fake, engine } = setup();

    engine.play({ id: 1, buffer: createFakeAudioBuffer(1), bus: 'music' });

    const voiceGain = fake.gains[FIRST_VOICE_GAIN];
    expect(fake.sources[0].outputs).toEqual([voiceGain]);
    expect(voiceGain.outputs).toEqual([fake.gains[MUSIC]]);
    expect(fake.panners).toHaveLength(0);
  });

  it('defaults to the sfx bus', () => {
    const { fake, engine } = setup();

    engine.play({ id: 1, buffer: createFakeAudioBuffer(1) });

    expect(fake.gains[FIRST_VOICE_GAIN].outputs).toEqual([fake.gains[SFX]]);
  });

  it('inserts an HRTF panner when a position is given', () => {
    const { fake, engine } = setup();

    engine.play({ id: 1, buffer: createFakeAudioBuffer(1), pos: [3, -1, 4], bus: 'voice' });

    const panner = fake.panners[0];
    expect(fake.panners).toHaveLength(1);
    expect(panner.panningModel).toBe('HRTF');
    expect([panner.positionX.value, panner.positionY.value, panner.positionZ.value]).toEqual([
      3, -1, 4,
    ]);
    expect(fake.gains[FIRST_VOICE_GAIN].outputs).toEqual([panner]);
    expect(panner.outputs).toEqual([fake.gains[VOICE]]);
  });
});

describe('createAudioEngine: listener orientation', () => {
  // Compare a listener axis to an expected triple, within float slop.
  const expectAxis = (actual: number[], expected: number[]): void => {
    for (let i = 0; i < 3; i += 1) expect(actual[i]).toBeCloseTo(expected[i], 6);
  };

  it('identity rotation faces -Z with +Y up', () => {
    const { fake, engine } = setup();
    const identity: Quat = [0, 0, 0, 1];

    engine.setListener([1, 2, 3], identity);

    const l = fake.listener;
    expect([l.positionX.value, l.positionY.value, l.positionZ.value]).toEqual([1, 2, 3]);
    expectAxis([l.forwardX.value, l.forwardY.value, l.forwardZ.value], [0, 0, -1]);
    expectAxis([l.upX.value, l.upY.value, l.upZ.value], [0, 1, 0]);
  });

  it('a 90 degree yaw faces -X with +Y still up', () => {
    const { fake, engine } = setup();
    const yaw90: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

    engine.setListener([0, 0, 0], yaw90);

    const l = fake.listener;
    expectAxis([l.forwardX.value, l.forwardY.value, l.forwardZ.value], [-1, 0, 0]);
    expectAxis([l.upX.value, l.upY.value, l.upZ.value], [0, 1, 0]);
  });

  it('writes nothing when the listener pose has not changed', () => {
    const { fake, engine } = setup();
    const identity: Quat = [0, 0, 0, 1];
    let writes = 0;
    Object.defineProperty(fake.listener.positionX, 'value', {
      configurable: true,
      get: (): number => 0,
      set: (): void => {
        writes += 1;
      },
    });

    engine.setListener([1, 2, 3], identity);
    expect(writes).toBe(1);

    engine.setListener([1, 2, 3], identity);
    engine.setListener([1, 2, 3], identity);
    expect(writes).toBe(1);

    engine.setListener([1, 2, 4], identity);
    expect(writes).toBe(2);
  });

  it('a 90 degree pitch tips forward down and up to -Z', () => {
    const { fake, engine } = setup();
    const pitch90: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

    engine.setListener([0, 0, 0], pitch90);

    const l = fake.listener;
    expectAxis([l.forwardX.value, l.forwardY.value, l.forwardZ.value], [0, 1, 0]);
    expectAxis([l.upX.value, l.upY.value, l.upZ.value], [0, 0, 1]);
  });
});

describe('createAudioEngine: decode cache', () => {
  it('decodes an id once and shares the promise', async () => {
    const { fake, engine } = setup(0.75);
    const bytes = new ArrayBuffer(8);

    const first = engine.decode('pistol', bytes);
    const second = engine.decode('pistol', new ArrayBuffer(8));

    expect(second).toBe(first);
    expect(fake.decodeCalls).toHaveLength(1);
    expect((await first).duration).toBe(0.75);

    void engine.decode('footstep', bytes);
    expect(fake.decodeCalls).toHaveLength(2);
  });

  it('forgets a failed decode so the next call retries', async () => {
    const fake = createFakeAudioContext();
    let calls = 0;
    fake.decodeAudioData = (): Promise<AudioBuffer> => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('bad bytes'))
        : Promise.resolve(createFakeAudioBuffer(1));
    };
    const engine = createAudioEngine({ context: asAudioContext(fake) });

    await expect(engine.decode('broken', new ArrayBuffer(4))).rejects.toThrow('bad bytes');
    await expect(engine.decode('broken', new ArrayBuffer(4))).resolves.toBeDefined();
    expect(calls).toBe(2);
  });
});

describe('createAudioEngine: voice pooling', () => {
  it('reuses the gain node of a retired voice', () => {
    const { fake, engine, advance } = setup();
    const buffer = createFakeAudioBuffer(0.1);

    engine.play({ id: 1, buffer });
    expect(fake.gains).toHaveLength(5);

    advance(0.2);
    expect(engine.ended).toEqual([1]);

    engine.play({ id: 2, buffer });
    engine.play({ id: 3, buffer });

    // One pooled voice plus one new one: never four gain nodes for three plays.
    expect(fake.gains).toHaveLength(6);
    expect(fake.sources).toHaveLength(3);
  });

  it('reuses a panner across positional replays', () => {
    const { fake, engine, advance } = setup();
    const buffer = createFakeAudioBuffer(0.1);

    engine.play({ id: 1, buffer, pos: [1, 0, 0] });
    advance(0.2);
    engine.play({ id: 2, buffer, pos: [0, 0, 5] });

    expect(fake.panners).toHaveLength(1);
    expect(fake.panners[0].positionZ.value).toBe(5);
    expect(fake.panners[0].outputs).toEqual([fake.gains[SFX]]);
  });

  it('a pooled voice does not keep its old connections', () => {
    const { fake, engine, advance } = setup();
    const buffer = createFakeAudioBuffer(0.1);

    engine.play({ id: 1, buffer, bus: 'music' });
    advance(0.2);
    engine.play({ id: 2, buffer, bus: 'voice' });

    expect(fake.gains[FIRST_VOICE_GAIN].outputs).toEqual([fake.gains[VOICE]]);
  });
});

describe('createAudioEngine: context lifecycle', () => {
  it('resume only touches a suspended context', async () => {
    const { fake, engine } = setup();

    await engine.resume();
    expect(fake.resumeCount).toBe(1);
    expect(fake.state).toBe('running');

    await engine.resume();
    expect(fake.resumeCount).toBe(1);
  });

  it('dispose tears the graph down but leaves a borrowed context open', () => {
    const { fake, engine } = setup();

    engine.play({ id: 1, buffer: createFakeAudioBuffer(5) });
    engine.dispose();

    expect(fake.sources[0].stopCount).toBe(1);
    expect(fake.gains[MASTER].outputs).toEqual([]);
    expect(fake.closed).toBe(false);

    engine.play({ id: 2, buffer: createFakeAudioBuffer(5) });
    expect(fake.sources).toHaveLength(1);
  });
});
