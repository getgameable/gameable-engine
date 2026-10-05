import { describe, expect, it } from 'vitest';

import { MAX_CLIENT_TEXT_BYTES, MAX_JSON_DEPTH, MAX_PAYLOAD_BYTES } from './constants.js';
import {
  buildClientText,
  buildServerText,
  parseClientText,
  parseServerText,
  utf8ByteLength,
} from './textFrameFunctions.js';
import type { ClientText, ServerText } from './types.js';

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes the way TextEncoder does', () => {
    for (const text of ['', 'abc', 'é', '€', '😀', 'a😀é€', '\ud800', 'x\udc00y']) {
      expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
    }
  });
});

describe('client text frames', () => {
  const frames: ClientText[] = [
    { t: 'hello', v: 1, room: 'lobby', name: 'Ana' },
    {
      t: 'hello',
      v: 1,
      room: 'lobby',
      name: 'Ana',
      seat: { id: 3, secret: 's3cret' },
      token: 'tok',
    },
    { t: 'msg', name: 'chat', payload: { text: 'hi', n: [1, 2] } },
    { t: 'msg', name: 'flag', payload: null },
    { t: 'ping', at: 123.5 },
  ];

  it('round-trips every kind', () => {
    for (const frame of frames) {
      const text = buildClientText(frame);
      expect(text).not.toBeNull();
      expect(parseClientText(text!)).toEqual(frame);
    }
  });

  it('refuses a payload over 2,048 UTF-8 bytes, counting multibyte characters', () => {
    // 683 euro signs are 2,049 bytes but only 683 UTF-16 units.
    const big = { t: 'msg', name: 'chat', payload: '€'.repeat(682) } as const;
    expect(utf8ByteLength(JSON.stringify(big.payload))).toBe(2048);
    expect(buildClientText(big)).not.toBeNull();
    expect(buildClientText({ ...big, payload: '€'.repeat(683) })).toBeNull();
    const raw = JSON.stringify({ ...big, payload: '€'.repeat(683) });
    expect(parseClientText(raw)).toBeNull();
  });

  it('keeps only the fields it checked', () => {
    const raw = '{"t":"ping","at":2,"extra":"x","__proto__":{"polluted":true}}';
    expect(parseClientText(raw)).toEqual({ t: 'ping', at: 2 });
    expect(Object.keys(parseClientText(raw)!)).toEqual(['t', 'at']);
  });

  it('refuses nesting deeper than MAX_JSON_DEPTH, counting the frame itself', () => {
    const nested = (depth: number) => '['.repeat(depth) + ']'.repeat(depth);
    // The frame object is one level, so the payload may nest MAX_JSON_DEPTH - 1 more.
    const ok = `{"t":"msg","name":"x","payload":${nested(MAX_JSON_DEPTH - 1)}}`;
    const deep = `{"t":"msg","name":"x","payload":${nested(MAX_JSON_DEPTH)}}`;
    expect(parseClientText(ok)).not.toBeNull();
    expect(parseClientText(deep)).toBeNull();
    expect(
      parseServerText(`{"t":"msg","from":1,"name":"x","payload":${nested(MAX_JSON_DEPTH)}}`),
    ).toBeNull();
    expect(parseClientText(`{"t":"msg","name":"x","payload":${nested(1000)}}`)).toBeNull();
  });

  it('does not count brackets inside strings, escaped quotes included', () => {
    const text = JSON.stringify({
      t: 'msg',
      name: 'x',
      payload: '"[[[' + '['.repeat(100) + '\\"{',
    });
    expect(parseClientText(text)).not.toBeNull();
  });

  it('refuses a frame over the client text cap before parsing it', () => {
    const raw = JSON.stringify({ t: 'ping', at: 1, pad: 'x'.repeat(MAX_CLIENT_TEXT_BYTES) });
    expect(parseClientText(raw)).toBeNull();
  });

  it('returns null for malformed and mistyped frames, never throws', () => {
    const bad = [
      '',
      'not json',
      '{',
      'null',
      '[]',
      '42',
      '{"t":"nope"}',
      '{"t":"ping"}',
      '{"t":"ping","at":"1"}',
      '{"t":"ping","at":1e999}',
      '{"t":"hello","v":1,"room":"r"}',
      '{"t":"hello","v":1.5,"room":"r","name":"n"}',
      '{"t":"hello","v":1,"room":"r","name":"n","seat":{"id":1}}',
      '{"t":"hello","v":1,"room":"r","name":"n","seat":{"id":-1,"secret":"s"}}',
      '{"t":"hello","v":1,"room":"r","name":"n","token":5}',
      '{"t":"msg","name":"x"}',
      '{"t":"msg","payload":1}',
      '{"t":"welcome","player":1}',
    ];
    for (const text of bad) expect(parseClientText(text), text).toBeNull();
  });

  it('returns null rather than throw on a payload JSON cannot carry', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(buildClientText({ t: 'msg', name: 'x', payload: cyclic })).toBeNull();
    expect(buildClientText({ t: 'msg', name: 'x', payload: 10n })).toBeNull();
    expect(buildClientText({ t: 'msg', name: 'x', payload: undefined })).toBeNull();
  });
});

