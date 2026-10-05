#!/usr/bin/env node
/**
 * Documentation linter. Independent checks, all failures reported at once:
 *
 * 1. Dead relative links across `docs/**` and every package README.
 * 2. The six mandatory README headings for every workspace package.
 * 3. The five mandatory recipe headings for every file in `docs/recipes/`.
 * 4. Every recipe's "Files you will edit" paths resolve inside a template, and
 *    every recipe is linked from `docs/recipes/index.md`.
 * 5. Code snippets: every `ts` fence in the docs and in every package README
 *    parses, and every `@gameable/*` symbol it imports really is exported.
 * 6. No `TODO(` markers left in authored documentation.
 * 7. The JSON schemas parse and declare draft 2020-12.
 * 8. `llms*.txt` freshness: regenerate into a temp directory and diff.
 * 9. Size budgets for the generated bundles, with each bundle's headroom and a
 *    warning for any with less than 5% of its budget left.
 *
 * `docs/api/` is generated (TypeDoc, gitignored) and the link check walks it, so
 * this script generates it first when it is missing. That is the same ordering
 * `.github/workflows/docs.yml` uses: `docs:api` before `docs:build`.
 *
 * Usage: `node tools/docs/lint.mjs`
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import {
  BUDGETS,
  fmt,
  generate,
  headroomWarnings,
  OUTPUTS,
  packageNames,
  ROOT,
} from './gen-llms.mjs';
import { publishLlms } from './publish-llms.mjs';

/** Headings every package README must carry, in order. */
const README_HEADINGS = [
  '## What',
  '## When to use',
  '## Install',
  '## Minimal example',
  '## API',
  '## Gotchas',
];

/** Headings every recipe must carry, in order. */
const RECIPE_HEADINGS = [
  '## Goal',
  '## Files you will edit',
  '## Steps',
  '## Verify',
  '## See also',
];

/** @type {string[]} */
const failures = [];

/**
 * Record a failure.
 *
 * @param {string} where Repo-relative path the failure belongs to.
 * @param {string} what Description of the problem.
 * @returns {void}
 */
function fail(where, what) {
  failures.push(`${where}: ${what}`);
}

/**
 * Every file under `dir` matching `re`, recursively, as repo-relative paths.
 *
 * @param {string} dir Repo-relative directory.
 * @param {RegExp} re Filename test.
 * @returns {string[]} Sorted repo-relative paths.
 */
