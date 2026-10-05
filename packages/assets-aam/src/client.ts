/**
 * The AvatarOS Asset Manager (AAM) HTTP client.
 *
 * AAM is a private service: every request carries an `X-API-Key` header, and
 * that key is read from the environment (see `./env.ts`) — never hardcoded,
 * never logged, never put in a URL. The client is the only place in this
 * package that holds the key, and it only attaches it to URLs that live under
 * `baseUrl`, so a manifest that mixes AAM assets with a public CDN cannot leak
 * the credential to the CDN.
 *
 * Everything is injectable: `fetch` so tests need no network, `retries` and
 * `backoffMs` so the exponential backoff can run under fake timers, and `cache`
 * so the Cache Storage layer is opt-in and stays inert under Node.
 */

/** Default number of retries after the first attempt. */
const DEFAULT_RETRIES = 3;

/** Default first-retry delay, in milliseconds; doubled per attempt. */
const DEFAULT_BACKOFF_MS = 300;

/** Cache Storage bucket the `cache-storage` mode reads and writes. */
const CACHE_NAME = 'gameable-aam-v1';

/** Matches a URL that carries its own scheme. */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

/** The answer for "this client is not caching", shared so it allocates once. */
const NO_CACHE: Promise<Cache | undefined> = Promise.resolve(undefined);

/** Which pose space an additive clip was baked in. */
export type AdditiveType = 'none' | 'local' | 'mesh';

/** Which pose an additive clip subtracts to become a delta. */
export type BasePoseType = 'none' | 'local_frame' | 'anim_frame' | 'ref_pose';

/** Whether a clip drives the body rig or the face. */
export type AnimationClipKind = 'body' | 'face';

/** Where {@link AamClient.fetchFile} may serve bytes from. */
export type AamCacheMode = 'none' | 'cache-storage';

/**
 * One row of `GET /api/characters/{slug}/animation-assets`.
 *
 * The field names are the server's, not this package's: `file_url` is snake
 * case and the additive settings are camel case, exactly as AAM sends them.
 * Renaming them here would make the row un-greppable against the service.
 *
 * @example
 * ```ts
 * import type { AnimationAssetRow } from 'gameable/aam';
 *
 * const row: AnimationAssetRow = {
 *   id: '42',
 *   name: 'wave',
 *   kind: 'body',
 *   additive: true,
 *   file_url: '/api/character-assets/42/wave.glb',
 *   updatedAt: '2026-09-01T10:00:00Z',
 *   additiveType: 'local',
 *   basePoseType: 'local_frame',
 *   basePoseAssetId: null,
 *   refFrameIndex: 0,
 * };
 * console.log(row.kind); // 'body'
 * ```
 */
export interface AnimationAssetRow {
  /** Server-assigned row id. */
  readonly id: string;
  /** Human-facing clip name; the manifest id is derived from it. */
  readonly name: string;
  /** Body clip (a GLB) or face clip (an ARKit JSON track). */
  readonly kind: AnimationClipKind;
  /** Whether the clip is played as an additive layer. */
  readonly additive: boolean;
  /** Path or URL the bytes are served from. */
  readonly file_url: string;
  /** Last-modified stamp, used as the cache version. `null` when unknown. */
  readonly updatedAt: string | null;
  /** Additive space. `none` when the clip is not additive. */
  readonly additiveType: AdditiveType;
  /** Which pose the additive bake subtracts. */
  readonly basePoseType: BasePoseType;
  /** Row id of the clip supplying the base pose, for `anim_frame`. */
  readonly basePoseAssetId: string | null;
  /** Frame index of the reference pose inside the base clip. */
  readonly refFrameIndex: number;
}

/** One file of a character's `/ogs` inference bundle. */
export interface AamBundleFile {
  /** Bare filename, for example `scene.json`. */
  readonly name: string;
  /** Absolute URL the bytes are served from. */
  readonly url: string;
  /** Size in bytes, when the server reports one. */
  readonly size?: number;
  /** Last-modified stamp, when the server reports one. */
  readonly updatedAt?: string;
}

