/**
 * What the Postgres store and its migrations share: `pg` loaded on first use
 * (so `gameable/net/server` stays importable where `pg` cannot run, such as
 * Play Solo's page), and error text with the URL's password taken out.
 */
import type pgTypes from 'pg';

/** The `pg` module, imported the first time a Postgres store or migration needs it. */
export async function loadPg(): Promise<typeof pgTypes> {
  const mod = (await import('pg')) as { default?: typeof pgTypes } & typeof pgTypes;
  return mod.default ?? mod;
}

/** The password in a Postgres URL, or `null` when it has none or is not a URL. */
function passwordOf(url: string): string | null {
  try {
    const password = new URL(url).password;
    return password === '' ? null : decodeURIComponent(password);
  } catch {
    return null;
  }
}

/**
 * One line about an error, safe to log: its Postgres code when it has one,
 * its message, and never the URL's password (raw or percent-encoded).
 */
export function describeError(error: unknown, url: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  let text = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string') text = `${code} ${text}`;
  const password = passwordOf(url);
  if (password !== null) {
    text = text.split(password).join('***').split(encodeURIComponent(password)).join('***');
  }
  if (text.includes(url)) text = text.split(url).join('<url>');
  return text.split('\n')[0] ?? text;
}

/** True for the Postgres codes that mean "this document is not JSON Postgres can store". */
export function isInvalidDoc(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '22P02' || code === '22P05' || code === '22025';
}
