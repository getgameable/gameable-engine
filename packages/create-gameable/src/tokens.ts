/**
 * `{{token}}` substitution, and the `template.json` that declares which tokens
 * a template uses.
 *
 * Templates are real workspace members: they are typechecked, linted and tested
 * in CI before anyone copies one. That only works if the placeholders are inert
 * in the template itself, so they live in strings and comments, never in
 * identifiers.
 */

/** Values substituted into a template. */
export type TokenMap = Readonly<Record<string, string>>;

/** What a template declares about itself. */
export interface TemplateManifest {
  /** Directory name, for example `fps`. */
  readonly name: string;
  /** Human title, used in the generated README and `index.html`. */
  readonly title: string;
  /** One line for the template chooser. */
  readonly description: string;
  /** Default token values, overridden by the command line. */
  readonly tokens: TokenMap;
  /** Paths, relative to the template root, that are never copied. */
  readonly exclude: readonly string[];
  /** Paths renamed on the way out, for example `_gitignore` to `.gitignore`. */
  readonly rename: Readonly<Record<string, string>>;
}

/** What a template gets when it ships no `template.json`. */
export const DEFAULT_MANIFEST: Omit<TemplateManifest, 'name' | 'title'> = {
  description: '',
  tokens: {},
  exclude: [],
  rename: {},
};

/** Files npm refuses to ship verbatim, and the names they travel under. */
export const SHIPPED_AS: Readonly<Record<string, string>> = {
  '.gitignore': '_gitignore',
  '.npmrc': '_npmrc',
};

/**
 * Replace every `{{token}}` in a string.
 *
 * Unknown tokens are left alone rather than blanked, so a mistake is visible in
 * the generated file instead of silently producing an empty string.
 *
 * @param text The template text.
 * @param tokens Values to substitute.
 * @returns The substituted text.
 */
export function applyTokens(text: string, tokens: TokenMap): string {
  return text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (whole, key: string) =>
    Object.hasOwn(tokens, key) ? (tokens[key] ?? whole) : whole,
  );
}

/**
 * Every `{{token}}` still present in a string.
 *
 * @param text Substituted text.
 * @returns Distinct token names, sorted; empty when substitution was complete.
 */
export function leftoverTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)) {
    const key = match.at(1);
    if (key !== undefined) found.add(key);
  }
  return [...found].sort();
}

/**
 * Turn a directory name into a package name npm will accept.
 *
 * @param raw What the user typed, for example `My FPS!`.
 * @returns A lowercase, dash-separated name, for example `my-fps`.
 */
export function toPackageName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_.]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return cleaned === '' ? 'my-game' : cleaned;
}

/**
 * Turn a package name into a human title.
 *
 * @param name A package name, for example `my-fps`.
 * @returns A title, for example `My Fps`.
 */
export function toTitle(name: string): string {
  return name
    .split(/[-_.]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Read a `template.json`, filling in everything it left out.
 *
 * @param name The template directory name.
 * @param raw The parsed `template.json`, or `undefined` when there is none.
 * @returns A complete manifest.
 */
export function normaliseManifest(name: string, raw: unknown): TemplateManifest {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    name: typeof record.name === 'string' ? record.name : name,
    title: typeof record.title === 'string' ? record.title : toTitle(name),
    description: typeof record.description === 'string' ? record.description : '',
    tokens: isStringRecord(record.tokens) ? record.tokens : {},
    exclude: Array.isArray(record.exclude) ? record.exclude.filter(isString) : [],
    rename: isStringRecord(record.rename) ? record.rename : {},
  };
}

/**
 * Is this a plain object whose values are all strings?
 *
 * @param value Anything.
 * @returns True when it can be used as a token map.
 */
function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(isString);
}

/**
 * Is this a string?
 *
 * @param value Anything.
 * @returns True when it is a string.
 */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}
