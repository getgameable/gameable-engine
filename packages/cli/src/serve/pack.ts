/**
 * Write one game's server bundle without the rest of `gameable build`: the
 * container build's step (`deploy/rooms/Dockerfile`), bundled to `pack.mjs`
 * by `scripts/bundle-server.mjs`.
 *
 *     node pack.mjs <gameDir> <distDir>
 *
 * The guest itself is built by the game's own script (`npm run build:guest`).
 */
import { resolve } from 'node:path';

import { writeServerBundle } from '../lib/serverBundle.js';
import { toPosix } from '../lib/paths.js';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node pack.mjs <gameDir> [distDir]');
  process.exit(1);
}
const gameDir = toPosix(resolve(args[0]));
const distDir = args.length > 1 ? toPosix(resolve(args[1])) : undefined;
if (!(await writeServerBundle(gameDir, { distDir }))) {
  console.error(`${gameDir} declares no features.multiplayer: there is nothing for a room server to host`);
  process.exit(1);
}
console.log(`wrote ${distDir ?? `${gameDir}/dist`}/server`);
