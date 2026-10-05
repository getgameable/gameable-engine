import { describe, expect, it } from 'vitest';

import { KEY_WORDS, keyIndex, writeKeyBit } from '@gameable/sdk';
import type { InputMods, MouseState } from '@gameable/sdk';

import { quantizeInput } from './abi';
import { createInputEncoder } from './encode-input';

/**
 * Build the input snapshot the engine's input module hands over.
 *
 * @returns A neutral snapshot with real typed arrays.
 */
function snapshot(): {
  down: Uint32Array;
  pressed: Uint32Array;
  released: Uint32Array;
  mods: InputMods;
  mouse: MouseState;
  focused: boolean;
} {
  return {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: true, ctrl: false, alt: false, meta: false, capsLock: false, numLock: true },
    mouse: {
      x: 10.5,
      y: 20.25,
      dx: -1.5,
      dy: 0.5,
      wheel: 3,
      buttons: 1,
      pressed: 1,
      released: 0,
      locked: true,
    },
    focused: true,
  };
}

describe('createInputEncoder', () => {
  it('produces the host-side shapes jco expects', () => {
    const encoder = createInputEncoder(8);
    const state = snapshot();
    writeKeyBit(state.down, keyIndex('KeyW'), true);

    const bodies = new Float32Array(15 * 2);
    bodies[0] = 1;
    bodies[15] = 2;

    const input = encoder.encode({
      frame: 42,
      dt: 1 / 60,
      elapsed: 0.7,
      inputState: state,
      bodies,
      bodyCount: 2,
    });

    // `frame` is a u64: bigint on the host, number in the guest.
    expect(typeof input.frame).toBe('bigint');
    expect(input.frame).toBe(42n);
    expect(input.input.keys.down).toBeInstanceOf(Uint32Array);
    expect(input.input.keys.down).toHaveLength(KEY_WORDS);
    expect(input.input.keys.down[0]).toBe(1 << keyIndex('KeyW'));
    expect(input.input.mods.shift).toBe(true);
    expect(input.input.mouse.x).toBe(10.5);
    expect(input.bodies).toBeInstanceOf(Float32Array);
    expect(input.bodies).toHaveLength(30);
    expect(input.bodies[0]).toBe(1);
    expect(input.bodies[15]).toBe(2);
    expect(input.contacts).toEqual([]);
    expect(input.events).toEqual([]);
  });

  it('reuses its record and its body views', () => {
    const encoder = createInputEncoder(8);
    const state = snapshot();
    const args = {
      frame: 0,
      dt: 1 / 60,
      elapsed: 0,
      inputState: state,
      bodies: new Float32Array(15),
      bodyCount: 1,
    };
    const a = encoder.encode(args);
    const aBodies = a.bodies;
    const b = encoder.encode({ ...args, frame: 1 });
    expect(b).toBe(a);
    expect(b.bodies).toBe(aBodies);
    expect(b.frame).toBe(1n);
  });

  it('aliases the incoming key bitsets rather than copying them', () => {
    const encoder = createInputEncoder(4);
    const state = snapshot();
    writeKeyBit(state.down, keyIndex('KeyA'), true);
    const input = encoder.encode({
      frame: 0,
      dt: 1 / 60,
      elapsed: 0,
      inputState: state,
      bodies: new Float32Array(0),
      bodyCount: 0,
    });
    // The guest copies on its way in; a second copy here bought nothing.
    expect(input.input.keys.down).toBe(state.down);
    expect(input.input.keys.pressed).toBe(state.pressed);
    expect(input.input.keys.released).toBe(state.released);
  });

  it('treats maxBodies as a hint, not a ceiling', () => {
    const encoder = createInputEncoder(2);
    const input = encoder.encode({
      frame: 0,
      dt: 1 / 60,
      elapsed: 0,
      inputState: snapshot(),
      bodies: new Float32Array(15 * 5),
      bodyCount: 5,
    });
    expect(input.bodies).toHaveLength(75);
  });

  it('never hands out a view over a buffer the caller has replaced', () => {
    const encoder = createInputEncoder(8);
    const state = snapshot();
    const small = new Float32Array(15 * 2);
    small[0] = 11;
    const first = encoder.encode({
      frame: 0,
      dt: 1 / 60,
      elapsed: 0,
      inputState: state,
      bodies: small,
      bodyCount: 2,
    });
    expect(first.bodies.buffer).toBe(small.buffer);

    // The host loop grows its buffer the moment a game outgrows it.
    const grown = new Float32Array(15 * 4);
    grown[0] = 22;
    const second = encoder.encode({
      frame: 1,
      dt: 1 / 60,
      elapsed: 0,
      inputState: state,
      bodies: grown,
      bodyCount: 2,
    });
    expect(second.bodies.buffer).toBe(grown.buffer);
    expect(second.bodies[0]).toBe(22);

    // ...and the same count over the same buffer is still memoised.
    const third = encoder.encode({
      frame: 2,
      dt: 1 / 60,
      elapsed: 0,
      inputState: state,
      bodies: grown,
      bodyCount: 2,
    });
    expect(third.bodies).toBe(second.bodies);
  });
});

