/**
 * `create-gameable` — the scaffolder behind `npm create gameable`.
 *
 * The command is `bin/create-gameable.mjs`; everything it does is exported
 * here so a tool can scaffold a game without spawning a process.
 *
 * @example
 * ```ts
 * import { scaffold, findTemplate } from 'create-gameable';
 *
 * const template = findTemplate(process.cwd(), 'fps');
 * if (template) {
 *   scaffold({
 *     targetDir: 'F:/games/my-fps',
 *     templateDir: template.dir,
 *     manifest: template.manifest,
 *     name: 'my-fps',
 *     title: 'My FPS',
 *     versions: { mode: 'semver', version: '0.1.0', gameDir: 'F:/games/my-fps' },
 *     aam: false,
 *   });
 * }
 * ```
 */

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'create-gameable';
 *
 * console.log(PACKAGE); // 'create-gameable'
 * ```
 */
export const PACKAGE = 'create-gameable' as const;

export { CREATE_HELP, CREATE_SPEC, main, ownVersion } from './create.js';

export {
  GITIGNORE,
  SKIP_DIRS,
  SKIP_FILES,
  TEXT_EXTENSIONS,
  TEXT_NAMES,
  agentsMd,
  envExample,
  hoistExtendedTsconfig,
  isTextFile,
  outputName,
  scaffold,
  stripDanglingSchema,
} from './scaffold.js';
export type { ScaffoldOptions, ScaffoldResult } from './scaffold.js';

export { findTemplate, listTemplates, readManifest, templateRoots } from './templates.js';
export type { Template } from './templates.js';

export {
  DEFAULT_MANIFEST,
  SHIPPED_AS,
  applyTokens,
  leftoverTokens,
  normaliseManifest,
  toPackageName,
  toTitle,
} from './tokens.js';
export type { TemplateManifest, TokenMap } from './tokens.js';

export {
  engineDependency,
  gamePackageJson,
  isEnginePackage,
  rewriteDependencies,
} from './versions.js';
export type { LinkMode, VersionContext } from './versions.js';

export { flagBool, flagNumber, flagString, parseArgs } from './args.js';
export type { ArgSpec, ParsedArgs } from './args.js';

export { absPosix, findRepoRoot, packageDirOf, relativeSpecifier, toPosix } from './paths.js';
