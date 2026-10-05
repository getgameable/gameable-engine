import { afterEach, describe, expect, it, vi } from 'vitest';

import { AamError, createAamClient, parseAnimationAssetRow } from './client.js';

/** One call recorded by {@link fakeFetch}. */
interface Recorded {
  url: string;
  apiKey: string | null;
  init: RequestInit | undefined;
}

/** A scripted response: a status plus an optional JSON body. */
interface Scripted {
  status?: number;
  json?: unknown;
  body?: ArrayBuffer;
  throws?: boolean;
}

/**
 * A `fetch` that replays a script and records every call.
 *
 * @param script Responses to return, in order. The last one repeats.
 * @returns The fake `fetch` and the call log.
 */
function fakeFetch(script: readonly Scripted[]): {
  fetch: typeof globalThis.fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const impl: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, apiKey: headers.get('X-API-Key'), init });
    const step = script[Math.min(i, script.length - 1)] ?? {};
    i += 1;
    if (step.throws === true) return Promise.reject(new TypeError('network down'));
    const status = step.status ?? 200;
    const body = step.body ?? (step.json === undefined ? null : JSON.stringify(step.json));
    return Promise.resolve(new Response(body, { status }));
  };
  return { fetch: impl, calls };
}

/** A minimal valid animation-asset row. */
const ROW = {
  id: 7,
  name: 'Wave (Right Hand)',
  kind: 'body',
  additive: true,
  file_url: '/api/character-assets/7/wave.glb',
  updatedAt: '2026-09-01T10:00:00Z',
  additiveType: 'local',
  basePoseType: 'local_frame',
  basePoseAssetId: null,
  refFrameIndex: 3,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('createAamClient', () => {
  it('rejects an empty base url', () => {
    expect(() => createAamClient({ baseUrl: '', apiKey: 'k' })).toThrow(AamError);
  });

  it('resolves paths against an absolute base url', () => {
    const client = createAamClient({ baseUrl: 'https://aam.example/', apiKey: 'k' });
    expect(client.baseUrl).toBe('https://aam.example');
    expect(client.resolveFileUrl('/api/x')).toBe('https://aam.example/api/x');
    expect(client.resolveFileUrl('api/x')).toBe('https://aam.example/api/x');
    expect(client.resolveFileUrl('https://cdn.example/a.glb')).toBe('https://cdn.example/a.glb');
  });

  it('resolves paths against a proxy prefix', () => {
    const client = createAamClient({ baseUrl: '/aam', apiKey: 'k' });
    expect(client.resolveFileUrl('/api/x')).toBe('/aam/api/x');
  });
});

describe('key injection', () => {
  it('adds the header for URLs under the base url only', async () => {
    const { fetch, calls } = fakeFetch([{ json: [] }]);
    const client = createAamClient({
      baseUrl: 'https://aam.example/root',
      apiKey: 'secret',
      fetch,
    });

    await client.request('https://aam.example/root/api/me');
    await client.request('https://aam.example/other/api/me');
    await client.request('https://cdn.example/root/a.glb');
    await client.request('/root/api/me');

    expect(calls.map((c) => c.apiKey)).toEqual(['secret', null, null, null]);
  });

  it('adds the header under a proxy prefix but never to an absolute URL', async () => {
    const { fetch, calls } = fakeFetch([{ json: [] }]);
    const client = createAamClient({ baseUrl: '/aam', apiKey: 'secret', fetch });

    await client.request('/aam/api/me');
    await client.request('/aamx/api/me');
    await client.request('https://aam.example/aam/api/me');

    expect(calls.map((c) => c.apiKey)).toEqual(['secret', null, null]);
  });

  it('sends no header at all when the key is empty', async () => {
    const { fetch, calls } = fakeFetch([{ json: [] }]);
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: '', fetch });

    await client.request('https://aam.example/api/me');

    expect(calls[0].apiKey).toBeNull();
  });

  it('preserves caller headers', async () => {
    const { fetch, calls } = fakeFetch([{ json: [] }]);
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'secret', fetch });

    await client.request('https://aam.example/api/me', { headers: { 'If-Match': '3' } });

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('If-Match')).toBe('3');
    expect(headers.get('X-API-Key')).toBe('secret');
  });

  it('reports ownership without fetching', () => {
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'k' });
    expect(client.owns('https://aam.example/api/x')).toBe(true);
    expect(client.owns('https://aam.example.evil.com/api/x')).toBe(false);
    expect(client.owns('')).toBe(false);
    expect(client.owns('not a url')).toBe(false);
  });
});

