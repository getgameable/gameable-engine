/**
 * Turning a red scoreboard into a list of things to change.
 *
 * ```sh
 * node tools/llm-eval/src/triage.ts                       # the most recent run
 * node tools/llm-eval/src/triage.ts results/2026-….json   # a specific one
 * ```
 *
 * A pass rate is a number. What milestone M6 actually asks for is the next
 * commit, and there are only two kinds:
 *
 * - **doc fix** — the API exists and works, and the bundle never showed it.
 *   The model could not have known. Fix the documentation.
 * - **API simplification** — several models independently reached for the
 *   same symbol that does not exist. That is the shape the API should have
 *   had. Fix the engine, not the prose.
 *
 * The signal that separates them is cheap: diff every identifier the model
 * imported from `gameable` against what that package actually exports,
 * and cross-reference both against the bundle the model was given.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundlePathFor } from './request.ts';
import type { RunReport } from './score.ts';
import { findRepoRoot } from './workspace.ts';

/** One actionable suggestion. */
export interface Suggestion {
  /** Which kind of change this is. */
  readonly kind: 'doc fix' | 'API simplification';
  /** The identifier or topic the suggestion is about. */
  readonly subject: string;
  /** Prompt ids that ran into it. */
  readonly prompts: readonly string[];
  /** What to do. */
  readonly action: string;
  /** Where to do it. */
  readonly where: string;
}

/**
 * Every name `packages/sdk/src/index.ts` exports.
 *
 * Parsed rather than imported: the SDK resolves through the `gameable-source`
 * export condition and pulls in bitecs, and the triage tool has no business
 * loading an engine package to read a list of names.
 *
 * @param repoRoot The engine checkout.
 * @returns The exported identifiers, values and types alike.
 */
export function sdkExports(repoRoot: string): Set<string> {
  const source = readFileSync(`${repoRoot}/packages/sdk/src/index.ts`, 'utf8');
  const names = new Set<string>();

  // `export { a, b as c } from './x'` and `export type { … }`.
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of (match[1] ?? '').split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name !== undefined && name !== '') names.add(name);
    }
  }
  // `export const X`, `export function X`, `export class X`, `export type X =`.
  for (const match of source.matchAll(
    /export\s+(?:declare\s+)?(?:const|let|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/**
 * Identifiers a file imports from `gameable`.
 *
 * @param source A TypeScript file the model wrote.
 * @returns The imported names.
 */
export function sdkImports(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@gameable\/sdk['"]/g,
  )) {
    for (const raw of (match[1] ?? '').split(',')) {
      const name = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name !== undefined && name !== '') names.push(name);
    }
  }
  return names;
}

/**
 * Symbols the compiler said do not exist.
 *
 * More reliable than reading the source, because it catches property access on
 * a facade (`ctx.physics.sweep`) as well as a bad import.
 *
 * @param detail The captured `tsc` output.
 * @returns The names the compiler complained about.
 */
export function missingSymbolsFromTsc(detail: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /has no exported member(?: named)? '([^']+)'/g,
    /Property '([^']+)' does not exist on type/g,
    /Cannot find name '([^']+)'/g,
  ];
  for (const pattern of patterns) {
    for (const match of detail.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names];
}

/** One `# FILE:` section of a generated bundle. */
export interface BundleSection {
  /** The repo-relative source path the generator recorded. */
  readonly file: string;
  /** Its text. */
  readonly text: string;
}

/**
 * Split a generated bundle back into the documents it was made from.
 *
 * @param bundle The contents of `llms-fps.txt` or similar.
 * @returns One entry per source file, in bundle order.
 */
export function splitBundle(bundle: string): BundleSection[] {
  const sections: BundleSection[] = [];
  const parts = bundle.split(/^# FILE: (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    sections.push({ file: (parts[i] ?? '').trim(), text: parts[i + 1] ?? '' });
  }
  return sections;
}

/**
 * Which document in the bundle was supposed to teach this task.
 *
 * Scored by how many of the task's distinctive words a section contains. It is
 * a heuristic and says so: the point is to put a filename next to a failure so
 * somebody can go and look, not to be right every time.
 *
 * @param sections The bundle, split.
 * @param text The prompt title and body.
 * @returns The best-matching source file, or undefined when nothing matched.
 */
