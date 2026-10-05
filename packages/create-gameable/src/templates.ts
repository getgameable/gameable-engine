/**
 * Finding the templates.
 *
 * When this package is published, `dist/templates/` is a copy of the
 * repository's own `templates/` made by `scripts/sync-templates.mjs` at
 * `prepack` time —
 * the same directories CI typechecks, lints and tests, so a template cannot
 * rot without something going red first. When the scaffolder runs from inside
 * a checkout, the authored directories are used directly.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { findRepoRoot, packageDirOf } from './paths.js';
import { normaliseManifest, type TemplateManifest } from './tokens.js';

/** One template, located on disk. */
export interface Template {
  /** Directory name, which is also what `--template` takes. */
  readonly name: string;
  /** Absolute, forward-slashed directory. */
  readonly dir: string;
  /** The template's own declaration, with defaults filled in. */
  readonly manifest: TemplateManifest;
  /** True for a multiplayer kit: its `src/game.ts` declares `features.multiplayer`. */
  readonly multiplayer: boolean;
}

/**
 * Every directory that might hold templates, best first.
 *
 * @param cwd Where the command was run.
 * @returns Absolute, forward-slashed candidate directories.
 */
export function templateRoots(cwd: string): string[] {
  const pkgDir = packageDirOf(import.meta.url);
  const repoRoot = findRepoRoot(pkgDir) ?? findRepoRoot(cwd);
  // The authored directories win inside a checkout: the bundled copy is a
  // prepack artefact and goes stale between syncs. Outside a checkout there is
  // no repository root, and the bundled copy is all there is.
  const roots = [
    process.env.GAMEABLE_TEMPLATES,
    repoRoot === undefined ? undefined : `${repoRoot}/templates`,
    `${pkgDir}/dist/templates`,
  ];
  return [...new Set(roots.filter((root): root is string => root !== undefined && root !== ''))];
}

/**
 * List every template that is actually installed.
 *
 * @param cwd Where the command was run.
 * @returns Templates, sorted by name, first root wins on a duplicate.
 */
export function listTemplates(cwd: string): Template[] {
  const seen = new Map<string, Template>();
  for (const root of templateRoots(cwd)) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (seen.has(entry.name)) continue;
      const dir = `${root}/${entry.name}`;
      if (!existsSync(`${dir}/package.json`)) continue;
      seen.set(entry.name, {
        name: entry.name,
        dir,
        manifest: readManifest(dir, entry.name),
        multiplayer: declaresMultiplayer(dir),
      });
    }
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Find one template by name.
 *
 * @param cwd Where the command was run.
 * @param name The `--template` value.
 * @returns The template, or `undefined` when it is not installed.
 */
export function findTemplate(cwd: string, name: string): Template | undefined {
  return listTemplates(cwd).find((template) => template.name === name);
}

/**
 * Read a template's `template.json`, tolerating its absence.
 *
 * @param dir Absolute template directory.
 * @param name Directory name, used as the fallback identity.
 * @returns A complete manifest.
 */
export function readManifest(dir: string, name: string): TemplateManifest {
  const path = `${dir}/template.json`;
  if (!existsSync(path)) return normaliseManifest(name, undefined);
  try {
    return normaliseManifest(name, JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return normaliseManifest(name, undefined);
  }
}

/**
 * The same rule as the engine's `packages/cli/scripts/kits.mjs`: a template is
 * a multiplayer kit when its `src/game.ts` declares `features.multiplayer`
 * (comments do not count).
 *
 * @param dir Absolute template directory.
 * @returns True for a multiplayer kit.
 */
function declaresMultiplayer(dir: string): boolean {
  const path = `${dir}/src/game.ts`;
  if (!existsSync(path)) return false;
  const code = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return /\bfeatures\s*:\s*\{[^}]*\bmultiplayer\s*:/.test(code);
}

/**
 * The chooser: one numbered line per template, its `template.json`
 * description beside it, multiplayer kits marked.
 *
 * @param templates Everything installed, in `listTemplates` order.
 * @returns The lines, without a trailing newline.
 */
export function chooserLines(templates: readonly Template[]): string[] {
  const width = templates.reduce((max, t) => Math.max(max, t.name.length), 0);
  return templates.map((t, index) => {
    const tag = t.multiplayer ? '[multiplayer] ' : '';
    return `  ${String(index + 1)}) ${t.name.padEnd(width)}  ${tag}${t.manifest.description}`.trimEnd();
  });
}
