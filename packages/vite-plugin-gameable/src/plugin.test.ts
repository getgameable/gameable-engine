import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultClientConditions } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

import { ALWAYS_EXCLUDED, gameable, resolveGameableConfig, resolveGameableMode } from './plugin';
import type { DevMiddleware, EmitContext } from './plugin';

/** Temporary directories a test made, removed afterwards. */
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A scratch app root with a transpiled guest in it.
 *
 * @param files Relative path to contents.
 * @returns The absolute root.
 */
function appRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'aos-vite-'));
  temporary.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

describe('resolveGameableMode', () => {
  it('is direct for the dev server and wasm for a build', () => {
    expect(resolveGameableMode({}, { command: 'serve', env: {} })).toBe('direct');
    expect(resolveGameableMode({}, { command: 'build', env: {} })).toBe('wasm');
  });

  it('lets GAMEABLE_WASM force the wasm sandbox in dev', () => {
    expect(resolveGameableMode({}, { command: 'serve', env: { GAMEABLE_WASM: '1' } })).toBe('wasm');
  });

  it('lets GAMEABLE_MODE force either way, including a direct build', () => {
    expect(resolveGameableMode({}, { command: 'build', env: { GAMEABLE_MODE: 'direct' } })).toBe(
      'direct',
    );
    expect(resolveGameableMode({}, { command: 'serve', env: { GAMEABLE_MODE: 'wasm' } })).toBe(
      'wasm',
    );
  });

  it('gives the explicit option the last word', () => {
    const env = { command: 'build', env: { GAMEABLE_MODE: 'wasm', GAMEABLE_WASM: '1' } } as const;
    expect(resolveGameableMode({ mode: 'direct' }, env)).toBe('direct');
  });

  it("lets Vite's own --mode pick the sandbox, so `vite build --mode direct` works", () => {
    expect(resolveGameableMode({}, { command: 'build', viteMode: 'direct', env: {} })).toBe(
      'direct',
    );
    expect(resolveGameableMode({}, { command: 'serve', viteMode: 'wasm', env: {} })).toBe('wasm');
    // Vite's default modes say nothing about the sandbox.
    expect(resolveGameableMode({}, { command: 'build', viteMode: 'production', env: {} })).toBe(
      'wasm',
    );
  });

  it('ignores a nonsense GAMEABLE_MODE', () => {
    expect(resolveGameableMode({}, { command: 'serve', env: { GAMEABLE_MODE: 'banana' } })).toBe(
      'direct',
    );
  });
});

describe('resolveGameableConfig', () => {
  it('adds the gameable-source condition and the three alias', () => {
    const config = resolveGameableConfig({}, { command: 'serve', env: {} });
    expect(config.conditions).toEqual(['gameable-source']);
    expect(config.alias).toHaveLength(1);
    expect(config.alias[0].replacement).toBe('three/webgpu');
    expect(config.alias[0].find.test('three')).toBe(true);
    expect(config.alias[0].find.test('three/webgpu')).toBe(false);
    expect(config.alias[0].find.test('three-mesh-bvh')).toBe(false);
  });

  it('excludes the wasm runtimes from the pre-bundle', () => {
    const config = resolveGameableConfig({ exclude: ['my-wasm'] }, { command: 'serve', env: {} });
    expect(config.exclude).toEqual([...ALWAYS_EXCLUDED, 'my-wasm']);
  });

  it('publishes the mode and the guest URL as defines', () => {
    const config = resolveGameableConfig({}, { command: 'build', env: {} });
    expect(config.define['import.meta.env.GAMEABLE_MODE']).toBe('"wasm"');
    expect(config.define['import.meta.env.GAMEABLE_GUEST_URL']).toBe('"/guest/game.js"');
  });

  it('honours the app base when building the guest URL', () => {
    const config = resolveGameableConfig({}, { command: 'build', env: {}, base: '/my-game/' });
    expect(config.guestUrl).toBe('/my-game/guest/game.js');
  });

  it('normalises a base without a trailing slash and a custom guest path', () => {
    const config = resolveGameableConfig(
      { guestBase: '/mod/' },
      { command: 'build', env: {}, base: '/x' },
    );
    expect(config.guestBase).toBe('/x/mod/');
    expect(config.guestOutDir).toBe('mod/');
    expect(config.guestUrl).toBe('/x/mod/game.js');
  });

  it('can be told to leave three and the condition alone', () => {
    const config = resolveGameableConfig(
      { three: false, source: false },
      { command: 'serve', env: {} },
    );
    expect(config.alias).toEqual([]);
    expect(config.conditions).toEqual([]);
    // the old name still works
    expect(
      resolveGameableConfig({ development: false }, { command: 'serve', env: {} }).conditions,
    ).toEqual([]);
  });
});

