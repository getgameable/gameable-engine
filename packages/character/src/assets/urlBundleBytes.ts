// A directory of loose files as the byte accessors the branch chain takes.
//
// The POC reached for the page's global `fetch` and a `/ogs/<slug>` URL layout.
// Here both are injected: a game resolves assets by id through the engine's asset
// registry, which may be a CDN, the AvatarOS asset manager, or a test's in-memory
// map. `AssetResolver` is the whole seam — nothing below it knows about URLs.
//
// Ported from aos-threejs-poc/src/ogs/assets/urlBundleBytes.ts @ cdd63b10

/** Resolves one bundle-relative filename to bytes. */
export type AssetResolver = (name: string, init?: { signal?: AbortSignal }) => Promise<Uint8Array>;

/** The pack accessors a branch chain consumes. */
export interface BundleBytes {
  /** Resident bytes, or undefined for a name that was never requested. */
  getBytes: (name: string) => Uint8Array | undefined;
  /** Lazy fetch for a file the eager pass skipped (the fp32 decoder fallback). */
  fetchBytes: (name: string) => Promise<Uint8Array>;
  /** Sum of every resident file, for `memoryReport()`. */
  totalBytes: number;
}

/** Options shared by the bundle loaders. */
export interface BundleFetchOptions {
  /** Overrides the global `fetch`; ignored when `resolver` is given. */
  fetch?: typeof globalThis.fetch;
  /** Resolve a bundle-relative name to bytes yourself (CDN, asset manager, tests). */
  resolver?: AssetResolver;
  signal?: AbortSignal;
}

/**
 * A resolver over a directory URL.
 *
 * Loud on a 404, never a stub: an HTML error page reaches ORT as a corrupt model
 * and fails somewhere far away from the missing file.
 *
 * @param base The directory the bundle's loose files sit in; a trailing slash is
 * tolerated and stripped.
 * @param options Fetch overrides. `options.resolver` is ignored here — this IS a
 * resolver — but `options.fetch` and `options.signal` both apply.
 * @returns A resolver that joins `base` and the requested name and throws on any
 * non-2xx response rather than returning the error body.
 */
export function directoryResolver(base: string, options: BundleFetchOptions = {}): AssetResolver {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error(
      'character bundle: no fetch available — pass options.fetch or options.resolver',
    );
  }
  const root = base.endsWith('/') ? base.slice(0, -1) : base;
  return async (name, init) => {
    const url = `${root}/${name}`;
    const response = await doFetch(url, { signal: init?.signal ?? options.signal });
    if (!response.ok) {
      throw new Error(`character bundle: ${url} -> HTTP ${String(response.status)}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

/**
 * Fetch every name up front — the decoders are all needed within one frame of each other.
 *
 * @param resolver How a bundle-relative name becomes bytes.
 * @param names Every file to make resident; duplicates are fetched once.
 * @param options Fetch options forwarded to the resolver.
 * @param options.signal Aborts the whole eager pass.
 * @returns The accessors the branch chain consumes: `getBytes` for a resident file,
 * `fetchBytes` for one the eager pass skipped, and `totalBytes` across everything
 * fetched here.
 */
export async function loadBundleBytes(
  resolver: AssetResolver,
  names: string[],
  options: { signal?: AbortSignal } = {},
): Promise<BundleBytes> {
  const resident = new Map<string, Uint8Array>();
  const unique = [...new Set(names)];
  const loaded = await Promise.all(unique.map((name) => resolver(name, options)));
  unique.forEach((name, index) => resident.set(name, loaded[index]));
  return {
    getBytes: (name) => resident.get(name),
    fetchBytes: async (name) => {
      const already = resident.get(name);
      if (already) return already;
      const bytes = await resolver(name, options);
      resident.set(name, bytes);
      return bytes;
    },
    totalBytes: loaded.reduce((total, bytes) => total + bytes.byteLength, 0),
  };
}

/**
 * Parse one bundle file as JSON.
 *
 * @param resolver How a bundle-relative name becomes bytes.
 * @param name The file to fetch, such as `scene.json` or a branch's `mesh.json`.
 * @param options Fetch options forwarded to the resolver.
 * @param options.signal Aborts the fetch.
 * @returns The parsed document, untyped — the manifest parsers validate it.
 */
export async function fetchBundleJson(
  resolver: AssetResolver,
  name: string,
  options: { signal?: AbortSignal } = {},
): Promise<unknown> {
  const bytes = await resolver(name, options);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/**
 * Try one bundle file as JSON; undefined when it is simply not there.
 *
 * @param resolver How a bundle-relative name becomes bytes.
 * @param name The optional file to probe for, such as a schema_version 1 bundle's
 * missing `scene.json`.
 * @param options Fetch options forwarded to the resolver.
 * @param options.signal Aborts the fetch.
 * @returns The parsed document, or undefined for any failure at all — a 404, a
 * transport error, or malformed JSON are not distinguished.
 */
export async function tryBundleJson(
  resolver: AssetResolver,
  name: string,
  options: { signal?: AbortSignal } = {},
): Promise<unknown> {
  try {
    return await fetchBundleJson(resolver, name, options);
  } catch {
    return undefined;
  }
}
