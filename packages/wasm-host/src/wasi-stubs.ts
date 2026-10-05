/**
 * The minimum WASI a componentize-qjs guest actually needs.
 *
 * A QuickJS component imports 18 `wasi:*` interfaces, but only two functions
 * are ever called: `wasi:clocks/monotonic-clock#now` (behind `performance.now`)
 * and `wasi:clocks/wall-clock#now` (behind `Date.now`). Everything else exists
 * to satisfy the import object. The one exception is the stderr
 * `OutputStream`, which QuickJS writes trap messages to — it needs a real
 * write path or a trap is invisible.
 *
 * We deliberately do **not** use `@bytecodealliance/preview2-shim`: it drags in
 * node built-ins, is far larger than this file, and would not run in a browser.
 */

/** Where stub stderr goes. Replaced by `minimalWasi({ stderr })`. */
export type StderrSink = (bytes: Uint8Array) => void;

/**
 * The default stderr sink: `console.error`, decoded as UTF-8.
 *
 * @param bytes The bytes the guest wrote.
 * @returns Nothing.
 */
function defaultStderr(bytes: Uint8Array): void {
  const text = new TextDecoder().decode(bytes).replace(/\n$/, '');
  if (text.length > 0) console.error(`[guest stderr] ${text}`);
}

/**
 * Build a stub that throws when called, so an unexpected WASI dependency is
 * loud rather than silent.
 *
 * @param name The interface and function being stubbed.
 * @returns A function that always throws.
 */
function trap(name: string): () => never {
  return () => {
    throw new Error(`WASI ${name} was called; gameable guests are not expected to need it`);
  };
}

/** Options for `minimalWasi`. */
export interface MinimalWasiOptions {
  /** Where the guest's stderr goes. Default: `console.error`. */
  stderr?: StderrSink;
  /** Monotonic nanoseconds. Default: `performance.now()`. */
  monotonicNs?: () => bigint;
}

/**
 * Build the `wasi:*` half of the import object.
 *
 * @param options Stderr sink and clock overrides.
 * @returns An object keyed by unversioned WASI interface name.
 *
 * @example
 * ```ts
 * import { minimalWasi } from 'gameable/host';
 *
 * const imports = { ...minimalWasi(), ...hostBindings(host) };
 * ```
 */
export function minimalWasi(options: MinimalWasiOptions = {}): Record<string, unknown> {
  const stderr = options.stderr ?? defaultStderr;
  const monotonicNs =
    options.monotonicNs ?? (() => BigInt(Math.round(performance.now() * 1_000_000)));

  class Pollable {
    block(): void {
      /* nothing to wait for */
    }
    ready(): boolean {
      return true;
    }
  }

  // jco keys its resource tables by constructor identity, so these empty
  // classes are the whole implementation. They are never instantiated by us.
  /* eslint-disable @typescript-eslint/no-extraneous-class */
  class InputStream {}

  class OutputStream {
    checkWrite(): bigint {
      return 4096n;
    }
    write(bytes: Uint8Array): void {
      stderr(bytes);
    }
    blockingWrite(bytes: Uint8Array): void {
      stderr(bytes);
    }
    blockingWriteAndFlush(bytes: Uint8Array): void {
      stderr(bytes);
    }
    flush(): void {
      /* nothing is buffered */
    }
    blockingFlush(): void {
      /* nothing is buffered */
    }
    subscribe(): Pollable {
      return new Pollable();
    }
    splice(): bigint {
      return 0n;
    }
    blockingSplice(): bigint {
      return 0n;
    }
    writeZeroes(): void {
      /* nothing is buffered */
    }
    blockingWriteZeroesAndFlush(): void {
      /* nothing is buffered */
    }
  }

  class IoError {
    toDebugString(): string {
      return 'io-error';
    }
  }

  class Descriptor {}
  class TerminalInput {}
  class TerminalOutput {}
  /* eslint-enable @typescript-eslint/no-extraneous-class */

  return {
    'wasi:cli/environment': {
      getEnvironment: () => [],
      getArguments: () => [],
      initialCwd: () => undefined,
    },
    'wasi:cli/exit': { exit: trap('cli/exit') },
    'wasi:cli/stderr': { getStderr: () => new OutputStream() },
    'wasi:cli/stdin': { getStdin: () => new InputStream() },
    'wasi:cli/stdout': { getStdout: () => new OutputStream() },
    'wasi:cli/terminal-input': { TerminalInput },
    'wasi:cli/terminal-output': { TerminalOutput },
    'wasi:cli/terminal-stderr': { getTerminalStderr: () => undefined },
    'wasi:cli/terminal-stdin': { getTerminalStdin: () => undefined },
    'wasi:cli/terminal-stdout': { getTerminalStdout: () => undefined },
    // The only two that ever fire.
    'wasi:clocks/monotonic-clock': {
      now: monotonicNs,
      resolution: () => 1000n,
      subscribeDuration: () => new Pollable(),
      subscribeInstant: () => new Pollable(),
    },
    'wasi:clocks/wall-clock': {
      now: () => {
        const ms = Date.now();
        return { seconds: BigInt(Math.floor(ms / 1000)), nanoseconds: (ms % 1000) * 1_000_000 };
      },
      resolution: () => ({ seconds: 0n, nanoseconds: 1_000_000 }),
    },
    'wasi:filesystem/preopens': { getDirectories: () => [] },
    'wasi:filesystem/types': { Descriptor, filesystemErrorCode: () => undefined },
    'wasi:io/error': { Error: IoError },
    'wasi:io/poll': { Pollable, poll: () => new Uint32Array([0]) },
    'wasi:io/streams': { InputStream, OutputStream },
    'wasi:random/insecure-seed': { insecureSeed: () => [0n, 0n] },
  };
}
