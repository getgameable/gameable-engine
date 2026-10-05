/**
 * Child-process helpers.
 *
 * Every call uses `spawn` with an **array** of arguments and no shell. A shell
 * string would need quoting, and quoting a Windows path that contains a space
 * is exactly the class of bug this repository keeps running into. Where a tool
 * is a node script — jco, tsc, vite, wasm-opt, npm — it is launched as
 * `process.execPath <script> …`, which sidesteps `.cmd` shims entirely.
 */
import { spawn } from 'node:child_process';

import { stripAnsi } from './colors.js';

/** How to run a child process. */
export interface RunOptions {
  /** Working directory. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Extra environment variables, merged over `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Pipe output to this process as it arrives, as well as capturing it. */
  readonly inherit?: boolean;
  /** Transform each captured chunk before it is echoed. */
  readonly filter?: (text: string) => string;
  /**
   * Hand the child this process's own stdio. Used for the dev server, which
   * owns the terminal until Ctrl-C. Nothing is captured in this mode.
   */
  readonly interactive?: boolean;
}

/** What a finished child process produced. */
export interface RunResult {
  /** Exit status. `null` becomes `-1`. */
  readonly status: number;
  /** Everything written to stdout. */
  readonly stdout: string;
  /** Everything written to stderr. */
  readonly stderr: string;
}

/** The subset of {@link run} the doctor needs, so tests can fake it. */
export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

/**
 * Spawn a process and wait for it.
 *
 * @param file Executable, or a node script when `file` is `process.execPath`.
 * @param args Arguments, already split.
 * @param options Working directory, environment and echo behaviour.
 * @returns The exit status and captured output.
 */
export async function run(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise<RunResult>((settle) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: options.interactive === true ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    if (options.interactive === true) {
      child.on('error', (err: Error) => {
        settle({ status: -1, stdout: '', stderr: err.message });
      });
      child.on('close', (code) => {
        settle({ status: code ?? -1, stdout: '', stderr: '' });
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    const echo = options.inherit ?? false;
    const filter = options.filter;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (echo) {
        const text = filter ? filter(chunk) : chunk;
        if (text.length > 0) process.stdout.write(text);
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (echo) {
        const text = filter ? filter(chunk) : chunk;
        if (text.length > 0) process.stderr.write(text);
      }
    });

    child.on('error', (err: Error) => {
      settle({ status: -1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      settle({ status: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Run a node script.
 *
 * @param script Absolute path to the script.
 * @param args Arguments for the script.
 * @param options Working directory, environment and echo behaviour.
 * @returns The exit status and captured output.
 */
export async function runNode(
  script: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return run(process.execPath, [script, ...args], options);
}

/**
 * Drop `jco componentize`'s expected `UNRESOLVED_IMPORT` diagnostics.
 *
 * componentize bundles with rolldown before it links the component, so the
 * versioned `gameable:engine/*@0.2.0` specifiers genuinely are unresolvable at that
 * point — componentize supplies them itself afterwards. The warnings are red,
 * multi-line and frightening, and they are noise every single time.
 *
 * A block runs from the `[UNRESOLVED_IMPORT]` line to the closing box rule,
 * plus the blank line after it.
 *
 * @param text Raw child-process output.
 * @returns The same output with those blocks removed.
 */
export function filterJcoNoise(text: string): string {
  const lines = stripAnsi(text).split('\n');
  const kept: string[] = [];
  let inBlock = false;
  let swallowBlank = false;

  for (const line of lines) {
    if (inBlock) {
      if (/^\s*[─┄┈]+[╯┘]\s*$/.test(line)) {
        inBlock = false;
        swallowBlank = true;
      }
      continue;
    }
    if (line.includes('[UNRESOLVED_IMPORT]')) {
      inBlock = true;
      swallowBlank = false;
      continue;
    }
    if (swallowBlank) {
      swallowBlank = false;
      if (line.trim() === '') continue;
    }
    kept.push(line);
  }

  return kept.join('\n');
}
