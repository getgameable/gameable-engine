// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import type { NetState } from '../client/NetService.js';
import { createPageRoom, type PageRoomNet } from './PageRoom.js';
import { roomMode } from './roomMode.js';
import { closeReasonText, netStatusText } from './statusText.js';

/**
 * A net service stand-in the test moves by hand.
 *
 * @returns It, connecting.
 */
function fakeNet(): PageRoomNet & { state: NetState; room: string | null; closeReason: string } {
  return { state: 'connecting', room: null, closeReason: '' };
}

/**
 * The badge's visible text, by part.
 *
 * @param root Where the badge is.
 * @returns The code, the status line and the button labels.
 */
function parts(root: ParentNode): { code: string; status: string; buttons: string[] } {
  return {
    code: root.querySelector('[data-part="code"]')?.textContent ?? '',
    status: root.querySelector('[data-part="status"]')?.textContent ?? '',
    buttons: [...root.querySelectorAll('button')].map((button) => button.textContent),
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

describe('closeReasonText and netStatusText', () => {
  it('says why a join failed, in words, with the reason code', () => {
    expect(closeReasonText('full')).toMatch(/full.*\(full\)/);
    expect(closeReasonText('origin')).toMatch(/address.*\(origin\)/);
    expect(closeReasonText('capacity')).toMatch(/capacity.*\(capacity\)/);
    expect(closeReasonText('no-room')).toMatch(/no room.*\(no-room\)/i);
    expect(closeReasonText('version')).toMatch(/reload.*\(version\)/);
    expect(closeReasonText('idle')).toMatch(/nothing.*reload.*\(idle\)/);
    expect(closeReasonText('something-new')).toBe('something-new');
  });

  it('names each net state', () => {
    expect(netStatusText('connecting', '', false)).toMatch(/connecting/i);
    expect(netStatusText('joined', '', false)).toMatch(/joined/i);
    expect(netStatusText('joined', '', true)).toMatch(/solo/i);
    expect(netStatusText('reconnecting', '', false)).toMatch(/reconnecting/i);
    expect(netStatusText('closed', 'full', false)).toMatch(/^Lost: .*full/);
  });
});

describe('createPageRoom: the room code on screen', () => {
  it('shows the state, then the code and a copy-link button once joined, and remembers the room', async () => {
    history.replaceState(null, '', '/?room=new');
    const copied: string[] = [];
    const net = fakeNet();
    const room = createPageRoom({
      net,
      mode: roomMode(location.search),
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    room.frame();
    expect(parts(document.body)).toMatchObject({
      code: '',
      status: expect.stringMatching(/connecting/i) as string,
    });

    net.state = 'joined';
    net.room = 'KQTX';
    room.frame();
    expect(parts(document.body).code).toBe('KQTX');
    expect(parts(document.body).status).toMatch(/joined/i);
    expect(location.search).toBe('?room=KQTX');

    const copy = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Copy link',
    );
    copy?.click();
    await Promise.resolve();
    expect(copied).toEqual([`${location.origin}/?room=KQTX`]);

    room.dispose();
    expect(document.querySelector('[data-part="code"]')).toBeNull();
  });

  it('shows reconnecting, and a lost room with its reason', () => {
    const net = fakeNet();
    const room = createPageRoom({ net, mode: roomMode('?room=KQTX') });
    net.state = 'reconnecting';
    room.frame();
    expect(parts(document.body).status).toMatch(/reconnecting/i);
    net.state = 'closed';
    net.closeReason = 'full';
    room.frame();
    expect(parts(document.body).status).toMatch(/^Lost: .*\(full\)/);
  });

  it('solo offers Play with friends only once the room server answers', async () => {
    const net = fakeNet();
    let answer: (yes: boolean) => void = () => undefined;
    createPageRoom({
      net,
      mode: roomMode(''),
      probe: () =>
        new Promise<boolean>((done) => {
          answer = done;
        }),
    });
    const friends = (): HTMLButtonElement | undefined =>
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Play with friends');
    expect(friends()?.hidden).toBe(true);
    answer(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(friends()?.hidden).toBe(false);
  });

  it('a hosted page with no room server keeps Play Solo and hides Play with friends', async () => {
    const net = fakeNet();
    createPageRoom({ net, mode: roomMode(''), probe: () => Promise.resolve(false) });
    await Promise.resolve();
    await Promise.resolve();
    const buttons = [...document.querySelectorAll('button')];
    expect(buttons.map((b) => [b.textContent, b.hidden])).toEqual([
      ['Play Solo', false],
      ['Play with friends', true],
    ]);
  });

  it('solo offers Play Solo (current) and Play with friends, which asks for a new room', async () => {
    history.replaceState(null, '', '/?seed=4');
    const went: string[] = [];
    const net = fakeNet();
    createPageRoom({
      net,
      mode: roomMode(location.search),
      navigate: (href) => went.push(href),
      probe: () => Promise.resolve(true),
    });
    await Promise.resolve();
    await Promise.resolve();
    const { buttons } = parts(document.body);
    expect(buttons).toEqual(['Play Solo', 'Play with friends']);
    const [solo, friends] = [...document.querySelectorAll('button')];
    expect(solo.getAttribute('aria-pressed')).toBe('true');
    friends.click();
    expect(went).toEqual([`${location.origin}/?seed=4&room=new`]);
  });

  it('writes the code and the close reason as text, never as markup', () => {
    const net = fakeNet();
    const room = createPageRoom({ net, mode: roomMode('?room=new') });
    const hostile = '<img src=x onerror="window.__pwned=1">';
    net.state = 'joined';
    net.room = hostile;
    room.frame();
    expect(parts(document.body).code).toBe(hostile);
    net.state = 'closed';
    net.closeReason = hostile;
    room.frame();
    expect(parts(document.body).status).toContain(hostile);
    expect(document.querySelector('.aos-room img')).toBeNull();
  });

  it('shows no code on a solo page, even though the solo room has one', () => {
    const net = fakeNet();
    const room = createPageRoom({ net, mode: roomMode(''), probe: () => Promise.resolve(false) });
    net.state = 'joined';
    net.room = 'SOLO';
    room.frame();
    expect(parts(document.body).code).toBe('');
  });

  it('touches the page only when something changed', () => {
    const net = fakeNet();
    const room = createPageRoom({ net, mode: roomMode('?room=KQTX') });
    room.frame();
    const status = document.querySelector('[data-part="status"]');
    const before = status?.firstChild;
    room.frame();
    room.frame();
    expect(status?.firstChild).toBe(before);
    expect(room.renders).toBe(1);
  });
});

describe('createPageRoom: no frames needed', () => {
  it('redraws and rewrites ?room= when net says it changed, with no frame() call (a hidden tab)', () => {
    history.replaceState(null, '', '/?room=new');
    const listeners = new Set<() => void>();
    const net = {
      ...fakeNet(),
      onChange: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const room = createPageRoom({ net, mode: roomMode(location.search) });
    net.state = 'joined';
    net.room = 'KQTX';
    for (const fn of listeners) fn();
    expect(parts(document.body).code).toBe('KQTX');
    expect(location.search).toBe('?room=KQTX');
    room.dispose();
    expect(listeners.size).toBe(0);
  });
});
