/**
 * Topic bundles: a subject whose concept pages, package READMEs and recipes
 * leave `llms-full.txt` for a bundle of their own, which also carries the
 * shared pages a model needs beside them.
 *
 * A page opts into a topic by being listed in one of its sets. It then leaves
 * the core corpus and the index's lists, `llms-full.txt` carries the topic's
 * one-line pointer instead, and the index lists the bundle. The site still
 * shows every page, and `docs/recipes/index.md` still links every recipe.
 */
import { exists } from './files.mjs';

/**
 * Packages a game never imports: plumbing under an SDK facade. `net` is the wire protocol,
 * transports and rooms behind `ctx.players` and `ctx.net`, so a model writing a game reads the
 * SDK's README for multiplayer and has no use for the protocol's; `rooms` is the room server
 * and client on Colyseus, which a game reaches only through `multiplayer()`.
 */
export const PLUMBING_PACKAGES = new Set(['net', 'rooms']);

/** Recipes about rooms and Play Solo, by basename in `docs/recipes/`. */
export const MULTIPLAYER_RECIPES = new Set([
  'play-with-friends.md',
  'send-a-message.md',
  'add-a-lobby.md',
  'add-a-vote.md',
]);

/** Concept pages about rooms, by basename in `docs/concepts/`. */
export const MULTIPLAYER_CONCEPTS = new Set(['multiplayer.md']);

/** Concept pages about splat characters, by basename in `docs/concepts/`. */
export const CHARACTER_CONCEPTS = new Set(['characters.md']);

/** Packages of the character stack, by directory name in `packages/`. */
export const CHARACTER_PACKAGES = new Set(['character']);

/**
 * Recipes about loading and driving a splat character, by basename in `docs/recipes/`. The
 * sample-character and animation recipes stay in the core corpus: the third-person template
 * uses them.
 */
export const CHARACTER_RECIPES = new Set([
  'give-an-npc-a-face.md',
  'load-a-character-from-asset-manager.md',
  'load-a-character.md',
  'preview-a-rig-without-decoders.md',
]);

/**
 * A topic's own pages, in bundle order: its concepts, then `middle` (the shared pages it
 * needs), then its package READMEs, then its recipes, each set alphabetically.
 *
 * @param {{ concepts: Set<string>, packages: Set<string>, recipes: Set<string> }} topic The topic.
 * @param {string[]} middle Repo-relative pages between the concepts and the READMEs.
 * @returns {string[]} Repo-relative paths that exist on disk, after AGENTS.md.
 */
function topicFiles(topic, middle) {
  return [
    'AGENTS.md',
    ...[...topic.concepts].sort().map((f) => `docs/concepts/${f}`),
    ...middle,
    ...[...topic.packages].sort().map((n) => `packages/${n}/README.md`),
    ...[...topic.recipes].sort().map((f) => `docs/recipes/${f}`),
  ].filter(exists);
}

/** The rooms bundle: the concept page, the sdk README, a room game, net and rooms, the recipes. */
const MULTIPLAYER = {
  output: 'llms-multiplayer.txt',
  title: 'Gameable Engine — multiplayer: rooms, the room server and Play Solo',
  summary: 'The model, the SDK, a room game, the net and rooms packages and the recipes.',
  pointer: 'Multiplayer: see llms-multiplayer.txt',
  index: 'rooms.',
  concepts: MULTIPLAYER_CONCEPTS,
  packages: PLUMBING_PACKAGES,
  recipes: MULTIPLAYER_RECIPES,
};

/** The character bundle: the concept page, the sdk README, the character package, the recipes. */
const CHARACTER = {
  output: 'llms-character.txt',
  title: 'Gameable Engine — splat characters in a game',
  summary: 'The character model, the SDK, the character package and the character recipes.',
  pointer: 'Characters: see llms-character.txt',
  index: 'splat characters.',
  concepts: CHARACTER_CONCEPTS,
  packages: CHARACTER_PACKAGES,
  recipes: CHARACTER_RECIPES,
};

/**
 * `llms-multiplayer.txt`'s files: AGENTS.md (the preamble says to read it first), the
 * multiplayer concepts, the sdk README (where `ctx.players` and `ctx.net` are), the mystery
 * example's `game.ts` (a room game whose systems say where they run), the net and rooms
 * READMEs, then the multiplayer recipes.
 *
 * @returns {string[]} Repo-relative paths that exist on disk.
 */
export function multiplayerFiles() {
  return topicFiles(MULTIPLAYER, ['packages/sdk/README.md', 'templates/mystery/src/game.ts']);
}

/**
 * `llms-character.txt`'s files: AGENTS.md, the characters concept page, the sdk README (where
 * `spawn-character`, `set-expression` and `look-at` are), the character package's README, then
 * the character recipes.
 *
 * @returns {string[]} Repo-relative paths that exist on disk.
 */
export function characterFiles() {
  return topicFiles(CHARACTER, ['packages/sdk/README.md']);
}

/** Recipes the survive kit's bundle carries, by basename in `docs/recipes/`. */
export const SURVIVE_RECIPES = new Set(['add-a-night-cycle.md']);

