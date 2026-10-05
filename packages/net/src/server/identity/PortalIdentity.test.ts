import { describe, expect, it, vi } from 'vitest';

import { portalIdentity } from './PortalIdentity.js';

const AUTH = 'https://auth.example';

/**
 * @param status The HTTP status.
 * @param body The JSON body.
 * @returns A fake `fetch` answering it, and its calls.
 */
function answering(status: number, body: unknown) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
}

/**
 * @param fetch The fake.
 * @returns The headers of its first call.
 */
function sentHeaders(fetch: ReturnType<typeof answering>): Headers {
  return new Headers(fetch.mock.calls[0][1]?.headers);
}

describe('portalIdentity', () => {
  it("maps /auth/me's { id, email } to { id, name: the email's local part } (the plan's case)", async () => {
    const fetch = answering(200, { id: 'u1', email: 'a@b', org_id: null, roles: ['user'] });
    const portal = portalIdentity({ authUrl: AUTH, fetch });
    const who = await portal.resolve({ headers: { cookie: 'avataros_session=jwt-1' } });
    expect(who).toEqual({ id: 'u1', name: 'a', kind: 'portal' });
    expect(fetch.mock.calls[0][0]).toBe('https://auth.example/auth/me');
  });

  it('forwards only the session cookie, never the rest of the jar', async () => {
    const fetch = answering(200, { id: 'u1', email: 'a@b' });
    const portal = portalIdentity({ authUrl: `${AUTH}/`, fetch });
    await portal.resolve({
      headers: { cookie: 'theme=dark; avataros_session=jwt-1; other=secret' },
    });
    expect(fetch.mock.calls[0][0]).toBe('https://auth.example/auth/me');
    expect(sentHeaders(fetch).get('cookie')).toBe('avataros_session=jwt-1');
  });

  it('takes a bearer token instead of the cookie, sent to /auth/me as its session cookie', async () => {
    const fetch = answering(200, { id: 'u2', email: 'ben@x.io' });
    const portal = portalIdentity({ authUrl: AUTH, fetch });
    const who = await portal.resolve({ headers: { authorization: 'Bearer jwt-2' } });
    expect(who).toEqual({ id: 'u2', name: 'ben', kind: 'portal' });
    const headers = sentHeaders(fetch);
    expect(headers.get('cookie')).toBe('avataros_session=jwt-2');
    expect(headers.get('authorization')).toBe('Bearer jwt-2');
  });

  it('resolves null on a 401, and asks nothing when there is no session at all', async () => {
    const refused = answering(401, { error: 'Unauthorized' });
    const portal = portalIdentity({ authUrl: AUTH, fetch: refused });
    expect(await portal.resolve({ headers: { cookie: 'avataros_session=expired' } })).toBeNull();
    const none = answering(200, { id: 'u1', email: 'a@b' });
    const quiet = portalIdentity({ authUrl: AUTH, fetch: none });
    expect(await quiet.resolve({ headers: { cookie: 'theme=dark' } })).toBeNull();
    expect(await quiet.resolve({ headers: { authorization: 'Basic abc' } })).toBeNull();
    expect(none).not.toHaveBeenCalled();
  });

  it('resolves null when the auth service fails, answers junk, or is too slow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const headers = { cookie: 'avataros_session=jwt' };
    const down = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(await portalIdentity({ authUrl: AUTH, fetch: down }).resolve({ headers })).toBeNull();
    const junk = vi.fn(() => Promise.resolve(new Response('<html>', { status: 200 })));
    expect(await portalIdentity({ authUrl: AUTH, fetch: junk }).resolve({ headers })).toBeNull();
    const noId = answering(200, { email: 'a@b' });
    expect(await portalIdentity({ authUrl: AUTH, fetch: noId }).resolve({ headers })).toBeNull();
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const slow = portalIdentity({ authUrl: AUTH, fetch: hang, timeoutMs: 20 });
    expect(await slow.resolve({ headers })).toBeNull();
    warn.mockRestore();
  });

  it('names the player: a name field first, the email local part next, then "player"; capped at 32', async () => {
    const headers = { cookie: 'avataros_session=jwt' };
    const named = answering(200, { id: 'u1', name: 'Ana Lima', email: 'a@b' });
    expect((await portalIdentity({ authUrl: AUTH, fetch: named }).resolve({ headers }))?.name).toBe(
      'Ana Lima',
    );
    const bare = answering(200, { id: 'u1' });
    expect((await portalIdentity({ authUrl: AUTH, fetch: bare }).resolve({ headers }))?.name).toBe(
      'player',
    );
    const long = answering(200, { id: 'u1', email: `${'n'.repeat(40)}@b` });
    expect((await portalIdentity({ authUrl: AUTH, fetch: long }).resolve({ headers }))?.name).toBe(
      'n'.repeat(32),
    );
  });

  it('refuses an auth URL that is not http(s)', () => {
    expect(() => portalIdentity({ authUrl: 'auth.example', fetch: answering(200, {}) })).toThrow(
      /authUrl/,
    );
  });
});
