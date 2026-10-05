/**
 * The whole argument parser. No `commander`, no `minimist`.
 *
 * Four forms are understood and nothing else:
 *
 * - `--flag` and `--no-flag` for booleans,
 * - `--key value` and `--key=value` for options that take a value,
 * - `-t` and friends, when the command declares an alias,
 * - `--`, after which everything is a positional.
 *
 * Anything the caller did not declare lands in {@link ParsedArgs.unknown} so a
 * typo produces a real error instead of silently doing the wrong thing.
 */

/** What a command accepts. */
export interface ArgSpec {
  /** Option names that consume the following token, for example `port`. */
  readonly value?: readonly string[];
  /** Option names that are `true`, `false` (via `--no-x`) or absent. */
  readonly boolean?: readonly string[];
  /** Single-character aliases, for example `{ t: 'template' }`. */
  readonly alias?: Readonly<Record<string, string>>;
}

/** The result of {@link parseArgs}. */
export interface ParsedArgs {
  /** Everything that was not an option, in order. */
  readonly positionals: readonly string[];
  /** Declared options that were present. */
  readonly flags: Readonly<Record<string, string | boolean>>;
  /** Tokens that looked like options but were not declared. */
  readonly unknown: readonly string[];
}

/**
 * Parse an argv slice.
 *
 * @param argv Arguments after the command name.
 * @param spec What this command accepts.
 * @returns Positionals, flags and anything undeclared.
 */
export function parseArgs(argv: readonly string[], spec: ArgSpec = {}): ParsedArgs {
  const valueNames = new Set(spec.value ?? []);
  const boolNames = new Set(spec.boolean ?? []);
  const alias = spec.alias ?? {};

  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const unknown: string[] = [];
  let passthrough = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    const rawName = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    const name = normalise(rawName, alias);

    if (name === undefined) {
      unknown.push(rawName);
      continue;
    }

    if (name.startsWith('no-')) {
      const positive = name.slice(3);
      if (boolNames.has(positive)) {
        flags[positive] = false;
        continue;
      }
      unknown.push(rawName);
      continue;
    }

    if (valueNames.has(name)) {
      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
        continue;
      }
      const next = argv.at(i + 1);
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        unknown.push(`${rawName} (expected a value)`);
        continue;
      }
      flags[name] = next;
      i += 1;
      continue;
    }

    if (boolNames.has(name)) {
      flags[name] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }

    unknown.push(rawName);
  }

  return { positionals, flags, unknown };
}

/**
 * Turn `-t` or `--template` into `template`.
 *
 * @param raw The token up to any `=`.
 * @param alias Single-character aliases.
 * @returns The long name, or `undefined` when the token is not an option.
 */
function normalise(raw: string, alias: Readonly<Record<string, string>>): string | undefined {
  if (raw.startsWith('--')) return raw.slice(2);
  const short = raw.slice(1);
  if (short.length !== 1) return undefined;
  return alias[short];
}

/**
 * Read a boolean flag.
 *
 * @param flags Parsed flags.
 * @param name Option name.
 * @param fallback Value to use when the option is absent.
 * @returns The flag value.
 */
export function flagBool(
  flags: Readonly<Record<string, string | boolean | undefined>>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  if (typeof raw === 'boolean') return raw;
  return raw !== 'false' && raw !== '0';
}

/**
 * Read a string flag.
 *
 * @param flags Parsed flags.
 * @param name Option name.
 * @param fallback Value to use when the option is absent.
 * @returns The flag value.
 */
export function flagString(
  flags: Readonly<Record<string, string | boolean | undefined>>,
  name: string,
  fallback: string,
): string {
  const raw = flags[name];
  if (typeof raw === 'string') return raw;
  return fallback;
}

/**
 * Read a numeric flag.
 *
 * @param flags Parsed flags.
 * @param name Option name.
 * @param fallback Value to use when the option is absent or unparseable.
 * @returns The flag value.
 */
export function flagNumber(
  flags: Readonly<Record<string, string | boolean | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = flags[name];
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
