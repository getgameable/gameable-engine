/**
 * The room server container's entry (`deploy/rooms/Dockerfile`): bundled by
 * `packages/cli/scripts/bundle-server.mjs` into one `main.mjs`, with Jolt's
 * wasm copied beside it, because the image has no node_modules.
 *
 *     node main.mjs --games /games
 *
 * Built games only: `--direct` needs Vite and the game's TypeScript.
 * `PORT`, `HOST`, `TRUST_PROXY` and `ORIGINS` come from the environment.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveCommand } from '../commands/serve.js';

const argv = process.argv.slice(2);
if (argv.includes('--direct')) {
  console.error('the room server image serves built games; --direct is for `gameable serve` in a game directory');
  process.exit(1);
}
// Trap 5: no node_modules here, so Jolt's wasm is the file beside this bundle, by explicit path.
const joltWasm = join(dirname(fileURLToPath(import.meta.url)), 'jolt-physics.wasm.wasm');
process.exitCode = await serveCommand(argv, process.cwd(), joltWasm);