/** The listing of `GET /api/characters/{slug}/ogs`. */
export interface AamCharacterBundle {
  /** Every file in the character's bundle, in server order. */
  readonly files: readonly AamBundleFile[];
}

/** Per-call options for {@link AamClient.fetchFile}. */
export interface AamFetchFileOptions {
  /** Abort signal forwarded to `fetch`. */
  readonly signal?: AbortSignal;
  /**
   * Cache version token, normally the row's `updatedAt` or `size`. Changing it
   * invalidates the Cache Storage entry, so a re-uploaded file is refetched
   * instead of being replayed from the previous bytes.
   */
  readonly version?: string | number | null;
}

/** Options accepted by {@link createAamClient}. */
export interface AamClientOptions {
  /** AAM origin or proxy prefix, for example `https://aam.example` or `/aam`. */
  readonly baseUrl: string;
  /** The `X-API-Key` value. Empty means "send no header" (cookie auth). */
  readonly apiKey: string;
  /** `fetch` implementation. Defaults to the global one. */
  readonly fetch?: typeof globalThis.fetch;
  /** Retries after the first attempt, on a network error or a 5xx. */
  readonly retries?: number;
  /** First-retry delay in milliseconds; doubled on each further attempt. */
  readonly backoffMs?: number;
  /** Where file bytes may be served from. Defaults to `none`. */
  readonly cache?: AamCacheMode;
}

/** A typed AAM client bound to one deployment and one key. */
export interface AamClient {
  /** The normalised base URL, without a trailing slash. */
  readonly baseUrl: string;

  /**
   * Whether a URL belongs to this AAM deployment.
   *
   * @param url Absolute URL, or a path when `baseUrl` is itself a path.
   * @returns True when the key may be attached to it.
   */
  owns(url: string): boolean;

  /**
   * Join an AAM path onto `baseUrl`.
   *
   * @param path Server path such as `/api/characters/myra/ogs`, or a URL.
   * @returns An absolute URL when `baseUrl` is absolute, else a prefixed path.
   */
  resolveFileUrl(path: string): string;

  /**
   * `fetch` with the key attached (same-origin only) and 5xx retried.
   *
   * @param input URL, `URL` or `Request` to fetch.
   * @param init Standard `fetch` init; its headers are preserved.
   * @returns The final `Response`, whatever its status.
   */
  request(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  /**
   * List a character's animation clips.
   *
   * @param slug Character slug.
   * @returns Every clip row, body and face.
   */
  listAnimationAssets(slug: string): Promise<AnimationAssetRow[]>;

  /**
   * List a character's `/ogs` inference bundle.
   *
   * @param slug Character slug.
   * @returns The bundle listing.
   */
  listCharacterBundle(slug: string): Promise<AamCharacterBundle>;

  /**
   * Fetch one file's bytes, through the cache layer when it is enabled.
   *
   * @param url File URL or AAM path.
   * @param options Abort signal and cache version token.
   * @returns The bytes.
   */
  fetchFile(url: string, options?: AamFetchFileOptions): Promise<ArrayBuffer>;
}

/**
 * An AAM request that could not be completed.
 *
 * The message names the path and the status but never the key — an error that
 * reaches a log must not carry the credential.
 *
 * @example
 * ```ts
 * import { AamError } from 'gameable/aam';
 *
 * const err = new AamError('/api/characters/myra/ogs', 'not found', 404);
 * console.log(err.status, err.path); // 404 '/api/characters/myra/ogs'
 * ```
 */
export class AamError extends Error {
  /** AAM path or URL the failure belongs to. */
  readonly path: string;

  /** HTTP status, when the failure came back as a response. */
  readonly status?: number;

