/**
 * Turning a model's answer into files on disk.
 *
 * The output contract the runner sends is deliberately the dumbest thing that
 * works — no diffs, no line numbers, no tool calls, because a 7B model gets
 * all three wrong:
 *
 * ````text
 * ```ts
 * // file: src/systems/shotgun.ts
 * <the whole new file>
 * ```
 * ````
 *
 * This module is the only place that trusts a model, so it is the only place
 * that has to be paranoid: a path that is absolute, that climbs out with `..`,
 * that names a Windows drive, or that lands anywhere but `src/` is rejected
 * and recorded, never written.
 */

/** One file the model asked for. */
export interface ParsedFile {
  /** Repo-relative, forward-slashed, guaranteed to start with `src/`. */
  readonly path: string;
  /** The full new contents, with the trailing newline normalised. */
  readonly content: string;
}

/** One file the model asked for that will not be written. */
export interface RejectedFile {
  /** Exactly what the model wrote, for the transcript. */
  readonly path: string;
  /** Why it was refused. */
  readonly reason: string;
}

/** Everything the parser found. */
export interface ParseResult {
  /** Files that passed every check, in the order they appeared. */
  readonly files: readonly ParsedFile[];
  /** Files that did not, with a reason each. */
  readonly rejected: readonly RejectedFile[];
  /** How many fenced blocks were seen, including ones with no `// file:` line. */
  readonly blocks: number;
}

/** Matches the marker line, in the comment syntaxes a model reaches for. */
const MARKER = /^\s*(?:\/\/|#|--|\/\*|<!--)\s*file:\s*(.+?)\s*(?:\*\/|-->)?\s*$/;

/** Matches a fence opener or closer: three or more backticks or tildes. */
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)/;

/**
 * Parse a model response into files.
 *
 * Accepts the marker inside the fence (the contract) and immediately above it
 * (what models do anyway). Prose outside fences is ignored rather than fatal:
 * a model that explains itself and then produces correct files has still done
 * the job, and the scorer measures the files.
 *
 * @param response The raw completion text.
 * @param options `root` is the only directory writes are allowed under; default `src`.
 * @returns The files, the rejections, and how many fences were seen.
 */
export function parseFences(
  response: string,
  options: { readonly root?: string } = {},
): ParseResult {
  const root = (options.root ?? 'src').replace(/\/+$/, '');
  const lines = response.split(/\r?\n/);
  const files: ParsedFile[] = [];
  const rejected: RejectedFile[] = [];
  let blocks = 0;

  /** The marker seen on the line just before a fence opener, if any. */
  let pending: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const open = FENCE.exec(line);
    if (open === null) {
      const marker = MARKER.exec(line);
      pending = marker?.[1];
      continue;
    }

    const delimiter = open[2] ?? '```';
    const body: string[] = [];
    let closed = false;
    for (i += 1; i < lines.length; i += 1) {
      const inner = lines[i] ?? '';
      const close = FENCE.exec(inner);
      // A closer is the same character, at least as long, and carries no info.
      if (
        close !== null &&
        (close[2] ?? '')[0] === delimiter[0] &&
        (close[2] ?? '').length >= delimiter.length &&
        (close[3] ?? '') === ''
      ) {
        closed = true;
        break;
      }
      body.push(inner);
    }
    blocks += 1;

    let raw = pending;
    pending = undefined;
    if (raw === undefined) {
      // Skip blank lines, then look for the marker on the first real line.
      let first = 0;
      while (first < body.length && (body[first] ?? '').trim() === '') first += 1;
      const marker = MARKER.exec(body[first] ?? '');
      if (marker !== null) {
        raw = marker[1];
        body.splice(0, first + 1);
      }
    }

    if (raw === undefined) continue;
    if (!closed) {
      rejected.push({ path: raw, reason: 'unterminated fence (response was truncated)' });
      continue;
    }

    const verdict = safePath(raw, root);
    if (typeof verdict !== 'string') {
      rejected.push({ path: raw, reason: verdict.reason });
      continue;
    }
    files.push({ path: verdict, content: `${trimBlankEdges(body).join('\n')}\n` });
  }

  return { files, rejected, blocks };
}

/**
 * Validate one path from a model.
 *
 * @param raw What the model wrote after `// file:`.
 * @param root The only directory writes are allowed under.
 * @returns The normalised path, or a rejection reason.
 */
export function safePath(raw: string, root = 'src'): string | { reason: string } {
  const cleaned = raw
    .trim()
    .replace(/^[`'"]|[`'"]$/g, '')
    .replaceAll('\\', '/')
    .trim();

  if (cleaned === '') return { reason: 'empty path' };
  if (/^[a-zA-Z]:\//.test(cleaned)) return { reason: 'absolute path (drive letter) rejected' };
  if (cleaned.startsWith('/')) return { reason: 'absolute path rejected' };
  if (cleaned.startsWith('//')) return { reason: 'UNC path rejected' };
  if (cleaned.includes('\0')) return { reason: 'NUL byte in path' };

  const segments = cleaned.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    return { reason: 'path traversal (..) rejected' };
  }
  const normalised = segments.join('/');
  const prefix = `${root}/`;
  if (!normalised.startsWith(prefix)) {
    return { reason: `outside ${prefix} — the game may only edit its own source` };
  }
  if (normalised.length > 200) return { reason: 'path is implausibly long' };
  return normalised;
}

/**
 * Drop leading and trailing blank lines from a block body.
 *
 * @param body The lines between the fences.
 * @returns The same lines with blank edges removed.
 */
function trimBlankEdges(body: readonly string[]): string[] {
  let start = 0;
  let end = body.length;
  while (start < end && (body[start] ?? '').trim() === '') start += 1;
  while (end > start && (body[end - 1] ?? '').trim() === '') end -= 1;
  return body.slice(start, end);
}

/** The contract appended to every user message. Exported so tests can assert on it. */
export const OUTPUT_CONTRACT = `
Respond with one or more fenced code blocks and nothing else. No explanation,
no diff, no prose before or after. Each block starts with a file marker and
then contains the COMPLETE new contents of that file:

\`\`\`ts
// file: src/game.ts
<the entire file, not a fragment>
\`\`\`

Rules:
- One block per file. Include every file you changed, in full.
- Paths are relative to the game directory and must start with \`src/\`.
- Do not invent engine APIs. Everything you may import from \`gameable\`
  is in the documentation above; if something you want is not there, solve the
  task with what is.
- The result must typecheck and build as-is.
`.trim();
