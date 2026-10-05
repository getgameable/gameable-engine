import { encodeInput, INPUT_FRAME_BYTES, type MutableInputSnapshot } from '@gameable/net';
import { KEY_WORDS } from '@gameable/sdk/keycodes';
import { describe, expect, it } from 'vitest';

import { createRoomIntake } from './RoomIntake.js';
import { createSeatMap } from './SeatMap.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function input(seq: number, dx: number): Uint8Array {
  const snapshot: MutableInputSnapshot = {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: { dx, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
    focused: true,
  };
  const out = new DataView(new ArrayBuffer(INPUT_FRAME_BYTES));
  return new Uint8Array(out.buffer, 0, encodeInput(out, seq, snapshot));
}

describe('RoomIntake', () => {
  it('coalesces input frames into the seat', () => {
    const seat = createSeatMap().add('s', 'Ana', 0);
    const intake = createRoomIntake();
    expect(intake.input(seat, input(1, 3), 0)).toBe('ok');
    expect(intake.input(seat, input(2, 4), 0)).toBe('ok');
    expect(seat.player.pendingSeq).toBe(2);
    expect(seat.player.pending.mouse.dx).toBe(7);
    expect(intake.counts.input).toBe(2);
  });

  it('refuses text on the input channel and input on the text channel', () => {
    const seat = createSeatMap().add('s', 'Ana', 0);
    const intake = createRoomIntake();
    expect(intake.input(seat, utf8('{"t":"ping","at":1}'), 0)).toBe('bad');
    expect(intake.text(seat, input(1, 0), 0)).toEqual({ kind: 'bad', reason: 'json' });
    expect(seat.player.hasPending).toBe(false);
    expect(intake.counts.bad).toBe(2);
  });

  it('refuses unknown types and hello, and passes msg and ping', () => {
    const seat = createSeatMap().add('s', 'Ana', 0);
    const intake = createRoomIntake();
    expect(intake.text(seat, utf8('{"t":"nope"}'), 0)).toEqual({ kind: 'bad', reason: 'type' });
    expect(intake.text(seat, utf8('{"t":"hello","v":1,"room":"r","name":"x"}'), 0)).toEqual({
      kind: 'bad',
      reason: 'hello',
    });
    const msg = intake.text(seat, utf8('{"t":"msg","name":"go","payload":{"n":1}}'), 0);
    expect(msg).toEqual({ kind: 'msg', name: 'go', payload: '{"n":1}' });
    expect(intake.text(seat, utf8('{"t":"ping","at":12.5}'), 0)).toEqual({
      kind: 'ping',
      at: 12.5,
    });
    expect(intake.counts).toMatchObject({ text: 2, bad: 2 });
    expect(seat.text.counts).toMatchObject({ spent: 4, bad: 2 }); // per player, too
  });

  it('says budget once a seat has spent its text budget, before parsing', () => {
    const seat = createSeatMap({ text: { burst: 2, refill: 1, everyMs: 1000 } }).add('s', 'Ana', 0);
    const intake = createRoomIntake();
    const ping = utf8('{"t":"ping","at":1}');
    expect(intake.text(seat, ping, 0).kind).toBe('ping');
    expect(intake.text(seat, utf8('garbage'), 0).kind).toBe('bad'); // a refused frame still costs
    expect(intake.text(seat, ping, 0)).toEqual({ kind: 'budget', verdict: 'tell' });
    expect(intake.text(seat, ping, 0)).toEqual({ kind: 'budget', verdict: 'refuse' });
    expect(intake.text(seat, ping, 1000).kind).toBe('ping');
    expect(intake.counts.budget).toBe(2);
    expect(seat.text.counts).toEqual({ spent: 3, oversize: 0, bad: 1, overBudget: 2 });
  });

  it('has its own, larger budget for input', () => {
    const seat = createSeatMap({ input: { burst: 2, refill: 1, everyMs: 1000 } }).add(
      's',
      'Ana',
      0,
    );
    const intake = createRoomIntake();
    expect([1, 2, 3].map((seq) => intake.input(seat, input(seq, 0), 0))).toEqual([
      'ok',
      'ok',
      'budget',
    ]);
    expect(seat.text.spend(0)).toBe('pass'); // input did not spend the text budget
  });
});
