/**
 * A twenty-line stand-in for `picocolors`.
 *
 * The CLI ships with three dependencies and none of them is a colour library.
 * Colour is disabled when the stream is not a TTY, when `NO_COLOR` is set, or
 * when `TERM=dumb`, and forced on by `FORCE_COLOR`.
 */

/** True when ANSI sequences should be emitted. */
const enabled = ((): boolean => {
  const env = process.env;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return process.stdout.isTTY;
})();

/**
 * Build one colour function.
 *
 * @param open SGR code that turns the attribute on.
 * @param close SGR code that turns it off again.
 * @returns A function wrapping its argument, or the identity when colour is off.
 */
function sgr(open: number, close: number): (text: string) => string {
  const prefix = `[${String(open)}m`;
  const suffix = `[${String(close)}m`;
  return (text: string): string => (enabled ? `${prefix}${text}${suffix}` : text);
}

/** The colours the CLI uses, in `picocolors` shape. */
export const color = {
  /** Failures. */
  red: sgr(31, 39),
  /** Successes. */
  green: sgr(32, 39),
  /** Warnings. */
  yellow: sgr(33, 39),
  /** Paths and URLs. */
  cyan: sgr(36, 39),
  /** Secondary detail. */
  gray: sgr(90, 39),
  /** Emphasis. */
  bold: sgr(1, 22),
  /** De-emphasis. */
  dim: sgr(2, 22),
} as const;

/** Whether this process will emit ANSI sequences. Exported for tests. */
export const colorEnabled = enabled;

/** Leading marks used by every command, so output reads the same everywhere. */
export const mark = {
  /** A check that passed. */
  ok: color.green('ok  '),
  /** A check that failed. */
  fail: color.red('FAIL'),
  /** A check that passed with a caveat. */
  warn: color.yellow('warn'),
  /** A step that is starting. */
  step: color.cyan('->  '),
} as const;

/**
 * Remove every ANSI escape sequence from a string.
 *
 * jco colours its diagnostics unconditionally; the noise filter has to match
 * on the text underneath.
 *
 * @param text Possibly coloured text.
 * @returns The same text with SGR and CSI sequences removed.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[A-Za-z]/g, '');
}
