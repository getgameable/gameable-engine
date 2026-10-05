/**
 * The componentize entry factory.
 *
 * `jco componentize` compiles exactly one module. That module must export a
 * `game` namespace object and import the versioned `gameable:engine/*@0.2.0`
 * specifiers — which only resolve inside componentize, so this file can never
 * be part of the browser bundle. A build therefore *generates* a tiny entry
 * per game:
 *
 * ```ts
 * // build/entry.ts — generated
 * import { createGuestExports } from '<sdk>/src/wit/entry.ts';
 * import definition from '<game>/src/game.ts';
 *
 * export const game = createGuestExports(definition);
 * ```
 *
 * and hands that to `jco componentize`. `fixtures/tiny-game/scripts/build.mjs`
 * is the reference implementation.
 *
 * Importing this module runs the prelude first, so QuickJS has `console`,
 * `TextEncoder` and `TextDecoder` before any game module scope executes.
 */
// Any program that reaches this file through `gameable/sdk/wit/entry` needs the
// ambient `gameable:engine/*` declarations, not only the sdk project itself.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./generated/wit.d.ts" />
import '../prelude';

import * as env from 'gameable:engine/env@0.2.0';
import * as assets from 'gameable:engine/assets@0.2.0';
import * as physicsQuery from 'gameable:engine/physics-query@0.2.0';

import { createGuest } from '../runtime';
import type { GameDefinition } from '../defineGame';
import type {
  FrameInput,
  FrameOutput,
  GameConfig,
  GuestExports,
  HostApi,
  OverlapHit,
  QueryFilter,
  RayHit,
  RayQuery,
  Vec3,
} from '../types';

/**
 * The WIT imports, adapted to the SDK's `HostApi`.
 *
 * Two coercions matter. `env.seed()` is a `u64`: `bigint` on the host but a
 * plain `number` in the guest, so `Number()` is a no-op here and load-bearing
 * on the host side. `option` returns arrive as `null` in the guest and
 * `undefined` on the host; `HostApi` accepts both and the facades normalise.
 */
export const hostImports: HostApi = {
  log: (level, msg) => {
    env.log(level, msg);
  },
  seed: () => Number(env.seed()),
  nowMs: () => env.nowMs(),
  raycast: (
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    filter: QueryFilter,
  ): RayHit | undefined | null => physicsQuery.raycast(origin, direction, maxDistance, filter),
  raycastBatch: (rays: readonly RayQuery[]): readonly (RayHit | undefined | null)[] =>
    physicsQuery.raycastBatch(rays as unknown as Parameters<typeof physicsQuery.raycastBatch>[0]),
  overlapSphere: (
    center: Vec3,
    radius: number,
    filter: QueryFilter,
    maxResults: number,
  ): readonly OverlapHit[] => physicsQuery.overlapSphere(center, radius, filter, maxResults),
  resolveId: (name: string) => assets.resolveId(name),
  describe: (id: number) => assets.describe(id),
};

/**
 * Build the `game` namespace the WIT world exports.
 *
 * @param definition The game's `defineGame` result.
 * @returns The five exported functions, with WIT calling conventions applied:
 *   `init` and `restore` throw a `game-error` record on failure, which jco
 *   lowers into `result<_, game-error>`.
 *
 * @example
 * ```ts
 * import { createGuestExports } from 'gameable/sdk/wit/entry';
 * import definition from './game';
 *
 * export const game = createGuestExports(definition);
 * ```
 */
export function createGuestExports(definition: GameDefinition): GuestExports {
  const guest = createGuest(hostImports, definition);
  return {
    init(config: GameConfig): void {
      // `seed` is a u64: a plain number in the guest. `options` is an
      // `option<string>`, which arrives as `null` rather than `undefined`.
      guest.init({
        seed: Number(config.seed),
        fixedHz: config.fixedHz,
        viewportWidth: config.viewportWidth,
        viewportHeight: config.viewportHeight,
        devMode: config.devMode,
        options: config.options ?? undefined,
      });
    },
    tick(frameInput: FrameInput): FrameOutput {
      return guest.tick(frameInput);
    },
    shutdown(): void {
      guest.shutdown();
    },
    snapshot(): Uint8Array {
      return guest.snapshot();
    },
    restore(state: ArrayLike<number>): void {
      guest.restore(state);
    },
  };
}
