/**
 * Reading the adapter's configuration out of the environment.
 *
 * The key is **never** written down in this repository. It arrives as
 * `VITE_ASSET_MANAGER_API_KEY`, is read exactly once, here, and is handed
 * straight to a client closure; nothing in this package logs it, puts it in a
 * URL, or copies it onto an error.
 *
 * The adapter is optional, so the absence of `VITE_ASSET_MANAGER_URL` is not an
 * error — it is the answer "this game does not use AAM", and callers branch on
 * `null` rather than catching.
 */

/** A usable AAM configuration read from the environment. */
export interface AamEnvConfig {
  /** Value of `VITE_ASSET_MANAGER_URL`, with any trailing slash removed. */
  readonly baseUrl: string;
  /**
   * Value of `VITE_ASSET_MANAGER_API_KEY`, or `''` when it is unset.
   *
   * Empty is legitimate: a deployment served from the same site authenticates
   * with its session cookie, and the client then sends no `X-API-Key` header at
   * all. The key is the localhost-development affordance, because a
   * domain-scoped cookie cannot reach `localhost`.
   */
  readonly apiKey: string;
}

/**
 * The build-time environment, when there is one.
 *
 * `import.meta.env` is Vite's; under Node, vitest or a plain bundler it may not
 * exist, and reading it must not throw.
 *
 * @returns The environment record, or an empty one.
 */
function defaultEnv(): Record<string, string | undefined> {
  const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
  return meta.env ?? {};
}

/**
 * Read the AAM configuration from a Vite-style environment.
 *
 * @param env Environment record. Defaults to `import.meta.env`.
 * @returns The configuration, or `null` when `VITE_ASSET_MANAGER_URL` is unset
 *   or blank — which means the adapter is simply not in use.
 *
 * @example
 * ```ts
 * import { aamConfigFromEnv, createAamClient } from 'gameable/aam';
 *
 * const config = aamConfigFromEnv({ VITE_ASSET_MANAGER_URL: 'https://aam.example' });
 * const client = config === null ? null : createAamClient(config);
 * console.log(config?.baseUrl); // 'https://aam.example'
 * ```
 */
export function aamConfigFromEnv(
  env: Record<string, string | undefined> = defaultEnv(),
): AamEnvConfig | null {
  const baseUrl = (env.VITE_ASSET_MANAGER_URL ?? '').trim().replace(/\/+$/, '');
  if (baseUrl === '') return null;
  return Object.freeze({
    baseUrl,
    apiKey: (env.VITE_ASSET_MANAGER_API_KEY ?? '').trim(),
  });
}
