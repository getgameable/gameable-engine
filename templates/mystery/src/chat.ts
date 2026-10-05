/**
 * Chat text: the cap, the cleaning, and the last few lines every HUD shows.
 *
 * A line is plain text from start to finish. It is cleaned here (control,
 * zero-width and direction characters become spaces, runs of space collapse,
 * the length is capped) and drawn by the HUD with `textContent`, never as
 * HTML. Shared by the guest and the page (`src/chatPrompt.ts`): no DOM here.
 */

/** The longest line, in UTF-16 code units. The page's input has the same cap. */
export const CHAT_MAX_CHARS = 120;
/** The longest name shown beside a line. */
export const NAME_MAX_CHARS = 24;
/** Lines every HUD keeps. */
export const CHAT_LINES = 3;

/**
 * @param c A UTF-16 code unit.
 * @returns True for one a chat line shows as a space: whitespace, control,
 *   zero-width, filler and bidirectional characters (U+061C included).
 */
function blank(c: number): boolean {
  return (
    c <= 0x20 ||
    (c >= 0x7f && c <= 0xa0) ||
    c === 0x061c ||
    c === 0x115f ||
    c === 0x1160 ||
    c === 0x180e ||
    (c >= 0x2000 && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202f) ||
    (c >= 0x2060 && c <= 0x206f) ||
    c === 0x3000 ||
    c === 0x3164 ||
    c === 0xfeff ||
    c === 0xffa0 ||
    (c >= 0xfff9 && c <= 0xfffb)
  );
}

/**
 * @param raw The text.
 * @param i An index into it.
 * @returns 2 when a surrogate pair starts at `i`, 1 for any other code unit
 *   but a lone surrogate, and 0 for a lone surrogate.
 */
function unitsAt(raw: string, i: number): number {
  const c = raw.charCodeAt(i);
  if (c < 0xd800 || c > 0xdfff) return 1;
  if (c >= 0xdc00) return 0; // a low surrogate with no high one before it
  const next = raw.charCodeAt(i + 1);
  return next >= 0xdc00 && next <= 0xdfff ? 2 : 0;
}

/**
 * Clean a line of user text for display: blanks and lone surrogates become
 * single spaces, the ends are trimmed and the length is capped without
 * splitting a surrogate pair. A lone surrogate is 6 bytes of JSON, so keeping
 * none is what keeps a capped line's echo under its message's byte cap.
 *
 * @param raw What was typed.
 * @param max The cap, in code units.
 * @returns The cleaned text, possibly empty.
 */
export function cleanText(raw: string, max: number): string {
  let out = '';
  let space = false;
  for (let i = 0; i < raw.length; i += 1) {
    const units = unitsAt(raw, i);
    if (units === 0 || blank(raw.charCodeAt(i))) {
      space = out !== '';
      continue;
    }
    if (out.length + (space ? 1 : 0) + units > max) break;
    if (space) out += ' ';
    space = false;
    out += units === 2 ? raw.slice(i, i + 2) : raw[i];
    i += units - 1;
  }
  return out;
}

/**
 * What the page's chat prompt sends for what was typed.
 *
 * @param raw The input's value.
 * @returns The `chat` payload, or null when there is nothing to say.
 */
export function chatPayload(raw: string): { text: string } | null {
  const text = cleanText(raw, CHAT_MAX_CHARS);
  return text === '' ? null : { text };
}

/** The last `CHAT_LINES` lines, oldest first. Authority state. */
export class ChatLog {
  /** The lines, oldest first; `''` for none yet. */
  readonly lines: string[] = [];

  constructor() {
    this.reset();
  }

  /** Forget every line. Call from `defineGame({ init })`. */
  reset(): void {
    this.lines.length = 0;
    for (let i = 0; i < CHAT_LINES; i += 1) this.lines.push('');
  }

  /** @param line A new line, already cleaned. The oldest one goes. */
  push(line: string): void {
    for (let i = 1; i < CHAT_LINES; i += 1) this.lines[i - 1] = this.lines[i];
    this.lines[CHAT_LINES - 1] = line;
  }
}

/** This guest's chat log: every line but a ghost's during a round. */
export const chatLog = new ChatLog();
/** Every line, ghosts' included: what a ghost's HUD shows during a round. */
export const ghostLog = new ChatLog();
