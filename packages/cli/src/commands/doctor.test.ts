import { describe, expect, it } from 'vitest';

import {
  componentizeBinding,
  meetsMajor,
  runChecks,
  threeVersions,
  type CheckResult,
  type DoctorDeps,
  type ParsedManifest,
} from './doctor.js';
import type { RunResult } from '../lib/run.js';

/** A healthy fake game directory. */
const GAME = 'F:/games/my-fps';

/** Files the happy-path fake filesystem contains. */
const HAPPY_FILES = new Set([
  `${GAME}/package.json`,
  `${GAME}/src/assets.json`,
  `${GAME}/public/arena.spz`,
  `${GAME}/public/shot.ogg`,
  `${GAME}/node_modules/gameable/wit/world.wit`,
]);

/** A manifest matching those files. */
const HAPPY_MANIFEST = {
  version: 1,
  baseUrl: '/',
  assets: [
    { id: 'arena', type: 'splat', src: 'arena.spz' },
    { id: 'shot', type: 'audio', src: 'shot.ogg' },
  ],
};

/**
 * Build a fake dependency set. Everything is healthy unless overridden.
 *
 * @param overrides Fields to replace.
 * @returns Dependencies that touch nothing real.
 */
function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const files = overrides.exists === undefined ? HAPPY_FILES : new Set<string>();
  return {
    cwd: GAME,
    run: fakeRun({}),
    exists: (path: string) => files.has(path),
    readFile: (path: string) => {
      if (path === `${GAME}/src/assets.json`) return JSON.stringify(HAPPY_MANIFEST);
      if (path.endsWith('package.json')) return JSON.stringify({ version: '1.33.0' });
      throw new Error(`unexpected read: ${path}`);
    },
    nodeVersion: '24.14.0',
    platform: 'win32',
    arch: 'x64',
    resolveDir: (_from: string, name: string) => `${GAME}/node_modules/${name}`,
    npmCli: 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js',
    parseManifest: (json: unknown) => json as ParsedManifest,
    ...overrides,
  };
}

/**
 * A fake child-process runner keyed on the first interesting argument.
 *
 * @param responses What each command should produce.
 * @param responses.npmVersion What `npm --version` prints.
 * @param responses.threeTree What `npm ls three --json` prints.
 * @param responses.gitLfsStatus The exit status of `git lfs version`.
 * @returns A runner that never spawns anything.
 */
function fakeRun(responses: {
  npmVersion?: string;
  threeTree?: unknown;
  gitLfsStatus?: number;
}): DoctorDeps['run'] {
  return (file: string, args: readonly string[]): Promise<RunResult> => {
    const done = (status: number, stdout = ''): Promise<RunResult> =>
      Promise.resolve({ status, stdout, stderr: '' });

    if (file === 'git') return done(responses.gitLfsStatus ?? 0, 'git-lfs/3.5.1');
    if (args.includes('--version')) return done(0, responses.npmVersion ?? '11.9.0');
    if (args.includes('ls')) {
      const tree = responses.threeTree ?? {
        name: 'my-fps',
        dependencies: { three: { version: '0.186.0' } },
      };
      return done(0, JSON.stringify(tree));
    }
    return done(0);
  };
}

/**
 * Find one check by name.
 *
 * @param results Everything `runChecks` returned.
 * @param name The check to look for.
 * @returns That result.
 */
function pick(results: readonly CheckResult[], name: string): CheckResult {
  const found = results.find((result) => result.name === name);
  if (!found)
    throw new Error(`no check named ${name}; got ${results.map((r) => r.name).join(', ')}`);
  return found;
}

describe('meetsMajor', () => {
  it('accepts an equal major', () => {
    expect(meetsMajor('24.0.0', 24)).toBe(true);
  });

  it('accepts a newer major', () => {
    expect(meetsMajor('v26.5.1', 24)).toBe(true);
  });

  it('rejects an older major', () => {
    expect(meetsMajor('22.11.0', 24)).toBe(false);
  });

  it('rejects nonsense', () => {
    expect(meetsMajor('not-a-version', 24)).toBe(false);
  });
});

describe('componentizeBinding', () => {
  it('names the msvc binding on Windows', () => {
    expect(componentizeBinding('win32', 'x64')).toBe(
      '@andreiltd/componentize-qjs-binding-win32-x64-msvc',
    );
  });

  it('names the gnu binding on Linux', () => {
    expect(componentizeBinding('linux', 'arm64')).toBe(
      '@andreiltd/componentize-qjs-binding-linux-arm64-gnu',
    );
  });

  it('names the plain binding on macOS', () => {
    expect(componentizeBinding('darwin', 'arm64')).toBe(
      '@andreiltd/componentize-qjs-binding-darwin-arm64',
    );
  });
});

