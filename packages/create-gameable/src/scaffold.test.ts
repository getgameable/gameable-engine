import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toPosix } from './paths.js';
import { envExample, isTextFile, outputName, scaffold } from './scaffold.js';
import { readManifest } from './templates.js';
import { leftoverTokens } from './tokens.js';
import type { VersionContext } from './versions.js';

const scratch = toPosix(mkdtempSync(join(tmpdir(), 'aos-create-')));
const templateDir = `${scratch}/template`;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Write a synthetic template that exercises every rule the copier has: a
 * `_gitignore`, a binary file, build output that must not be copied, an
 * excluded file and tokens in several file types.
 */
beforeAll(() => {
  mkdirSync(`${templateDir}/src/systems`, { recursive: true });
  mkdirSync(`${templateDir}/public`, { recursive: true });
  mkdirSync(`${templateDir}/node_modules/junk`, { recursive: true });
  mkdirSync(`${templateDir}/dist`, { recursive: true });

  writeFileSync(
    `${templateDir}/package.json`,
    JSON.stringify(
      {
        name: '@gameable/template-fps',
        version: '0.0.0',
        private: true,
        type: 'module',
        files: ['src'],
        scripts: { dev: 'vite', build: 'gameable build' },
        dependencies: { gameable: '*', three: '0.186.0' },
        devDependencies: { vite: '8.3.0' },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    `${templateDir}/template.json`,
    JSON.stringify({
      name: 'fps',
      title: 'First-person shooter',
      description: 'walk, shoot, win',
      tokens: { tagline: 'Shoot the capsules.' },
      exclude: ['NOTES.md'],
    }),
    'utf8',
  );
  writeFileSync(
    `${templateDir}/index.html`,
    '<title>{{title}}</title>\n<!-- {{tagline}} -->\n',
    'utf8',
  );
  writeFileSync(`${templateDir}/README.md`, '# {{title}}\n\nPackage `{{name}}`.\n', 'utf8');
  writeFileSync(`${templateDir}/src/game.ts`, "export const id = '{{name}}';\n", 'utf8');
  writeFileSync(`${templateDir}/src/systems/weapon.ts`, 'export function weapon() {}\n', 'utf8');
  writeFileSync(
    `${templateDir}/src/assets.json`,
    JSON.stringify({ version: 1, assets: [] }),
    'utf8',
  );
  writeFileSync(`${templateDir}/_gitignore`, 'node_modules/\ndist/\n', 'utf8');
  writeFileSync(`${templateDir}/NOTES.md`, 'internal only\n', 'utf8');
  writeFileSync(`${templateDir}/public/arena.bin`, Buffer.from([0, 1, 2, 250, 255]));
  writeFileSync(`${templateDir}/dist/stale.js`, 'never copied\n', 'utf8');
  writeFileSync(`${templateDir}/node_modules/junk/index.js`, 'never copied\n', 'utf8');
  writeFileSync(`${templateDir}/tsconfig.tsbuildinfo`, '{}', 'utf8');
});

/**
 * Scaffold into a fresh directory under the scratch root.
 *
 * @param name The game name, also the directory name.
 * @param aam Whether to include the Asset Manager keys.
 * @returns The target directory and what was written.
 */
function build(name: string, aam = false): { dir: string; files: string[] } {
  const dir = `${scratch}/out-${name}`;
  rmSync(dir, { recursive: true, force: true });
  const versions: VersionContext = { mode: 'semver', version: '0.4.2', gameDir: dir };
  const result = scaffold({
    targetDir: dir,
    templateDir,
    manifest: readManifest(templateDir, 'fps'),
    name,
    title: 'My FPS',
    versions,
    aam,
  });
  return { dir, files: result.files };
}

describe('isTextFile', () => {
  it('recognises source and config files', () => {
    for (const name of ['game.ts', 'assets.json', 'README.md', 'index.html', 'vite.config.ts']) {
      expect(isTextFile(name)).toBe(true);
    }
  });

  it('recognises dotfiles that ship under a different name', () => {
    expect(isTextFile('_gitignore')).toBe(true);
    expect(isTextFile('.gitignore')).toBe(true);
  });

  it('treats binaries as binaries', () => {
    for (const name of ['arena.spz', 'shot.ogg', 'body.glb', 'logo.png']) {
      expect(isTextFile(name)).toBe(false);
    }
  });
});

describe('outputName', () => {
  it('puts the dot back on a shipped dotfile', () => {
    expect(outputName('_gitignore', {})).toBe('.gitignore');
    expect(outputName('_npmrc', {})).toBe('.npmrc');
  });

  it('honours an explicit rename first', () => {
    expect(outputName('_gitignore', { _gitignore: '.ignore-me' })).toBe('.ignore-me');
  });

  it('leaves an ordinary name alone', () => {
    expect(outputName('game.ts', {})).toBe('game.ts');
  });
});

describe('scaffold', () => {
  it('writes the files the template declares, and nothing else', () => {
    const { files } = build('a');
    expect(files).toEqual([
      '.env.example',
      '.gitignore',
      'AGENTS.md',
      'README.md',
      'index.html',
      'package.json',
      'public/arena.bin',
      'src/assets.json',
      'src/game.ts',
      'src/systems/weapon.ts',
    ]);
  });

  it('never copies build output or node_modules', () => {
    const { dir } = build('b');
    expect(existsSync(`${dir}/dist`)).toBe(false);
    expect(existsSync(`${dir}/node_modules`)).toBe(false);
    expect(existsSync(`${dir}/tsconfig.tsbuildinfo`)).toBe(false);
  });

  it('drops template.json and anything the template excluded', () => {
    const { dir } = build('c');
    expect(existsSync(`${dir}/template.json`)).toBe(false);
    expect(existsSync(`${dir}/NOTES.md`)).toBe(false);
  });

  it('substitutes every token, leaving none behind', () => {
    const { dir } = build('my-fps');
    const html = readFileSync(`${dir}/index.html`, 'utf8');
    const readme = readFileSync(`${dir}/README.md`, 'utf8');
    expect(html).toContain('<title>My FPS</title>');
    expect(html).toContain('Shoot the capsules.');
    expect(readme).toContain('# My FPS');
    expect(readme).toContain('Package `my-fps`.');
    expect(leftoverTokens(html + readme)).toEqual([]);
  });

  it('substitutes tokens in nested source files', () => {
    const { dir } = build('d');
    expect(readFileSync(`${dir}/src/game.ts`, 'utf8')).toBe("export const id = 'd';\n");
  });

  it('copies binary files byte for byte', () => {
    const { dir } = build('e');
    const copied = readFileSync(`${dir}/public/arena.bin`);
    expect([...copied]).toEqual([0, 1, 2, 250, 255]);
  });

  it('renames _gitignore and keeps the template contents', () => {
    const { dir } = build('f');
    const ignore = readFileSync(`${dir}/.gitignore`, 'utf8');
    expect(ignore).toContain('node_modules/\ndist/\n');
    expect(ignore).toContain('.env.local\n');
  });

  it('writes a package.json a standalone game can install', () => {
    const { dir } = build('my-fps');
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as Record<string, unknown>;
    expect(pkg.name).toBe('my-fps');
    expect(pkg.version).toBe('0.1.0');
    expect(pkg.files).toBeUndefined();
    expect(pkg.dependencies).toEqual({ gameable: '0.4.2', three: '0.186.0' });
    expect(pkg.devDependencies).toEqual({ vite: '8.3.0' });
    expect(pkg.scripts).toEqual({ dev: 'vite', build: 'gameable build' });
  });

  it('writes a game-scoped AGENTS.md', () => {
    const { dir } = build('g');
    const agents = readFileSync(`${dir}/AGENTS.md`, 'utf8');
    expect(agents).toContain('# AGENTS.md');
    expect(agents).toContain('src/game.ts');
    expect(agents).toContain('Never edit anything under `node_modules/gameable/`');
  });

  it('writes .env.example without Asset Manager keys by default', () => {
    const { dir } = build('h');
    const env = readFileSync(`${dir}/.env.example`, 'utf8');
    expect(env).toContain('VITE_ASSET_BASE_URL=');
    expect(env).not.toContain('VITE_ASSET_MANAGER_URL');
  });

  it('adds the Asset Manager keys under --aam', () => {
    const { dir } = build('i', true);
    const env = readFileSync(`${dir}/.env.example`, 'utf8');
    expect(env).toContain('VITE_ASSET_MANAGER_URL=');
    expect(env).toContain('VITE_ASSET_MANAGER_KEY=');
  });

  it('refuses a directory that is not a template', () => {
    expect(() =>
      scaffold({
        targetDir: `${scratch}/nope`,
        templateDir: `${scratch}/not-a-template`,
        manifest: readManifest(`${scratch}/not-a-template`, 'x'),
        name: 'x',
        title: 'X',
        versions: { mode: 'semver', version: '0.1.0', gameDir: `${scratch}/nope` },
        aam: false,
      }),
    ).toThrow(/not a template/);
  });
});

describe('hoistExtendedTsconfig', () => {
  it('copies the base in and rewrites the extends, comments intact', () => {
    // The synthetic template sits at <scratch>/template, so ../tsconfig.base.json
    // is outside it, exactly as a workspace member's is.
    writeFileSync(
      `${scratch}/tsconfig.base.json`,
      '{ "compilerOptions": { "strict": true } }',
      'utf8',
    );
    writeFileSync(
      `${templateDir}/tsconfig.json`,
      ['{', '  "extends": "../tsconfig.base.json",', '  // kept', '  "include": ["src"]', '}'].join(
        '\n',
      ),
      'utf8',
    );
    const { dir, files } = build('tsconfig');
    const written = readFileSync(`${dir}/tsconfig.json`, 'utf8');
    expect(written).toContain('"extends": "./tsconfig.base.json"');
    expect(written).toContain('// kept');
    expect(existsSync(`${dir}/tsconfig.base.json`)).toBe(true);
    expect(files).toContain('tsconfig.base.json');
    rmSync(`${templateDir}/tsconfig.json`, { force: true });
  });

  it('leaves a self-contained tsconfig alone', () => {
    writeFileSync(
      `${templateDir}/tsconfig.json`,
      '{ "extends": "./base.json", "include": ["src"] }',
      'utf8',
    );
    writeFileSync(`${templateDir}/base.json`, '{}', 'utf8');
    const { dir } = build('selfcontained');
    expect(readFileSync(`${dir}/tsconfig.json`, 'utf8')).toContain('"extends": "./base.json"');
    expect(existsSync(`${dir}/tsconfig.base.json`)).toBe(false);
    rmSync(`${templateDir}/tsconfig.json`, { force: true });
    rmSync(`${templateDir}/base.json`, { force: true });
  });
});

describe('stripDanglingSchema', () => {
  it('drops a $schema that pointed outside the template', () => {
    writeFileSync(
      `${templateDir}/src/assets.json`,
      JSON.stringify(
        {
          $schema: '../../../docs/schemas/assets.schema.json',
          version: 1,
          baseUrl: '/',
          assets: [],
        },
        null,
        2,
      ),
      'utf8',
    );
    const { dir } = build('schema');
    const manifest = JSON.parse(readFileSync(`${dir}/src/assets.json`, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest.$schema).toBeUndefined();
    expect(manifest.version).toBe(1);
    expect(manifest.baseUrl).toBe('/');
    expect(manifest.assets).toEqual([]);
  });

  it('keeps a $schema that is an absolute URL', () => {
    writeFileSync(
      `${templateDir}/src/assets.json`,
      JSON.stringify(
        { $schema: 'https://engine.gameable.com/assets.schema.json', version: 1, assets: [] },
        null,
        2,
      ),
      'utf8',
    );
    const { dir } = build('schema-url');
    const manifest = JSON.parse(readFileSync(`${dir}/src/assets.json`, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest.$schema).toBe('https://engine.gameable.com/assets.schema.json');
  });
});

describe('envExample', () => {
  it('is a comment-led file a person can read', () => {
    expect(envExample(false).startsWith('#')).toBe(true);
  });
});