  /**
   * Build an AAM error.
   *
   * @param path AAM path or URL involved.
   * @param message What went wrong.
   * @param status HTTP status, when there was one.
   * @param options Standard `Error` options, used to keep the cause.
   */
  constructor(path: string, message: string, status?: number, options?: ErrorOptions) {
    super(`${path}: ${message}`, options);
    this.name = 'AamError';
    this.path = path;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Whether a URL carries its own scheme or is protocol-relative.
 *
 * @param url Candidate URL.
 * @returns True when it is absolute.
 */
function isAbsoluteUrl(url: string): boolean {
  return url.startsWith('//') || ABSOLUTE_URL.test(url);
}

/**
 * The URL a `fetch` argument addresses.
 *
 * @param input URL, `URL` or `Request`.
 * @returns The URL as a string.
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Resolve after `ms`, through the global timer so fake timers can drive it.
 *
 * @param ms Delay in milliseconds.
 * @returns A promise that settles after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Narrow an unknown value to a plain JSON object.
 *
 * @param value Value to test.
 * @returns True when `value` is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The first defined value among several keys of a row.
 *
 * AAM sends some fields snake_case and some camelCase, and the `/ogs` listing
 * has changed spelling once already. Reading both spellings is cheaper than a
 * migration.
 *
 * @param row Raw row.
 * @param keys Keys to try, in order.
 * @returns The first non-nullish value, or `undefined`.
 */
function pick(row: Record<string, unknown>, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Coerce a value to a string, falling back when it is absent.
 *
 * @param value Raw value.
 * @param fallback Value used when `value` is not a string or number.
 * @returns The string.
 */
function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

/**
 * Coerce a value to a finite number.
 *
 * @param value Raw value.
 * @param fallback Value used when `value` is not a finite number.
 * @returns The number.
 */
function asCount(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Coerce a value to one of a closed set of strings.
 *
 * @param value Raw value.
 * @param allowed Accepted values.
 * @param fallback Value used when `value` is not one of them.
 * @returns The matched value, or `fallback`.
 */
function asOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * The array inside a list response, whether it is bare or wrapped.
 *
 * @param path Path the response came from, for the error message.
 * @param json Parsed response body.
 * @returns The rows.
 */
function rowsOf(path: string, json: unknown): readonly unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json)) {
    for (const key of ['items', 'assets', 'files', 'rows', 'data']) {
      const value = json[key];
      if (Array.isArray(value)) return value;
    }
  }
  throw new AamError(path, 'expected a JSON array of rows');
}

/**
 * Parse one animation-asset row, defaulting every optional field.
 *
 * @param path Path the row came from, for the error message.
 * @param raw Raw row.
 * @param index Position in the listing, for the error message.
 * @returns The typed row.
 */
export function parseAnimationAssetRow(
  path: string,
  raw: unknown,
  index: number,
): AnimationAssetRow {
  if (!isRecord(raw)) throw new AamError(path, `row ${String(index)} is not an object`);

  const id = asText(pick(raw, 'id', 'asset_id', 'assetId'), '');
  if (id === '') throw new AamError(path, `row ${String(index)} has no id`);

  const fileUrl = asText(pick(raw, 'file_url', 'fileUrl', 'url'), '');
  if (fileUrl === '') {
    throw new AamError(path, `animation asset "${id}" has no file_url; it cannot be loaded`);
  }

  const additiveType = asOneOf<AdditiveType>(
    pick(raw, 'additiveType', 'additive_type'),
    ['none', 'local', 'mesh'],
    'none',
  );
  const basePoseId = pick(raw, 'basePoseAssetId', 'base_pose_asset_id');
  const updatedAt = pick(raw, 'updatedAt', 'updated_at');

  return Object.freeze({
    id,
    name: asText(pick(raw, 'name', 'display_name', 'displayName'), `clip_${id}`),
    kind: asOneOf<AnimationClipKind>(pick(raw, 'kind', 'type'), ['body', 'face'], 'body'),
    additive: pick(raw, 'additive') === true || additiveType !== 'none',
    file_url: fileUrl,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
    additiveType,
    basePoseType: asOneOf<BasePoseType>(
      pick(raw, 'basePoseType', 'base_pose_type'),
      ['none', 'local_frame', 'anim_frame', 'ref_pose'],
      'none',
    ),
    basePoseAssetId: basePoseId === undefined ? null : asText(basePoseId, ''),
    refFrameIndex: asCount(pick(raw, 'refFrameIndex', 'ref_frame_index'), 0),
  });
}

/**
 * Build a client for one AAM deployment.
 *
 * @param options Base URL, key, and the injectable `fetch`, retry and cache
 *   policy.
 * @returns The client.
 *
 * @example
 * ```ts
 * import { createAamClient } from 'gameable/aam';
 *
 * const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: key });
 * console.log(client.resolveFileUrl('/api/characters/myra/ogs'));
 * // 'https://aam.example/api/characters/myra/ogs'
 * ```
 */
export function createAamClient(options: AamClientOptions): AamClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  if (base === '') throw new AamError('baseUrl', 'must be a non-empty URL or path prefix');