function walk(dir, re) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel, re));
    else if (re.test(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * Markdown files whose links are checked.
 *
 * @returns {string[]} Repo-relative markdown paths.
 */
function linkedFiles() {
  return [
    ...['AGENTS.md', 'CLAUDE.md', 'README.md'].filter((f) => existsSync(join(ROOT, f))),
    ...walk('docs', /\.md$/),
    ...packageNames()
      .map((n) => `packages/${n}/README.md`)
      .filter((f) => existsSync(join(ROOT, f))),
  ];
}

/**
 * Markdown files a human wrote: everything under `docs/` except the TypeDoc
 * output, plus the package READMEs. Checks that are about authoring — prose
 * markers, snippet quality — run over these and not over generated pages.
 *
 * @returns {string[]} Repo-relative markdown paths.
 */
function authoredFiles() {
  return [
    ...['AGENTS.md', 'CLAUDE.md', 'README.md'].filter((f) => existsSync(join(ROOT, f))),
    ...walk('docs', /\.md$/).filter((f) => !f.startsWith('docs/api/')),
    ...packageNames()
      .map((n) => `packages/${n}/README.md`)
      .filter((f) => existsSync(join(ROOT, f))),
  ];
}

/**
 * Workspace template directory names, sorted.
 *
 * @returns {string[]} e.g. `['fps', 'third-person']`.
 */
function templateNames() {
  const abs = join(ROOT, 'templates');
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(abs, e.name, 'package.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * Generate `docs/api/` when it is not there. It is TypeDoc output, gitignored,
 * and the link check walks it, so a fresh clone would otherwise either skip the
 * check silently or fail on links into a directory nobody has built yet.
 *
 * @returns {void}
 */
function ensureApiDocs() {
  if (existsSync(join(ROOT, 'docs/api/index.md'))) return;
  console.log('  docs/api is missing; running `npm run docs:api` (TypeDoc)…');
  const result = spawnSync('npx', ['typedoc'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0 || !existsSync(join(ROOT, 'docs/api/index.md'))) {
    fail('docs/api', 'could not be generated; run `npm run docs:api` and read the TypeDoc output');
  }
}

/** Check 1: dead relative links. */
function checkLinks() {
  const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const file of linkedFiles()) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const withoutCode = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const m of withoutCode.matchAll(linkRe)) {
      const raw = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // absolute URL or mailto
      if (raw.startsWith('#')) continue; // in-page anchor
      const target = decodeURI(raw.split('#')[0]);
      if (target === '') continue;
      const base = target.startsWith('/') ? ROOT : dirname(join(ROOT, file));
      const publicRoot = join(ROOT, 'docs/public');
      const publicFile = resolve(publicRoot, target.replace(/^\//, ''));
      const isPublicAsset =
        file.startsWith('docs/') &&
        target.startsWith('/') &&
        publicFile.startsWith(publicRoot + sep) &&
        statSafe(publicFile)?.isFile();
      const abs = isPublicAsset ? publicFile : normalize(resolve(base, target.replace(/^\//, '')));
      if (!abs.startsWith(normalize(ROOT))) {
        fail(file, `link escapes the repository: ${raw}`);
        continue;
      }
      const ok =
        existsSync(abs) ||
        (statSafe(abs)?.isDirectory() ?? false) ||
        existsSync(`${abs}.md`) ||
        existsSync(join(abs, 'index.md')) ||
        existsSync(join(abs, 'README.md'));
      if (!ok) {
        fail(file, `dead link ${raw} -> ${relative(ROOT, abs).replaceAll('\\', '/')}`);
        continue;
      }
      // A `docs/**` page is a VitePress page, and VitePress only routes files
      // inside `docs/`. A link that escapes it exists on disk, so the check
      // above is happy, and `docs:build` then fails with `ignoreDeadLinks:
      // false`. Say so here, where the fix is obvious: inline code, or the
      // generated API page.
      if (file.startsWith('docs/') && !normalize(abs).startsWith(normalize(join(ROOT, 'docs')))) {
        fail(
          file,
          `link ${raw} leaves docs/, so VitePress cannot route it; use inline code or link into docs/api/`,
        );
      }
    }
  }
}

/**
 * `statSync` that returns null instead of throwing.
 *
 * @param {string} p Absolute path.
 * @returns {import('node:fs').Stats | null} Stats, or null when missing.
 */
function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * Assert that `headings` appear in `text` in order, as level-2 headings.
 *
 * @param {string} file Repo-relative path, for the error message.
 * @param {string} text File contents.
 * @param {string[]} headings Required headings, in order.
 * @param {string} kind Label used in the error message.
 * @returns {void}
 */
function checkHeadings(file, text, headings, kind) {
  const found = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => `## ${m[1]}`);
  const missing = headings.filter((h) => !found.includes(h));
  if (missing.length > 0) {
    fail(file, `${kind} is missing ${missing.join(', ')}`);
    return;
  }
  const order = headings.map((h) => found.indexOf(h));
  const sorted = [...order].sort((a, b) => a - b);
  if (order.join() !== sorted.join()) {
    fail(file, `${kind} headings are out of order; expected ${headings.join(' -> ')}`);
  }
}

/** Check 2: package README template. */
function checkReadmes() {
  for (const name of packageNames()) {
    const rel = `packages/${name}/README.md`;
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      fail(rel, 'every package needs a README');
      continue;
    }
    checkHeadings(rel, readFileSync(abs, 'utf8'), README_HEADINGS, 'package README');
  }
}

/** Check 3: recipe template. */
function checkRecipes() {
  for (const rel of walk('docs/recipes', /\.md$/)) {
    const base = rel.split('/').pop();
    if (base === 'README.md' || base === 'index.md') continue;
    checkHeadings(rel, readFileSync(join(ROOT, rel), 'utf8'), RECIPE_HEADINGS, 'recipe');
  }
}

/** Checks 4 and 5: llms bundle freshness and size budgets. */
function checkBundles() {
  const tmp = mkdtempSync(join(tmpdir(), 'gameable-docs-'));
  try {
    const report = generate(tmp); // throws if a budget is blown
    for (const name of OUTPUTS) {
      const committed = join(ROOT, name);
      if (!existsSync(committed)) {
        fail(name, 'missing; run `npm run docs:llms` and commit the result');
        continue;
      }
      const a = readFileSync(committed, 'utf8');
      const b = readFileSync(join(tmp, name), 'utf8');
      if (a !== b) {
        fail(
          name,
          `stale (${describeDiff(a, b)}); run \`npm run docs:llms\` and commit the result`,
        );
      }
    }
    for (const r of report) {
      const pct = Math.round((r.bytes / r.budget) * 100);
      console.log(
        `  ${r.name.padEnd(24)} ${fmt(r.bytes).padStart(9)}  ${String(pct).padStart(3)}% of ${fmt(
          r.budget,
        ).padStart(8)}, ${fmt(Math.max(0, r.budget - r.bytes)).padStart(8)} headroom`,
      );
    }
    for (const warning of headroomWarnings(report)) console.warn(`  warning: ${warning}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Describe the first difference between two strings, for the error message.
 *
 * @param {string} a Committed text.
 * @param {string} b Freshly generated text.
 * @returns {string} A short description.
 */
function describeDiff(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.min(la.length, lb.length);
  for (let i = 0; i < n; i += 1) {
    if (la[i] !== lb[i]) return `first differs at line ${String(i + 1)}`;
  }
  return `committed has ${String(la.length)} lines, generated has ${String(lb.length)}`;
}

/**
 * The body of one level-2 section of a markdown file.
 *
 * @param {string} text File contents.
 * @param {string} heading The level-2 heading, without the `##`.
 * @returns {string} The section body, or an empty string.
 */
function sectionOf(text, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm');
  return re.exec(text)?.[1] ?? '';
}

/**
 * Check 4: every path in a recipe's "Files you will edit" exists in a template,
 * or is a new file in a directory that exists in one.
 *
 * A recipe promises "edit these two files and you are done". A path that is not
 * where the template puts it — `assets.json` when the template has
 * `src/assets.json`, a directory that was renamed — turns that promise into a
 * guessing game, and a language model copying the recipe has nothing to guess
 * with. Paths are written relative to the game root, so both `<template>/<p>`
 * and `<template>/src/<p>` count as resolved.
 */
function checkRecipeFiles() {
  const templates = templateNames();
  if (templates.length === 0) return;

  for (const rel of walk('docs/recipes', /\.md$/)) {
    const base = rel.split('/').pop();
    if (base === 'README.md' || base === 'index.md') continue;
    const section = sectionOf(readFileSync(join(ROOT, rel), 'utf8'), 'Files you will edit');
    const paths = [...section.matchAll(/^\s*[-*]\s+`?([\w./-]+\.\w+)`?/gm)].map((m) => m[1]);
    if (paths.length === 0) {
      fail(rel, '"Files you will edit" lists no paths');
      continue;
    }
    if (paths.length > 2) {
      fail(rel, `"Files you will edit" lists ${String(paths.length)} files; the limit is two`);
    }
    for (const p of paths) {
      const candidates = templates.flatMap((t) => [
        join(ROOT, 'templates', t, p),
        join(ROOT, 'templates', t, 'src', p),
      ]);
      if (candidates.some((c) => existsSync(c))) continue;
      // A recipe may create a file, but only inside a directory a template
      // already has — not loose at the game root, where it would be the wrong
      // place for everything the templates actually hold.
      const newFileOk = templates.some((t) => {
        const root = join(ROOT, 'templates', t);
        return [join(root, p), join(root, 'src', p)].some((c) => {
          const dir = dirname(c);
          return dir !== root && existsSync(dir);
        });
      });
      if (newFileOk) continue;
      fail(rel, `"Files you will edit" path ${p} is in no template (${templates.join(', ')})`);
    }
  }
}

/**
 * Check: `docs/recipes/index.md` links every recipe.
 *
 * The sidebar is generated from the filesystem and cannot go stale; this page is
 * written by hand, because grouping recipes by genre is a judgement no directory
 * listing makes. That is exactly why it needs a check: a recipe nobody linked is
 * a recipe nobody finds. Add a line under the genre it belongs to.
 */
function checkRecipeIndex() {
  const rel = 'docs/recipes/index.md';
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    fail(rel, 'the recipe listing is missing');
    return;
  }
  const text = readFileSync(abs, 'utf8');
  for (const recipe of walk('docs/recipes', /\.md$/)) {
    const base = recipe.split('/').pop() ?? '';
    if (base === 'README.md' || base === 'index.md') continue;
    if (!text.includes(`./${base}`)) {
      fail(rel, `does not link ./${base}; add it under the genre it belongs to`);
    }
  }
}

/**
 * Fenced code blocks of a markdown file.
 *
 * @param {string} text File contents.
 * @param {Set<string>} langs Info strings to accept.
 * @returns {{ lang: string, code: string, line: number }[]} The blocks.
 */
function fences(text, langs) {
  /** @type {{ lang: string, code: string, line: number }[]} */
  const out = [];
  const re = /^```([\w-]*)[^\n]*\n([\s\S]*?)^```/gm;
  for (const m of text.matchAll(re)) {
    if (!langs.has(m[1])) continue;
    out.push({
      lang: m[1],
      code: m[2],
      line: text.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

/**
 * Every symbol each workspace package exports from its entry point.
 *
 * Built once, with the TypeScript compiler rather than a regular expression,
 * because `export * from './x'` and `export { a as b }` are both common in these
 * entry points and neither survives a regex.
 *
 * @returns {Map<string, Set<string>>} Package name to exported symbol names.
 */
function packageExports() {
  const names = packageNames();
  const roots = names.map((n) => join(ROOT, 'packages', n, 'src/index.ts')).filter(existsSync);
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    customConditions: ['gameable-source'],
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  /** @type {Map<string, Set<string>>} */
  const map = new Map();
  for (const root of roots) {
    const name = `@gameable/${relative(join(ROOT, 'packages'), root).replaceAll('\\', '/').split('/')[0]}`;
    const sf = program.getSourceFile(root);
    const symbol = sf ? checker.getSymbolAtLocation(sf) : undefined;
    if (!symbol) {
      fail(name, 'entry point has no module symbol; is `src/index.ts` a module?');
      continue;
    }
    map.set(name, new Set(checker.getExportsOfModule(symbol).map((s) => s.getName())));
  }
  return map;
}

/**
 * Parse a snippet as a standalone TypeScript module.
 *
 * @param {string} code The snippet.
 * @returns {import('typescript').SourceFile} The parsed file.
 */
function parseSnippet(code) {
  return ts.createSourceFile('snippet.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/**
 * Syntax errors of a source file that was never part of a `Program`.
 * `parseDiagnostics` is internal, and the only place they live.
 *
 * @param {import('typescript').SourceFile} sf A parsed file.
 * @returns {import('typescript').Diagnostic[]} Syntax diagnostics.
 */
function syntaxErrorsOf(sf) {
  return /** @type {import('typescript').Diagnostic[]} */ (
    Reflect.get(sf, 'parseDiagnostics') ?? []
  );
}

/**
 * Check 5: documentation snippets are real code.
 *
 * Two things are verified for every `ts` fence in an authored page and in every
 * package README. First, it parses — a snippet with a stray brace is copied
 * verbatim by readers and by language models, and neither of them is amused.
 * Second, every named import from an `@gameable/*` package is a symbol that
 * package actually exports, which is the failure that outlives a rename.
 *
 * Free identifiers (`renderer`, `ctx`, `canvas`) are deliberately *not*
 * resolved: a minimal example is an excerpt, and demanding that it declare its
 * whole world would make every README longer and worse.
 */
function checkSnippets() {
  const exportsByPackage = packageExports();
  const langs = new Set(['ts', 'typescript', 'tsx']);

  for (const rel of authoredFiles()) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    for (const block of fences(text, langs)) {
      const sf = parseSnippet(block.code);
      if (syntaxErrorsOf(sf).length > 0) {
        // A snippet may be an excerpt rather than a module — a bare object
        // literal showing the shape of one option, say. Give it one more go as
        // an expression before calling it broken.
        const expression = parseSnippet(`const _excerpt = (${block.code.trim()});`);
        if (syntaxErrorsOf(expression).length === 0) continue;
        const first = ts.flattenDiagnosticMessageText(syntaxErrorsOf(sf)[0].messageText, ' ');
        fail(rel, `snippet at line ${String(block.line)} does not parse: ${first}`);
        continue;
      }

      for (const statement of sf.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith('@gameable/')) continue;
        if (specifier.split('/').length > 2) continue; // deep import, e.g. '@gameable/sdk/prelude'
        const known = exportsByPackage.get(specifier);
        if (!known) {
          fail(rel, `snippet at line ${String(block.line)} imports unknown package ${specifier}`);
          continue;
        }
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue; // default or namespace
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (!known.has(name)) {
            fail(
              rel,
              `snippet at line ${String(block.line)} imports { ${name} } from ${specifier}, which does not export it`,
            );
          }
        }
      }
    }
  }

  // Every package README must show something runnable under `## Minimal example`.
  for (const name of packageNames()) {
    const rel = `packages/${name}/README.md`;
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const section = sectionOf(readFileSync(abs, 'utf8'), 'Minimal example');
    if (fences(section, new Set([...langs, 'sh', 'bash', 'json'])).length === 0) {
      fail(rel, '"Minimal example" has no fenced code block');
    }
  }
}

/**
 * Check 6: no `TODO(` left in authored documentation.
 *
 * A `TODO(` in a page is a promise to a reader that nobody is tracking. Put it
 * in an issue, or in the source, not in the docs.
 */
function checkTodos() {
  for (const rel of authoredFiles()) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      if (line.includes('TODO(')) {
        fail(rel, `line ${String(i + 1)}: TODO( markers do not ship in documentation`);
      }
    }
  }
}

/** Check: the JSON schemas parse and declare draft 2020-12. */
function checkSchemas() {
  for (const rel of walk('docs/schemas', /\.json$/)) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
    } catch (err) {
      fail(rel, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (doc.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
      fail(rel, 'must declare $schema https://json-schema.org/draft/2020-12/schema');
    }
    if (typeof doc.title !== 'string') fail(rel, 'must have a title');
  }
}

console.log('docs:lint');
ensureApiDocs();
try {
  publishLlms(join(ROOT, 'docs/public'));
} catch (err) {
  fail('LLM downloads', err instanceof Error ? err.message : String(err));
}
checkLinks();
checkReadmes();
checkRecipes();
checkRecipeFiles();
checkRecipeIndex();
checkSnippets();
checkTodos();
checkSchemas();

try {
  checkBundles();
} catch (err) {
  fail('llms bundles', err instanceof Error ? err.message : String(err));
}

if (failures.length > 0) {
  console.error(`\ndocs:lint found ${String(failures.length)} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `docs:lint ok — ${String(linkedFiles().length)} markdown files, ${String(
    packageNames().length,
  )} package READMEs, ${String(Object.keys(BUDGETS).length)} bundles`,
);
