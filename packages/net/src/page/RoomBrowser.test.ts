// @vitest-environment jsdom
/**
 * The "Browse rooms" panel: the badge's button, the list it opens, its Join,
 * New room and Quick join buttons, and the rules that keep it honest (loaded
 * only on open, hidden without a room server, server text as text).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { browseRows } from './browseRows.js';
import { createPageRoom, type PageRoomNet } from './PageRoom.js';
import type { LiveRoomList, PublicRoom } from './roomList.js';
import { roomMode } from './roomMode.js';

/** A live list the test moves by hand. */
class FakeList implements LiveRoomList {
  rooms: readonly PublicRoom[];
  state: 'open' | 'closed' = 'open';
  closes = 0;
  private readonly fns = new Set<() => void>();

  constructor(rooms: readonly PublicRoom[]) {
    this.rooms = rooms;
  }

  onChange(fn: () => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  close(): void {
    this.closes += 1;
    this.state = 'closed';
  }

  set(rooms: readonly PublicRoom[]): void {
    this.rooms = rooms;
    for (const fn of this.fns) fn();
  }
}

const net = (): PageRoomNet => ({ state: 'joined', room: null, closeReason: '' });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};
const button = (label: string, root: ParentNode = document): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === label);
const panel = (): HTMLElement | null => document.querySelector('.aos-browse');
const rowTexts = (): string[][] =>
  [...document.querySelectorAll('.aos-browse [data-part=row]')].map((row) =>
    [...row.querySelectorAll('[data-cell]')].map((cell) => cell.textContent),
  );

/**
 * A solo page with the browse panel.
 *
 * @param list What the loader resolves to, or an error it rejects with.
 * @param probe The room server's answer.
 * @returns The page's loader calls and where it navigated.
 */
function soloPage(list: FakeList | Error, probe = true) {
  history.replaceState(null, '', '/?seed=4');
  const loads: [string, string][] = [];
  const went: string[] = [];
  createPageRoom({
    net: net(),
    mode: roomMode(location.search),
    navigate: (href) => went.push(href),
    probe: () => Promise.resolve(probe),
    browse: {
      game: 'my-game',
      list: (game, endpoint) => {
        loads.push([game, endpoint]);
        return list instanceof Error ? Promise.reject(list) : Promise.resolve(list);
      },
    },
  });
  return { loads, went };
}

afterEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

describe('browseRows', () => {
  it('puts open rooms first, fullest first, and says each in words', () => {
    const rows = browseRows([
      { code: 'FULL', players: 2, maxPlayers: 2, phase: 'playing' },
      { code: 'BBBB', players: 1, maxPlayers: 6, phase: null },
      { code: 'AAAA', players: 3, maxPlayers: 6, phase: 'lobby' },
    ]);
    expect(rows).toEqual([
      { code: 'AAAA', seats: '3/6', phase: 'lobby', full: false },
      { code: 'BBBB', seats: '1/6', phase: '—', full: false },
      { code: 'FULL', seats: '2/2', phase: 'playing', full: true },
    ]);
  });
});

describe('the Browse rooms panel', () => {
  it('loads the room list only when the panel opens, then lists each room with a Join', async () => {
    const list = new FakeList([{ code: 'KQTX', players: 2, maxPlayers: 6, phase: 'lobby' }]);
    const { loads, went } = soloPage(list);
    await flush();
    expect(button('Browse rooms')?.hidden).toBe(false);
    expect(loads).toEqual([]);
    expect(panel()?.hidden ?? true).toBe(true);

    button('Browse rooms')?.click();
    await flush();
    expect(loads).toEqual([['my-game', `ws://${location.host}/services/rooms/`]]);
    expect(panel()?.hidden).toBe(false);
    expect(rowTexts()).toEqual([['KQTX', '2/6', 'lobby']]);

    button('Join', panel() ?? document)?.click();
    expect(went).toEqual([`${location.origin}/?seed=4&room=KQTX`]);
  });

  it('follows the live list, and closes it with the panel', async () => {
    const list = new FakeList([]);
    soloPage(list);
    await flush();
    button('Browse rooms')?.click();
    await flush();
    expect(panel()?.textContent).toMatch(/no open rooms/i);
    list.set([
      { code: 'AAAA', players: 1, maxPlayers: 2, phase: null },
      { code: 'BBBB', players: 2, maxPlayers: 2, phase: 'playing' },
    ]);
    expect(rowTexts()).toEqual([
      ['AAAA', '1/2', '—'],
      ['BBBB', '2/2', 'playing'],
    ]);
    const joins = [...(panel()?.querySelectorAll('button') ?? [])].filter(
      (b) => b.textContent === 'Join',
    );
    expect(joins.map((b) => b.disabled)).toEqual([false, true]); // a full room cannot be joined

    button('Close', panel() ?? document)?.click();
    expect(panel()?.hidden).toBe(true);
    expect(list.closes).toBe(1);
  });

  it('offers New room and Quick join', async () => {
    const { went } = soloPage(new FakeList([]));
    await flush();
    button('Browse rooms')?.click();
    await flush();
    button('New room', panel() ?? document)?.click();
    button('Quick join', panel() ?? document)?.click();
    expect(went).toEqual([
      `${location.origin}/?seed=4&room=new`,
      `${location.origin}/?seed=4&room=quick`,
    ]);
  });

  it('is hidden when the room server does not answer, like Play with friends', async () => {
    const { loads } = soloPage(new FakeList([]), false);
    await flush();
    expect(button('Browse rooms')?.hidden).toBe(true);
    expect(loads).toEqual([]);
  });

  it('says so when the list cannot be loaded', async () => {
    soloPage(new Error('429'));
    await flush();
    button('Browse rooms')?.click();
    await flush();
    expect(panel()?.textContent).toMatch(/could not reach the room list/i);
  });

  it('writes a hostile code and phase as text, never as markup', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    soloPage(new FakeList([{ code: hostile, players: 1, maxPlayers: 4, phase: hostile }]));
    await flush();
    button('Browse rooms')?.click();
    await flush();
    expect(rowTexts()).toEqual([[hostile, '1/4', hostile]]);
    expect(document.querySelector('img')).toBeNull();
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it('closes a list that arrives after the panel was closed', async () => {
    const list = new FakeList([]);
    let deliver: (l: FakeList) => void = () => undefined;
    createPageRoom({
      net: net(),
      mode: roomMode('?room=KQTX'),
      browse: {
        game: 'my-game',
        list: () =>
          new Promise<FakeList>((done) => {
            deliver = done;
          }),
      },
    });
    button('Browse rooms')?.click(); // open
    button('Browse rooms')?.click(); // and close again before the list is there
    expect(panel()?.hidden).toBe(true);
    deliver(list);
    await flush();
    expect(list.closes).toBe(1);
    expect(panel()?.hidden).toBe(true);
  });

  it('is on a room page too, without a probe', () => {
    const list = new FakeList([]);
    let loads = 0;
    createPageRoom({
      net: net(),
      mode: roomMode('?room=KQTX'),
      browse: {
        game: 'my-game',
        list: () => {
          loads += 1;
          return Promise.resolve(list);
        },
      },
    });
    expect(button('Browse rooms')?.hidden).toBe(false);
    expect(loads).toBe(0);
  });
});