/** The survive kit's bundle: the rooms concept, the sdk README, the kit's game, its recipes. */
const SURVIVE = {
  output: 'llms-survive.txt',
  title: 'Gameable Engine — the survive kit: day/night survival for four to six players',
  summary: "The rooms model, the SDK, the kit's game and prefabs, and the night cycle recipe.",
  pointer: 'The survive kit: see llms-survive.txt',
  index: 'the survive kit.',
  concepts: MULTIPLAYER_CONCEPTS,
  packages: new Set(),
  recipes: SURVIVE_RECIPES,
};

/**
 * `llms-survive.txt`'s files: AGENTS.md, the multiplayer concept page, the sdk README, the
 * kit's AGENTS.md, `game.ts` and `prefabs.ts`, the room recipes it builds on, then its own.
 *
 * @returns {string[]} Repo-relative paths that exist on disk.
 */
export function surviveFiles() {
  return topicFiles(SURVIVE, [
    'packages/sdk/README.md',
    'templates/survive/AGENTS.md',
    'templates/survive/src/game.ts',
    'templates/survive/src/prefabs.ts',
    'docs/recipes/play-with-friends.md',
    'docs/recipes/send-a-message.md',
  ]);
}

/** Recipes for the hangout kit (`templates/hangout`), by basename in `docs/recipes/`. */
export const HANGOUT_RECIPES = new Set(['park-another-car.md']);

/** The hangout kit's bundle: the kit and the room pages it needs, nothing else. */
const HANGOUT = {
  output: 'llms-hangout.txt',
  title: 'Gameable Engine — the hangout kit: a street for up to twelve friends',
  summary: 'The hangout template, the multiplayer model, the SDK and the recipes a hangout needs.',
  pointer: 'Hangout kit: see llms-hangout.txt',
  index: 'the hangout kit.',
  concepts: new Set(),
  packages: new Set(),
  recipes: HANGOUT_RECIPES,
};

/**
 * `llms-hangout.txt`'s files: AGENTS.md, the multiplayer concept page, the sdk README, the
 * kit's own AGENTS.md and README, the four files a change starts in (the game, the street, the
 * prefabs, the messages), the two room recipes it builds on, then its own recipes.
 *
 * @returns {string[]} Repo-relative paths that exist on disk.
 */
export function hangoutFiles() {
  return topicFiles(HANGOUT, [
    'docs/concepts/multiplayer.md',
    'packages/sdk/README.md',
    'templates/hangout/AGENTS.md',
    'templates/hangout/README.md',
    'templates/hangout/src/game.ts',
    'templates/hangout/src/street.ts',
    'templates/hangout/src/prefabs.ts',
    'templates/hangout/src/messages.ts',
    'docs/recipes/play-with-friends.md',
    'docs/recipes/send-a-message.md',
  ]);
}

/**
 * The mystery kit's bundle: the multiplayer concepts and the kit's recipes, which are the
 * multiplayer topic's own (it owns them; this bundle carries copies). No packages of its own.
 */
const MYSTERY = {
  output: 'llms-mystery.txt',
  title: 'Gameable Engine — the mystery kit: a hidden-role multiplayer round',
  summary: 'Everything needed to change the mystery kit (templates/mystery), and nothing else.',
  pointer: 'The mystery kit: see llms-mystery.txt',
  index: 'the mystery kit (templates/mystery).',
  concepts: MULTIPLAYER_CONCEPTS,
  packages: new Set(),
  recipes: MULTIPLAYER_RECIPES,
};

/**
 * `llms-mystery.txt`'s files: AGENTS.md, the multiplayer concept page, the ECS page, the sdk
 * README, the kit's AGENTS.md, README, `game.ts`, `prefabs.ts`, `messages.ts` and `round.ts`,
 * then the recipes it lists: play with friends, send a message, add a lobby, add a vote.
 *
 * @returns {string[]} Repo-relative paths that exist on disk.
 */
export function mysteryFiles() {
  return topicFiles(MYSTERY, [
    'docs/concepts/ecs.md',
    'packages/sdk/README.md',
    'templates/mystery/AGENTS.md',
    'templates/mystery/README.md',
    'templates/mystery/src/game.ts',
    'templates/mystery/src/prefabs.ts',
    'templates/mystery/src/messages.ts',
    'templates/mystery/src/round.ts',
  ]);
}

/** Recipes for the brawl kit (`templates/brawl`), by basename in `docs/recipes/`. */
export const BRAWL_RECIPES = new Set(['add-a-kick.md']);

/** The brawl kit's bundle: the kit and the room pages it needs, nothing else. */
const BRAWL = {
  output: 'llms-brawl.txt',
  title: 'Gameable Engine — the brawl kit: a fighting arena for 2 to 4 players',
  summary:
    'The brawl template, the multiplayer model, the SDK and the recipes a fighting game needs.',
  pointer: 'Brawl kit: see llms-brawl.txt',
  index: 'the brawl kit.',
  concepts: new Set(),
  packages: new Set(),
  recipes: BRAWL_RECIPES,
};

