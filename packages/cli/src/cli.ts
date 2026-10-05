/**
 * Command dispatch for `gameable`.
 *
 * `src/bin.ts` is the executable wrapper; everything here is a pure function of
 * its arguments and returns an exit code instead of calling `process.exit`, so
 * the whole surface is testable. There is no argument-parsing library: the
 * parser is forty lines and the command surface is five verbs.
 */
import { readFileSync } from 'node:fs';

import { buildCommand } from './commands/build.js';
import { devCommand } from './commands/dev.js';
import { docsCommand } from './commands/docs.js';
import { doctorCommand } from './commands/doctor.js';
import { serveCommand } from './commands/serve.js';
import { color } from './lib/colors.js';
import { packageDirOf } from './lib/paths.js';

/**
 * This package's version, read from its own manifest.
 *
 * @returns The version string, or `0.0.0` when the manifest is unreadable.
 */
function version(): string {
  try {
    const json = JSON.parse(
      readFileSync(`${packageDirOf(import.meta.url)}/package.json`, 'utf8'),
    ) as {
      version?: unknown;
    };
    return typeof json.version === 'string' ? json.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Top-level help. */
const HELP = `
${color.bold('gameable')} — the command line for gameable games

  ${color.bold('gameable dev')} [--wasm] [--port <n>]
      Run the game with Vite. Direct mode by default: your TypeScript runs in
      the page through the same SDK runtime the component uses.

  ${color.bold('gameable build')} [--release] [--report] [--no-wasm] [--no-gate]
      jco guest-types, tsc --noEmit, componentize, transpile, vite build.
      --report prints size and timing numbers and enforces the budgets.

  ${color.bold('gameable serve')} [--direct] [--port <n>] [--games <dir>]
      The room server for a multiplayer game: the built game (up to eight
      rooms), or with --direct src/game.ts in one room. See serve --help.

  ${color.bold('gameable doctor')} [--quiet]
      Check node, npm, three, the manifest, WIT and the jco toolchain.
      The exit code is the number of failures.

  ${color.bold('gameable docs')} [fps|third-person|multiplayer|index|full] [--open]
      Print where the llms*.txt bundles are on this machine.

  --version, -v      print the version
  --help, -h         this text
`.trim();

/**
 * Dispatch one invocation.
 *
 * @param argv Arguments after the executable and script, usually `process.argv.slice(2)`.
 * @param cwd Working directory the command applies to.
 * @returns The process exit code.
 */
export async function main(argv: readonly string[], cwd: string): Promise<number> {
  const command = argv.at(0);
  const rest = argv.slice(1);

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    console.log(version());
    return 0;
  }

  switch (command) {
    case 'dev':
      return devCommand(rest, cwd);
    case 'build':
      return buildCommand(rest, cwd);
    case 'serve':
      return serveCommand(rest, cwd);
    case 'doctor':
      return doctorCommand(rest, cwd);
    case 'docs':
      return docsCommand(rest, cwd);
    default:
      console.error(`${color.red('unknown command')} "${command}"`);
      console.error('');
      console.error(HELP);
      return 1;
  }
}

export { HELP };
