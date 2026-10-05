/**
 * The QuickJS compatibility layer. Import this **first**, before any game code.
 *
 * `jco componentize --backend qjs` runs game logic in QuickJS-NG, which is a
 * bare ECMAScript engine: there is no `console`, no `TextEncoder` /
 * `TextDecoder`, no `structuredClone`, no timers and no `crypto`. Worse,
 * `Math.random()` is identically seeded on every instantiation, because Wizer
 * snapshots the heap at build time.
 *
 * Importing this module installs the missing globals and replaces
 * `Math.random` with a guard that throws until `init` seeds the SDK generator.
 * Everything it installs is a no-op when the global already exists, so the
 * same module is safe in V8 (`mode: 'direct'`, vitest, the Vite dev server).
 *
 * @example
 * ```ts
 * import 'gameable/sdk/prelude';
 *
 * console.log('this reaches env.log once the runtime is initialised');
 * ```
 */
import type { LogLevel } from './types';

/** Where prelude `console` output goes. */
export type LogSink = (level: LogLevel, msg: string) => void;

/** The most recent console lines, kept until a real sink is installed. */
const backlog: { level: LogLevel; msg: string }[] = [];

/** Cap on `backlog`, so a game that logs in a loop before `init` cannot grow it forever. */
const BACKLOG_MAX = 64;

let sink: LogSink | null = null;

/** A global object that may be missing the things QuickJS does not ship. */
interface MutableGlobal {
  console?: unknown;
  TextEncoder?: unknown;
  TextDecoder?: unknown;
  performance?: { now?: () => number };
}

const g = globalThis as unknown as MutableGlobal;

/**
 * Encode a JavaScript string as UTF-8 without `TextEncoder`.
 *
 * @param s The string to encode.
 * @returns A freshly allocated UTF-8 byte array.
 */
export function utf8Encode(s: string): Uint8Array {
  // Two passes: measure, then fill. One allocation, no intermediate array.
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        n += 4;
        i += 1;
      } else n += 3;
    } else n += 3;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < s.length; i += 1) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i += 1;
      }
    }
    if (c < 0x80) {
      out[o] = c;
      o += 1;
    } else if (c < 0x800) {
      out[o] = 0xc0 | (c >> 6);
      out[o + 1] = 0x80 | (c & 63);
      o += 2;
    } else if (c < 0x10000) {
      out[o] = 0xe0 | (c >> 12);
      out[o + 1] = 0x80 | ((c >> 6) & 63);
      out[o + 2] = 0x80 | (c & 63);
      o += 3;
    } else {
      out[o] = 0xf0 | (c >> 18);
      out[o + 1] = 0x80 | ((c >> 12) & 63);
      out[o + 2] = 0x80 | ((c >> 6) & 63);
      out[o + 3] = 0x80 | (c & 63);
      o += 4;
    }
  }
  return out;
}

/**
 * Decode UTF-8 bytes without `TextDecoder`.
 *
 * @param b The bytes. Any `ArrayLike<number>` works, including the plain
 *   `Array` jco hands the guest.
 * @param start First byte to read.
 * @param end One past the last byte to read; defaults to `b.length`.
 * @returns The decoded string.
 */
export function utf8Decode(b: ArrayLike<number>, start = 0, end?: number): string {
  const stop = end ?? b.length;
  let s = '';
  let i = start;
  while (i < stop) {
    const c = b[i] ?? 0;
    if (c < 0x80) {
      s += String.fromCharCode(c);
      i += 1;
    } else if (c < 0xe0) {
      s += String.fromCharCode(((c & 31) << 6) | ((b[i + 1] ?? 0) & 63));
      i += 2;
    } else if (c < 0xf0) {
      s += String.fromCharCode(
        ((c & 15) << 12) | (((b[i + 1] ?? 0) & 63) << 6) | ((b[i + 2] ?? 0) & 63),
      );
      i += 3;
    } else {
      const cp =
        ((c & 7) << 18) |
        (((b[i + 1] ?? 0) & 63) << 12) |
        (((b[i + 2] ?? 0) & 63) << 6) |
        ((b[i + 3] ?? 0) & 63);
      const v = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 1023));
      i += 4;
    }
  }
  return s;
}

/**
 * Point prelude `console` at the host logger.
 *
 * The runtime calls this at the top of `init`. Any lines buffered before then
 * are flushed in order, so module-scope logging is not silently lost.
 *
 * @param next The sink, or `null` to go back to buffering.
 * @returns Nothing.
 */