  const apiKey = options.apiKey;
  const doFetch = options.fetch ?? globalThis.fetch;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const cacheMode = options.cache ?? 'none';
  /** The memoised `caches.open()` promise, built on first use. */
  let cacheBucket: Promise<Cache | undefined> | undefined;
  const baseIsAbsolute = isAbsoluteUrl(base);
  const baseParsed = baseIsAbsolute
    ? new URL(base.startsWith('//') ? `https:${base}` : base)
    : null;

  /**
   * Whether the key may be attached to a URL.
   *
   * @param url Candidate URL.
   * @returns True when the URL is under `baseUrl`.
   */
  function owns(url: string): boolean {
    const target = url.trim();
    if (target === '') return false;
    if (baseParsed === null) {
      // A path prefix such as `/aam`: only same-document paths can match, and
      // an absolute URL is by definition somewhere else.
      return !isAbsoluteUrl(target) && (target === base || target.startsWith(`${base}/`));
    }
    if (!isAbsoluteUrl(target)) return false;
    let parsed: URL;
    try {
      parsed = new URL(target.startsWith('//') ? `https:${target}` : target);
    } catch {
      return false;
    }
    if (parsed.origin !== baseParsed.origin) return false;
    const prefix = baseParsed.pathname.replace(/\/+$/, '');
    return prefix === '' || parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`);
  }

  /**
   * Join an AAM path onto the base URL.
   *
   * @param path Server path, or an already-absolute URL.
   * @returns The URL to fetch.
   */
  function resolveFileUrl(path: string): string {
    if (isAbsoluteUrl(path)) return path;
    return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
  }

  /**
   * `fetch` with the key attached and transient failures retried.
   *
   * Retries a network error and a 5xx; a 4xx is definitive and returns at once,
   * because retrying a 401 or a 404 only delays the real message.
   *
   * @param input URL, `URL` or `Request`.
   * @param init Standard `fetch` init.
   * @returns The final response.
   */
  async function request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = urlOf(input);
    const headers = new Headers(init?.headers);
    if (apiKey !== '' && owns(url)) headers.set('X-API-Key', apiKey);
    const withAuth: RequestInit = { ...init, headers };

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await doFetch(input, withAuth);
        if (response.status < 500 || attempt === retries) return response;
        // A 5xx we are about to retry still arrived with a body. Nothing will
        // ever read it, and an un-drained body holds its connection open — in
        // a browser that is a socket per retry.
        await response.body?.cancel().catch(() => undefined);
      } catch (err) {
        if (attempt === retries) {
          throw new AamError(url, 'network request failed', undefined, { cause: err });
        }
      }
      await sleep(backoffMs * 2 ** attempt);
    }
    // The last attempt always returns or throws, so the loop cannot fall out
    // of the bottom; `retries` is clamped at zero or more by the constructor.
    throw new AamError(url, 'request failed');
  }

  /**
   * GET an AAM path and parse the JSON body.
   *
   * @param path Server path.
   * @returns The parsed body.
   */
  async function getJson(path: string): Promise<unknown> {
    const url = resolveFileUrl(path);
    const response = await request(url);
    if (!response.ok) {
      throw new AamError(path, `request failed with ${String(response.status)}`, response.status);
    }
    return (await response.json()) as unknown;
  }

  /**
   * The Cache Storage bucket, or `undefined` where the API does not exist.
   *
   * `caches.open()` is a round trip to the storage layer, so the promise is
   * memoised: every file this client fetches shares one open bucket instead of
   * opening it again per asset.
   *
   * @returns The opened cache, or `undefined`.
   */
  function openCache(): Promise<Cache | undefined> {
    if (cacheMode !== 'cache-storage') return NO_CACHE;
    if (typeof caches === 'undefined') return NO_CACHE;
    cacheBucket ??= caches.open(CACHE_NAME).catch(() => undefined);
    return cacheBucket;
  }

  /**
   * The cache key for a file, versioned so re-uploaded bytes miss.
   *
   * @param url Resolved file URL.
   * @param version Version token, or nullish for none.
   * @returns The key URL.
   */
  function cacheKey(url: string, version: string | number | null | undefined): string {
    if (version === undefined || version === null || version === '') return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}__aamver=${encodeURIComponent(String(version))}`;
  }

