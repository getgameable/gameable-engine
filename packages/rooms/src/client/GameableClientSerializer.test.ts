/**
 * `GameableClientSerializer` alone: frames behind the Colyseus byte, queued until a
 * sink attaches, and rows handed over as the sink's own copy.
 */
import { describe, expect, it } from 'vitest';

import { ROOM_STATE, ROOM_STATE_PATCH } from '../channels.js';
import { GameableClientSerializer, type GameableFrameSink } from './GameableClientSerializer.js';

/** @returns A sink that records what it got. */
function recorder(): GameableFrameSink & { got: (string | Uint8Array)[] } {
  const got: (string | Uint8Array)[] = [];
  return {
    got,
    welcome: (text) => got.push(`welcome ${text}`),
    text: (text) => got.push(`text ${text}`),
    rows: (bytes) => got.push(bytes),
  };
}

const encode = (byte: number, text: string): Uint8Array =>
  new Uint8Array([byte, ...new TextEncoder().encode(text)]);

describe('GameableClientSerializer', () => {
  it('queues frames that arrive before the sink, then delivers them in order', () => {
    const serializer = new GameableClientSerializer();
    serializer.setState(encode(ROOM_STATE, '{"t":"welcome"}'), { offset: 1 });
    serializer.patch(new Uint8Array([ROOM_STATE_PATCH, 2, 9, 9]), { offset: 1 });
    serializer.patch(encode(ROOM_STATE_PATCH, '{"t":"cmd"}'), { offset: 1 });
    const sink = recorder();
    serializer.attach(sink);
    expect(sink.got).toEqual([
      'welcome {"t":"welcome"}',
      new Uint8Array([2, 9, 9]),
      'text {"t":"cmd"}',
    ]);
  });

  it("hands rows over as a copy: the SDK's frame buffer may be reused at once", () => {
    const serializer = new GameableClientSerializer();
    const sink = recorder();
    serializer.attach(sink);
    const frame = new Uint8Array([ROOM_STATE_PATCH, 2, 1, 2, 3]);
    serializer.patch(frame, { offset: 1 });
    frame.fill(0);
    expect(sink.got).toEqual([new Uint8Array([2, 1, 2, 3])]);
  });

  it('delivers nothing after teardown, queued frames included', () => {
    const serializer = new GameableClientSerializer();
    serializer.patch(encode(ROOM_STATE_PATCH, '{"t":"cmd"}'), { offset: 1 });
    serializer.teardown();
    const sink = recorder();
    serializer.attach(sink);
    expect(sink.got).toEqual([]);
  });
});