describe('quantizeInput', () => {
  it('rounds every f32 field so direct mode matches wasm mode', () => {
    const encoder = createInputEncoder(4);
    const state = snapshot();
    state.mouse.dx = 0.1;
    const input = quantizeInput(
      encoder.encode({
        frame: 0,
        dt: 1 / 60,
        elapsed: 0.1,
        inputState: state,
        bodies: new Float32Array(0),
        bodyCount: 0,
      }),
    );
    expect(input.dt).toBe(Math.fround(1 / 60));
    expect(input.elapsed).toBe(Math.fround(0.1));
    expect(input.input.mouse.dx).toBe(Math.fround(0.1));
    expect(input.input.mouse.dx).not.toBe(0.1);
  });

  it('rounds contact floats', () => {
    const encoder = createInputEncoder(4);
    const input = quantizeInput(
      encoder.encode({
        frame: 0,
        dt: 1 / 60,
        elapsed: 0,
        inputState: snapshot(),
        bodies: new Float32Array(0),
        bodyCount: 0,
        contacts: [
          {
            a: 1,
            b: 2,
            entityA: 1,
            entityB: 2,
            phase: 'begin',
            point: { x: 0.1, y: 0, z: 0 },
            normal: { x: 0, y: 1, z: 0 },
            impulse: 0.3,
          },
        ],
      }),
    );
    expect(input.contacts[0]?.point.x).toBe(Math.fround(0.1));
    expect(input.contacts[0]?.impulse).toBe(Math.fround(0.3));
  });

  it('encodes the players lane into pooled records, keys aliased, floats rounded', () => {
    const encoder = createInputEncoder(4);
    const one = snapshot();
    writeKeyBit(one.down, keyIndex('W'), true);
    const playerInput = (state: ReturnType<typeof snapshot>) => ({
      keys: { down: state.down, pressed: state.pressed, released: state.released },
      mods: state.mods,
      mouse: { ...state.mouse, x: 0.1 },
      gamepads: [],
      focused: true,
    });
    const players = [
      { player: 1, seq: 7, input: playerInput(one) },
      { player: 2, seq: 3, input: playerInput(snapshot()) },
    ];
    const args = {
      frame: 0,
      dt: 1 / 60,
      elapsed: 0,
      inputState: snapshot(),
      bodies: new Float32Array(0),
      bodyCount: 0,
      players,
    };
    const first = quantizeInput(encoder.encode(args)).players;
    expect(first.map((p) => [p.player, p.seq])).toEqual([
      [1, 7],
      [2, 3],
    ]);
    expect(first[0].input.keys.down).toBe(one.down);
    expect(first[0].input.mouse.x).toBe(Math.fround(0.1));
    // Rounded on the encoder's copy, never on the caller's.
    expect(players[0].input.mouse.x).toBe(0.1);
    // A steady room hands over the same list and records every step.
    expect(encoder.encode(args).players).toBe(first);
    expect(encoder.encode({ ...args, players: undefined }).players).toHaveLength(0);
  });
});
