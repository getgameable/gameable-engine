/**
 * `gameable serve`'s options: flags first, then the container's environment
 * (`PORT`, `HOST`, `TRUST_PROXY`, `ORIGINS`), then the defaults.
 */
import { randomInt } from 'node:crypto';

import { parseArgs } from '../lib/args.js';
import { absPosix } from '../lib/paths.js';

/** What `gameable serve` accepts. */
export const SERVE_SPEC = {
  boolean: ['direct', 'help'],
  value: ['port', 'host', 'origins', 'trust-proxy', 'games', 'max-rooms', 'seed'],
  alias: { h: 'help', p: 'port' },
} as const;

/** The room server's port when nothing says otherwise. */
export const DEFAULT_PORT = 8790;

/** Pages allowed in by default: a dev server on this machine, by either name. */
export const DEFAULT_ORIGINS: readonly string[] = ['http://localhost:*', 'http://127.0.0.1:*'];

/** A resolved `serve` invocation. */
export interface ServeOptions {
  /** `direct`: `src/game.ts` through Vite, one room. `built`: the wasm guest and `dist/server/game.json`. */
  readonly mode: 'direct' | 'built';
  /** The game's directory (the working directory). */
  readonly gameDir: string;
  /** With `--games`, a folder of built games, `<dir>/<name>/dist`; the game directory is then unused. */
  readonly gamesDir: string | undefined;
  readonly port: number;
  readonly host: string;
  readonly origins: readonly string[];
  /** Proxies in front of the server whose `X-Forwarded-For` is trusted (nginx alone: 1). */
  readonly trustProxy: number;
  readonly maxRooms: number;
  /** One seed for every room; undefined rolls a fresh one per room. */
  readonly seed: number | undefined;
}

/** A usage error: printed with the help text, exit code 1. */
export class ServeUsageError extends Error {}

/**
 * @param argv Arguments after `serve`.
 * @param cwd The working directory.
 * @param env The environment (the container's settings).
 * @returns The resolved options.
 * @throws {ServeUsageError} On an unknown flag, a bad number, or a combination that cannot run.
 */
export function resolveServeOptions(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServeOptions {
  const { flags, unknown } = parseArgs(argv, SERVE_SPEC);
  if (unknown.length > 0) throw new ServeUsageError(`unknown option: ${unknown.join(', ')}`);
  const value = (flag: string, variable?: string): { text: string; from: string } | undefined => {
    const raw = flags[flag];
    if (typeof raw === 'string') return { text: raw, from: `--${flag}` };
    const fromEnv = variable === undefined ? undefined : env[variable];
    return fromEnv === undefined || fromEnv === '' ? undefined : { text: fromEnv, from: variable as string };
  };
  const direct = flags.direct === true;
  const gamesDir = value('games');
  if (direct && gamesDir !== undefined) {
    throw new ServeUsageError('--direct serves the game in this directory; --games serves built games');
  }
  const maxRooms = whole(value('max-rooms'), direct ? 1 : 8, 1, 1000);
  if (direct && maxRooms !== 1) {
    throw new ServeUsageError(
      `--direct runs the game's TypeScript in this process, where two rooms would share the SDK's state: ` +
        `it takes --max-rooms 1, not ${String(maxRooms)}. Build the game (gameable build) for more rooms.`,
    );
  }
  const origins = value('origins', 'ORIGINS');
  const seed = value('seed');
  return {
    mode: direct ? 'direct' : 'built',
    gameDir: cwd,
    gamesDir: gamesDir === undefined ? undefined : absPosix(cwd, gamesDir.text),
    port: whole(value('port', 'PORT'), DEFAULT_PORT, 0, 65_535),
    host: value('host', 'HOST')?.text ?? '127.0.0.1',
    origins:
      origins === undefined
        ? DEFAULT_ORIGINS
        : origins.text.split(',').map((o) => o.trim()).filter((o) => o !== ''),
    trustProxy: whole(value('trust-proxy', 'TRUST_PROXY'), 0, 0, 16),
    maxRooms,
    seed: seed === undefined ? undefined : whole(seed, 0, 0, 2 ** 32 - 1),
  };
}

/**
 * @param raw The value and where it came from, or undefined.
 * @param fallback Used when absent.
 * @param min Smallest allowed.
 * @param max Largest allowed.
 * @returns The whole number.
 * @throws {ServeUsageError} When it is not a whole number in range.
 */
function whole(raw: { text: string; from: string } | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = /^\d+$/.test(raw.text.trim()) ? Number(raw.text) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ServeUsageError(`${raw.from} must be a whole number from ${String(min)} to ${String(max)}, got "${raw.text}"`);
  }
  return n;
}

/**
 * @param pinned `--seed`, or undefined.
 * @returns A function giving each new room its seed: a fresh 32-bit roll, so
 *   two rooms deal differently, or the pinned one every time.
 */
export function roomSeeds(pinned: number | undefined): () => number {
  return pinned === undefined ? () => randomInt(0, 2 ** 32 - 1) : () => pinned;
}
