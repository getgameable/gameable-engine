/**
 * Where a conversation relay finds the hosted Gameable services, and with what
 * key.
 *
 * A talking character needs two services: conversation (the character's mind
 * and voice) and transcription (the player's speech, as text). Gameable hosts
 * both. One key opens both: the API key from your Gameable account. The relay
 * holds it server-side; it never reaches the page.
 *
 * Each service can be pointed elsewhere, with its own key, for a staging or
 * self-hosted deployment.
 */

/** The hosted conversation service. */
export const GAMEABLE_CONVERSATION_URL = 'https://talk.gameable.com';

/** The hosted transcription service's websocket. */
export const GAMEABLE_TRANSCRIPTION_URL = 'wss://voice.gameable.com/ws';

/** The service half of the relay's options. */
export interface RelayServices {
  readonly convorcherUrl: string;
  readonly convorcherKey: string;
  readonly parlayUrl: string;
  readonly parlayKey: string;
}

/** Environment variables, as `process.env` has them. */
export type ServiceEnv = Readonly<Record<string, string | undefined>>;

/**
 * Read the services from the environment.
 *
 * | Variable | Default |
 * | --- | --- |
 * | `GAMEABLE_API_KEY` | none; the key for both services |
 * | `GAMEABLE_CONVERSATION_URL`, `GAMEABLE_CONVERSATION_KEY` | {@link GAMEABLE_CONVERSATION_URL}, the API key |
 * | `GAMEABLE_TRANSCRIPTION_URL`, `GAMEABLE_TRANSCRIPTION_KEY` | {@link GAMEABLE_TRANSCRIPTION_URL}, the API key |
 *
 * The older `CONVORCHER_URL` / `CONVORCHER_KEY` / `PARLAY_URL` / `PARLAY_KEY`
 * names are still read, after the new ones.
 *
 * @param env Usually `process.env`.
 * @returns The services, or `undefined` when a key is missing.
 *
 * @example
 * ```ts
 * import { servicesFromEnv } from 'gameable/conversation/relay';
 *
 * const services = servicesFromEnv({ GAMEABLE_API_KEY: 'gk_example' });
 * console.log(services?.convorcherUrl); // 'https://talk.gameable.com'
 * ```
 */
export function servicesFromEnv(env: ServiceEnv): RelayServices | undefined {
  const pick = (...names: string[]): string | undefined =>
    names.map((name) => env[name]?.trim()).find((value) => value !== undefined && value !== '');
  const key = pick('GAMEABLE_API_KEY');
  const convorcherKey = pick('GAMEABLE_CONVERSATION_KEY', 'CONVORCHER_KEY') ?? key;
  const parlayKey = pick('GAMEABLE_TRANSCRIPTION_KEY', 'PARLAY_KEY') ?? key;
  if (convorcherKey === undefined || parlayKey === undefined) return undefined;
  return {
    convorcherUrl: pick('GAMEABLE_CONVERSATION_URL', 'CONVORCHER_URL') ?? GAMEABLE_CONVERSATION_URL,
    convorcherKey,
    parlayUrl: pick('GAMEABLE_TRANSCRIPTION_URL', 'PARLAY_URL') ?? GAMEABLE_TRANSCRIPTION_URL,
    parlayKey,
  };
}
