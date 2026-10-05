/**
 * Turning a template's workspace dependencies into something a standalone game
 * can install.
 *
 * Templates are workspace members, so they declare `"gameable": "*"`
 * (or `workspace:*`, if npm ever grows the protocol). Neither resolves outside
 * the monorepo. A scaffolded game gets either a published semver range or, when
 * `create-gameable` is being run from a checkout of the engine itself, a
 * `file:` link straight back at `packages/gameable`, so a change to the engine shows up
 * in the game without a publish.
 */
import { relativeSpecifier, toPosix } from './paths.js';

/** How engine dependencies are pointed at the engine. */
export type LinkMode = 'file' | 'semver' | 'packed';

/** Everything {@link engineDependency} needs to decide. */
export interface VersionContext {
  /** Published range, or `file:` links back into a checkout. */
  readonly mode: LinkMode;
  /** The version to publish against, in `semver` mode. */
  readonly version: string;
  /** The engine repository root, required in `file` mode. */
  readonly repoRoot?: string;
  /** Directory containing npm-pack tarballs, required in packed mode. */
  readonly packagesDir?: string;
  /** Absolute path to the game being created, for relative `file:` links. */
  readonly gameDir: string;
}

/** Dependency specifiers that mean "the copy in this workspace". */
const WORKSPACE_SPECS = new Set(['0.0.0', '*', 'workspace:*', 'workspace:^', 'workspace:~']);

/**
 * Is this the engine package?
 *
 * Templates depend on the one published package, `gameable`; the workspace
 * packages behind it (`@gameable/*`) are bundled into it and never installed
 * on their own.
 *
 * @param name A dependency name.
 * @returns True for `gameable`.
 */
export function isEnginePackage(name: string): boolean {
  return name === 'gameable';
}

/**
 * The version specifier a generated game should use for one dependency.
 *
 * Anything that is not the engine package, and the engine pinned to a real
 * version, is left exactly as the template wrote it. Pinning is a hard rule
 * here, not a preference.
 *
 * @param name The dependency name.
 * @param spec What the template declared.
 * @param ctx Publishing mode, version and paths.
 * @returns The specifier to write into the game's `package.json`.
 */
export function engineDependency(name: string, spec: string, ctx: VersionContext): string {
  if (!isEnginePackage(name)) return spec;

  if (ctx.mode === 'packed') {
    if (ctx.packagesDir === undefined) throw new Error('packed mode requires packagesDir');
    const version = WORKSPACE_SPECS.has(spec) ? ctx.version : spec;
    const archive = `gameable-${version}.tgz`;
    return `file:${relativeSpecifier(toPosix(ctx.gameDir), `${toPosix(ctx.packagesDir)}/${archive}`)}`;
  }
  if (!WORKSPACE_SPECS.has(spec)) return spec;

  if (ctx.mode === 'file' && ctx.repoRoot !== undefined) {
    return `file:${relativeSpecifier(toPosix(ctx.gameDir), `${toPosix(ctx.repoRoot)}/packages/gameable`)}`;
  }

  return ctx.version;
}

/**
 * Rewrite every dependency block of a template's `package.json`.
 *
 * @param pkg The parsed manifest. Not mutated.
 * @param ctx Publishing mode, version and paths.
 * @returns A new manifest with engine dependencies rewritten.
 */
export function rewriteDependencies(
  pkg: Readonly<Record<string, unknown>>,
  ctx: VersionContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...pkg };
  for (const block of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = pkg[block];
    if (typeof deps !== 'object' || deps === null) continue;
    const rewritten: Record<string, string> = {};
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      rewritten[name] = typeof spec === 'string' ? engineDependency(name, spec, ctx) : String(spec);
    }
    out[block] = rewritten;
  }
  return out;
}

/**
 * Build the game's own `package.json` from the template's.
 *
 * Everything that only makes sense inside the monorepo is dropped: the
 * workspace `private` flag, the `files` allow-list, and any `workspaces` key a
 * template might have inherited.
 *
 * @param template The template's parsed manifest.
 * @param name The new game's package name.
 * @param ctx Publishing mode, version and paths.
 * @returns The manifest to write, pretty-printed by the caller.
 */
export function gamePackageJson(
  template: Readonly<Record<string, unknown>>,
  name: string,
  ctx: VersionContext,
): Record<string, unknown> {
  const rewritten = rewriteDependencies(template, ctx);
  delete rewritten.files;
  delete rewritten.workspaces;
  delete rewritten.publishConfig;
  // The game is the author's own work: the engine's licence is not theirs to inherit.
  delete rewritten.license;
  return {
    ...rewritten,
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
  };
}
