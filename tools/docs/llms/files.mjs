/**
 * File helpers the llms generator shares: the repository root, reading and
 * listing files, the package and template names, and concatenating files into
 * a bundle.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the repository root. */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Read a repo-relative file as UTF-8.
 *
 * @param {string} rel Repo-relative, forward-slashed path.
 * @returns {string} File contents.
 */
export function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * @param {string} rel Repo-relative path.
 * @returns {boolean} True when the file is on disk.
 */
export function exists(rel) {
  return existsSync(join(ROOT, rel));
}

/**
 * Sorted repo-relative paths of files in `dir` matching `re`.
 *
 * @param {string} dir Repo-relative directory.
 * @param {RegExp} re Filename test.
 * @returns {string[]} Sorted repo-relative paths.
 */
export function listDir(dir, re) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => re.test(f))
    .sort()
    .map((f) => `${dir}/${f}`);
}

/**
 * Order the files of a directory: `preferred` first, in that order, then
 * whatever else is there, alphabetically.
 *
 * @param {string} dir Repo-relative directory.
 * @param {RegExp} re Filename test.
 * @param {string[]} preferred Basenames to pull to the front.
 * @param {string[]} skip Basenames to leave out entirely.
 * @returns {string[]} Repo-relative paths.
 */
export function ordered(dir, re, preferred = [], skip = []) {
  const all = listDir(dir, re)
    .map((p) => p.slice(dir.length + 1))
    .filter((f) => !skip.includes(f));
  const head = preferred.filter((f) => all.includes(f));
  const tail = all.filter((f) => !head.includes(f));
  return [...head, ...tail].map((f) => `${dir}/${f}`);
}

/**
 * Workspace package directory names, sorted.
 *
 * @returns {string[]} Package directory names.
 */
export function packageNames() {
  const abs = join(ROOT, 'packages');
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Template directory names that a scaffold can be copied from, sorted.
 *
 * @returns {string[]} Template directory names, e.g. `['fps', 'third-person']`.
 */
export function templateNames() {
  const abs = join(ROOT, 'templates');
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(abs, e.name, 'package.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * Concatenate files with `# FILE: <path>` separators.
 *
 * @param {string[]} files Repo-relative paths.
 * @returns {string} The concatenated bundle.
 */
export function concatFiles(files) {
  let out = '';
  for (const f of files) {
    out += `# FILE: ${f}\n\n`;
    out += read(f).replace(/\s+$/, '');
    out += '\n\n';
  }
  return out;
}

/**
 * A standalone bundle's files, each under its own name (`# FILE: gameable-character.md`): the
 * reader has no checkout of the engine, so a repository path would name a file they cannot open.
 *
 * @param {string[]} files Repo-relative paths.
 * @returns {string} The concatenated bundle.
 */
export function standaloneFiles(files) {
  let out = '';
  for (const f of files) {
    out += `# FILE: ${f.split('/').pop()}\n\n`;
    out += read(f).replace(/\s+$/, '');
    out += '\n\n';
  }
  return out;
}

/**
 * Format a byte count.
 *
 * @param {number} n Bytes.
 * @returns {string} Human-readable size.
 */
export function fmt(n) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${String(n)} B`;
}