describe('retry and backoff', () => {
  it('retries a 5xx with exponential backoff and succeeds', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch([{ status: 503 }, { status: 502 }, { json: [ROW] }]);
    const client = createAamClient({
      baseUrl: 'https://aam.example',
      apiKey: 'k',
      fetch,
      retries: 3,
      backoffMs: 100,
    });

    const pending = client.listAnimationAssets('myra');
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    // Second delay is doubled: nothing at +100, the third call at +200.
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(3);

    const rows = await pending;
    expect(rows).toHaveLength(1);
  });

  it('gives up after `retries` extra attempts and surfaces the status', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch([{ status: 500 }]);
    const client = createAamClient({
      baseUrl: 'https://aam.example',
      apiKey: 'k',
      fetch,
      retries: 2,
      backoffMs: 10,
    });

    const pending = client.listAnimationAssets('myra');
    const assertion = expect(pending).rejects.toMatchObject({ status: 500 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toHaveLength(3);
  });

  it('retries a network error and throws when every attempt fails', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch([{ throws: true }]);
    const client = createAamClient({
      baseUrl: 'https://aam.example',
      apiKey: 'k',
      fetch,
      retries: 1,
      backoffMs: 10,
    });

    const pending = client.listAnimationAssets('myra');
    const assertion = expect(pending).rejects.toThrow(AamError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 4xx', async () => {
    const { fetch, calls } = fakeFetch([{ status: 404 }]);
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'k', fetch });

    await expect(client.listAnimationAssets('myra')).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
  });

  it('defaults to three retries', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch([{ status: 500 }]);
    const client = createAamClient({
      baseUrl: 'https://aam.example',
      apiKey: 'k',
      fetch,
      backoffMs: 1,
    });

    const pending = client.listAnimationAssets('myra');
    const assertion = expect(pending).rejects.toThrow(AamError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toHaveLength(4);
  });
});

describe('row parsing', () => {
  it('parses a full row and keeps the server field names', async () => {
    const { fetch, calls } = fakeFetch([{ json: [ROW] }]);
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'k', fetch });

    const [row] = await client.listAnimationAssets('my ra');

    expect(calls[0].url).toBe('https://aam.example/api/characters/my%20ra/animation-assets');
    expect(row).toEqual({
      id: '7',
      name: 'Wave (Right Hand)',
      kind: 'body',
      additive: true,
      file_url: '/api/character-assets/7/wave.glb',
      updatedAt: '2026-09-01T10:00:00Z',
      additiveType: 'local',
      basePoseType: 'local_frame',
      basePoseAssetId: null,
      refFrameIndex: 3,
    });
  });

  it('defaults every optional field', () => {
    const row = parseAnimationAssetRow('/p', { id: 'a1', file_url: '/f.glb' }, 0);
    expect(row).toEqual({
      id: 'a1',
      name: 'clip_a1',
      kind: 'body',
      additive: false,
      file_url: '/f.glb',
      updatedAt: null,
      additiveType: 'none',
      basePoseType: 'none',
      basePoseAssetId: null,
      refFrameIndex: 0,
    });
  });

  it('accepts snake_case spellings and an unknown enum falls back', () => {
    const row = parseAnimationAssetRow(
      '/p',
      {
        id: 'a1',
        fileUrl: '/f.json',
        kind: 'face',
        additive_type: 'wat',
        base_pose_type: 'ref_pose',
        base_pose_asset_id: 12,
        ref_frame_index: '4',
        updated_at: 'yesterday',
      },
      0,
    );
    expect(row.kind).toBe('face');
    expect(row.additiveType).toBe('none');
    expect(row.basePoseType).toBe('ref_pose');
    expect(row.basePoseAssetId).toBe('12');
    expect(row.refFrameIndex).toBe(4);
    expect(row.updatedAt).toBe('yesterday');
  });

  it('treats a non-none additiveType as additive', () => {
    expect(
      parseAnimationAssetRow('/p', { id: 'a', file_url: '/f', additiveType: 'mesh' }, 0),
    ).toMatchObject({ additive: true, additiveType: 'mesh' });
  });

  it('fails loudly on a row with no id or no file_url', () => {
    expect(() => parseAnimationAssetRow('/p', { file_url: '/f' }, 2)).toThrow(/row 2 has no id/);
    expect(() => parseAnimationAssetRow('/p', { id: 'a' }, 0)).toThrow(/no file_url/);
    expect(() => parseAnimationAssetRow('/p', 'nope', 1)).toThrow(/not an object/);
  });

  it('rejects a body that is not a list', async () => {
    const { fetch } = fakeFetch([{ json: { ok: true } }]);
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'k', fetch });
    await expect(client.listAnimationAssets('myra')).rejects.toThrow(/expected a JSON array/);
  });

  it('unwraps a list wrapped in `items`', async () => {
    const { fetch } = fakeFetch([{ json: { items: [ROW] } }]);
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'k', fetch });
    await expect(client.listAnimationAssets('myra')).resolves.toHaveLength(1);
  });
});

