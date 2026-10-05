import { describe, expect, it } from 'vitest';

import { createAamClient } from './client.js';
import { createAamResolver } from './resolver.js';

/** One recorded call. */
interface Recorded {
  url: string;
  apiKey: string | null;
}

/**
 * A `fetch` that records the key it was handed and answers 200.
 *
 * @returns The fake `fetch` and the call log.
 */
function recordingFetch(): { fetch: typeof globalThis.fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, apiKey: new Headers(init?.headers).get('X-API-Key') });
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  return { fetch: impl, calls };
}

describe('createAamResolver', () => {
  it('injects the key for same-origin URLs only', async () => {
    const { fetch, calls } = recordingFetch();
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'secret', fetch });
    const resolver = createAamResolver(client);

    await resolver.fetch('https://aam.example/api/characters/myra/ogs');
    await resolver.fetch('https://cdn.example/public/arena.spz');

    expect(calls).toEqual([
      { url: 'https://aam.example/api/characters/myra/ogs', apiKey: 'secret' },
      { url: 'https://cdn.example/public/arena.spz', apiKey: null },
    ]);
  });

  it('accepts a URL object and a Request', async () => {
    const { fetch, calls } = recordingFetch();
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'secret', fetch });
    const resolver = createAamResolver(client);

    await resolver.fetch(new URL('https://aam.example/api/me'));
    await resolver.fetch(new Request('https://cdn.example/a.glb'));

    expect(calls.map((c) => c.apiKey)).toEqual(['secret', null]);
  });

  it('is usable as the fetch option of loadManifest', async () => {
    const manifest = {
      version: 1,
      baseUrl: 'https://aam.example/assets/',
      assets: [{ id: 'arena', type: 'splat', src: 'arena.spz' }],
    };
    const calls: Recorded[] = [];
    const impl: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, apiKey: new Headers(init?.headers).get('X-API-Key') });
      return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
    };
    const { loadManifest } = await import('@gameable/assets');
    const client = createAamClient({
      baseUrl: 'https://aam.example',
      apiKey: 'secret',
      fetch: impl,
    });

    const loaded = await loadManifest('https://aam.example/assets/assets.json', {
      fetch: createAamResolver(client).fetch,
    });

    expect(loaded.assets[0]?.id).toBe('arena');
    expect(calls[0]?.apiKey).toBe('secret');
  });
});