describe('gameable()', () => {
  it('is a pre-enforced plugin', () => {
    const plugin = gameable();
    expect(plugin.name).toBe('gameable');
    expect(plugin.enforce).toBe('pre');
  });

  it('contributes the whole configuration from the config hook', () => {
    const plugin = gameable({ mode: 'direct' });
    const contributed = plugin.config?.(
      { base: '/' },
      { command: 'build', mode: 'production' },
    ) as {
      resolve: { conditions: string[]; alias: unknown[] };
      optimizeDeps: { exclude: string[] };
      define: Record<string, string>;
      build: { target: string; assetsInlineLimit: (p: string) => boolean | undefined };
    };
    // Setting resolve.conditions replaces Vite's defaults (Vite 6+), so the
    // plugin must keep them: without `browser`, a dependency with a browser
    // build (ws, under @colyseus/sdk) resolves to its Node build in the page.
    expect(contributed.resolve.conditions).toEqual(['gameable-source', ...defaultClientConditions]);
    expect(contributed.resolve.conditions).toContain('browser');
    expect(contributed.resolve.alias).toHaveLength(1);
    expect(contributed.optimizeDeps.exclude).toContain('jolt-physics');
    expect(contributed.define['import.meta.env.GAMEABLE_MODE']).toBe('"direct"');
    expect(contributed.build.target).toBe('esnext');
    expect(contributed.build.assetsInlineLimit('a/b.wasm')).toBe(false);
    expect(contributed.build.assetsInlineLimit('a/arena.collider.bin')).toBe(false);
    expect(contributed.build.assetsInlineLimit('a/arena.spz')).toBe(false);
    expect(contributed.build.assetsInlineLimit('a/b.png')).toBeUndefined();
  });

  it('serves the transpiled guest off disk in dev', () => {
    const root = appRoot({ 'build/guest/game.js': 'export const instantiate = 1;' });
    const plugin = gameable();
    plugin.configResolved?.({ root, base: '/' });

    let middleware: DevMiddleware | undefined;
    plugin.configureServer?.({ middlewares: { use: (fn) => (middleware = fn) } });
    expect(middleware).toBeDefined();

    const headers: Record<string, string> = {};
    let body: unknown;
    let nexted = false;
    middleware?.(
      { url: '/guest/game.js' },
      {
        setHeader: (name, value) => (headers[name] = value),
        statusCode: 200,
        end: (chunk) => (body = chunk),
      },
      () => (nexted = true),
    );
    expect(nexted).toBe(false);
    expect(headers['Content-Type']).toBe('text/javascript');
    expect(String(body)).toContain('instantiate');
  });

  it('refuses to serve outside the guest directory', () => {
    const root = appRoot({ 'build/guest/game.js': 'x', 'secret.txt': 'no' });
    const plugin = gameable();
    plugin.configResolved?.({ root, base: '/' });
    let middleware: DevMiddleware | undefined;
    plugin.configureServer?.({ middlewares: { use: (fn) => (middleware = fn) } });

    let nexted = false;
    middleware?.(
      { url: '/guest/../../secret.txt' },
      { setHeader: () => undefined, statusCode: 200, end: () => undefined },
      () => (nexted = true),
    );
    expect(nexted).toBe(true);
  });

  it('labels every other .wasm response', () => {
    const plugin = gameable();
    plugin.configResolved?.({ root: appRoot(), base: '/' });
    let middleware: DevMiddleware | undefined;
    plugin.configureServer?.({ middlewares: { use: (fn) => (middleware = fn) } });

    const headers: Record<string, string> = {};
    middleware?.(
      { url: '/node_modules/.vite/deps/jolt-physics.wasm.wasm?v=1' },
      { setHeader: (n, v) => (headers[n] = v), statusCode: 200, end: () => undefined },
      () => undefined,
    );
    expect(headers['Content-Type']).toBe('application/wasm');
  });

  it('emits the guest into a wasm-mode build', () => {
    const root = appRoot({
      'build/guest/game.js': 'guest',
      'build/guest/game.core.wasm': 'core',
      'build/guest/interfaces/gameable-engine-env.d.ts': 'types',
    });
    const plugin = gameable({ mode: 'wasm' });
    plugin.configResolved?.({ root, base: '/' });

    const emitted: string[] = [];
    const context: EmitContext = {
      emitFile: (asset) => emitted.push(asset.fileName),
      warn: () => undefined,
    };
    plugin.generateBundle?.call(context);
    expect(emitted).toEqual([
      'guest/game.core.wasm',
      'guest/game.js',
      'guest/interfaces/gameable-engine-env.d.ts',
    ]);
  });

  it('emits the guest relative to outDir under a sub-path base', () => {
    // The docs site hosts the games at `/play/<name>/`. The file name must not
    // carry the base: Vite serves `outDir` from the base, so a prefixed name
    // would land at `/play/fps/play/fps/guest/` while the URL says
    // `/play/fps/guest/`.
    const root = appRoot({ 'build/guest/game.js': 'guest' });
    const plugin = gameable({ mode: 'wasm' });
    plugin.config?.({ base: '/play/fps/' }, { command: 'build', mode: 'production' });
    plugin.configResolved?.({ root, base: '/play/fps/' });

    const emitted: string[] = [];
    plugin.generateBundle?.call({
      emitFile: (asset) => emitted.push(asset.fileName),
      warn: () => undefined,
    });
    expect(emitted).toEqual(['guest/game.js']);
  });

  it('keeps the mode the config hook chose through configResolved', () => {
    const plugin = gameable();
    plugin.config?.({ base: '/' }, { command: 'build', mode: 'direct' });
    plugin.configResolved?.({ root: appRoot(), base: '/' });
    const warnings: string[] = [];
    plugin.generateBundle?.call({
      emitFile: () => undefined,
      warn: (message) => warnings.push(message),
    });
    expect(warnings[0]).toMatch(/this direct build has none/); // the direct-mode note, not the wasm one
  });

  it('warns rather than failing when the guest was never built', () => {
    const plugin = gameable({ mode: 'wasm' });
    plugin.configResolved?.({ root: appRoot(), base: '/' });
    const warnings: string[] = [];
    plugin.generateBundle?.call({
      emitFile: () => undefined,
      warn: (message) => warnings.push(message),
    });
    expect(warnings[0]).toContain('npm run build:guest');
  });
});
