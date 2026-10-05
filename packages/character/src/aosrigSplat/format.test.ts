import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadAosrigSplatBundle,
  parseBindings,
  parseDescriptor,
  parseGaussianPly,
} from './format.js';
import { packGaussianChunk } from './packFast.js';

const fixture = new URL('../../test/fixtures/aosrig-splat/', import.meta.url);
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, fixture)));
const descriptor = (): ReturnType<typeof parseDescriptor> =>
  parseDescriptor(JSON.parse(new TextDecoder().decode(bytes('character.json'))) as unknown);

describe('creator/engine export contract', () => {
  it('reads Python-exported records without reordering splats or joints', () => {
    const d = descriptor(),
      b = parseBindings(bytes('bindings.bin'), d),
      p = parseGaussianPly(bytes('character.ply'), 2);
    const { records } = packGaussianChunk(p, b, d.plyToCharacter, 0, 2);
    expect([...records.slice(0, 3)]).toEqual([0.25, 0.5, expect.closeTo(0.003, 7)]);
    expect([...records.slice(44, 47)]).toEqual([expect.closeTo(0.1, 7), expect.closeTo(0.1, 7), 0]);
    expect([...records.slice(4, 10)]).toEqual([
      expect.closeTo(0.0001, 7),
      0,
      0,
      expect.closeTo(0.0004, 7),
      0,
      expect.closeTo(0.0009, 7),
    ]);
    expect(records[27]).toBeGreaterThan(0); // facial influence
    expect(records[44 + 27]).toBe(0); // body-only record
    expect([...new Uint32Array(records.buffer).slice(16, 20)]).toEqual([0, 0, 0, 0]);
  });
  it('keeps raw PLY bytes unchanged while translating runtime centers', () => {
    const raw = bytes('character.ply'),
      before = raw.slice(),
      d = descriptor();
    d.plyToCharacter[7] = 1.3;
    const packed = packGaussianChunk(
      parseGaussianPly(raw, 2),
      parseBindings(bytes('bindings.bin'), d),
      d.plyToCharacter,
      0,
      2,
    );
    expect(packed.records[1]).toBeCloseTo(1.8);
    expect(raw).toEqual(before);
  });
  it.each([8, 12, 16, 20, 24, 28])('rejects corrupt binding header at %i', (offset) => {
    const raw = bytes('bindings.bin');
    new DataView(raw.buffer).setUint32(offset, 999, true);
    expect(() => parseBindings(raw, descriptor())).toThrow();
  });
  it('rejects truncated records, out-of-range indices, nonfinite and unnormalized weights', () => {
    const raw = bytes('bindings.bin');
    expect(() => parseBindings(raw.slice(0, -1), descriptor())).toThrow();
    for (const [offset, value] of [
      [32, 100],
      [48, NaN],
      [48, 2],
    ]) {
      const broken = raw.slice();
      const v = new DataView(broken.buffer);
      if (offset === 32) v.setUint32(offset, value, true);
      else v.setFloat32(offset, value, true);
      expect(() => parseBindings(broken, descriptor())).toThrow();
    }
  });
  it('rejects unsupported versions and paths escaping the extracted directory', () => {
    const d = descriptor();
    expect(() => parseDescriptor({ ...d, version: 2 })).toThrow();
    d.files['rig.glb'].src = '../rig.glb';
    expect(() => parseDescriptor(d)).toThrow();
  });
  it('takes a declared colour space of srgb or linear, leaves it absent, and refuses any other', () => {
    const d = descriptor();
    expect(parseDescriptor(d).colorSpace).toBeUndefined();
    expect(parseDescriptor({ ...d, colorSpace: 'srgb' }).colorSpace).toBe('srgb');
    expect(parseDescriptor({ ...d, colorSpace: 'linear' }).colorSpace).toBe('linear');
    expect(() => parseDescriptor({ ...d, colorSpace: 'rec709' })).toThrow();
    expect(() => parseDescriptor({ ...d, colorSpace: 1 })).toThrow();
  });
  it('rejects malformed or truncated PLY', () => {
    expect(() => parseGaussianPly(bytes('character.ply').slice(0, -1), 2)).toThrow();
    expect(() => parseGaussianPly(bytes('character.ply'), 3)).toThrow();
  });
});

