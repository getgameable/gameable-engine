/**
 * The core corpus (`llms-full.txt`'s files, in their fixed order) and the
 * preamble every engine bundle opens with.
 */
import { exists, ordered, packageNames, templateNames } from './files.mjs';
import { topicConcepts, topicPackages, topicRecipes } from './topics.mjs';

/**
 * Packages for apps outside the engine, whose guide ships as its own standalone bundle: left
 * out of the game-building corpus (`llms-full.txt`) and the index's package list, which point
 * at that bundle instead. A model building a game has no use for them.
 */
const OUTSIDE_PACKAGES = new Set(['gameable-character']);

/**
 * Concept pages in reading order. Anything in `docs/concepts/` that is not
 * listed here is appended alphabetically, so a new page lands in the corpus
 * without an edit; the list only fixes the order of the ones a reader needs
 * first. `docs/.vitepress/config.ts` keeps the same order for the sidebar.
 */
export const CONCEPT_ORDER = [
  'index.md',
  'engine-loop.md',
  'modules.md',
  'assets.md',
  'wasm-boundary.md',
  'ecs.md',
  'splats.md',
  'characters.md',
  'animation.md',
  'physics.md',
];

/**
 * Package names the corpus and the index describe.
 *
 * @returns {string[]} `packageNames()` without {@link OUTSIDE_PACKAGES} or a topic's packages.
 */
export function corpusPackageNames() {
  const routed = topicPackages();
  return packageNames().filter((n) => !OUTSIDE_PACKAGES.has(n) && !routed.has(n));
}

/**
 * @returns {string[]} The concept pages the core corpus and the index list, in reading order.
 */
export function corpusConcepts() {
  return ordered('docs/concepts', /\.md$/, CONCEPT_ORDER, ['README.md', ...topicConcepts()]);
}

/**
 * The core corpus, in the fixed order the bundles must preserve: the rules, the
 * overview, the tutorials, the concept tour and its pages, one README per
 * package, the recipe listing and its recipes, the schemas, then the two
 * reference pages. The topic bundles' own pages (`topics.mjs`) are not in it.
 *
 * One thing is deliberately absent, and it is still on the site and in
 * `llms.txt`. The corpus is everything a model needs to build a game, not every
 * file in `docs/`:
 *
 * - `docs/schemas/*.json` are 11 KB of JSON Schema that say what
 *   `docs/concepts/assets.md` already says in prose, and a model that genuinely
 *   needs the machine-readable form can open the file. Inlining them costs 4% of
 *   the budget for a duplicate.
 *
 * @returns {string[]} Repo-relative paths that exist on disk.
 */
export function corpusFiles() {
  return [
    'AGENTS.md',
    'docs/index.md',
    ...ordered('docs/start', /\.md$/, ['index.md']),
    ...corpusConcepts(),
    ...corpusPackageNames().map((n) => `packages/${n}/README.md`),
    ...ordered('docs/recipes', /\.md$/, ['index.md'], topicRecipes()),
    'docs/troubleshooting.md',
    'docs/glossary.md',
  ].filter(exists);
}

/**
 * The "How to use these files" preamble every bundle opens with.
 *
 * A small model that is handed 60 KB of markdown with no instructions reads it
 * as reference material and then improvises. This says, in the first thing it
 * reads, what the files are for and what the path through them is.
 *
 * @returns {string} The preamble, ending in a blank line.
 */
export function preamble() {
  const templates = templateNames();
  const list =
    templates.length > 0 ? templates.map((t) => `templates/${t}`).join(' or ') : 'a template';
  return [
    '# How to use these files',
    '',
    'A generated bundle of the Gameable Engine docs. Each file starts with `# FILE: <path>`.',
    '',
    '1. Read AGENTS.md, the first file below. Its numbered rules are enforced by',
    '   ESLint and `npm run check`, not advice.',
    `2. Copy ${list}, or run`,
    `   \`npm create gameable my-game -- --template ${templates[0] ?? 'fps'}\`.`,
    '3. Edit `src/game.ts` and `src/prefabs.ts` — plus `src/systems/*.ts` and',
    '   `src/assets.json` when a recipe says so. **Never edit `packages/*`**: if a',
    '   game needs an engine change, say so and stop. That is a missing feature.',
    '4. Run `npm run dev`, open http://localhost:5173. A save is a reload; there is',
    '   no build step.',
    '5. For one task, ask for its recipe by name ("show me',
    '   docs/recipes/add-a-weapon.md"). Each is Goal / Files you will edit / Steps /',
    '   Verify / See also, and touches at most two files. docs/recipes/index.md',
    '   lists them all.',
    '',
    'Assets are addressed by string id, never a path or URL. Nothing in a system',
    'allocates. Import `three/webgpu`, never bare `three`.',
    '',
  ].join('\n');
}
