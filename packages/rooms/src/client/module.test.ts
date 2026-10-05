/**
 * `multiplayer()`'s default connection and `roomsEndpoint`, without a server:
 * the connection factory is replaced to record what the page asked for.
 */
import { FeatureError } from '@gameable/core/headless';
import { createLoopbackConnection } from '@gameable/net/client';
import { chooseRoom, roomMode } from '@gameable/net/page';
import { loopbackPair } from '@gameable/net/testing';
import { describe, expect, it, vi } from 'vitest';

import type { ColyseusConnectionOptions } from './ColyseusConnection.js';
import { leaveReason, refusalReason } from './reasons.js';

const made = vi.hoisted(() => [] as ColyseusConnectionOptions[]);
vi.mock('./ColyseusConnection.js', async (original) => {
  const real = await original<typeof import('./ColyseusConnection.js')>();
  return {
    ...real,
    createColyseusConnection: (options: ColyseusConnectionOptions) => {
      made.push(options);
      return real.createColyseusConnection(options);
    },
  };
});

/** The `room` code each `multiplayer()` handed on to net's loader. */
const codes = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock('@gameable/net/client', async (original) => {
  const real = await original<typeof import('@gameable/net/client')>();
  return {
    ...real,
    multiplayer: (options: Parameters<typeof real.multiplayer>[0]) => {
      codes.push(options?.room);
      return real.multiplayer(options);
    },
  };
});

const { multiplayer } = await import('./module.js');
const { roomsEndpoint } = await import('./endpoint.js');

/**
 * @param href The page's address.
 * @param options More options.
 * @returns The connection options `multiplayer()` made.
 */
async function connectionFor(href: string, options = {}): Promise<ColyseusConnectionOptions> {
  made.length = 0;
  await multiplayer({ location: { href }, game: 'party', ...options });
  expect(made).toHaveLength(1);
  return made[0];
}

describe('roomsEndpoint', () => {
  it('is the page origin /services/rooms/, https to wss and http to ws', () => {
    expect(roomsEndpoint('https://play.example/mystery/?room=KQTX')).toBe(
      'wss://play.example/services/rooms/',
    );
    expect(roomsEndpoint('http://play.example:8080/x')).toBe(
      'ws://play.example:8080/services/rooms/',
    );
  });

  it('takes ?rooms= on a local page only', () => {
    expect(roomsEndpoint('http://localhost:5173/?rooms=http://localhost:8790')).toBe(
      'ws://localhost:8790/',
    );
    expect(roomsEndpoint('http://127.0.0.1/?rooms=https://dev.example/r/')).toBe(
      'wss://dev.example/r/',
    );
    expect(roomsEndpoint('http://[::1]:5173/?rooms=ws://127.0.0.1:1')).toBe('ws://127.0.0.1:1/');
    expect(roomsEndpoint('https://play.example/?rooms=wss://evil.example/')).toBe(
      'wss://play.example/services/rooms/',
    );
  });

  it('refuses ?rooms= on hosts that only look local', () => {
    // Each is a page some other domain serves; `?rooms=` there would send a
    // player's input wherever the link says.
    for (const page of [
      'http://localhost.evil.com/',
      'http://evil.localhost/',
      'http://localhost@evil.com/',
      'http://127.0.0.1.evil.com/',
      'http://127.0.0.1.nip.io/',
    ]) {
      const origin = new URL(page).origin;
      expect(roomsEndpoint(`${page}?rooms=ws://attacker.example/`), page).toBe(
        `${origin.replace(/^http/, 'ws')}/services/rooms/`,
      );
    }
  });
});