export function citedDoc(sections: readonly BundleSection[], text: string): string | undefined {
  const words = [...new Set(text.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? [])].filter(
    (word) => !STOPWORDS.has(word),
  );
  if (words.length === 0) return undefined;
  let best: { file: string; score: number } | undefined;
  for (const section of sections) {
    const haystack = section.text.toLowerCase();
    let score = 0;
    for (const word of words) if (haystack.includes(word)) score += 1;
    if (best === undefined || score > best.score) best = { file: section.file, score };
  }
  return best !== undefined && best.score >= 3 ? best.file : undefined;
}

/** Words too common in this repository to carry signal. */
const STOPWORDS = new Set([
  'should',
  'which',
  'their',
  'there',
  'where',
  'while',
  'these',
  'those',
  'other',
  'every',
  'after',
  'about',
  'rather',
  'instead',
  'existing',
  'change',
  'changed',
  'without',
  'because',
  'through',
  'already',
  'player',
  'game',
  'games',
]);

/**
 * Read back the files a prompt's transcript recorded.
 *
 * @param transcriptDir The prompt's transcript directory.
 * @returns Path to contents for every file the model wrote.
 */
export function readTranscriptFiles(transcriptDir: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(transcriptDir)) return files;
  for (const name of readdirSync(transcriptDir)) {
    if (name === 'system.md' || name === 'user.md' || name === 'response.md') continue;
    files.set(name.replaceAll('__', '/'), readFileSync(join(transcriptDir, name), 'utf8'));
  }
  return files;
}

/**
 * Work out what to change.
 *
 * @param report A run report.
 * @param repoRoot The engine checkout.
 * @param toolRoot `tools/llm-eval`, which the transcript paths are relative to.
 * @returns Suggestions, worst first.
 */
export function triage(report: RunReport, repoRoot: string, toolRoot: string): Suggestion[] {
  const exports = sdkExports(repoRoot);
  const bundles = new Map<string, BundleSection[]>();
  /**
   * The bundle a prompt's template was given, split into documents.
   *
   * @param template The template name.
   * @returns Its sections, cached.
   */
  const sectionsFor = (template: string): BundleSection[] => {
    let sections = bundles.get(template);
    if (sections === undefined) {
      const path = bundlePathFor(repoRoot, template);
      sections = existsSync(path) ? splitBundle(readFileSync(path, 'utf8')) : [];
      bundles.set(template, sections);
    }
    return sections;
  };

  /** Invented identifier to the prompts that reached for it. */
  const invented = new Map<string, Set<string>>();
  /** Real identifier that the bundle never mentions, to the prompts that needed it. */
  const undocumented = new Map<string, Set<string>>();
  /** Prompt id to the document that should have taught it. */
  const docGaps: { prompt: string; doc: string; why: string }[] = [];

  for (const result of report.results) {
    if (result.pass) continue;
    const sections = sectionsFor(report.template.substituteFor ?? report.template.name);
    const bundleText = sections.map((s) => s.text).join('\n');
    const written = readTranscriptFiles(resolve(toolRoot, result.transcript));
    const fromFiles = [...written.values()].flatMap((source) => sdkImports(source));
    const fromCompiler = missingSymbolsFromTsc(result.stages.typecheck.detail ?? '');
    const names = [...new Set([...fromFiles, ...fromCompiler])];

    for (const name of names) {
      if (!exports.has(name)) {
        // Only count names the compiler or the SDK boundary actually rejected;
        // a local helper the model defined is not an invented engine API.
        if (fromCompiler.includes(name) || fromFiles.includes(name)) {
          add(invented, name, result.id);
        }
        continue;
      }
      if (!bundleText.includes(name)) add(undocumented, name, result.id);
    }

    if (result.failure === 'checks' || result.failure === 'unit') {
      const doc = citedDoc(sections, `${result.title} ${result.id}`);
      if (doc !== undefined) {
        docGaps.push({
          prompt: result.id,
          doc,
          why:
            result.failure === 'checks'
              ? 'it built and ran but did not do what was asked'
              : "it compiled but broke the game's own rules",
        });
      }
    }
  }

  const suggestions: Suggestion[] = [];

  for (const [name, prompts] of invented) {
    const many = prompts.size >= 2;
    suggestions.push({
      kind: many ? 'API simplification' : 'doc fix',
      subject: name,
      prompts: [...prompts].sort(),
      action: many
        ? `${String(prompts.size)} prompts independently reached for \`${name}\`, which does not exist. That is the shape the SDK is expected to have; consider adding it, or renaming what it collides with.`
        : `\`${name}\` does not exist. One prompt invented it, which usually means the documentation does not show the real way to do that.`,
      where: many ? 'packages/sdk/src/index.ts' : 'docs/recipes/',
    });
  }

  for (const [name, prompts] of undocumented) {
    suggestions.push({
      kind: 'doc fix',
      subject: name,
      prompts: [...prompts].sort(),
      action: `\`${name}\` is exported by gameable but never appears in the bundle the model was given. Add it to a recipe or to the SDK README so it reaches \`llms-${report.template.name}.txt\`.`,
      where: 'packages/sdk/README.md or docs/recipes/',
    });
  }

  for (const gap of docGaps) {
    suggestions.push({
      kind: 'doc fix',
      subject: gap.prompt,
      prompts: [gap.prompt],
      action: `${gap.why}. The document in the bundle closest to this task is \`${gap.doc}\`; re-read it as the model would.`,
      where: gap.doc,
    });
  }

  return suggestions.sort((a, b) => b.prompts.length - a.prompts.length);
}

