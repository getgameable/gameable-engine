/**
 * The two child processes the scaffolder runs: `git init` and `npm install`.
 *
 * Array arguments, no shell. npm is reached through its own `npm-cli.js`
 * because on Windows `npm` is a `.cmd` shim and node will not spawn one without
 * a shell.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** What a finished child process produced. */
export interface RunResult {
  /** Exit status. `null` becomes `-1`. */
  readonly status: number;
  /** Everything written to stderr, when it was captured. */
  readonly stderr: string;
}

/**
 * Spawn a process and wait for it.
 *
 * @param file Executable, or a node script when `file` is `process.execPath`.
 * @param args Arguments, already split.
 * @param cwd Working directory.
 * @param inherit Hand the child this process's stdio.
 * @returns The exit status.
 */
export async function run(
  file: string,
  args: readonly string[],
  cwd: string,
  inherit = false,
): Promise<RunResult> {
  return new Promise<RunResult>((settle) => {
    const child = spawn(file, [...args], {
      cwd,
      stdio: inherit ? 'inherit' : ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err: Error) => {
      settle({ status: -1, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      settle({ status: code ?? -1, stderr });
    });
  });
}

/**
 * Locate npm's own JavaScript entry point.
 *
 * @returns The absolute path, or `undefined` when npm cannot be found.
 */
export function findNpmCli(): string | undefined {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv !== undefined && fromEnv.endsWith('.js') && existsSync(fromEnv)) {
    return fromEnv.replaceAll('\\', '/');
  }
  const nodeDir = dirname(process.execPath).replaceAll('\\', '/');
  for (const candidate of [
    `${nodeDir}/node_modules/npm/bin/npm-cli.js`,
    `${nodeDir}/../lib/node_modules/npm/bin/npm-cli.js`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
