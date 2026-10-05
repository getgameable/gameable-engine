/**
 * Copying a template into a new directory.
 *
 * The copy is a walk rather than `cpSync`, because three things happen on the
 * way: build output is skipped, `_gitignore` becomes `.gitignore` (npm will not
 * ship a `.gitignore` inside a package), and every text file goes through
 * `{{token}}` substitution.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

import { toPosix } from './paths.js';
import { SHIPPED_AS, applyTokens, type TemplateManifest, type TokenMap } from './tokens.js';
import { gamePackageJson, type VersionContext } from './versions.js';

/** Directory names never copied out of a template. */
export const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.gameable',
  '.git',
  '.vite',
  'coverage',
  'test-results',
  'playwright-report',
]);

/** File names never copied out of a template. */
export const SKIP_FILES = new Set([
  'template.json',
  'tsconfig.tsbuildinfo',
  '.DS_Store',
  'Thumbs.db',
]);

/** Extensions treated as text, and therefore token-substituted. */
export const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.html',
  '.css',
  '.txt',
  '.yml',
  '.yaml',
  '.svg',
  '.wit',
  '.example',
  '.gitignore',
  '.npmrc',
]);

/** Files with no extension that are still text. */
export const TEXT_NAMES = new Set(['.gitignore', '_gitignore', '.npmrc', '_npmrc', 'LICENSE']);

/** Everything {@link scaffold} needs. */
export interface ScaffoldOptions {
  /** Absolute, forward-slashed directory to create. */
  readonly targetDir: string;
  /** Absolute, forward-slashed template directory. */
  readonly templateDir: string;
  /** The template's declaration. */
  readonly manifest: TemplateManifest;
  /** The new game's package name. */
  readonly name: string;
  /** The new game's human title. */
  readonly title: string;
  /** How engine dependencies are pinned. */
  readonly versions: VersionContext;
  /** Wire up the AvatarOS Asset Manager in `.env.example`. */
  readonly aam: boolean;
}

/** What {@link scaffold} wrote. */
export interface ScaffoldResult {
  /** Every file written, relative to the target directory, sorted. */
  readonly files: string[];
  /** Tokens that were substituted. */
  readonly tokens: TokenMap;
}

/**
 * Is this file text, and therefore token-substituted?
 *
 * @param fileName A base name.
 * @returns True when the file should be read as UTF-8 and substituted.
 */
export function isTextFile(fileName: string): boolean {
  if (TEXT_NAMES.has(fileName)) return true;
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return false;
  return TEXT_EXTENSIONS.has(fileName.slice(dot));
}

/**
 * The name a file takes in the generated game.
 *
 * npm strips `.gitignore` out of a published tarball, so templates ship theirs
 * as `_gitignore`; this puts the dot back. A template's own `rename` map wins.
 *
 * @param fileName The name inside the template.
 * @param rename The template's explicit renames.
 * @returns The name to write.
 */
export function outputName(
  fileName: string,
  rename: Readonly<Record<string, string | undefined>>,
): string {
  const explicit = rename[fileName];
  if (explicit !== undefined) return explicit;
  for (const [real, shipped] of Object.entries(SHIPPED_AS)) {
    if (fileName === shipped) return real;
  }
  return fileName;
}

/**
 * Copy a template into a new directory, substituting as it goes.
 *
 * @param options Where from, where to, and what to substitute.
 * @returns Which files were written.
 * @throws {Error} When the template is missing a `package.json`.
 */