/**
 * Append to a map of sets.
 *
 * @param map The map.
 * @param key The key.
 * @param value The value to add.
 * @returns Nothing.
 */
function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

/**
 * Render suggestions for a terminal.
 *
 * @param report The run.
 * @param suggestions What {@link triage} returned.
 * @returns Printable text.
 */
export function renderTriage(report: RunReport, suggestions: readonly Suggestion[]): string {
  const lines: string[] = [];
  const failures = report.results.filter((r) => !r.pass);
  lines.push(`triage — ${report.model} (${report.provider}), ${report.finishedAt}`);
  lines.push(
    `  ${String(failures.length)} failure(s) of ${String(report.summary.attempted)}: ` +
      Object.entries(report.summary.buckets)
        .map(([bucket, count]) => `${bucket}=${String(count)}`)
        .join(' '),
  );
  lines.push('');

  for (const kind of ['API simplification', 'doc fix'] as const) {
    const group = suggestions.filter((s) => s.kind === kind);
    lines.push(`${kind.toUpperCase()} candidates (${String(group.length)})`);
    if (group.length === 0) {
      lines.push('  none');
    }
    for (const suggestion of group) {
      lines.push(`  ${suggestion.subject}  [${suggestion.prompts.join(', ')}]`);
      lines.push(`    ${suggestion.action}`);
      lines.push(`    where: ${suggestion.where}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The most recently written run report in a directory.
 *
 * @param dir The results directory.
 * @returns An absolute path, or undefined when there is none.
 */
export function latestReport(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const last = files.at(-1);
  return last === undefined ? undefined : join(dir, last);
}

/**
 * Command-line entry point.
 *
 * @param argv Arguments after the executable and script.
 * @returns A process exit code.
 */
export function main(argv: readonly string[]): number {
  const repoRoot = findRepoRoot();
  const here = fileURLToPath(new URL('..', import.meta.url))
    .replaceAll('\\', '/')
    .replace(/\/$/, '');
  const resultsDir = `${here}/results`;
  const path = argv[0] ?? latestReport(resultsDir);
  if (path === undefined) {
    console.error(`no run report found in ${resultsDir}. Run the eval first.`);
    return 1;
  }
  const report = JSON.parse(readFileSync(path, 'utf8')) as RunReport;
  console.log(renderTriage(report, triage(report, repoRoot, here)));
  return 0;
}

/** True when this module was run, rather than imported by a test. */
const RUN_DIRECTLY =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_DIRECTLY) process.exitCode = main(process.argv.slice(2));
