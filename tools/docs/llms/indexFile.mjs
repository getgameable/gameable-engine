/**
 * The spec-style `llms.txt` index: the bundles, the templates, and one line
 * per page of the core corpus.
 */
import { corpusConcepts, corpusPackageNames } from './corpus.mjs';
import { exists, listDir, ordered, read, templateNames } from './files.mjs';
import { TOPICS } from './topics.mjs';

/**
 * First non-heading, non-directive paragraph of a markdown file, flattened to
 * one line and truncated. Used for the index notes.
 *
 * @param {string} rel Repo-relative markdown path.
 * @param {number} max Maximum characters.
 * @returns {string} A one-line summary.
 */
function firstLine(rel, max = 72) {
  const body = read(rel)
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/^#.*$/gm, '')
    .replace(/^:::[\s\S]*?:::$/gm, '')
    .replace(/^>.*$/gm, '')
    .replace(/```[\s\S]*?```/g, '');
  const para = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 20 && !p.startsWith('|') && !p.startsWith('-'));
  if (!para) return '';
  const flat = para.replace(/\s+/g, ' ').replace(/[`*[\]]/g, '');
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The first level-1 heading of a markdown file.
 *
 * @param {string} rel Repo-relative markdown path.
 * @returns {string} Heading text, or the file's basename.
 */
function titleOf(rel) {
  const m = /^#\s+(.+)$/m.exec(read(rel));
  return m ? m[1].trim() : rel.split('/').pop();
}

/**
 * @param {string} name A bundle's file name.
 * @param {string} note What it is for.
 * @returns {string} Its index line.
 */
const bundleLine = (name, note) => `- [${name}](${name}): ${note}`;

/**
 * Build the spec-style `llms.txt` index.
 *
 * @returns {string} The index document.
 */
export function buildIndex() {
  const l = [];
  l.push('# Gameable Engine');
  l.push('');
  l.push(
    '> Gameable Engine (`aos-gameable-engine`) is a browser game engine: gaussian-splat worlds rendered by three.js on WebGPU, with all game logic compiled to a WebAssembly component.',
  );
  l.push('');
  l.push(
    'Status: M0-M3 shipped. Building a game? Read one task bundle below, copy a template, edit src/game.ts, run `npm run dev`, follow one recipe. Never read the whole repository; never edit packages/*.',
  );
  l.push('');

  l.push('## Bundles');
  l.push('');
  l.push(bundleLine('llms-fps.txt', 'first-person shooter.'));
  l.push(bundleLine('llms-third-person.txt', 'third-person adventure.'));
  l.push(bundleLine('llms-three-character.txt', 'a character in a three.js app.'));
  l.push(bundleLine('llms-visit.txt', 'a character page.'));
  for (const topic of TOPICS) l.push(bundleLine(topic.output, topic.index));
  l.push(bundleLine('llms-full.txt', 'the core corpus, without the topics above.'));
  l.push('');

  l.push('## Templates');
  l.push('');
  for (const t of templateNames()) {
    l.push(`- [templates/${t}](templates/${t}/src/game.ts)`);
  }
  l.push('');

  l.push('## Start here');
  l.push('');
  l.push('- [AGENTS.md](AGENTS.md): hard rules, commands, repository map.');
  l.push('- [Overview](docs/index.md): what the engine is; the 60-second quickstart.');
  // Titles only: a tutorial's title says what it is, and a 42-character cut of its first
  // paragraph did not. The bytes go to the next bundle's line (this file is capped at 4 KB).
  for (const f of ordered('docs/start', /\.md$/, ['index.md'])) {
    l.push(`- [${titleOf(f)}](${f})`);
  }
  l.push('');

  l.push('## Concepts');
  l.push('');
  for (const f of corpusConcepts()) {
    l.push(`- [${titleOf(f)}](${f}): ${firstLine(f, 42)}`);
  }
  l.push('');

  l.push('## Packages');
  l.push('');
  for (const n of corpusPackageNames()) {
    const rel = `packages/${n}/README.md`;
    if (!exists(rel)) continue;
    l.push(`- [@gameable/${n}](${rel})`);
  }
  l.push('');

  l.push('## Schemas');
  l.push('');
  for (const f of listDir('docs/schemas', /\.json$/)) {
    /** @type {{ title?: string, description?: string }} */
    const doc = JSON.parse(read(f));
    l.push(`- [${doc.title ?? f}](${f}): JSON Schema, draft 2020-12.`);
  }
  l.push('');

  l.push('## Reference');
  l.push('');
  l.push('- [Recipes](docs/recipes/index.md): every recipe, by genre.');
  l.push('- [Troubleshooting](docs/troubleshooting.md): symptom-first fixes.');
  l.push('- [Glossary](docs/glossary.md): project-specific terms.');
  l.push('- [API reference](docs/api/): TypeDoc markdown; run `npm run docs:api`.');
  l.push('');

  return l.join('\n');
}
