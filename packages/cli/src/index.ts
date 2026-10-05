/**
 * `gameable/cli` — the `gameable` command, and the pieces of it other
 * packages reuse.
 *
 * The guest build pipeline is the interesting export: `gameable/vite`
 * runs it on demand during development and `create-gameable` runs it once after
 * scaffolding, and all three go through the identical jco invocation.
 *
 * @example
 * ```ts
 * import { guestBuild } from 'gameable/cli';
 *
 * const result = await guestBuild({ gameDir: 'F:/games/my-fps', release: true });
 * console.log(result.guestEntry); // 'F:/games/my-fps/dist/guest/game.js'
 * ```
 */

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/cli';
 *
 * console.log(PACKAGE); // 'gameable/cli'
 * ```
 */
export const PACKAGE = 'gameable' as const;

export { main } from './cli.js';

export {
  GuestBuildError,
  bundleConfigSource,
  directorySize,
  entrySource,
  generateGuestTypes,
  guestBuild,
  newestMtime,
  resolveToolchain,
  sdkAliases,
} from './lib/guestBuild.js';
export type { GuestBuildOptions, GuestBuildResult, GuestToolchain } from './lib/guestBuild.js';

export { flagBool, flagNumber, flagString, parseArgs } from './lib/args.js';
export type { ArgSpec, ParsedArgs } from './lib/args.js';

export { color, colorEnabled, mark, stripAnsi } from './lib/colors.js';

export {
  absPosix,
  findRepoRoot,
  findUp,
  isAbsolutePath,
  packageDirOf,
  relativeSpecifier,
  resolveFrom,
  resolvePackageDir,
  toPosix,
} from './lib/paths.js';

export { filterJcoNoise, run, runNode } from './lib/run.js';
export type { RunOptions, RunResult, Runner } from './lib/run.js';

export {
  DEFAULT_GATES,
  brotliSize,
  checkGates,
  formatBytes,
  formatReport,
  measure,
  percentile,
} from './lib/report.js';
export type { MeasureOptions, ReportGates, ReportNumbers } from './lib/report.js';

export { buildCommand } from './commands/build.js';
export { devCommand } from './commands/dev.js';
export { docsCommand, findBundle } from './commands/docs.js';
export {
  componentizeBinding,
  doctorCommand,
  findNpmCli,
  meetsMajor,
  realDeps,
  runChecks,
  threeVersions,
} from './commands/doctor.js';
export type { CheckResult, CheckStatus, DoctorDeps } from './commands/doctor.js';