describe('multiplayer() from @gameable/rooms/client', () => {
  it('connects to the page origin by default, and a url option wins over it', async () => {
    expect((await connectionFor('https://play.example/m/')).url).toBe(
      'wss://play.example/services/rooms/',
    );
    const own = await connectionFor('https://play.example/m/', { url: 'wss://rooms.example/' });
    expect(own.url).toBe('wss://rooms.example/');
    expect(own.game).toBe('party');
  });

  it('?room=new (or newRoom) makes a fresh room; a code or nothing joins', async () => {
    expect((await connectionFor('https://p.example/?room=new')).create).toBe(true);
    expect(
      await connectionFor('https://p.example/', { newRoom: true, private: true }),
    ).toMatchObject({
      create: true,
      private: true,
    });
    expect((await connectionFor('https://p.example/?room=KQTX')).create).toBe(false);
    expect((await connectionFor('https://p.example/')).create).toBe(false);
  });

  it('?room=quick is a quick match: no code, no fresh room; a code is passed on', async () => {
    codes.length = 0;
    expect((await connectionFor('https://p.example/?room=quick')).create).toBe(false);
    expect((await connectionFor('https://p.example/?room=QUICK')).create).toBe(false);
    await connectionFor('https://p.example/?room=KQTX');
    expect(codes).toEqual([undefined, undefined, 'KQTX']);
  });

  it('reads ?room= with net/page roomMode: a code is trimmed and upper-cased, as the badge shows it', async () => {
    codes.length = 0;
    await connectionFor('https://p.example/?room=%20kqtx%20');
    expect(codes).toEqual(['KQTX']);
    expect((await connectionFor('https://p.example/?room=%20New%20')).create).toBe(true);
  });

  it("a page's room choice keeps ?rooms= on a local host and ignores it on a public one", async () => {
    const noSolo = (): Promise<never> => Promise.reject(new Error('not solo'));
    const search = '?room=new&rooms=http://localhost:8790';
    const { multiplayer: asked } = await chooseRoom(roomMode(search), {
      game: 'my-game',
      name: 'Ana',
      startSolo: noSolo,
    });
    const local = await connectionFor(`http://localhost:5181/${search}`, asked);
    expect(local).toMatchObject({ url: 'ws://localhost:8790/', game: 'my-game', create: true });
    const shared = await connectionFor(`https://play.example/g/${search}`, asked);
    expect(shared).toMatchObject({ url: 'wss://play.example/services/rooms/', create: true });
  });

  it('uses a given connection as is and makes none (Play Solo)', async () => {
    made.length = 0;
    const connection = createLoopbackConnection({ connect: () => loopbackPair()[0] });
    const feature = await multiplayer({ connection, location: { href: 'https://p.example/' } });
    expect(feature.name).toBe('multiplayer');
    expect(made).toEqual([]);
  });

  it('refuses with a FeatureError when there is no page and no url', async () => {
    await expect(multiplayer({ location: undefined })).rejects.toBeInstanceOf(FeatureError);
  });
});

describe('reasons', () => {
  it('names the refusals the room server gives', () => {
    expect(refusalReason({ code: 403, message: '' })).toBe('origin');
    expect(refusalReason({ code: 522, message: 'room "KQTX" is locked' })).toBe('full');
    expect(refusalReason({ code: 404, message: 'no room has the code "ZZZZ"' })).toBe('no-room');
    expect(refusalReason({ code: 404, message: '<html>Not Found' })).toBe('no-server');
    expect(refusalReason({ code: 522, message: 'room "KQTX" not found' })).toBe('no-room');
    expect(refusalReason({ code: 429, message: '' })).toBe('busy');
    expect(refusalReason({ code: 503, message: '' })).toBe('capacity');
    expect(refusalReason({ code: 426, message: 'the room server speaks protocol 1' })).toBe(
      'version',
    );
    expect(refusalReason({ code: 525, message: 'full moon only' })).toBe('refused');
    expect(refusalReason(new Error('socket'))).toBe('refused');
    expect(leaveReason(4100)).toBe('idle'); // dropped for sending nothing; the seat is held
    expect(leaveReason(4002)).toBe('error');
    expect(leaveReason(4002, 'budget')).toBe('budget'); // the room said why just before the 4002
    expect(leaveReason(1006, 'budget')).toBe('lost'); // the error frame only names a 4002
    expect([leaveReason(4000), leaveReason(1006), leaveReason(4003), leaveReason(4001)]).toEqual([
      'left',
      'lost',
      'lost',
      'shutdown',
    ]);
  });
});