  return {
    baseUrl: base,
    owns,
    resolveFileUrl,
    request,

    async listAnimationAssets(slug) {
      const path = `/api/characters/${encodeURIComponent(slug)}/animation-assets`;
      const json = await getJson(path);
      return rowsOf(path, json).map((raw, i) => parseAnimationAssetRow(path, raw, i));
    },

    async listCharacterBundle(slug) {
      const path = `/api/characters/${encodeURIComponent(slug)}/ogs`;
      const json = await getJson(path);
      const files = rowsOf(path, json).map((raw, i): AamBundleFile => {
        if (!isRecord(raw)) throw new AamError(path, `row ${String(i)} is not an object`);
        const name = asText(pick(raw, 'filename', 'name'), '');
        const url = asText(pick(raw, 'fileUrl', 'file_url', 'url'), '');
        if (name === '' || url === '') {
          throw new AamError(path, `row ${String(i)} has no filename or fileUrl`);
        }
        const size = pick(raw, 'size', 'byte_size', 'byteSize');
        const updatedAt = pick(raw, 'updatedAt', 'updated_at');
        return Object.freeze({
          name,
          url: resolveFileUrl(url),
          ...(size === undefined ? {} : { size: asCount(size, 0) }),
          ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
        });
      });
      return Object.freeze({ files: Object.freeze(files) });
    },

    async fetchFile(url, fetchOptions = {}) {
      const resolved = resolveFileUrl(url);
      const key = cacheKey(resolved, fetchOptions.version);
      const cache = await openCache();

      if (cache !== undefined) {
        try {
          const hit = await cache.match(key);
          if (hit !== undefined) return await hit.arrayBuffer();
        } catch {
          // A cache read failure is never fatal; fall through to the network.
        }
      }

      // `no-store` only makes sense when this client is the cache: it tells
      // the HTTP layer not to keep a second, unversioned copy of bytes we are
      // about to store ourselves. With `cache: 'none'` there is nothing else
      // holding the file, so suppressing the browser's own cache would mean
      // re-downloading every asset on every run.
      const init: RequestInit = cache === undefined ? {} : { cache: 'no-store' };
      if (fetchOptions.signal !== undefined) init.signal = fetchOptions.signal;
      const response = await request(resolved, init);
      if (!response.ok) {
        throw new AamError(url, `request failed with ${String(response.status)}`, response.status);
      }
      const bytes = await response.arrayBuffer();

      if (cache !== undefined) {
        try {
          await cache.put(key, new Response(bytes));
        } catch {
          // Storage full or opaque response: the bytes are already in hand.
        }
      }
      return bytes;
    },
  };
}