describe('listCharacterBundle', () => {
  it('normalises both row spellings and absolutises the URLs', async () => {
    const { fetch, calls } = fakeFetch([
      {
        json: [
          {
            filename: 'scene.json',
            fileUrl: '/api/texavatars-assets-file/c/1/scene.json',
            size: 12,
          },
          { name: 'mesh.bin', file_url: '/api/texavatars-assets-file/c/2/mesh.bin', byte_size: 99 },
          { filename: 'hair.gsh', fileUrl: 'https://cdn.example/hair.gsh', updatedAt: 'now' },
        ],
      },
    ]);
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'k', fetch });

    const bundle = await client.listCharacterBundle('myra');

    expect(calls[0].url).toBe('https://aam.example/api/characters/myra/ogs');
    expect(bundle.files).toEqual([
      {
        name: 'scene.json',
        url: 'https://aam.example/api/texavatars-assets-file/c/1/scene.json',
        size: 12,
      },
      {
        name: 'mesh.bin',
        url: 'https://aam.example/api/texavatars-assets-file/c/2/mesh.bin',
        size: 99,
      },
      { name: 'hair.gsh', url: 'https://cdn.example/hair.gsh', updatedAt: 'now' },
    ]);
  });

  it('fails loudly on a row with no filename', async () => {
    const { fetch } = fakeFetch([{ json: [{ fileUrl: '/x' }] }]);
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'k', fetch });
    await expect(client.listCharacterBundle('myra')).rejects.toThrow(/no filename or fileUrl/);
  });
});

describe('fetchFile', () => {
  it('returns the bytes and forwards the abort signal', async () => {
    const payload = new Uint8Array([1, 2, 3]).buffer;
    const { fetch, calls } = fakeFetch([{ body: payload }]);
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'k', fetch });
    const controller = new AbortController();

    const bytes = await client.fetchFile('/api/f/1.glb', { signal: controller.signal });

    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls[0].url).toBe('https://aam.example/api/f/1.glb');
    expect(calls[0].apiKey).toBe('k');
    expect(calls[0].init?.signal).toBe(controller.signal);
  });

  it('surfaces a failing status', async () => {
    const { fetch } = fakeFetch([{ status: 404 }]);
    const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'k', fetch });
    await expect(client.fetchFile('/api/f/1.glb')).rejects.toMatchObject({ status: 404 });
  });

  it('leaves the HTTP cache alone unless this client is the cache', async () => {
    const { fetch, calls } = fakeFetch([{ body: new Uint8Array([9]).buffer }]);
    const plain = createAamClient({ baseUrl: 'https://aam.example', apiKey: 'k', fetch });
    await plain.fetchFile('/api/f/1.glb');
    // With no Cache Storage layer the browser's own cache is the only one
    // there is; `no-store` would re-download every asset on every run.
    expect(calls[0].init?.cache).toBeUndefined();

    const cached = createAamClient({
      baseUrl: 'https://aam.example',
      apiKey: 'k',
      fetch,
      cache: 'cache-storage',
    });
    await cached.fetchFile('/api/f/2.glb');
    // Still no bucket in Node, so still nothing to double up with.
    expect(calls[1].init?.cache).toBeUndefined();
  });

  it('cancels a 5xx body before retrying it', async () => {
    vi.useFakeTimers();
    const cancels: number[] = [];
    let i = 0;
    const fetchImpl: typeof globalThis.fetch = () => {
      i += 1;
      if (i === 1) {
        const failed = new Response('upstream is unwell', { status: 503 });
        const index = i;
        const stream = failed.body;
        if (stream) {
          const realCancel = stream.cancel.bind(stream);
          stream.cancel = async (reason?: unknown): Promise<void> => {
            cancels.push(index);
            return realCancel(reason);
          };
        }
        return Promise.resolve(failed);
      }
      return Promise.resolve(new Response(new Uint8Array([4]).buffer, { status: 200 }));
    };
    const client = createAamClient({
      baseUrl: 'https://aam.example',
      apiKey: 'k',
      fetch: fetchImpl,
      retries: 1,
      backoffMs: 10,
    });

    const pending = client.fetchFile('/api/f/1.glb');
    await vi.advanceTimersByTimeAsync(20);
    const bytes = await pending;

    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([4]));
    // The abandoned response's body was released rather than left holding its
    // connection open.
    expect(cancels).toEqual([1]);
  });

  it('stays on the network when Cache Storage does not exist', async () => {
    expect(typeof caches).toBe('undefined');
    const { fetch, calls } = fakeFetch([{ body: new Uint8Array([9]).buffer }]);
    const client = createAamClient({
      baseUrl: 'https://aam.example',
      apiKey: 'k',
      fetch,
      cache: 'cache-storage',
    });

    await client.fetchFile('/api/f/1.glb', { version: 'v2' });

    expect(calls).toHaveLength(1);
  });
});