export function setLogSink(next: LogSink | null): void {
  sink = next;
  if (!next) return;
  for (const entry of backlog) next(entry.level, entry.msg);
  backlog.length = 0;
}

/**
 * Format console arguments the way a browser would, without `JSON.stringify`
 * throwing on cycles.
 *
 * @param args The console arguments.
 * @returns One flat line.
 */
function format(args: readonly unknown[]): string {
  let out = '';
  for (let i = 0; i < args.length; i += 1) {
    if (i > 0) out += ' ';
    const a = args[i];
    if (typeof a === 'string') out += a;
    else if (a instanceof Error) out += `${a.name}: ${a.message}`;
    else {
      try {
        // `JSON.stringify` returns undefined for undefined and for functions,
        // whatever the lib types say.
        const json: unknown = JSON.stringify(a);
        out += typeof json === 'string' ? json : String(a);
      } catch {
        out += String(a);
      }
    }
  }
  return out;
}

/**
 * Emit one console line.
 *
 * @param level Severity.
 * @param args Console arguments.
 * @returns Nothing.
 */
function emit(level: LogLevel, args: readonly unknown[]): void {
  const msg = format(args);
  if (sink) {
    sink(level, msg);
    return;
  }
  if (backlog.length < BACKLOG_MAX) backlog.push({ level, msg });
}

/** The message `Math.random` throws with before the runtime is seeded. */
const RANDOM_MESSAGE =
  'Math.random() is not available in an gameable guest: QuickJS seeds it ' +
  'identically on every run because Wizer snapshots the heap at build time. ' +
  'Use the seeded SDK generator instead — `rng.float()`, `rng.int(n)`, ' +
  '`rng.pick(xs)` from @gameable/sdk, or `ctx.rng` inside a system.';

let randomFn: (() => number) | null = null;

/**
 * True when this realm looks like the QuickJS component guest rather than V8.
 *
 * Decided once, before anything is polyfilled: a realm with neither `console`
 * nor `TextEncoder` is componentize-qjs. It is the only realm whose
 * `Math.random` the prelude is allowed to replace — patching the global in V8
 * would reach vitest, Vite and the host application too.
 */
export const IS_COMPONENT_GUEST =
  typeof g.console === 'undefined' && typeof g.TextEncoder === 'undefined';

/**
 * Route `Math.random` at the seeded SDK generator.
 *
 * The runtime calls this from `init`. Until then `Math.random()` throws with
 * `RANDOM_MESSAGE`, which is far kinder than a game that silently replays the
 * same "random" sequence on every instantiation.
 *
 * Only effective in the component guest; see `IS_COMPONENT_GUEST`.
 *
 * @param next The seeded generator, or `null` to re-arm the guard.
 * @returns Nothing.
 */
export function setRandomSource(next: (() => number) | null): void {
  randomFn = next;
}

/** Installs everything. Runs once, on first import. */
function install(): void {
  if (typeof g.console === 'undefined') {
    g.console = {
      log: (...args: unknown[]) => {
        emit('info', args);
      },
      info: (...args: unknown[]) => {
        emit('info', args);
      },
      debug: (...args: unknown[]) => {
        emit('debug', args);
      },
      trace: (...args: unknown[]) => {
        emit('trace', args);
      },
      warn: (...args: unknown[]) => {
        emit('warn', args);
      },
      error: (...args: unknown[]) => {
        emit('error', args);
      },
    };
  }

  if (typeof g.TextEncoder === 'undefined') {
    g.TextEncoder = class {
      readonly encoding = 'utf-8';
      encode(input = ''): Uint8Array {
        return utf8Encode(input);
      }
    };
  }

  if (typeof g.TextDecoder === 'undefined') {
    g.TextDecoder = class {
      readonly encoding = 'utf-8';
      decode(input?: ArrayLike<number> | ArrayBufferLike): string {
        if (input === undefined) return '';
        const bytes =
          typeof (input as ArrayLike<number>).length === 'number'
            ? (input as ArrayLike<number>)
            : new Uint8Array(input as ArrayBufferLike);
        return utf8Decode(bytes);
      }
    };
  }

  if (typeof g.performance === 'undefined') {
    const origin = Date.now();
    g.performance = { now: () => Date.now() - origin };
  } else if (typeof g.performance.now !== 'function') {
    const origin = Date.now();
    g.performance.now = () => Date.now() - origin;
  }

  if (IS_COMPONENT_GUEST) {
    Math.random = (): number => {
      if (randomFn) return randomFn();
      throw new Error(RANDOM_MESSAGE);
    };
  }
}

install();
