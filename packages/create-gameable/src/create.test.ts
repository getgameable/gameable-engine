/**
 * End to end: run the real command into a temporary directory with
 * `--no-install --no-git`, then point `gameable doctor` at the result.
 *
 * `GAMEABLE_TEMPLATES` makes the test independent of which templates happen to be
 * authored, so it keeps working while `templates/fps` is still being written.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from './create.js';
import { toPosix } from './paths.js';

const scratch = toPosix(mkdtempSync(join(tmpdir(), 'aos-create-e2e-')));
const templates = `${scratch}/templates`;
const repoRoot = toPosix(fileURLToPath(new URL('../../../', import.meta.url)));
const cliBin = `${repoRoot}/packages/cli/bin/gameable.mjs`;

beforeAll(() => {
  mkdirSync(`${templates}/fps/src`, { recursive: true });
  writeFileSync(
    `${templates}/fps/package.json`,
    JSON.stringify(
      {
        name: '@gameable/template-fps',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: { dev: 'gameable dev', build: 'gameable build --release' },
        dependencies: { '@gameable/sdk': '0.0.0' },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    `${templates}/fps/template.json`,
    JSON.stringify({ title: 'First-person shooter', description: 'walk, shoot, win' }),
    'utf8',
  );
  writeFileSync(`${templates}/fps/index.html`, '<title>{{title}}</title>\n', 'utf8');
  writeFileSync(`${templates}/fps/src/game.ts`, "export const id = '{{name}}';\n", 'utf8');
  writeFileSync(
    `${templates}/fps/src/assets.json`,
    JSON.stringify({ version: 1, baseUrl: '/', assets: [] }, null, 2),
    'utf8',
  );
  writeFileSync(`${templates}/fps/_gitignore`, 'node_modules/\n', 'utf8');
  process.env.GAMEABLE_TEMPLATES = templates;
});

afterAll(() => {
  delete process.env.GAMEABLE_TEMPLATES;
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Run `main` with stdout captured.
 *
 * @param argv Command-line arguments.
 * @param cwd Directory the target path resolves against.
 * @returns The exit code and everything printed.
 */
async function runCreate(argv: string[], cwd = scratch): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  });
  const code = await main(argv, cwd);
  return { code, out: lines.join('\n') };
}

