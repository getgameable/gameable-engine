import { describe, expect, it, vi } from 'vitest';

import type { EngineEventMap } from './events.js';
import { createEvents } from './events.js';

/** The map most tests here use. */
interface TestMap {
  /** Something was hit. */
  hit: { damage: number };
  /** Something happened with no payload. */
  ping: undefined;
}

describe('createEvents', () => {
  it('delivers a payload to every subscriber, in subscription order', () => {
    const events = createEvents<TestMap>();
    const order: string[] = [];
    events.on('hit', () => order.push('a'));
    events.on('hit', () => order.push('b'));

    events.emit('hit', { damage: 3 });

    expect(order).toEqual(['a', 'b']);
  });

  it('passes the payload through unchanged', () => {
    const events = createEvents<TestMap>();
    const payload = { damage: 7 };
    const seen = vi.fn();
    events.on('hit', seen);
    events.emit('hit', payload);
    expect(seen).toHaveBeenCalledWith(payload);
  });

  it('does nothing when nobody is listening', () => {
    const events = createEvents<TestMap>();
    expect(() => {
      events.emit('hit', { damage: 1 });
    }).not.toThrow();
    expect(events.listenerCount('hit')).toBe(0);
  });

  it('unsubscribes through the returned function', () => {
    const events = createEvents<TestMap>();
    const seen = vi.fn();
    const off = events.on('hit', seen);

    events.emit('hit', { damage: 1 });
    off();
    events.emit('hit', { damage: 2 });

    expect(seen).toHaveBeenCalledTimes(1);
    expect(events.listenerCount('hit')).toBe(0);
  });

  it('unsubscribes through off()', () => {
    const events = createEvents<TestMap>();
    const seen = vi.fn();
    events.on('hit', seen);
    events.off('hit', seen);
    events.emit('hit', { damage: 1 });
    expect(seen).not.toHaveBeenCalled();
  });

  it('ignores off() for a handler that was never subscribed', () => {
    const events = createEvents<TestMap>();
    expect(() => {
      events.off('hit', vi.fn());
    }).not.toThrow();
  });

  it('removes only the named handler', () => {
    const events = createEvents<TestMap>();
    const a = vi.fn();
    const b = vi.fn();
    events.on('hit', a);
    events.on('hit', b);
    events.off('hit', a);
    events.emit('hit', { damage: 1 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('keeps event names separate', () => {
    const events = createEvents<TestMap>();
    const hit = vi.fn();
    const ping = vi.fn();
    events.on('hit', hit);
    events.on('ping', ping);
    events.emit('ping', undefined);
    expect(hit).not.toHaveBeenCalled();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('fires a once() handler exactly once', () => {
    const events = createEvents<TestMap>();
    const seen = vi.fn();
    events.once('hit', seen);

    events.emit('hit', { damage: 1 });
    events.emit('hit', { damage: 2 });

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ damage: 1 });
    expect(events.listenerCount('hit')).toBe(0);
  });

  it('can cancel a once() handler before it fires', () => {
    const events = createEvents<TestMap>();
    const seen = vi.fn();
    const off = events.once('hit', seen);
    off();
    events.emit('hit', { damage: 1 });
    expect(seen).not.toHaveBeenCalled();
  });

  it('survives a handler unsubscribing itself mid-emit', () => {
    const events = createEvents<TestMap>();
    const seen: string[] = [];
    const first = () => {
      seen.push('first');
      events.off('hit', first);
    };
    events.on('hit', first);
    events.on('hit', () => seen.push('second'));

    events.emit('hit', { damage: 1 });
    events.emit('hit', { damage: 2 });

    expect(seen).toEqual(['first', 'second', 'second']);
    expect(events.listenerCount('hit')).toBe(1);
  });

  it('does not call a handler removed earlier in the same emit', () => {
    const events = createEvents<TestMap>();
    const later = vi.fn();
    events.on('hit', () => {
      events.off('hit', later);
    });
    events.on('hit', later);

    events.emit('hit', { damage: 1 });
    events.emit('hit', { damage: 2 });

    expect(later).not.toHaveBeenCalled();
    expect(events.listenerCount('hit')).toBe(1);
  });

  it('supports nested emits', () => {
    const events = createEvents<TestMap>();
    const seen: string[] = [];
    events.on('hit', () => {
      seen.push('hit');
      events.emit('ping', undefined);
    });
    events.on('ping', () => seen.push('ping'));

    events.emit('hit', { damage: 1 });

    expect(seen).toEqual(['hit', 'ping']);
  });

  it('drops everything on clear()', () => {
    const events = createEvents<TestMap>();
    const seen = vi.fn();
    events.on('hit', seen);
    events.clear();
    events.emit('hit', { damage: 1 });
    expect(seen).not.toHaveBeenCalled();
    expect(events.listenerCount('hit')).toBe(0);
  });

  it('types the engine event map', () => {
    const events = createEvents<EngineEventMap>();
    const seen = vi.fn();
    events.on('engine:resize', seen);
    events.emit('engine:resize', { width: 800, height: 600 });
    expect(seen).toHaveBeenCalledWith({ width: 800, height: 600 });
  });
});
