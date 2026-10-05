/**
 * `gameable dev` — Vite, in direct mode.
 *
 * Direct mode runs the game's TypeScript in the host's own realm through the
 * same SDK runtime the component uses, so there is no build step between an
 * edit and a reload. `--wasm` builds the component first and sets `GAMEABLE_WASM=1`,
 * which is how you check parity locally; it is not the default because a
 * thirty-second componentize is not a dev loop.
 */
import { existsSync } from 'node:fs';

import { flagBool, flagNumber, parseArgs } from '../lib/args.js';
import { color, mark } from '../lib/colors.js';
import { GuestBuildError, guestBuild } from '../lib/guestBuild.js';
import { absPosix, resolvePackageFile } from '../lib/paths.js';
import { runNode } from '../lib/run.js';

/** Options `gameable dev` accepts. */
export const DEV_SPEC = {
  boolean: ['wasm', 'open', 'host', 'help'],
  value: ['port'],
  alias: { h: 'help', p: 'port' },
} as const;

/** One screen of help. */
export const DEV_HELP = `
${color.bold('gameable dev')} — run the game with Vite

  --wasm           build the guest component first and serve with GAMEABLE_WASM=1
  --port <n>       port to listen on (default: Vite's, 5173)
  --host           listen on the network, not just localhost
  --open           open a browser

Direct mode is the default: your TypeScript runs in the page, through the same
SDK runtime the component uses. Edit src/game.ts and save.
`.trim();

/**
 * Run the dev server.
 *
 * @param argv Arguments after `dev`.
 * @param cwd The game directory.
 * @returns The process exit code, once Vite exits.
 */
export async function devCommand(argv: readonly string[], cwd: string): Promise<number> {
  const { flags, unknown } = parseArgs(argv, DEV_SPEC);
  if (unknown.length > 0) {
    console.error(`${mark.fail} unknown option: ${unknown.join(', ')}`);
    console.error(DEV_HELP);
    return 1;
  }
  if (flagBool(flags, 'help', false)) {
    console.log(DEV_HELP);
    return 0;
  }

  const gameDir = absPosix(cwd);
  if (!existsSync(`${gameDir}/package.json`)) {
    console.error(`${mark.fail} ${gameDir} has no package.json. Run this inside a game directory.`);
    return 1;
  }

  const wasm = flagBool(flags, 'wasm', false);
  const port = flagNumber(flags, 'port', 5173);

  if (wasm) {
    console.log(`${mark.step}building the guest component (--wasm)`);
    try {
      const result = await guestBuild({
        gameDir,
        onLog: (line) => {
          console.log(color.gray(`    ${line}`));
        },
      });
      console.log(
        result.built
          ? `${mark.ok}guest built in ${(result.durationMs / 1000).toFixed(1)} s`
          : `${mark.ok}guest already up to date`,
      );
    } catch (err) {
      if (err instanceof GuestBuildError) {
        console.error(`${mark.fail} ${err.step}: ${err.message}`);
        if (err.output.length > 0) console.error(err.output);
      } else {
        console.error(`${mark.fail} ${err instanceof Error ? err.message : String(err)}`);
      }
      return 1;
    }
  }

  const vite = resolvePackageFile(gameDir, 'vite', 'bin/vite.js');
  if (vite === undefined) {
    console.error(`${mark.fail} vite is not installed here. Run \`npm install\` first.`);
    return 1;
  }

  const args = ['--port', String(port), '--strictPort'];
  if (flagBool(flags, 'host', false)) args.push('--host');
  if (flagBool(flags, 'open', false)) args.push('--open');

  console.log('');
  console.log(`  ${color.bold('gameable')} ${color.gray(wasm ? 'wasm mode' : 'direct mode')}`);
  console.log(`  ${color.cyan(`http://localhost:${String(port)}/`)}`);
  console.log(`  ${color.gray('edit src/game.ts')}`);
  console.log('');

  const result = await runNode(vite, args, {
    cwd: gameDir,
    env: wasm ? { GAMEABLE_WASM: '1' } : {},
    interactive: true,
  });
  return result.status === 0 ? 0 : 1;
}
