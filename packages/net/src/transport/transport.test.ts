import { afterEach, describe, expect, it, vi } from 'vitest';
import { latencyPair, loopbackPair } from '../testing/index.js';
import type { TransportData } from './Transport.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('loopbackPair', () => {
  it('delivers in order both ways', async () => {
    const [a, b] = loopbackPair();
    const atA: TransportData[] = [];
    const atB: TransportData[] = [];
    a.onMessage((d) => atA.push(d));
    b.onMessage((d) => atB.push(d));
    a.send('one');
    a.send(new Uint8Array([2]));
    b.send('three');
    a.send('four');
    await flush();
    expect(atB).toEqual(['one', new Uint8Array([2]), 'four']);
    expect(atA).toEqual(['three']);
  });

  it('closing one side fires onClose on the other with the reason, once on each end', async () => {
    const [a, b] = loopbackPair();
    const onA = vi.fn();
    const onB = vi.fn();
    a.onClose(onA);
    b.onClose(onB);
    a.close('bye');
    a.close('again');
    await flush();
    b.close('too');
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onA).toHaveBeenCalledWith('bye');
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onB).toHaveBeenCalledWith('bye');
  });

  it('reads frames sent before the close ahead of the close', async () => {
    const [a, b] = loopbackPair();
    const seen: string[] = [];
    b.onMessage((d) => seen.push(String(d)));
    b.onClose(() => seen.push('closed'));
    a.send('last');
    a.close();
    await flush();
    expect(seen).toEqual(['last', 'closed']);
  });

  it('drops a send after close and gives late listeners nothing', async () => {
    const [a, b] = loopbackPair();
    const got = vi.fn();
    b.onMessage(got);
    a.close();
    a.send('late');
    await flush();
    expect(got).not.toHaveBeenCalled();
    const lateClose = vi.fn();
    a.onClose(lateClose);
    b.onClose(lateClose);
    await flush();
    expect(lateClose).not.toHaveBeenCalled();
  });

  it('does not recurse when a handler sends during delivery', async () => {
    const [a, b] = loopbackPair();
    let depth = 0;
    let deepest = 0;
    const seen: string[] = [];
    a.onMessage((d) => {
      depth += 1;
      deepest = Math.max(deepest, depth);
      seen.push(`a:${String(d)}`);
      if (d === 'ping') a.send('pong');
      depth -= 1;
    });
    b.onMessage((d) => {
      depth += 1;
      deepest = Math.max(deepest, depth);
      seen.push(`b:${String(d)}`);
      if (d === 'start') b.send('ping');
      depth -= 1;
    });
    a.send('start');
    await flush();
    expect(seen).toEqual(['b:start', 'a:ping', 'b:pong']);
    expect(deepest).toBe(1);
    // The send inside the handler had not been delivered when the handler returned.
    expect(seen).not.toContain('a:pong');
  });
});

describe('latencyPair', () => {
  it('delivers after the delay', () => {
    vi.useFakeTimers();
    const [a, b] = latencyPair({ ms: 50 });
    const got = vi.fn();
    b.onMessage(got);
    a.send('x');
    vi.advanceTimersByTime(49);
    expect(got).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    // The loopback below it still hands over on a microtask.
    return Promise.resolve().then(() => {
      expect(got).toHaveBeenCalledWith('x');
    });
  });

  it('with loss 1 drops every binary frame and never a text frame', async () => {
    const [a, b] = latencyPair({ loss: 1 });
    const got: TransportData[] = [];
    b.onMessage((d) => got.push(d));
    for (let i = 0; i < 20; i++) {
      a.send(new Uint8Array([i]));
      a.send(`t${String(i)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(got).toHaveLength(20);
    expect(got.every((d) => typeof d === 'string')).toBe(true);
  });

  it('drops the same binary frames for the same seed, and some but not all at loss 0.5', async () => {
    const run = async (seed: number): Promise<number[]> => {
      const [a, b] = latencyPair({ loss: 0.5, seed });
      const got: number[] = [];
      b.onMessage((d) => got.push((d as Uint8Array)[0]));
      for (let i = 0; i < 40; i++) a.send(new Uint8Array([i]));
      await new Promise((resolve) => setTimeout(resolve, 10));
      return got;
    };
    const first = await run(7);
    expect(await run(7)).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(40);
  });

  it('reports queued bytes while frames wait, and closes the far end after the frames', async () => {
    const [a, b] = latencyPair({ ms: 5 });
    const seen: string[] = [];
    b.onMessage((d) => seen.push(String(d)));
    b.onClose((r) => seen.push(`closed:${r}`));
    a.send('abcd');
    expect(a.bufferedAmount).toBe(4);
    a.close('done');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(a.bufferedAmount).toBe(0);
    expect(seen).toEqual(['abcd', 'closed:done']);
  });

  it('copies a binary frame at send, so reusing the buffer does not change what arrives', async () => {
    for (const [a, b] of [loopbackPair(), latencyPair({ ms: 1 })]) {
      const got: number[] = [];
      b.onMessage((d) => got.push((d as Uint8Array)[0]));
      const scratch = new Uint8Array([1]);
      a.send(scratch);
      scratch[0] = 99;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(got).toEqual([1]);
    }
  });

  it('keeps delivering to later listeners when one throws', async () => {
    const [a, b] = loopbackPair();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const later = vi.fn();
    b.onMessage(() => {
      throw new Error('boom');
    });
    b.onMessage(later);
    a.send('x');
    await flush();
    expect(later).toHaveBeenCalledWith('x');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