export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  const templateDir = toPosix(options.templateDir);
  const targetDir = toPosix(options.targetDir);
  if (!existsSync(`${templateDir}/package.json`)) {
    throw new Error(`${templateDir} is not a template: no package.json`);
  }

  const tokens: TokenMap = {
    ...options.manifest.tokens,
    name: options.name,
    title: options.title,
    aosVersion: options.versions.version,
    year: String(new Date().getUTCFullYear()),
  };
  const exclude = new Set(options.manifest.exclude.map((path) => path.replace(/^\.\//, '')));
  const written: string[] = [];

  mkdirSync(targetDir, { recursive: true });
  copyTree(templateDir, targetDir, '', {
    exclude,
    rename: options.manifest.rename,
    tokens,
    written,
  });

  // package.json is not a token substitution problem; it is a dependency
  // rewriting problem, so it is written from the parsed manifest instead.
  const templatePkg = JSON.parse(
    applyTokens(readFileSync(`${templateDir}/package.json`, 'utf8'), tokens),
  ) as Record<string, unknown>;
  const pkg = gamePackageJson(templatePkg, options.name, options.versions);
  writeFileSync(`${targetDir}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  if (!written.includes('package.json')) written.push('package.json');

  hoistExtendedTsconfig(targetDir, templateDir, written);
  if (options.versions.mode !== 'file') {
    // Installed tarballs expose built exports; source-only conditions belong
    // to development inside the engine checkout.
    for (const file of [
      'tsconfig.json',
      'tsconfig.base.json',
      'vitest.config.ts',
      'vite.config.ts',
    ]) {
      const path = `${targetDir}/${file}`;
      if (!existsSync(path)) continue;
      const source = readFileSync(path, 'utf8');
      let packed = source
        .replace(/\[(['"])gameable-source\1\]/g, '[]')
        .replace(/\bgameable\(\)/g, 'gameable({ source: false })');
      if (file === 'vitest.config.ts') {
        // vitest's node environment resolves through the SSR conditions. The
        // templates set them (to the source condition, emptied above); a
        // config without one gets its own line.
        const ssr = "ssr: { resolve: { conditions: ['node', 'import'] } }";
        packed = /^\s*ssr:\s*\{\s*resolve:\s*\{\s*conditions:\s*\[\]\s*\}\s*\}/m.test(packed)
          ? packed.replace(/ssr:\s*\{\s*resolve:\s*\{\s*conditions:\s*\[\]\s*\}\s*\}/, ssr)
          : packed.replace('  test: {', `  ${ssr},\n  test: {`);
      }
      writeFileSync(path, packed, 'utf8');
    }
  }
  if (options.versions.mode !== 'file' && existsSync(`${targetDir}/vitest.config.ts`)) {
    mkdirSync(`${targetDir}/scripts`, { recursive: true });
    writeAlways(targetDir, 'scripts/test.mjs', PACKAGED_TEST_RUNNER, written);
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    scripts.test = 'node scripts/test.mjs';
    pkg.scripts = scripts;
    writeFileSync(`${targetDir}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }
  for (const manifestPath of ['src/assets.json', 'assets.json']) {
    stripDanglingSchema(targetDir, templateDir, manifestPath);
  }
  const ignorePath = `${targetDir}/.gitignore`;
  const existingIgnore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  writeAlways(targetDir, '.gitignore', `${existingIgnore}\n${GITIGNORE}`, written);
  writeIfAbsent(targetDir, 'AGENTS.md', agentsMd(options.title, options.name), written);
  writeAlways(targetDir, '.env.example', envExample(options.aam), written);

  written.sort();
  return { files: written, tokens };
}

/**
 * Make a copied `tsconfig.json` stand on its own.
 *
 * Templates are workspace members, so their `tsconfig.json` usually extends the
 * repository's `tsconfig.base.json` by a relative path that means nothing once
 * the game is somewhere else. The base is copied in next to it and the
 * `extends` string is rewritten — textually, so the comments survive.
 *
 * One level only: a base that itself extends something outside the repository
 * is not a shape this repository has.
 *
 * @param targetDir Absolute game directory.
 * @param templateDir Absolute template directory the `extends` resolves against.
 * @param written Accumulator of written paths.
 */
export function hoistExtendedTsconfig(
  targetDir: string,
  templateDir: string,
  written: string[],
): void {
  const path = `${targetDir}/tsconfig.json`;
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  const match = /"extends"\s*:\s*"([^"]+)"/.exec(text);
  const value = match?.[1];
  if (match === null || value === undefined || !value.startsWith('.')) return;

  const resolved = toPosix(resolve(templateDir, value));
  if (resolved.startsWith(`${templateDir}/`)) return; // already self-contained

  const source = existsSync(resolved) ? resolved : `${resolved}.json`;
  if (!existsSync(source)) return;

  copyFileSync(source, `${targetDir}/tsconfig.base.json`);
  writeFileSync(path, text.replace(match[0], '"extends": "./tsconfig.base.json"'), 'utf8');
  if (!written.includes('tsconfig.base.json')) written.push('tsconfig.base.json');
}

/**
 * Remove a `$schema` key whose relative path does not survive the copy.
 *
 * A template's `src/assets.json` points `$schema` at the repository's
 * `docs/schemas/assets.schema.json` so editors complete it. That path dangles
 * the moment the file is somewhere else, and `parseManifest` rejects unknown
 * top-level keys, so the generated game would not boot. Absolute URLs are left
 * alone: those keep working.
 *
 * The edit is textual, so key order and formatting survive.
 *
 * @param targetDir Absolute game directory.
 * @param templateDir Absolute template directory.
 * @param relativePath The JSON file, relative to both roots.
 */
export function stripDanglingSchema(
  targetDir: string,
  templateDir: string,
  relativePath: string,
): void {
  const path = `${targetDir}/${relativePath}`;
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  const match = /^[^\S\n]*"\$schema"\s*:\s*"([^"]+)"\s*,?[^\S\n]*\n?/m.exec(text);
  const value = match?.[1];
  if (match === null || value === undefined) return;
  if (!value.startsWith('.')) return; // an absolute URL still resolves

  const sourceDir = `${templateDir}/${relativePath}`.replace(/\/[^/]+$/, '');
  const resolved = toPosix(resolve(sourceDir, value));
  if (resolved.startsWith(`${templateDir}/`)) return; // still inside the game

  writeFileSync(path, text.replace(match[0], ''), 'utf8');
}

