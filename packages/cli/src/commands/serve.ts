/**
 * `gameable serve` — the room server for a multiplayer game.
 *
 * `--direct` runs the game's TypeScript in this process (the dev loop, one
 * room). Without it, it serves the built game (`gameable build` writes the
 * wasm guest and `dist/server/`), up to eight rooms, or several built games
 * with `--games <dir>`.
 */
import { color, mark } from '../lib/colors.js';
import { DEFAULT_PORT, resolveServeOptions, type ServeOptions, ServeUsageError } from '../serve/options.js';
import { type ServeHandle, startServe } from '../serve/startServe.js';

/** One screen of help. */
export const SERVE_HELP = `
${color.bold('gameable serve')} — the room server for a multiplayer game

  --direct             run src/game.ts in this process: the dev loop, one room
  --port <n>           port to listen on (default ${String(DEFAULT_PORT)}; env PORT)
  --host <addr>        interface to bind (default 127.0.0.1; env HOST; a container: 0.0.0.0)
  --origins <list>     page origins allowed in, comma-separated
                       (default http://localhost:*,http://127.0.0.1:*; env ORIGINS)
  --trust-proxy <n>    proxies in front whose X-Forwarded-For counts (default 0;
                       nginx alone: 1; Traefik then nginx: 2; env TRUST_PROXY)
  --games <dir>        serve every built game in <dir>/<name>/dist
  --max-rooms <n>      rooms this process holds at once (default 8; --direct: 1)
  --seed <n>           one seed for every room (default: a fresh one per room)

Without --direct it serves dist/ as gameable build left it. Each game is
served under its package.json name without the npm scope; /health answers JSON.
`.trim();

/**
 * Run the room server until SIGINT or SIGTERM.
 *
 * @param argv Arguments after `serve`.
 * @param cwd The game directory.
 * @param joltWasm Jolt's wasm file, when it is not in node_modules (the container).
 * @returns The process exit code: 0 after a signal, 1 when the server could not start.
 */
export async function serveCommand(argv: readonly string[], cwd: string, joltWasm?: string): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(SERVE_HELP);
    return 0;
  }
  let options: ServeOptions;
  try {
    options = resolveServeOptions(argv, cwd);
  } catch (error) {
    if (!(error instanceof ServeUsageError)) throw error;
    console.error(`${mark.fail} ${error.message}`);
    console.error(SERVE_HELP);
    return 1;
  }
  let handle: ServeHandle;
  try {
    handle = await startServe(options, joltWasm);
  } catch (error) {
    console.error(`${mark.fail} ${startFailure(error, options)}`);
    return 1;
  }
  console.log('');
  console.log(`  ${color.bold('gameable serve')} ${color.gray(options.mode)}`);
  console.log(`  ${color.cyan(`ws://${options.host}:${String(handle.port)}/`)}  ${color.gray('/health')}`);
  for (const line of handle.about) console.log(`  ${color.gray(line)}`);
  console.log(`  ${color.gray(`origins: ${options.origins.join(', ')}`)}`);
  console.log('');
  await stopped(handle);
  return 0;
}

/**
 * @param error What `startServe` threw.
 * @param options The options it ran with.
 * @returns One clear line.
 */
function startFailure(error: unknown, options: ServeOptions): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'EADDRINUSE') {
    return `port ${String(options.port)} is already in use on ${options.host}: stop what holds it, or pass --port`;
  }
  if (code === 'EACCES') return `binding ${options.host}:${String(options.port)} was refused (EACCES)`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param handle The running server.
 * @returns Resolves once a signal has closed it.
 */
function stopped(handle: ServeHandle): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      void handle.close().finally(resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
