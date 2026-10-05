/**
 * The name a game is served under: its `package.json` name without the npm
 * scope (`@gameable/example-mystery` is `example-mystery`), by the page's own
 * `catalogName`, so the page and the room server never spell it differently.
 */
import { readFileSync } from 'node:fs';

import { catalogName } from '@gameable/net/page';

/**
 * @param gameDir The game's directory.
 * @returns Its catalog name, from its `package.json`.
 * @throws {Error} When the package has no usable name (the room catalog refuses one that is not a room name).
 */
export function gameNameOf(gameDir: string): string {
  const manifest = JSON.parse(readFileSync(`${gameDir}/package.json`, 'utf8')) as { name?: unknown };
  return catalogName(typeof manifest.name === 'string' ? manifest.name : '');
}
