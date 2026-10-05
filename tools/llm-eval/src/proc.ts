/**
 * Running other people's programs.
 *
 * Everything is spawned with array arguments and no shell, and every path is
 * absolute and forward-slashed, for the same reason the rest of the repository
 * does it: a Windows path in a shell-string pipeline is a bug waiting for a
 * space in a directory name.
 */
import { spawn } from 'node:child_process';

/** What a finished child process left behind. */
export interface RunResult {
  /** Exit code, or -1 when the process was killed or never started. */
  readonly status: number;
  /** stdout and stderr interleaved, capped. */
  readonly output: string;
  /** How long it took. */
  readonly durationMs: number;
  /** Set when the run hit its timeout. */
  readonly timedOut: boolean;
}

/** How to run something. */
export interface RunOptions {
  /** Working directory. Absolute. */
  readonly cwd: string;
  /** Extra environment on top of the parent's. */
  readonly env?: Readonly<Record<string, string>>;
  /** Kill after this many ms. Default 10 minutes. */
  readonly timeoutMs?: number;
  /** Keep at most this many characters of output. Default 20000, from the end. */
  readonly maxOutput?: number;
}

/**
 * Run a command to completion.
 *
 * Never throws on a non-zero exit: a failing typecheck is data, not an
 * exception. Only a process that could not be started rejects.
 *
 * @param command The executable, normally `process.execPath`.
 * @param args Arguments, as an array.
 * @param options Where and how.
 * @returns The exit code, the captured output and the elapsed time.
 */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxOutput = options.maxOutput ?? 20_000;

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
    });

    let buffer = '';
    let timedOut = false;
    /**
     * Append a chunk, keeping only the tail.
     *
     * @param chunk Bytes from the child.
     * @returns Nothing.
     */
    const append = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      if (buffer.length > maxOutput * 2) buffer = buffer.slice(-maxOutput);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: code ?? -1,
        output: buffer.length > maxOutput ? `…${buffer.slice(-maxOutput)}` : buffer,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}

/**
 * Forward slashes, always.
 *
 * @param p Any path.
 * @returns The same path with `\` replaced.
 */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}
