/**
 * The executable. `bin/gameable.mjs` launches the build of this file.
 *
 * Nothing lives here but the process plumbing: everything else is in
 * `src/cli.ts`, which returns an exit code instead of calling `process.exit`.
 */
import { main } from './cli.js';

const code = await main(process.argv.slice(2), process.cwd());
if (code !== 0) process.exitCode = code;