describe('threeVersions', () => {
  it('finds a single top-level three', () => {
    expect(threeVersions({ dependencies: { three: { version: '0.186.0' } } })).toEqual(['0.186.0']);
  });

  it('finds a nested duplicate', () => {
    const tree = {
      dependencies: {
        three: { version: '0.186.0' },
        'some-addon': { version: '1.0.0', dependencies: { three: { version: '0.180.0' } } },
      },
    };
    expect(threeVersions(tree)).toEqual(['0.180.0', '0.186.0']);
  });

  it('deduplicates the same version seen twice', () => {
    const tree = {
      dependencies: {
        three: { version: '0.186.0' },
        a: { dependencies: { three: { version: '0.186.0' } } },
      },
    };
    expect(threeVersions(tree)).toEqual(['0.186.0']);
  });

  it('copes with an empty tree', () => {
    expect(threeVersions({})).toEqual([]);
  });
});

describe('runChecks', () => {
  it('passes on a healthy machine', async () => {
    const results = await runChecks(deps());
    const failures = results.filter((r) => r.status === 'fail');
    expect(failures).toEqual([]);
  });

  it('fails an old node with an install link', async () => {
    const results = await runChecks(deps({ nodeVersion: '22.11.0' }));
    const node = pick(results, 'node');
    expect(node.status).toBe('fail');
    expect(node.fix).toContain('nodejs.org');
  });

  it('fails an old npm', async () => {
    const results = await runChecks(deps({ run: fakeRun({ npmVersion: '10.8.2' }) }));
    expect(pick(results, 'npm').status).toBe('fail');
  });

  it('only warns when git lfs is missing', async () => {
    const results = await runChecks(deps({ run: fakeRun({ gitLfsStatus: 1 }) }));
    expect(pick(results, 'git lfs').status).toBe('warn');
  });

  it('fails two copies of three with a copy-pasteable fix', async () => {
    const results = await runChecks(
      deps({
        run: fakeRun({
          threeTree: {
            dependencies: {
              three: { version: '0.186.0' },
              addon: { dependencies: { three: { version: '0.180.0' } } },
            },
          },
        }),
      }),
    );
    const three = pick(results, 'three');
    expect(three.status).toBe('fail');
    expect(three.fix).toContain('overrides');
  });

  it('fails an invalid manifest and says where', async () => {
    const results = await runChecks(
      deps({
        parseManifest: () => {
          throw new Error('assets[0].id: must match /^[a-z0-9]/');
        },
      }),
    );
    const manifest = pick(results, 'assets.json');
    expect(manifest.status).toBe('fail');
    expect(manifest.detail).toContain('assets[0].id');
  });

  it('fails when a manifest file is not on disk', async () => {
    const results = await runChecks(
      deps({
        exists: (path: string) => HAPPY_FILES.has(path) && path !== `${GAME}/public/shot.ogg`,
      }),
    );
    const files = pick(results, 'asset files');
    expect(files.status).toBe('fail');
    expect(files.detail).toContain('shot');
  });

  it('does not look on disk for a src the game resolves at load time', async () => {
    const results = await runChecks(
      deps({
        parseManifest: () => ({
          baseUrl: '/',
          assets: [
            { id: 'env.arena', src: '@placeholder/arena.spz' },
            { id: 'remote', src: 'https://cdn.example.com/arena.spz' },
          ],
        }),
      }),
    );
    const files = pick(results, 'asset files');
    expect(files.status).toBe('ok');
    expect(files.detail).toContain('1 resolved at load time');
  });

  it('fails when the WIT package cannot be found', async () => {
    const results = await runChecks(deps({ exists: () => false }));
    const wit = pick(results, 'wit');
    expect(wit.status).toBe('fail');
    expect(wit.fix).toContain('npm install gameable');
  });

  it('fails when the componentize binding is missing', async () => {
    const results = await runChecks(
      deps({
        resolveDir: (_from: string, name: string) =>
          name.includes('componentize-qjs-binding') ? undefined : `${GAME}/node_modules/${name}`,
      }),
    );
    const binding = pick(results, 'qjs binding');
    expect(binding.status).toBe('fail');
    expect(binding.fix).toContain('componentize-qjs-binding-win32-x64-msvc');
  });

  it('fails when jco is not installed', async () => {
    const results = await runChecks(deps({ resolveDir: () => undefined }));
    expect(pick(results, 'jco').status).toBe('fail');
    expect(pick(results, 'jco').fix).toContain('npm install');
  });

  it('always warns about WebGPU, because node cannot probe it', async () => {
    const results = await runChecks(deps());
    const webgpu = pick(results, 'webgpu');
    expect(webgpu.status).toBe('warn');
    expect(webgpu.fix).toContain('--enable-unsafe-webgpu');
  });

  it('reports no reserved aos: imports when src/ is not readable', async () => {
    const results = await runChecks(deps());
    expect(pick(results, 'wit imports').status).toBe('ok');
  });

  it('warns rather than fails when there is no manifest at all', async () => {
    const results = await runChecks(
      deps({
        exists: (path: string) => path === `${GAME}/node_modules/gameable/wit/world.wit`,
      }),
    );
    expect(pick(results, 'assets.json').status).toBe('warn');
  });
});
