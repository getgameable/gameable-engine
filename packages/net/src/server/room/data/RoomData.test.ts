import type { GameEvent } from '@gameable/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryStore } from '../../store/index.js';
import type { PlayerStore } from '../../store/index.js';
import { RoomData } from './RoomData.js';

/** Let every settled promise run its callbacks. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

interface Setup {
  store: PlayerStore;
  data: RoomData;
  events: GameEvent[];
  logs: string[];
  saves: () => number;
}

/**
 * A room's data over a memory store, counting the store's saves.
 *
 * @param store The store, a fresh memory store by default.
 * @returns The parts.
 */
function setup(store: PlayerStore = memoryStore()): Setup {
  const events: GameEvent[] = [];
  const logs: string[] = [];
  const save = vi.spyOn(store, 'save');
  const data = new RoomData({
    store,
    game: 'steal',
    push: (event) => events.push(event),
    log: (line) => logs.push(line),
  });
  return { store, data, events, logs, saves: () => save.mock.calls.length };
}

/**
 * @param envelope What `join` returned.
 * @returns The envelope's doc, parsed.
 */
const docOf = (envelope: string | null | undefined): unknown =>
  envelope == null ? null : (JSON.parse(envelope) as { doc: unknown }).doc;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RoomData', () => {
  it('a join loads the stored document and when it was saved', async () => {
    const store = memoryStore();
    await store.save('steal', 'u1', '{"coins":10}', 0);
    const { data } = setup(store);
    const envelope = await data.join(0, 'u1');
    expect(JSON.parse(envelope ?? 'null')).toEqual({
      doc: { coins: 10 },
      savedAt: 1_000_000,
      now: 1_000_000,
    });
    // No document: the envelope still carries the server's clock.
    const none = await data.join(1, 'nobody');
    expect(JSON.parse(none ?? 'null')).toEqual({ doc: null, savedAt: null, now: 1_000_000 });
  });

  it('two saves within 6 s make one store.save; the later one is written at the 6 s mark', async () => {
    const s = setup();
    await s.data.join(0, 'u1');
    s.data.savePlayer(0, '{"coins":1}');
    await settle();
    s.data.savePlayer(0, '{"coins":2}');
    await settle();
    expect(s.saves()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.saves()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.saves()).toBe(2);
    expect((await s.store.load('steal', 'u1'))?.data).toBe('{"coins":2}');
  });

  it('leave flushes a pending save, and a rejoin sees it', async () => {
    const s = setup();
    await s.data.join(0, 'u1');
    s.data.savePlayer(0, '{"coins":1}');
    await settle();
    s.data.savePlayer(0, '{"coins":7}');
    await s.data.leave(0);
    expect(s.saves()).toBe(2);
    expect(docOf(await s.data.join(3, 'u1'))).toEqual({ coins: 7 });
  });

  it('dispose flushes every pending save', async () => {
    const s = setup();
    await s.data.join(0, 'u1');
    await s.data.join(1, 'u2');
    s.data.savePlayer(0, '{"a":1}');
    s.data.savePlayer(0, '{"a":2}');
    s.data.savePlayer(1, '{"b":1}');
    s.data.savePlayer(1, '{"b":2}');
    await s.data.dispose();
    expect((await s.store.load('steal', 'u1'))?.data).toBe('{"a":2}');
    expect((await s.store.load('steal', 'u2'))?.data).toBe('{"b":2}');
  });

  it('a stale save is logged and the room keeps going', async () => {
    const s = setup();
    await s.data.join(0, 'u1');
    await s.store.save('steal', 'u1', '{"other":"room"}', 0); // someone else wrote first
    s.data.savePlayer(0, '{"coins":1}');
    await settle();
    expect(s.logs.some((l) => l.includes('stale'))).toBe(true);
    expect((await s.store.load('steal', 'u1'))?.data).toBe('{"other":"room"}');
    expect(() => {
      s.data.savePlayer(0, '{"coins":2}');
    }).not.toThrow();
  });

  it('a store that throws is logged and never throws into the caller', async () => {
    const broken = memoryStore();
    vi.spyOn(broken, 'load').mockRejectedValue(new Error('down'));
    vi.spyOn(broken, 'save').mockImplementation(() => {
      throw new Error('down');
    });
    const s = setup(broken);
    expect(docOf(await s.data.join(0, 'u1'))).toBeNull();
    expect(() => {
      s.data.savePlayer(0, '{"coins":1}');
    }).not.toThrow();
    await settle();
    expect(s.logs.length).toBeGreaterThan(0);
  });

  it('an exchange moves both documents or neither, and its result carries the id', async () => {
    const s = setup();
    await s.store.save('steal', 'u1', '{"coins":10}', 0);
    await s.store.save('steal', 'u2', '{"owned":["gem"]}', 0);
    await s.data.join(0, 'u1');
    await s.data.join(1, 'u2');

    s.data.exchange({ id: 7, a: 0, b: 1, give: '{"coins":4}', take: '{"owned":["gem"]}' });
    await settle();
    expect(s.events).toEqual([
      {
        tag: 'exchange-result',
        val: {
          id: 7,
          ok: true,
          reason: '',
          aData: '{"coins":6,"owned":["gem"]}',
          bData: '{"owned":[],"coins":4}',
        },
      },
    ]);
    expect(JSON.parse((await s.store.load('steal', 'u1'))?.data ?? '')).toEqual({
      coins: 6,
      owned: ['gem'],
    });
    expect(JSON.parse((await s.store.load('steal', 'u2'))?.data ?? '')).toEqual({
      owned: [],
      coins: 4,
    });

    // u2 has no gem left to give: refused, and neither side changes.
    s.data.exchange({ id: 8, a: 0, b: 1, give: '{"coins":1}', take: '{"owned":["gem"]}' });
    await settle();
    expect(s.events[1]).toEqual({
      tag: 'exchange-result',
      val: { id: 8, ok: false, reason: 'refused', aData: '', bData: '' },
    });
    expect(JSON.parse((await s.store.load('steal', 'u1'))?.data ?? '')).toEqual({
      coins: 6,
      owned: ['gem'],
    });

    s.data.exchange({ id: 9, a: 0, b: 5, give: '{}', take: '{}' });
    await settle();
    expect(s.events[2]).toEqual({
      tag: 'exchange-result',
      val: { id: 9, ok: false, reason: 'unknown-player', aData: '', bData: '' },
    });
  });

  it('an exchange writes pending saves first, and drops saves made before its result', async () => {
    const store = memoryStore();
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const exchange = store.exchange.bind(store);
    vi.spyOn(store, 'exchange').mockImplementation(async (...args) => {
      await gate;
      return exchange(...args);
    });
    const s = setup(store);
    await s.data.join(0, 'u1');
    await s.data.join(1, 'u2');
    s.data.savePlayer(0, '{"coins":1}');
    s.data.savePlayer(0, '{"coins":5}'); // pending behind the throttle
    s.data.exchange({ id: 1, a: 0, b: 1, give: '{"coins":5}', take: '{}' });
    await settle(); // the pending save is written; the exchange waits on the store
    expect((await store.load('steal', 'u1'))?.data).toBe('{"coins":5}');
    s.data.savePlayer(0, '{"coins":5,"stale":true}'); // the guest has not seen the result yet
    open();
    await settle();
    // The result carries what the store wrote, so the guest adopts it over its stale copy.
    expect(s.events[0]).toEqual({
      tag: 'exchange-result',
      val: { id: 1, ok: true, reason: '', aData: '{"coins":0}', bData: '{"coins":5}' },
    });
    await s.data.leave(0);
    expect(JSON.parse((await store.load('steal', 'u1'))?.data ?? '')).toEqual({ coins: 0 });
  });

  it('start hands the game document over as a game-data event; saveGame writes it', async () => {
    const store = memoryStore();
    await store.saveGame('steal', '{"round":2}', 0);
    const s = setup(store);
    await s.data.start();
    expect(s.events).toEqual([{ tag: 'game-data', val: { data: '{"round":2}' } }]);
    s.data.saveGame('{"round":3}');
    await s.data.dispose();
    expect((await store.loadGame('steal'))?.data).toBe('{"round":3}');
  });
});