it('omits all-zero SH GPU storage but preserves nonzero directional coefficients', () => {
  const original = bytes('character.ply');
  const headerEnd = new TextDecoder().decode(original).indexOf('end_header\n') + 11;
  const header = new TextDecoder()
    .decode(original.subarray(0, headerEnd))
    .replace(
      'end_header\n',
      Array.from({ length: 45 }, (_, i) => `property float f_rest_${String(i)}\n`).join('') +
        'end_header\n',
    );
  const payload = new Float32Array(2 * 59);
  const originalView = new DataView(original.buffer, original.byteOffset + headerEnd);
  for (let i = 0; i < 2; i++)
    for (let k = 0; k < 14; k++)
      payload[i * 59 + k] = originalView.getFloat32((i * 14 + k) * 4, true);
  const prefix = new TextEncoder().encode(header);
  const raw = new Uint8Array(prefix.length + payload.byteLength);
  raw.set(prefix);
  raw.set(new Uint8Array(payload.buffer), prefix.length);
  const d = descriptor(),
    bindings = parseBindings(bytes('bindings.bin'), d);
  const zero = packGaussianChunk(parseGaussianPly(raw, 2), bindings, d.plyToCharacter, 0, 2);
  expect(zero.shCount).toBe(0);
  expect(zero.sh).toHaveLength(1);
  new DataView(raw.buffer).setFloat32(prefix.length + 14 * 4, 0.25, true);
  const directional = packGaussianChunk(parseGaussianPly(raw, 2), bindings, d.plyToCharacter, 0, 2);
  expect(directional.shCount).toBe(45);
  expect(directional.sh[0]).toBe(0.25);
});

