import { KEY_WORDS } from '@gameable/sdk/keycodes';
import { describe, expect, it } from 'vitest';

import {
  FrameKind,
  INPUT_FRAME_BYTES,
  MAX_CLIENT_TEXT_BYTES,
  MAX_JSON_DEPTH,
  MAX_PAYLOAD_BYTES,
} from '../../protocol/constants.js';
import { encodeInput } from '../../protocol/InputCodec.js';
import type { MutableInputSnapshot } from '../../protocol/types.js';
import { InboundParser, parseClientFrame } from './InboundParser.js';

function snapshot(): MutableInputSnapshot {
  return {
    down: new Uint32Array(KEY_WORDS),
    pressed: new Uint32Array(KEY_WORDS),
    released: new Uint32Array(KEY_WORDS),
    mods: { shift: false, ctrl: false, alt: false, meta: false, capsLock: false, numLock: false },
    mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0, released: 0 },
    focused: false,
  };
}

function inputFrame(seq: number, key = 0): Uint8Array {
  const s = snapshot();
  s.down[0] = key;
  s.focused = true;
  const out = new DataView(new ArrayBuffer(INPUT_FRAME_BYTES));
  encodeInput(out, seq, s);
  return new Uint8Array(out.buffer);
}

describe('InboundParser text frames', () => {
  const parser = new InboundParser();

  it('parses a valid frame of each client type', () => {
    expect(parser.parse('{"t":"ping","at":4}')).toEqual({
      kind: 'text',
      msg: { t: 'ping', at: 4 },
    });
    expect(parser.parse('{"t":"msg","name":"emote","payload":{"a":1}}')).toEqual({
      kind: 'text',
      msg: { t: 'msg', name: 'emote', payload: { a: 1 } },
    });
    expect(parser.parse('{"t":"hello","v":1,"room":"r","name":"Ana"}')).toMatchObject({
      kind: 'text',
      msg: { t: 'hello', room: 'r' },
    });
  });

  it('refuses a text frame over the cap as size', () => {
    const big = `{"t":"msg","name":"x","payload":"${'a'.repeat(MAX_CLIENT_TEXT_BYTES)}"}`;
    expect(parser.parse(big)).toEqual({ kind: 'bad', reason: 'size' });
  });

  it('refuses a msg whose payload alone is over MAX_PAYLOAD_BYTES as payload', () => {
    // The frame is under MAX_CLIENT_TEXT_BYTES; only the payload is over its cap.
    const over = `{"t":"msg","name":"x","payload":"${'a'.repeat(MAX_PAYLOAD_BYTES - 1)}"}`;
    expect(parser.parse(over)).toEqual({ kind: 'bad', reason: 'payload' });
    const at = `{"t":"msg","name":"x","payload":"${'a'.repeat(MAX_PAYLOAD_BYTES - 2)}"}`;
    expect(parser.parse(at).kind).toBe('text'); // the quotes count: exactly the cap passes
    const longName = `{"t":"msg","name":5,"payload":"${'a'.repeat(MAX_PAYLOAD_BYTES - 2)}"}`;
    expect(parser.parse(longName)).toEqual({ kind: 'bad', reason: 'shape' });
    expect(parser.parse(`null${' '.repeat(MAX_PAYLOAD_BYTES)}`)).toEqual({ kind: 'bad', reason: 'shape' });
  });

  it('refuses invalid JSON as json', () => {
    expect(parser.parse('{"t":')).toEqual({ kind: 'bad', reason: 'json' });
    expect(parser.parse('')).toEqual({ kind: 'bad', reason: 'json' });
  });

  it('refuses an unknown or missing t as type', () => {
    expect(parser.parse('{"t":"nope"}')).toEqual({ kind: 'bad', reason: 'type' });
    expect(parser.parse('{"x":1}')).toEqual({ kind: 'bad', reason: 'type' });
  });

  it('refuses a known type with the wrong fields as shape', () => {
    expect(parser.parse('{"t":"msg","name":5,"payload":1}')).toEqual({
      kind: 'bad',
      reason: 'shape',
    });
    expect(parser.parse('{"t":"ping"}')).toEqual({ kind: 'bad', reason: 'shape' });
    expect(parser.parse('[1,2]')).toEqual({ kind: 'bad', reason: 'shape' });
    expect(parser.parse('7')).toEqual({ kind: 'bad', reason: 'shape' });
  });

  it('refuses a too-deep frame as depth', () => {
    const n = MAX_JSON_DEPTH + 1;
    const deep = `{"t":"msg","name":"x","payload":${'['.repeat(n)}${']'.repeat(n)}}`;
    expect(parser.parse(deep)).toEqual({ kind: 'bad', reason: 'depth' });
  });

  it('treats bytes as a binary frame even when they spell JSON', () => {
    const bytes = new TextEncoder().encode('{"t":"ping","at":1}');
    expect(parser.parse(bytes)).toEqual({ kind: 'bad', reason: 'kind' });
  });
});

describe('InboundParser binary frames', () => {
  it('decodes an input frame to its seq and keys', () => {
    const parser = new InboundParser();
    const frame = parser.parse(inputFrame(77, 0b1010));
    expect(frame.kind).toBe('input');
    if (frame.kind !== 'input') throw new Error('unreachable');
    expect(frame.seq).toBe(77);
    expect(frame.snapshot.down[0]).toBe(0b1010);
    expect(frame.snapshot.focused).toBe(true);
  });

  it('refuses an unknown kind as kind', () => {
    const parser = new InboundParser();
    expect(parser.parse(new Uint8Array([9, 0, 0]))).toEqual({ kind: 'bad', reason: 'kind' });
    expect(parser.parse(new Uint8Array(0))).toEqual({ kind: 'bad', reason: 'kind' });
  });

  it('refuses a truncated or padded input frame, and a rows frame, as kind', () => {
    const parser = new InboundParser();
    const good = inputFrame(1);
    expect(parser.parse(good.subarray(0, good.length - 1))).toEqual({
      kind: 'bad',
      reason: 'kind',
    });
    const padded = new Uint8Array(good.length + 1);
    padded.set(good);
    expect(parser.parse(padded)).toEqual({ kind: 'bad', reason: 'kind' });
    expect(parser.parse(new Uint8Array([FrameKind.ROWS, 0, 0, 0, 0]))).toEqual({
      kind: 'bad',
      reason: 'kind',
    });
  });

  it('refuses a binary frame over the cap as size', () => {
    const parser = new InboundParser();
    expect(parser.parse(new Uint8Array(MAX_CLIENT_TEXT_BYTES + 1))).toEqual({
      kind: 'bad',
      reason: 'size',
    });
  });

  it('reuses its result and snapshot: the next input overwrites the last', () => {
    const parser = new InboundParser();
    const first = parser.parse(inputFrame(1, 1));
    const second = parser.parse(inputFrame(2, 2));
    expect(second).toBe(first);
    expect(first.kind === 'input' && first.seq).toBe(2);
  });

  it('allocates nothing on the input path', () => {
    const parser = new InboundParser();
    const frame = inputFrame(5, 3);
    for (let i = 0; i < 2000; i += 1) parser.parse(frame);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 200_000; i += 1) parser.parse(frame);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(1_000_000);
  });
});

describe('parseClientFrame', () => {
  it('parses with a shared parser', () => {
    expect(parseClientFrame('{"t":"ping","at":1}').kind).toBe('text');
  });
});
