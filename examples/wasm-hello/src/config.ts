/**
 * What this page talks to, read once from the URL so a host can run the same
 * build for any exported character (the Gameable studio's published pages do this):
 *
 * - `?character=` the character's `character.json`, same origin only.
 * - `?talk=` the conversation relay's base URL, same origin only.
 * - `?id=` the id the relay knows this character by.
 * - `?name=` the speaker label in the chat.
 *
 * Anything missing or refused falls back to the bundled greeter.
 */
export interface HelloConfig {
  character: string;
  talk: string;
  id: string;
  name: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A same-origin URL from the query, or undefined. */
function sameOrigin(value: string | null, page: URL): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, page);
    return url.origin === page.origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the page's configuration from its query string.
 *
 * @param href The page's address, `location.href` by default.
 * @param base Vite's BASE_URL, where the bundled greeter lives.
 * @returns The character, relay, relay id and label to use.
 */
export function readConfig(
  href: string = location.href,
  base: string = import.meta.env.BASE_URL,
): HelloConfig {
  const page = new URL(href);
  const query = page.searchParams;
  const id = query.get('id') ?? '';
  const name = (query.get('name') ?? '').trim().slice(0, 64);
  let talk = sameOrigin(query.get('talk'), page) ?? new URL('/services/hello/', page).href;
  if (!talk.endsWith('/')) talk += '/';
  return {
    character:
      sameOrigin(query.get('character'), page) ??
      new URL(`${base}characters/greeter/character.json`, page).href,
    talk,
    id: ID.test(id) ? id : 'greeter',
    name: name || 'Gameable guide',
  };
}
