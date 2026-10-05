import { describe, expect, it } from 'vitest';

import {
  engineDependency,
  gamePackageJson,
  isEnginePackage,
  rewriteDependencies,
  type VersionContext,
} from './versions.js';

const PUBLISHED: VersionContext = {
  mode: 'semver',
  version: '0.4.2',
  gameDir: 'F:/games/my-fps',
};

const LINKED: VersionContext = {
  mode: 'file',
  version: '0.0.0',
  repoRoot: 'F:/work/aos/gameable',
  gameDir: 'F:/work/aos/gameable/scratch/my-fps',
};

describe('isEnginePackage', () => {
  it('recognises the one published package, not the workspace ones', () => {
    expect(isEnginePackage('gameable')).toBe(true);
    expect(isEnginePackage('@gameable/sdk')).toBe(false);
    expect(isEnginePackage('three')).toBe(false);
  });
});

describe('engineDependency', () => {
  it('turns a workspace pin into a exact published version', () => {
    expect(engineDependency('gameable', '0.0.0', PUBLISHED)).toBe('0.4.2');
  });

  it('keeps an unpublished version exact', () => {
    expect(engineDependency('gameable', '0.0.0', { ...PUBLISHED, version: '0.0.0' })).toBe('0.0.0');
  });

  it('understands the workspace protocol too', () => {
    expect(engineDependency('gameable', 'workspace:*', PUBLISHED)).toBe('0.4.2');
  });

  it('links back into a checkout with a relative file: path', () => {
    expect(engineDependency('gameable', '*', LINKED)).toBe('file:../../packages/gameable');
  });

  it('leaves a third-party dependency exactly as pinned', () => {
    expect(engineDependency('three', '0.186.0', PUBLISHED)).toBe('0.186.0');
  });

  it('leaves an engine package that is already pinned to a real version', () => {
    expect(engineDependency('gameable', '0.3.1', PUBLISHED)).toBe('0.3.1');
  });

  it('never emits a backslash in a file: link', () => {
    expect(engineDependency('gameable', '0.0.0', LINKED)).not.toContain('\\');
  });
});

describe('packed dependencies', () => {
  it('uses tarballs outside the engine workspace and preserves exact pins', () => {
    const ctx: VersionContext = {
      mode: 'packed',
      version: '0.0.0',
      gameDir: '/games/mystery',
      packagesDir: '/games/packs',
    };
    expect(engineDependency('gameable', '*', ctx)).toBe('file:../packs/gameable-0.0.0.tgz');
    expect(engineDependency('gameable', '0.3.1', ctx)).toBe('file:../packs/gameable-0.3.1.tgz');
    expect(engineDependency('three', '0.186.0', ctx)).toBe('0.186.0');
  });
  it('rejects packed mode without an archive directory', () => {
    expect(() => engineDependency('gameable', '*', { ...PUBLISHED, mode: 'packed' })).toThrow(
      'packagesDir',
    );
  });
});

describe('rewriteDependencies', () => {
  it('rewrites every dependency block', () => {
    const out = rewriteDependencies(
      {
        dependencies: { gameable: '*', three: '0.186.0' },
        devDependencies: { gameable: '0.0.0', vite: '8.3.0' },
      },
      PUBLISHED,
    );
    expect(out.dependencies).toEqual({ gameable: '0.4.2', three: '0.186.0' });
    expect(out.devDependencies).toEqual({ gameable: '0.4.2', vite: '8.3.0' });
  });

  it('leaves the original untouched', () => {
    const input = { dependencies: { gameable: '0.0.0' } };
    rewriteDependencies(input, PUBLISHED);
    expect(input.dependencies.gameable).toBe('0.0.0');
  });

  it('copes with no dependencies at all', () => {
    expect(rewriteDependencies({ name: 'x' }, PUBLISHED)).toEqual({ name: 'x' });
  });
});

describe('gamePackageJson', () => {
  it('renames, versions and privatises', () => {
    const pkg = gamePackageJson(
      {
        name: '@gameable/template-fps',
        version: '0.0.0',
        private: true,
        scripts: { dev: 'vite' },
      },
      'my-fps',
      PUBLISHED,
    );
    expect(pkg.name).toBe('my-fps');
    expect(pkg.version).toBe('0.1.0');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.scripts).toEqual({ dev: 'vite' });
  });

  it('drops workspace-only fields', () => {
    const pkg = gamePackageJson(
      { files: ['dist'], workspaces: ['packages/*'], publishConfig: { access: 'public' } },
      'my-fps',
      PUBLISHED,
    );
    expect(pkg.files).toBeUndefined();
    expect(pkg.workspaces).toBeUndefined();
    expect(pkg.publishConfig).toBeUndefined();
  });
});
