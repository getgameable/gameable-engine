/**
 * `startPlaySolo`: the stale-guest warning a dev page shows before Play Solo
 * starts, and the plain error when the authority cannot start.
 */
import { defineGame } from '@gameable/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import type { InPageAuthority } from './InPageAuthority.js';
import { checkGuestStatus, GUEST_STATUS_PATH, staleGuestWarning } from './guestStatus.js';
import { standInGuest } from './soloTesting.js';
import { startPlaySolo } from './startPlaySolo.js';

const DEFINITION = defineGame({ features: { multiplayer: { maxPlayers: 2 } } });
const open: InPageAuthority[] = [];

afterEach(async () => {
  for (const solo of open.splice(0)) await solo.stop();
});

/**
 * @param body The dev server's answer, or an error to throw.
 * @param ok The response's `ok`.
 * @returns A fetch stand-in that records the paths it was asked.
 */
function devServer(body: unknown, ok = true) {
  const asked: string[] = [];
  const fetch = (path: string): Promise<{ ok: boolean; json(): Promise<unknown> }> => {
    asked.push(path);
    if (body instanceof Error) return Promise.reject(body);
    return Promise.resolve({ ok, json: () => Promise.resolve(body) });
  };
  return { asked, fetch };
}

describe('staleGuestWarning', () => {
  it('warns plainly: stale rules, or no guest at all, and the command to run', () => {
    expect(staleGuestWarning({ builtAt: 1, sourceAt: 2, stale: true })).toMatch(
      /STALE rules.*npm run build:guest/,
    );
    expect(staleGuestWarning({ builtAt: 0, sourceAt: 2, stale: true })).toMatch(
      /no built guest.*npm run build:guest/,
    );
    expect(staleGuestWarning({ builtAt: 3, sourceAt: 2, stale: false })).toBeNull();
  });
});

describe('checkGuestStatus', () => {
  it("asks the dev server's path and returns its warning", async () => {
    const server = devServer({ builtAt: 1, sourceAt: 2, stale: true });
    expect(await checkGuestStatus(server.fetch)).toMatch(/STALE/);
    expect(server.asked).toEqual([GUEST_STATUS_PATH]);
  });

  it('says nothing when the check itself fails (no dev server, a 404, bad JSON)', async () => {
    expect(await checkGuestStatus(devServer(new Error('offline')).fetch)).toBeNull();
    expect(await checkGuestStatus(devServer({}, false).fetch)).toBeNull();
    expect(await checkGuestStatus(devServer('nonsense').fetch)).toBeNull();
  });
});

describe('startPlaySolo', () => {
  it('in dev, warns about a stale guest and still starts the authority', async () => {
    const server = devServer({ builtAt: 1, sourceAt: 2, stale: true });
    const warnings: string[] = [];
    const solo = await startPlaySolo({
      guest: standInGuest(),
      definition: DEFINITION,
      dev: true,
      fetch: server.fetch,
      warn: (message) => warnings.push(message),
    });
    open.push(solo);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/STALE/);
    expect(solo.connection.state).toBe('idle');
  });

  it('outside dev, never asks', async () => {
    const server = devServer({ builtAt: 1, sourceAt: 2, stale: true });
    open.push(
      await startPlaySolo({ guest: standInGuest(), definition: DEFINITION, fetch: server.fetch }),
    );
    expect(server.asked).toEqual([]);
  });

  it('fails with the command to run when the guest cannot load', async () => {
    const guest = { ...standInGuest(), guestModuleUrl: 'data:text/javascript,throw new Error(1)' };
    await expect(startPlaySolo({ guest, definition: DEFINITION })).rejects.toThrow(
      /Play Solo could not start.*npm run build:guest/s,
    );
  });
});
