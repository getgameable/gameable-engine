/**
 * The game's name in the room server's catalog, shared by the page and
 * `gameable serve` so the two never spell it differently.
 */

/**
 * A game's catalog name: its `package.json` `name` without the npm scope.
 * The page reads it at build time (Vite imports `package.json`); the room
 * server registers the game under the same string.
 *
 * @param packageName The `name` field of the game's `package.json`.
 * @returns The catalog name, such as `example-mystery` or `my-game`.
 * @throws {Error} When nothing is left after the scope.
 *
 * @example
 * ```ts
 * import { catalogName } from 'gameable/net/page';
 *
 * catalogName('@gameable/example-mystery'); // 'example-mystery'
 * catalogName('my-game'); // 'my-game'
 * ```
 */
export function catalogName(packageName: string): string {
  const slash = packageName.startsWith('@') ? packageName.indexOf('/') : -1;
  const name = (slash === -1 ? packageName : packageName.slice(slash + 1)).trim();
  if (name === '') {
    throw new Error(`no catalog name in the package name "${packageName}"`);
  }
  return name;
}
