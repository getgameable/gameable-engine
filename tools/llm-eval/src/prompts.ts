/**
 * The task set: what we ask a model to do, and how we tell whether it did it.
 *
 * Every prompt is a JSON file in `src/prompts/`, because the set is data. A
 * prompt is a realistic change request against a freshly scaffolded game — the
 * kind of sentence somebody types into an editor — plus the grep-style
 * assertions that separate "it built" from "it built and does the thing".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Which scaffold the task is written against. */
export type TemplateName = 'fps' | 'third-person';

/** Which scoring stage a prompt may opt out of. */
export type StageName = 'typecheck' | 'unit' | 'build' | 'e2e' | 'checks';

/** One grep-style assertion against the files the model wrote. */
export interface Check {
  /**
   * The file to search, relative to the game directory, or `*` for the
   * concatenation of every file the model wrote.
   */
  readonly file: string;
  /** A JavaScript regular expression source. */
  readonly pattern: string;
  /** Regex flags. Default `i`. */
  readonly flags?: string;
  /** `present` (default) or `absent`. */
  readonly mode?: 'present' | 'absent';
  /** Require at least this many matches. Default 1, and ignored when `mode` is `absent`. */
  readonly minCount?: number;
  /** What the assertion is really testing, printed when it fails. */
  readonly note?: string;
}

/** One task. */
export interface TaskPrompt {
  /** Stable id; names the transcript and keys the fake client's script. */
  readonly id: string;
  /** One line for the scoreboard. */
  readonly title: string;
  /** What the model is asked to do. */
  readonly prompt: string;
  /** Which template to scaffold. */
  readonly template: TemplateName;
  /** Files a correct answer plausibly writes. Advisory: recorded, never fatal on its own. */
  readonly expectedFiles: readonly string[];
  /** Assertions on the produced files. */
  readonly checks: readonly Check[];
  /** Set when the task needs a template that does not exist yet; the runner skips it. */
  readonly skipUntilTemplate?: boolean;
  /** Empty `src/` before asking, so the model writes the game from the bundle alone. */
  readonly scaffoldEmpty?: boolean;
  /** Stages this task does not get scored on, with a reason in {@link TaskPrompt.skipReason}. */
  readonly skipStages?: readonly StageName[];
  /** Why {@link TaskPrompt.skipStages} is set. */
  readonly skipReason?: string;
}

/** Where the JSON lives. */
const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'prompts');

/**
 * Load every prompt, validated and sorted by id.
 *
 * @param dir Override the prompt directory (tests use this).
 * @returns The whole task set.
 */
export function loadPrompts(dir: string = PROMPT_DIR): TaskPrompt[] {
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  const prompts = files.map((name) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    return validatePrompt(raw, name);
  });
  const seen = new Set<string>();
  for (const prompt of prompts) {
    if (seen.has(prompt.id)) throw new Error(`duplicate prompt id: ${prompt.id}`);
    seen.add(prompt.id);
  }
  return prompts.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Check one parsed JSON file has the shape of a prompt.
 *
 * @param raw The parsed JSON.
 * @param file The file name, for the error message.
 * @returns The same object, typed.
 */
export function validatePrompt(raw: unknown, file: string): TaskPrompt {
  const p = raw as Partial<TaskPrompt>;
  const fail = (what: string): never => {
    throw new Error(`${file}: ${what}`);
  };
  if (typeof p.id !== 'string' || p.id === '') fail('needs a non-empty string id');
  if (typeof p.title !== 'string' || p.title === '') fail('needs a title');
  if (typeof p.prompt !== 'string' || p.prompt === '') fail('needs a prompt');
  if (p.template !== 'fps' && p.template !== 'third-person') {
    fail('template must be "fps" or "third-person"');
  }
  if (!Array.isArray(p.expectedFiles)) fail('expectedFiles must be an array');
  if (!Array.isArray(p.checks)) fail('checks must be an array');
  for (const check of p.checks ?? []) {
    if (typeof check.file !== 'string' || typeof check.pattern !== 'string') {
      fail('every check needs a file and a pattern');
    }
    try {
      new RegExp(check.pattern, check.flags ?? 'i');
    } catch {
      fail(`check pattern is not a valid regular expression: ${check.pattern}`);
    }
  }
  return p as TaskPrompt;
}

/**
 * Select prompts by a `--prompts` value.
 *
 * @param all Everything {@link loadPrompts} returned.
 * @param selector `all`, a template name, or a comma-separated list of ids.
 * @returns The chosen prompts, in id order.
 */
export function selectPrompts(all: readonly TaskPrompt[], selector: string): TaskPrompt[] {
  const trimmed = selector.trim();
  if (trimmed === '' || trimmed === 'all') return [...all];
  if (trimmed === 'fps' || trimmed === 'third-person') {
    return all.filter((p) => p.template === trimmed);
  }
  const wanted = new Set(
    trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  );
  const chosen = all.filter((p) => wanted.has(p.id));
  const missing = [...wanted].filter((id) => !chosen.some((p) => p.id === id));
  if (missing.length > 0) {
    throw new Error(`no prompt with id: ${missing.join(', ')}. Try --prompts all.`);
  }
  return chosen;
}

/** Result of running one {@link Check}. */
export interface CheckResult {
  /** The assertion that ran. */
  readonly check: Check;
  /** Whether it held. */
  readonly ok: boolean;
  /** How many matches were found. */
  readonly matches: number;
  /** Why it failed, when it did. */
  readonly detail?: string;
}

/**
 * Run a prompt's checks against the files the model actually wrote.
 *
 * @param checks The assertions.
 * @param written Path to contents, for every file that was written.
 * @returns One result per check, in order.
 */
export function runChecks(
  checks: readonly Check[],
  written: ReadonlyMap<string, string>,
): CheckResult[] {
  const everything = [...written.values()].join('\n');
  return checks.map((check): CheckResult => {
    const haystack = check.file === '*' ? everything : written.get(check.file);
    if (haystack === undefined) {
      return {
        check,
        ok: false,
        matches: 0,
        detail: `${check.file} was not written`,
      };
    }
    const flags = check.flags ?? 'i';
    const re = new RegExp(check.pattern, flags.includes('g') ? flags : `${flags}g`);
    const matches = [...haystack.matchAll(re)].length;
    if (check.mode === 'absent') {
      return {
        check,
        ok: matches === 0,
        matches,
        detail: matches === 0 ? undefined : `expected no match for /${check.pattern}/`,
      };
    }
    const need = check.minCount ?? 1;
    return {
      check,
      ok: matches >= need,
      matches,
      detail:
        matches >= need
          ? undefined
          : `expected >= ${String(need)} match(es) of /${check.pattern}/ in ${check.file}, found ${String(matches)}`,
    };
  });
}
