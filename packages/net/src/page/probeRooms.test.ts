import { describe, expect, it } from 'vitest';

import { probeRooms, roomsHealthUrl } from './probeRooms.js';

/**
 * A fetch stand-in that records each call.
 *
 * @param answer How it answers, given the request's abort signal.
 * @returns The stand-in and its calls.
 */
function fakeFetch(answer: (signal: AbortSignal | undefined) => Promise<Response>): {
  fetch: typeof fetch;
  calls: { url: string; mode: string | undefined }[];
} {
  const calls: { url: string; mode: string | undefined }[] = [];
  return {
    calls,
    fetch: (input, init) => {
      calls.push({
        url: input instanceof Request ? input.url : input.toString(),
        mode: init?.mode,
      });
      return answer(init?.signal ?? undefined);
    },
  };
}

/**
 * @param type The response type.
 * @param status The HTTP status.
 * @param body The body text: the room server's health JSON by default.
 * @returns A response as fetch would hand back.
 */
function response(
  type: ResponseType,
  status: number,
  body = '{"ok":true,"rooms":0,"players":0,"uptime":1}',
): Response {
  return {
    type,
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  } as Response;
}

describe('roomsHealthUrl', () => {
  it("is the room server's /health over http(s)", () => {
    expect(roomsHealthUrl('wss://play.example/services/rooms/')).toBe(
      'https://play.example/services/rooms/health',
    );
    expect(roomsHealthUrl('ws://localhost:8790/')).toBe('http://localhost:8790/health');
  });
});

describe('probeRooms: is there a room server to play with friends on?', () => {
  const page = 'https://play.example';

  it('yes when the same-origin /health answers 200', async () => {
    const f = fakeFetch(() => Promise.resolve(response('basic', 200)));
    expect(
      await probeRooms('wss://play.example/services/rooms/', { fetch: f.fetch, origin: page }),
    ).toBe(true);
    expect(f.calls).toEqual([
      { url: 'https://play.example/services/rooms/health', mode: 'same-origin' },
    ]);
  });

  it('no when nothing serves it (the hosted docs answer 404)', async () => {
    const f = fakeFetch(() => Promise.resolve(response('basic', 404)));
    expect(
      await probeRooms('wss://play.example/services/rooms/', { fetch: f.fetch, origin: page }),
    ).toBe(false);
  });

  it('no when a 200 is not a room server (a dev server answers every path with its page)', async () => {
    const html = fakeFetch(() => Promise.resolve(response('basic', 200, '<!doctype html>')));
    expect(
      await probeRooms('ws://localhost:5181/services/rooms/', {
        fetch: html.fetch,
        origin: 'http://localhost:5181',
      }),
    ).toBe(false);
    const sick = fakeFetch(() => Promise.resolve(response('basic', 200, '{"ok":false}')));
    expect(
      await probeRooms('wss://play.example/services/rooms/', { fetch: sick.fetch, origin: page }),
    ).toBe(false);
  });

  it('no on a network error', async () => {
    const f = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(
      await probeRooms('wss://play.example/services/rooms/', { fetch: f.fetch, origin: page }),
    ).toBe(false);
  });

  it('no when it does not answer within the timeout', async () => {
    const f = fakeFetch(
      (signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const started = Date.now();
    const answered = await probeRooms('wss://play.example/services/rooms/', {
      fetch: f.fetch,
      origin: page,
      timeoutMs: 30,
    });
    expect(answered).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('yes for a local dev server on another port: the opaque answer is an answer', async () => {
    const f = fakeFetch(() => Promise.resolve(response('opaque', 0)));
    const answered = await probeRooms('ws://localhost:8790/', {
      fetch: f.fetch,
      origin: 'http://localhost:5181',
    });
    expect(answered).toBe(true);
    expect(f.calls[0]?.mode).toBe('no-cors');
  });

  it('defaults to about 1.5 s', async () => {
    const { PROBE_TIMEOUT_MS } = await import('./probeRooms.js');
    expect(PROBE_TIMEOUT_MS).toBe(1500);
  });
});
