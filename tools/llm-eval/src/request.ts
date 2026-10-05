/**
 * Assembling what the model actually sees.
 *
 * The split matters for cost as much as for accuracy:
 *
 * - **`system`** is the docs bundle plus the game's current source. It is byte
 *   identical for every prompt in a run, so one `cache_control` breakpoint
 *   turns twenty full-price reads of a 60 KB bundle into one write and
 *   nineteen reads at a tenth the price.
 * - **`user`** is the task and the output contract, and nothing else.
 *
 * The model is given the *whole* contents of every file it is likely to
 * rewrite, because the output contract asks for whole files back. Handing it
 * only `game.ts` and then asking for a complete `weapon.ts` is a test of
 * invention, not of the documentation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { OUTPUT_CONTRACT } from './fences.ts';
import type { TaskPrompt } from './prompts.ts';

/** Files the model always gets, when they exist. */
const ALWAYS: readonly string[] = ['src/game.ts', 'src/prefabs.ts'];

/** One prompt, ready to send. */
export interface BuiltRequest {
  /** Bundle plus current source. Cached. */
  readonly system: string;
  /** Task plus output contract. */
  readonly user: string;
  /** Which game files were included, in order. */
  readonly includedFiles: readonly string[];
}

/**
 * Build the two halves of a request.
 *
 * @param options The task, the docs bundle and the game directory.
 * @returns The assembled request.
 */
export function buildRequest(options: {
  readonly prompt: TaskPrompt;
  readonly bundle: string;
  readonly gameDir: string;
}): BuiltRequest {
  const { prompt, bundle, gameDir } = options;
  const wanted = [...new Set([...ALWAYS, ...prompt.expectedFiles])];
  const included: string[] = [];
  const parts: string[] = [bundle.trimEnd()];

  parts.push('');
  parts.push('# The game you are editing');
  parts.push('');
  if (prompt.scaffoldEmpty === true) {
    parts.push(
      'The game directory is empty apart from its configuration: `src/` contains no',
      'TypeScript at all. Everything the game needs, you write.',
    );
  } else {
    parts.push(
      'Below is the complete current contents of the files you are most likely to',
      'change. Anything not shown is unchanged and still there.',
    );
  }
  parts.push('');

  for (const relative of wanted) {
    const abs = join(gameDir, relative);
    if (!existsSync(abs)) continue;
    included.push(relative);
    parts.push(`## \`${relative}\``);
    parts.push('');
    parts.push(`\`\`\`${language(relative)}`);
    parts.push(readFileSync(abs, 'utf8').trimEnd());
    parts.push('```');
    parts.push('');
  }

  const user = [`task-id: ${prompt.id}`, '', prompt.prompt.trim(), '', OUTPUT_CONTRACT].join('\n');

  return { system: parts.join('\n'), user, includedFiles: included };
}

/**
 * A fence language tag for a path.
 *
 * @param path A file path.
 * @returns `ts`, `json`, or the empty string.
 */
function language(path: string): string {
  const ext = extname(path);
  if (ext === '.ts') return 'ts';
  if (ext === '.json') return 'json';
  return '';
}

/**
 * Where a template's docs bundle lives.
 *
 * These are the files `AGENTS.md` tells a model to read, and the whole point
 * of the eval is that they are all it gets.
 *
 * @param repoRoot The engine checkout.
 * @param template `fps` or `third-person`.
 * @returns An absolute path.
 */
export function bundlePathFor(repoRoot: string, template: string): string {
  return `${repoRoot}/llms-${template}.txt`;
}