/** Internal state threaded through the copy walk. */
interface CopyState {
  /** Template-relative paths that are never copied. */
  readonly exclude: ReadonlySet<string>;
  /** The template's explicit renames. */
  readonly rename: Readonly<Record<string, string>>;
  /** Values substituted into every text file. */
  readonly tokens: TokenMap;
  /** Accumulator of written paths, relative to the target. */
  readonly written: string[];
}

/**
 * Copy one directory level, recursing into subdirectories.
 *
 * @param fromDir Absolute source directory.
 * @param toDir Absolute target root.
 * @param prefix Path of this level relative to the template root.
 * @param state Exclusions, renames, tokens and the accumulator.
 */
function copyTree(fromDir: string, toDir: string, prefix: string, state: CopyState): void {
  for (const entry of readdirSync(`${fromDir}/${prefix}`.replace(/\/$/, ''), {
    withFileTypes: true,
  })) {
    const sourceRelative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (state.exclude.has(sourceRelative)) continue;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      mkdirSync(`${toDir}/${sourceRelative}`, { recursive: true });
      copyTree(fromDir, toDir, sourceRelative, state);
      continue;
    }
    if (SKIP_FILES.has(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue;

    const outName = outputName(entry.name, state.rename);
    const outRelative = prefix === '' ? outName : `${prefix}/${outName}`;
    const source = `${fromDir}/${sourceRelative}`;
    const target = `${toDir}/${outRelative}`;

    if (outRelative === 'package.json') continue; // written from the parsed manifest

    if (isTextFile(entry.name)) {
      writeFileSync(target, applyTokens(readFileSync(source, 'utf8'), state.tokens), 'utf8');
    } else {
      copyFileSync(source, target);
    }
    state.written.push(outRelative);
  }
}

/**
 * Write a file only when the template did not provide one.
 *
 * @param dir Absolute target directory.
 * @param name File name.
 * @param text Contents.
 * @param written Accumulator of written paths.
 */
function writeIfAbsent(dir: string, name: string, text: string, written: string[]): void {
  if (existsSync(`${dir}/${name}`)) return;
  writeFileSync(`${dir}/${name}`, text, 'utf8');
  written.push(name);
}

/**
 * Write a file, replacing anything the template provided.
 *
 * @param dir Absolute target directory.
 * @param name File name.
 * @param text Contents.
 * @param written Accumulator of written paths.
 */
function writeAlways(dir: string, name: string, text: string, written: string[]): void {
  writeFileSync(`${dir}/${name}`, text, 'utf8');
  if (!written.includes(name)) written.push(name);
}

/** The `.gitignore` every generated game gets, when the template has none. */
export const GITIGNORE = `node_modules/
dist/
build/
.gameable/
.vite/
coverage/
test-results/
playwright-report/
*.tsbuildinfo

# Local environment. .env.example is committed; .env is not.
.env
.env.*.local
.env.local

.DS_Store
Thumbs.db
`;

/**
 * The `.env.example` a generated game gets.
 *
 * @param aam Whether the AvatarOS Asset Manager keys are included.
 * @returns The file contents.
 */
export function envExample(aam: boolean): string {
  const lines = [
    '# Copy to .env.local and fill in. Vite only exposes VITE_-prefixed keys to',
    '# the browser, and .env.local is gitignored.',
    '',
    '# Where assets.json resolves relative src entries against. Leave empty to',
    '# serve them from public/.',
    'VITE_ASSET_BASE_URL=',
    '',
  ];
  if (aam) {
    lines.push(
      '# AvatarOS Asset Manager. Without these, gameable/aam falls back',
      '# to the static manifest and the placeholder assets.',
      'VITE_ASSET_MANAGER_URL=',
      'VITE_ASSET_MANAGER_KEY=',
      '',
    );
  }
  return lines.join('\n');
}

/**
 * The game-scoped `AGENTS.md`, written when the template does not ship one.
 *
 * @param title The game's title.
 * @param name The game's package name.
 * @returns The file contents.
 */
export function agentsMd(title: string, name: string): string {
  return `# AGENTS.md — ${title}

This is a game, not the engine. Everything you need is in \`src/\`.

## The whole loop

\`\`\`sh
npm run dev      # http://localhost:5173, edit src/game.ts, save
npm run build    # componentize the guest, then build the site
npm test         # the smoke spec drives the same loop headlessly
npx gameable doctor
\`\`\`

## Hard rules

1. **Never edit anything under \`node_modules/gameable/\`.** If the game cannot
   be written without an engine change, say so and stop. That is a missing
   feature, not a workaround.
2. **Assets are addressed by string id only.** Never a path, never a URL, in
   game code. Add an entry to \`src/assets.json\` instead.
3. **No allocation in a system.** Systems run 60 times a second. Preallocate
   typed arrays, memoise subarrays, use dirty flags.
4. **Import from \`gameable\`**, never from \`gameable:engine/*\` — those
   specifiers belong to the generated \`.gameable/entry.ts\`.
5. **Import \`three/webgpu\`, \`three/tsl\` or \`three/addons/...\`**, never bare
   \`three\`, on the rare occasion you touch three directly.
6. **Seed randomness inside \`init()\`** from the seed the engine passes. Module
   level state is frozen into the wasm snapshot at build time.

## Where things are

| Path              | What                                           |
| ----------------- | ---------------------------------------------- |
| \`src/game.ts\`     | the one \`defineGame\` call. Start here          |
| \`src/prefabs.ts\`  | entity templates                               |
| \`src/systems/\`    | one file per behaviour, \`(ctx) => void\`        |
| \`src/hud.ts\`      | the HUD model                                  |
| \`src/assets.json\` | asset ids to files. The ids are the contract   |
| \`public/\`         | files served at the site root                  |

## Reading

\`npx gameable docs\` prints where the engine's \`llms-fps.txt\` and friends are.
Read one bundle, not the whole engine.

Package: \`${name}\`.
`;
}

/** Tests must not select source-only development exports in installed packages. */
const PACKAGED_TEST_RUNNER =
  "// Test installed package exports under the same conditions as a production build.\nimport { spawnSync } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\nconst result = spawnSync(process.execPath, [fileURLToPath(new URL('vitest.mjs', import.meta.resolve('vitest/package.json'))), 'run', ...process.argv.slice(2)], {\n  stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },\n});\nprocess.exit(result.status ?? 1);\n";
