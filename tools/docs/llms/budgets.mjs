/**
 * The bundles' names and budgets, in a module of their own: `docs/.vitepress/config.ts`
 * imports `publish-llms.mjs`, which needs only these, and VitePress's config bundler cannot
 * load `gen-llms.mjs` (a script with a shebang, which it moves off the first line).
 */

/**
 * Byte budgets, enforced here and again in `lint.mjs`, which also warns when a bundle has less
 * than {@link HEADROOM_WARNING} of its budget left.
 *
 * `llms-full.txt` stays at 360 KB, about 90k tokens: the point of the cap is that one file fits
 * a model's context. When it fills, a topic moves out into its own bundle (`llms/topics.mjs`),
 * as rooms (`llms-multiplayer.txt`) and splat characters (`llms-character.txt`) did; the cap is
 * raised only together with such a move, and the reason recorded here.
 */
export const BUDGETS = {
  'llms-full.txt': 360 * 1024,
  // 6 KB from 4 (the multiplayer kits): every kit adds one index line; the index stays a page, not a corpus.
  'llms.txt': 6 * 1024,
  'llms-fps.txt': 72 * 1024,
  'llms-third-person.txt': 72 * 1024,
  'llms-three-character.txt': 28 * 1024,
  'llms-visit.txt': 72 * 1024,
  'llms-multiplayer.txt': 120 * 1024,
  'llms-character.txt': 96 * 1024,
  'llms-survive.txt': 72 * 1024,
  'llms-hangout.txt': 72 * 1024,
  'llms-mystery.txt': 120 * 1024,
  'llms-brawl.txt': 80 * 1024,
  'llms-steal.txt': 96 * 1024,
  'llms-collect.txt': 80 * 1024,
};

/** The share of a budget below which `docs:lint` warns that a bundle is nearly full. */
export const HEADROOM_WARNING = 0.05;

/** Output file names, in the order they are written. `publish-llms.mjs` publishes these. */
export const OUTPUTS = Object.keys(BUDGETS);