describe('create-gameable', () => {
  it('scaffolds a game with --no-install --no-git', async () => {
    const { code } = await runCreate(['my-game', '--template', 'fps', '--no-install', '--no-git']);
    expect(code).toBe(0);

    const dir = `${scratch}/my-game`;
    for (const file of [
      'package.json',
      'index.html',
      'src/game.ts',
      'src/assets.json',
      '.gitignore',
      '.env.example',
      'AGENTS.md',
    ]) {
      expect(existsSync(`${dir}/${file}`), file).toBe(true);
    }
    expect(existsSync(`${dir}/template.json`)).toBe(false);
    expect(existsSync(`${dir}/.git`)).toBe(false);
    expect(existsSync(`${dir}/node_modules`)).toBe(false);
  });

  it('replaces every token', async () => {
    await runCreate(['token-game', '--template', 'fps', '--no-install', '--no-git']);
    const dir = `${scratch}/token-game`;
    // The default title is the game's own name. template.json's `title` names
    // the template in the chooser, not the game.
    expect(readFileSync(`${dir}/index.html`, 'utf8')).toBe('<title>Token Game</title>\n');
    expect(readFileSync(`${dir}/src/game.ts`, 'utf8')).toBe("export const id = 'token-game';\n");
  });

  it('honours --title over the template default', async () => {
    await runCreate([
      'titled',
      '--template',
      'fps',
      '--title',
      'Capsule Hunt',
      '--no-install',
      '--no-git',
    ]);
    expect(readFileSync(`${scratch}/titled/index.html`, 'utf8')).toContain('Capsule Hunt');
  });

  it('names the package after the directory, sanitised', async () => {
    await runCreate(['My Game', '--template', 'fps', '--no-install', '--no-git']);
    const pkg = JSON.parse(readFileSync(`${scratch}/My Game/package.json`, 'utf8')) as {
      name: string;
      version: string;
    };
    expect(pkg.name).toBe('my-game');
    expect(pkg.version).toBe('0.1.0');
  });

  it('adds the Asset Manager keys under --aam', async () => {
    await runCreate(['aam-game', '--template', 'fps', '--aam', '--no-install', '--no-git']);
    expect(readFileSync(`${scratch}/aam-game/.env.example`, 'utf8')).toContain(
      'VITE_ASSET_MANAGER_URL=',
    );
  });

  it('refuses a non-empty directory without --force', async () => {
    mkdirSync(`${scratch}/occupied`, { recursive: true });
    writeFileSync(`${scratch}/occupied/keep.txt`, 'mine', 'utf8');
    const { code, out } = await runCreate([
      'occupied',
      '--template',
      'fps',
      '--no-install',
      '--no-git',
    ]);
    expect(code).toBe(1);
    expect(out).toContain('--force');
  });

  it('rejects an unknown template by name', async () => {
    const { code, out } = await runCreate([
      'nope',
      '--template',
      'roguelike',
      '--no-install',
      '--no-git',
    ]);
    expect(code).toBe(1);
    // The list is sorted by name, so fps is in it but not necessarily first.
    expect(out).toContain('Available: ');
    expect(out).toContain(' fps');
  });

  it('rejects an unknown option instead of guessing', async () => {
    const { code, out } = await runCreate(['x', '--templatte', 'fps']);
    expect(code).toBe(1);
    expect(out).toContain('unknown option');
  });

  it('--list prints every template with its description, kits marked, and fps stays the default', async () => {
    const kit = `${templates}/aaa-party`;
    mkdirSync(`${kit}/src`, { recursive: true });
    writeFileSync(
      `${kit}/package.json`,
      JSON.stringify({ name: '@gameable/template-party' }),
      'utf8',
    );
    writeFileSync(
      `${kit}/template.json`,
      JSON.stringify({ description: 'a party for four' }),
      'utf8',
    );
    writeFileSync(
      `${kit}/src/game.ts`,
      'export default defineGame({ features: { multiplayer: { maxPlayers: 4 } } });\n',
      'utf8',
    );
    try {
      const { code, out } = await runCreate(['--list']);
      expect(code).toBe(0);
      expect(out).toMatch(/1\) aaa-party +\[multiplayer\] a party for four/);
      expect(out).toMatch(/\d\) fps +walk, shoot, win/); // the repository's templates are listed too
      // Sorted first, but not the default.
      const elsewhere = `${scratch}/default-is-fps`;
      mkdirSync(elsewhere, { recursive: true });
      const made = await runCreate(['--no-install', '--no-git'], elsewhere);
      expect(made.code).toBe(0);
      expect(made.out).toContain('from the fps template');
    } finally {
      rmSync(kit, { recursive: true, force: true });
    }
  });

  it('prints help without touching the filesystem', async () => {
    const { code, out } = await runCreate(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('npm create gameable');
  });

  it('takes defaults and never blocks when stdin is not a TTY', async () => {
    const elsewhere = `${scratch}/defaults`;
    mkdirSync(elsewhere, { recursive: true });
    const { code } = await runCreate(['--no-install', '--no-git'], elsewhere);
    expect(code).toBe(0);
    expect(existsSync(`${elsewhere}/my-game/package.json`)).toBe(true);
  });
});

describe('gameable doctor against a scaffold', () => {
  it.runIf(existsSync(cliBin) && existsSync(`${repoRoot}/packages/cli/dist/bin.js`))(
    'runs every check and reports the toolchain',
    async () => {
      await runCreate(['doctor-game', '--template', 'fps', '--no-install', '--no-git']);
      let output: string;
      try {
        output = execFileSync(process.execPath, [cliBin, 'doctor'], {
          cwd: `${scratch}/doctor-game`,
          encoding: 'utf8',
          env: { ...process.env, NO_COLOR: '1' },
        });
      } catch (err) {
        // doctor exits with the number of failures, which is not a crash.
        output = (err as { stdout?: string }).stdout ?? '';
      }
      expect(output).toContain('gameable doctor');
      expect(output).toContain('node');
      expect(output).toContain('assets.json');
      expect(output).toContain('webgpu');
    },
    120_000,
  );
});
