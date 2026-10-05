/**
 * The fetch resolver: one `fetch` that knows where the key belongs.
 *
 * `loadManifest` and the character bundle loader both take a `fetch` option.
 * Handing them this one makes AAM-hosted assets load with no other change to a
 * game: entries whose URL is under the deployment get the `X-API-Key` header
 * and the retry policy, and every other entry — a public CDN, a `blob:` URL, a
 * file from the game's own `/assets/` directory — goes through untouched.
 *
 * That split is the whole point. A single fetch wrapper that attached the key
 * to everything would post the credential to any third-party host that happened
 * to appear in a manifest.
 */
import type { AamClient } from './client.js';

/** A drop-in `fetch` bound to one AAM deployment. */
export interface AamResolver {
  /** `fetch`, with the key attached to AAM URLs only. */
  readonly fetch: typeof globalThis.fetch;
}

/**
 * Build the `fetch` option for `loadManifest` and `loadCharacterBundle`.
 *
 * @param client Client for the deployment that holds the key.
 * @returns An object with a single `fetch`, assignable anywhere the engine
 *   accepts a `fetch` override.
 *
 * @example
 * ```ts
 * import { loadManifest } from 'gameable/assets';
 * import { createAamClient, createAamResolver } from 'gameable/aam';
 *
 * const client = createAamClient({ baseUrl: 'https://aam.example', apiKey: key });
 * const resolver = createAamResolver(client);
 * const manifest = await loadManifest('/assets/assets.json', { fetch: resolver.fetch });
 * console.log(manifest.assets.length);
 * ```
 */
export function createAamResolver(client: AamClient): AamResolver {
  return Object.freeze({
    /**
     * Fetch a URL, adding the key when it belongs to this deployment.
     *
     * @param input URL, `URL` or `Request` to fetch.
     * @param init Standard `fetch` init; its headers are preserved.
     * @returns The response.
     */
    fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      client.request(input, init),
  });
}
