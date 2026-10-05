import { describe, expect, it } from 'vitest';

import { friendsHref, rememberRoom, roomHref } from './roomHref.js';
import { roomMode } from './roomMode.js';

/**
 * A stand-in for `window`: its address and a history that records each replaceState.
 *
 * @param href The starting address.
 * @returns The stand-in and its recorded calls.
 */
function page(href: string): {
  location: { href: string };
  history: { replaceState(data: unknown, unused: string, url?: string | URL | null): void };
  calls: string[];
} {
  const calls: string[] = [];
  const location = { href };
  return {
    location,
    calls,
    history: {
      replaceState: (_data, _unused, url) => {
        const next = String(url);
        calls.push(next);
        location.href = new URL(next, location.href).href;
      },
    },
  };
}

describe('roomHref and friendsHref', () => {
  it('sets ?room= and keeps every other parameter', () => {
    expect(roomHref('http://localhost:5181/?room=new&rooms=http://localhost:8790', 'KQTX')).toBe(
      'http://localhost:5181/?room=KQTX&rooms=http%3A%2F%2Flocalhost%3A8790',
    );
    expect(roomHref('https://play.example/g/?seed=4#x', 'ABCD')).toBe(
      'https://play.example/g/?seed=4&room=ABCD#x',
    );
  });

  it('a solo page invites friends by asking for a new room', () => {
    expect(friendsHref('http://localhost:5181/?seed=4')).toBe(
      'http://localhost:5181/?seed=4&room=new',
    );
  });
});

describe('rememberRoom: a reload resumes the seat', () => {
  it('after ?room=new, writes ?room=CODE with replaceState', () => {
    const win = page('http://localhost:5181/?room=new&rooms=http://localhost:8790');
    expect(rememberRoom(roomMode('?room=new'), 'KQTX', win)).toBe(true);
    expect(win.calls).toEqual([
      'http://localhost:5181/?room=KQTX&rooms=http%3A%2F%2Flocalhost%3A8790',
    ]);
  });

  it('after a quick match, writes ?room=CODE with replaceState', () => {
    const win = page('https://play.example/?room=quick');
    expect(rememberRoom(roomMode('?room=quick'), 'MNPQ', win)).toBe(true);
    expect(win.calls).toEqual(['https://play.example/?room=MNPQ']);
  });

  it('writes nothing for a join by code, for solo, or before the code is known', () => {
    const win = page('https://play.example/?room=KQTX');
    expect(rememberRoom(roomMode('?room=KQTX'), 'KQTX', win)).toBe(false);
    expect(rememberRoom(roomMode(''), 'SOLO', win)).toBe(false);
    expect(rememberRoom(roomMode('?room=new'), null, win)).toBe(false);
    expect(win.calls).toEqual([]);
  });

  it('writes once: the address already names the room afterwards', () => {
    const win = page('https://play.example/?room=new');
    const mode = roomMode('?room=new');
    rememberRoom(mode, 'KQTX', win);
    expect(rememberRoom(mode, 'KQTX', win)).toBe(false);
    expect(win.calls).toHaveLength(1);
  });
});