describe('server text frames', () => {
  const players = [
    { id: 1, name: 'Ana', connected: true },
    { id: 2, name: 'Bo', connected: false },
  ];
  const frames: ServerText[] = [
    { t: 'welcome', player: 1, entity: 9, secret: 'abc', frame: 600, snapshot: { entities: [] }, players },
    { t: 'cmd', frame: 601, ack: 12, entity: 9, commands: [{ tag: 'despawn', val: 4 }] },
    { t: 'players', players },
    { t: 'msg', from: 2, name: 'chat', payload: 'hi' },
    { t: 'pong', at: 1.5, server: 99 },
    { t: 'error', code: 'full' },
    { t: 'error', code: 'version', detail: 'server speaks 1' },
  ];

  it('round-trips every kind', () => {
    for (const frame of frames) {
      const text = buildServerText(frame);
      expect(text).not.toBeNull();
      expect(parseServerText(text!)).toEqual(frame);
    }
  });

  it('carries a welcome snapshot larger than the payload cap', () => {
    const snapshot = { blob: 'x'.repeat(MAX_PAYLOAD_BYTES * 4) };
    const frame: ServerText = { t: 'welcome', player: 1, entity: 0, secret: 's', frame: 0, snapshot, players };
    expect(parseServerText(buildServerText(frame)!)).toEqual(frame);
  });

  it('writes from with JSON.stringify, so a NaN id still makes valid JSON', () => {
    const text = buildServerText({ t: 'msg', from: Number.NaN, name: 'n', payload: 1 });
    expect(() => JSON.parse(text!) as unknown).not.toThrow();
    expect(parseServerText(text!)).toBeNull(); // from: null is not an id
  });

  it('refuses an oversized msg payload both ways', () => {
    const payload = 'y'.repeat(MAX_PAYLOAD_BYTES);
    expect(buildServerText({ t: 'msg', from: 1, name: 'n', payload })).toBeNull();
    expect(parseServerText(JSON.stringify({ t: 'msg', from: 1, name: 'n', payload }))).toBeNull();
  });

  it('returns null for malformed and mistyped frames', () => {
    const bad = [
      'nope',
      '{"t":"error","code":"other"}',
      '{"t":"error","code":"full","detail":3}',
      '{"t":"players","players":[{"id":1,"name":"a"}]}',
      '{"t":"players","players":{}}',
      '{"t":"cmd","frame":1,"ack":1,"commands":{}}',
      '{"t":"pong","at":1}',
      '{"t":"welcome","player":1,"secret":"s","frame":0,"players":[]}',
      '{"t":"ping","at":1}',
    ];
    for (const text of bad) expect(parseServerText(text), text).toBeNull();
  });
});