describe('version 2 packages (the aosrig-v2 skeleton)', () => {
  const soma = new URL('../../test/fixtures/aosrig-splat-soma/', import.meta.url);
  const somaBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, soma)));
  const names = (
    JSON.parse(new TextDecoder().decode(somaBytes('expected.json'))) as { names: string[] }
  ).names;
  const hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
  const packageFiles = (): Record<string, Uint8Array> => ({
    'character.ply': bytes('character.ply'),
    'bindings.bin': bytes('bindings.bin'),
    'head.aosrig': new Uint8Array([1, 2, 3]),
    'skeleton.json': somaBytes('skeleton.json'),
    'clips.json': somaBytes('clips.json'),
  });
  const v2 = (files = packageFiles()): Record<string, unknown> => ({
    ...(descriptor() as unknown as Record<string, unknown>),
    version: 2,
    rig: 'aosrig-v2',
    jointNames: names,
    clips: ['ual_celebration'],
    files: Object.fromEntries(
      Object.entries(files).map(([name, b]) => [name, { src: name, sha256: hex(b) }]),
    ),
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads a version 2 descriptor and refuses one that mixes the versions', () => {
    const d = parseDescriptor(v2());
    expect(d.version).toBe(2);
    expect(d.clips).toEqual(['ual_celebration']);
    expect(() => parseDescriptor({ ...v2(), rig: 'aosrig_v0' })).toThrow();
    expect(() => parseDescriptor({ ...descriptor(), rig: 'aosrig-v2' })).toThrow();
    expect(() => parseDescriptor({ ...v2(), version: 3 })).toThrow();
    expect(() =>
      parseDescriptor({ ...v2(), jointNames: names.filter((n) => n !== 'Hips') }),
    ).toThrow();
    expect(() => parseDescriptor({ ...v2(), clips: ['a', 'a'] })).toThrow(/repeated/);
    expect(() => parseDescriptor({ ...v2(), clips: undefined })).toThrow(/clip names/);
    expect(() =>
      parseDescriptor({ ...v2(), corrective: { index: 'corrective/index.json' } }),
    ).toThrow(/no pose corrections/);
    const noSkeleton = v2();
    delete (noSkeleton.files as Record<string, unknown>)['skeleton.json'];
    expect(() => parseDescriptor(noSkeleton)).toThrow(/skeleton\.json/);
  });

  it('loads a package: every file hashed, the skeleton and clips read, shared clips after', async () => {
    const files = packageFiles();
    const clip = (
      JSON.parse(new TextDecoder().decode(files['clips.json'])) as {
        clips: Record<string, unknown>[];
      }
    ).clips[0];
    const shared = new TextEncoder().encode(
      JSON.stringify({
        format: 'soma-clips',
        version: 1,
        space: 'soma',
        clips: [{ ...clip, name: 'shared_wave' }, clip],
      }),
    );
    const served: Record<string, Uint8Array | undefined> = {
      '/hero/character.json': new TextEncoder().encode(JSON.stringify(v2(files))),
      '/clips/shared.json': shared,
      ...Object.fromEntries(Object.entries(files).map(([n, b]) => [`/hero/${n}`, b])),
    };
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      const path = new URL(url).pathname;
      asked.push(path);
      const body = served[path];
      return Promise.resolve(
        body ? new Response(body as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 }),
      );
    });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const bundle = await loadAosrigSplatBundle('http://game.test/hero/character.json', undefined, {
      clipFiles: ['../clips/shared.json', '/clips/missing.json'],
    });
    expect(bundle.soma?.skeleton.joints).toHaveLength(110);
    // the package's own clip, then the shared one; a shared clip of a name it has is left out
    expect(bundle.soma?.clips.map((c) => c.name)).toEqual(['ual_celebration', 'shared_wave']);
    expect([...bundle.files.keys()].sort()).toEqual([
      'bindings.bin',
      'character.ply',
      'head.aosrig',
    ]);
    expect(asked).not.toContain('/hero/corrective/index.json');
    expect(asked).toContain('/clips/missing.json');
    expect(bundle.corrective).toBeUndefined();
  });

  it('resolves every file beside where a redirect ended, not the address asked for', async () => {
    const files = packageFiles();
    const pack = new TextEncoder().encode(
      JSON.stringify({ format: 'soma-clips', version: 1, space: 'soma', clips: [] }),
    );
    const descriptor = {
      ...v2(files),
      sharedClips: {
        src: '../soma_ready_clips.json',
        sha256: hex(pack),
        bytes: pack.length,
        format: 'soma-clips',
      },
    };
    const served: Record<string, Uint8Array | undefined> = {
      '/pub/simon/v7/character.json': new TextEncoder().encode(JSON.stringify(descriptor)),
      '/pub/simon/soma_ready_clips.json': pack,
      ...Object.fromEntries(Object.entries(files).map(([n, b]) => [`/pub/simon/v7/${n}`, b])),
    };
    const asked: string[] = [];
    // The stable address answers 302 to the current version; fetch follows it, and the response
    // says where it ended (Response.url), as a browser's does.
    const redirecting = (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(input as string);
      const path = url.pathname === '/c/simon' ? '/pub/simon/v7/character.json' : url.pathname;
      asked.push(path);
      const body = served[path];
      const response = body
        ? new Response(body as Uint8Array<ArrayBuffer>)
        : new Response('', { status: 404 });
      Object.defineProperty(response, 'url', { value: `https://studio.test${path}` });
      return Promise.resolve(response);
    };
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const bundle = await loadAosrigSplatBundle('https://studio.test/c/simon', undefined, {
      fetch: redirecting,
    });
    expect(bundle.soma?.skeleton.joints).toHaveLength(110);
    expect(asked).toContain('/pub/simon/v7/character.ply');
    expect(asked).toContain('/pub/simon/soma_ready_clips.json');
    expect(asked.filter((p) => p.startsWith('/c/'))).toEqual([]);
  });

  it('asks only for the optional files the package lists, so no 404 reaches the console', async () => {
    const files = packageFiles();
    const listing = Object.entries(files).map(([path, b]) => ({ path, bytes: b.length }));
    const descriptor = { ...v2(files), package: { files: listing } };
    const served: Record<string, Uint8Array | undefined> = {
      '/q/hero/character.json': new TextEncoder().encode(JSON.stringify(descriptor)),
      ...Object.fromEntries(Object.entries(files).map(([n, b]) => [`/q/hero/${n}`, b])),
    };
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      const path = new URL(url).pathname;
      asked.push(path);
      const body = served[path];
      return Promise.resolve(
        body ? new Response(body as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 }),
      );
    });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await loadAosrigSplatBundle('http://game.test/q/hero/character.json', undefined, {
      sharedClips: false,
    });
    expect(asked.filter((p) => !served[p])).toEqual([]);
  });

  it('refuses a malformed package listing rather than dropping its hashes', () => {
    const withListing = (files: unknown): unknown => ({ ...v2(), package: { files } });
    expect(() => parseDescriptor(withListing([{ bytes: 4 }]))).toThrow(/package listing/);
    expect(() =>
      parseDescriptor(withListing([{ path: 'teeth.json', bytes: 4, sha256: 'nope' }])),
    ).toThrow(/package listing/);
    expect(() => parseDescriptor(withListing('teeth.json'))).toThrow(/package listing/);
  });

  it('keeps a listed file without a size, counting it 0 and saying so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sha256 = 'a'.repeat(64);
    const d = parseDescriptor({ ...v2(), package: { files: [{ path: 'teeth.json', sha256 }] } });
    expect(d.package?.files).toEqual([{ path: 'teeth.json', sha256, bytes: 0 }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('teeth.json'));
  });

  it('reports progress against the sizes the package lists, ending at done', async () => {
    const files = packageFiles();
    const listing = Object.entries(files).map(([path, b]) => ({ path, bytes: b.length }));
    const descriptor = { ...v2(files), package: { files: listing } };
    const served: Record<string, Uint8Array | undefined> = {
      '/p/hero/character.json': new TextEncoder().encode(JSON.stringify(descriptor)),
      ...Object.fromEntries(Object.entries(files).map(([n, b]) => [`/p/hero/${n}`, b])),
    };
    vi.stubGlobal('fetch', (url: string) => {
      const body = served[new URL(url).pathname];
      return Promise.resolve(
        body ? new Response(body as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 }),
      );
    });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const calls: [number, number][] = [];
    await loadAosrigSplatBundle('http://game.test/p/hero/character.json', undefined, {
      sharedClips: false,
      onProgress: (loaded, total) => calls.push([loaded, total]),
    });
    const expected = Object.values(files).reduce((n, b) => n + b.length, 0);
    expect(calls[0]).toEqual([0, expected]);
    expect(calls.at(-1)).toEqual([expected, expected]);
    for (let k = 1; k < calls.length; k++)
      expect(calls[k][0]).toBeGreaterThanOrEqual(calls[k - 1][0]);
  });

  it("fetches every file through the host's fetch when it gives one (a private store's key)", async () => {
    const files = packageFiles();
    const served: Record<string, Uint8Array | undefined> = {
      '/ogs/character.json': new TextEncoder().encode(JSON.stringify(v2(files))),
      ...Object.fromEntries(Object.entries(files).map(([n, b]) => [`/ogs/${n}`, b])),
    };
    vi.stubGlobal('fetch', () => Promise.reject(new Error('the global fetch sends no key')));
    const keyed: string[] = [];
    const hostFetch = (input: RequestInfo | URL): Promise<Response> => {
      // the loader asks by URL string
      const path = new URL(input as string).pathname;
      keyed.push(path);
      const body = served[path];
      return Promise.resolve(
        body ? new Response(body as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 }),
      );
    };
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const bundle = await loadAosrigSplatBundle('https://aam.test/ogs/character.json', undefined, {
      fetch: hostFetch,
      sharedClips: false,
    });
    expect([...bundle.files.keys()].sort()).toEqual([
      'bindings.bin',
      'character.ply',
      'head.aosrig',
    ]);
    expect(keyed).toContain('/ogs/character.json');
    expect(keyed).toContain('/ogs/character.ply');
    expect(keyed).toContain('/ogs/bindings.bin');
  });

  it('keeps the head and skeleton for a fuller copy, which then downloads none of them again', async () => {
    const files = { ...packageFiles(), 'body.glb': new Uint8Array([7, 7, 7]) };
    const served: Record<string, Uint8Array | undefined> = {
      '/hero/character.json': new TextEncoder().encode(JSON.stringify(v2(files))),
      ...Object.fromEntries(Object.entries(files).map(([n, b]) => [`/hero/${n}`, b])),
    };
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      const path = new URL(url).pathname;
      asked.push(path);
      const body = served[path];
      return Promise.resolve(
        body ? new Response(body as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 }),
      );
    });
    const light = await loadAosrigSplatBundle('http://game.test/hero/character.json', undefined, {
      keepShared: true,
    });
    const shared = ['head.aosrig', 'skeleton.json', 'clips.json', 'body.glb'];
    expect([...(light.shared?.keys() ?? [])].sort()).toEqual(
      shared.map((n) => hex(files[n as keyof typeof files])).sort(),
    );
    asked.length = 0;
    const full = await loadAosrigSplatBundle('http://game.test/hero/character.json', undefined, {
      reuse: light.shared,
      sharedClips: false,
      mouth: false,
    });
    expect(asked.sort()).toEqual([
      '/hero/bindings.bin',
      '/hero/character.json',
      '/hero/character.ply',
    ]);
    expect(full.soma?.skeleton.joints).toHaveLength(110);
    expect(full.shared).toBeUndefined();
  });

  it('fetches and checks the body mesh when character.json names it', async () => {
    const files = { ...packageFiles(), 'body.glb': new Uint8Array([7, 7, 7]) };
    const served: Record<string, Uint8Array | undefined> = {
      '/hero/character.json': new TextEncoder().encode(JSON.stringify(v2(files))),
      ...Object.fromEntries(Object.entries(files).map(([n, b]) => [`/hero/${n}`, b])),
    };
    vi.stubGlobal('fetch', (url: string) => {
      const body = served[new URL(url).pathname];
      return Promise.resolve(
        body ? new Response(body as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 }),
      );
    });
    const bundle = await loadAosrigSplatBundle('http://game.test/hero/character.json');
    expect([...(bundle.files.get('body.glb') ?? [])]).toEqual([7, 7, 7]);
    served['/hero/body.glb'] = new Uint8Array([8]);
    await expect(loadAosrigSplatBundle('http://game.test/hero/character.json')).rejects.toThrow(
      /hash mismatch for body\.glb/,
    );
  });

  describe('the shared clip pack', () => {
    /**
     * Two packages naming one pack beside them, served from memory.
     *
     * @param packPath The pack's path on the site (unique per test: the page caches packs).
     * @param packHash The hash the descriptors state (the pack's own when omitted).
     * @returns The fetch log and the loader's URLs.
     */
    function serveTwo(packPath: string, packHash?: string): { asked: string[] } {
      const files = packageFiles();
      const clip = (
        JSON.parse(new TextDecoder().decode(files['clips.json'])) as {
          clips: Record<string, unknown>[];
        }
      ).clips[0];
      const pack = new TextEncoder().encode(
        JSON.stringify({
          format: 'soma-clips',
          version: 1,
          space: 'soma',
          clips: [
            { ...clip, name: 'ual_celebration', loop: true },
            { ...clip, name: 'pack_only' },
          ],
        }),
      );
      const descriptor = {
        ...v2(files),
        sharedClips: {
          src: `..${packPath}`,
          sha256: packHash ?? hex(pack),
          bytes: pack.length,
          format: 'soma-clips',
          clips: ['ual_celebration', 'pack_only'],
        },
      };
      const served: Record<string, Uint8Array | undefined> = { [packPath]: pack };
      for (const who of ['hero', 'friend']) {
        served[`/${who}/character.json`] = new TextEncoder().encode(JSON.stringify(descriptor));
        for (const [n, b] of Object.entries(files)) served[`/${who}/${n}`] = b;
      }
      const asked: string[] = [];
      vi.stubGlobal('fetch', (url: string) => {
        const path = new URL(url).pathname;
        asked.push(path);
        const body = served[path];
        return Promise.resolve(
          body ? new Response(body as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 }),
        );
      });
      return { asked };
    }

    it('is fetched once for every character that names it, under their own clips', async () => {
      const { asked } = serveTwo('/pack-a.json');
      const [hero, friend] = await Promise.all([
        loadAosrigSplatBundle('http://game.test/hero/character.json'),
        loadAosrigSplatBundle('http://game.test/friend/character.json'),
      ]);
      expect(asked.filter((p) => p === '/pack-a.json')).toHaveLength(1);
      for (const bundle of [hero, friend]) {
        expect(bundle.soma?.clips.map((c) => c.name)).toEqual(['ual_celebration', 'pack_only']);
        // the package's own clip of that name wins over the pack's (which loops)
        expect(bundle.soma?.clips[0].loop).toBe(false);
      }
      // read once: the two characters share the pack's numbers
      expect(hero.soma?.clips[1]).toBe(friend.soma?.clips[1]);
    });

    it('is not fetched when the host skips it', async () => {
      const { asked } = serveTwo('/pack-b.json');
      const bundle = await loadAosrigSplatBundle(
        'http://game.test/hero/character.json',
        undefined,
        {
          sharedClips: false,
        },
      );
      expect(asked).not.toContain('/pack-b.json');
      expect(bundle.soma?.clips.map((c) => c.name)).toEqual(['ual_celebration']);
    });

    it('is said and left out when it does not match its hash; the character still loads', async () => {
      serveTwo('/pack-c.json', 'f'.repeat(64));
      const said = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const bundle = await loadAosrigSplatBundle('http://game.test/hero/character.json');
      expect(bundle.soma?.clips.map((c) => c.name)).toEqual(['ual_celebration']);
      expect(String(said.mock.calls[0]?.[0])).toContain('shared clip pack');
    });

    it('is refused in the descriptor when it points at another site or is not a clip file', () => {
      const pack = { src: '../pack.json', sha256: 'a'.repeat(64), format: 'soma-clips' };
      expect(parseDescriptor({ ...v2(), sharedClips: pack }).sharedClips?.src).toBe('../pack.json');
      expect(() =>
        parseDescriptor({ ...v2(), sharedClips: { ...pack, src: 'https://x/p.json' } }),
      ).toThrow();
      expect(() =>
        parseDescriptor({ ...v2(), sharedClips: { ...pack, src: '//x/p.json' } }),
      ).toThrow();
      expect(() => parseDescriptor({ ...v2(), sharedClips: { ...pack, format: 'glb' } })).toThrow();
      expect(() => parseDescriptor({ ...v2(), sharedClips: { ...pack, sha256: 'x' } })).toThrow();
      expect(() => parseDescriptor({ ...descriptor(), sharedClips: pack })).toThrow();
    });
  });

  it('refuses a package whose skeleton does not match its hash', async () => {
    const files = packageFiles();
    const served: Record<string, Uint8Array | undefined> = {
      '/hero/character.json': new TextEncoder().encode(JSON.stringify(v2(files))),
      ...Object.fromEntries(Object.entries(files).map(([n, b]) => [`/hero/${n}`, b])),
    };
    served['/hero/skeleton.json'] = files['skeleton.json'].slice(1);
    vi.stubGlobal('fetch', (url: string) => {
      const body = served[new URL(url).pathname];
      return Promise.resolve(
        body ? new Response(body as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 }),
      );
    });
    await expect(loadAosrigSplatBundle('http://game.test/hero/character.json')).rejects.toThrow(
      /hash mismatch for skeleton\.json/,
    );
  });
});