/**
 * `llms-brawl.txt`'s files: AGENTS.md, the multiplayer concept page (prediction is there), the
 * sdk README, the kit's own AGENTS.md and README, the files a change starts in (the game, the
 * abilities, the messages, the movement, the round), the two room recipes it builds on, then its
 * own recipes.
 *
 * @returns {string[]} Repo-relative paths that exist on disk.
 */
export function brawlFiles() {
  return topicFiles(BRAWL, [
    'docs/concepts/multiplayer.md',
    'packages/sdk/README.md',
    'templates/brawl/AGENTS.md',
    'templates/brawl/README.md',
    'templates/brawl/src/game.ts',
    'templates/brawl/src/systems/abilities.ts',
    'templates/brawl/src/messages.ts',
    'templates/brawl/src/systems/move.ts',
    'templates/brawl/src/systems/round.ts',
    'docs/recipes/play-with-friends.md',
    'docs/recipes/send-a-message.md',
  ]);
}

/** Recipes for the steal kit (`templates/steal`), by basename in `docs/recipes/`. */
export const STEAL_RECIPES = new Set(['save-player-progress.md']);

/** The steal kit's bundle: the kit, the room and ECS pages it needs, and its recipes. */
const STEAL = {
  output: 'llms-steal.txt',
  title: 'Gameable Engine — the steal kit: steal-a-brainrot with saved player progress',
  summary:
    'The steal template, the multiplayer model, the SDK (ctx.data) and the recipes it needs.',
  pointer: 'Steal kit: see llms-steal.txt',
  index: 'the steal kit.',
  concepts: new Set(),
  packages: new Set(),
  recipes: STEAL_RECIPES,
};

/**
 * `llms-steal.txt`'s files: AGENTS.md, the multiplayer and ECS concept pages, the sdk README
 * (where `ctx.data` is), the kit's own AGENTS.md and README, the files a change starts in (the
 * game, the wallet, the steal, the prefabs), the two room recipes it builds on, then its own.
 *
 * @returns {string[]} Repo-relative paths that exist on disk.
 */
export function stealFiles() {
  return topicFiles(STEAL, [
    'docs/concepts/multiplayer.md',
    'docs/concepts/ecs.md',
    'packages/sdk/README.md',
    'templates/steal/AGENTS.md',
    'templates/steal/README.md',
    'templates/steal/src/game.ts',
    'templates/steal/src/wallet.ts',
    'templates/steal/src/systems/steal.ts',
    'templates/steal/src/prefabs.ts',
    'docs/recipes/play-with-friends.md',
    'docs/recipes/send-a-message.md',
  ]);
}

/** Recipes the collect kit's bundle carries, by basename in `docs/recipes/`. */
export const COLLECT_RECIPES = new Set(['trade-with-another-player.md']);

/** The collect kit's bundle: the rooms concept, the sdk README, the kit's game, its recipes. */
const COLLECT = {
  output: 'llms-collect.txt',
  title: 'Gameable Engine — the collect kit: eggs, pets and trades for up to eight players',
  summary: "The rooms model, the SDK, the kit's game, documents and trades, and the trade recipe.",
  pointer: 'The collect kit: see llms-collect.txt',
  index: 'the collect kit.',
  concepts: MULTIPLAYER_CONCEPTS,
  packages: new Set(),
  recipes: COLLECT_RECIPES,
};

/**
 * `llms-collect.txt`'s files: AGENTS.md, the multiplayer concept page, the sdk README, the
 * kit's AGENTS.md, README, `game.ts`, `pets.ts`, its messages and trade system, the room
 * recipes it builds on, then its own.
 *
 * @returns {string[]} Repo-relative paths that exist on disk.
 */
export function collectFiles() {
  return topicFiles(COLLECT, [
    'packages/sdk/README.md',
    'templates/collect/AGENTS.md',
    'templates/collect/README.md',
    'templates/collect/src/game.ts',
    'templates/collect/src/pets.ts',
    'templates/collect/src/messages.ts',
    'templates/collect/src/systems/trade.ts',
    'docs/recipes/play-with-friends.md',
    'docs/recipes/send-a-message.md',
  ]);
}

/** Every topic bundle, in the order the index lists them, with its file list. */
export const TOPICS = [
  { ...MULTIPLAYER, files: multiplayerFiles },
  { ...CHARACTER, files: characterFiles },
  { ...MYSTERY, files: mysteryFiles },
  { ...SURVIVE, files: surviveFiles },
  { ...HANGOUT, files: hangoutFiles },
  { ...BRAWL, files: brawlFiles },
  { ...STEAL, files: stealFiles },
  { ...COLLECT, files: collectFiles },
];

/** @returns {string[]} Concept basenames some topic owns. */
export const topicConcepts = () => TOPICS.flatMap((t) => [...t.concepts]);

/** @returns {Set<string>} Package names some topic owns. */
export const topicPackages = () => new Set(TOPICS.flatMap((t) => [...t.packages]));

/** @returns {string[]} Recipe basenames some topic owns. */
export const topicRecipes = () => TOPICS.flatMap((t) => [...t.recipes]);
