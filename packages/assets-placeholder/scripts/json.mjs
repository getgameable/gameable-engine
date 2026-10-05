/**
 * A tiny JSON serialiser that keeps arrays of primitives on one line.
 *
 * `JSON.stringify(value, null, 2)` puts every array element on its own line,
 * which turns a `[x, y, z]` spawn point into four lines and a 52-channel
 * blendshape frame into fifty-two. The generated assets are committed and read
 * by people, so they are formatted here instead.
 *
 * Usage: `import { stringifyCompact } from './json.mjs';`
 */

/** Default maximum line width before an array is broken up. Matches `.prettierrc`. */
const DEFAULT_WIDTH = 100;

/**
 * Whether a value can appear on an inlined array line.
 *
 * @param {unknown} v Value to test.
 * @returns {boolean} True for `null`, numbers, strings and booleans.
 */
function isPrimitive(v) {
  return v === null || ['number', 'string', 'boolean'].includes(typeof v);
}

/**
 * Pack rendered values onto as few indented lines as `width` allows.
 *
 * This is Prettier's "fill" behaviour for arrays of numbers: greedily keep
 * adding items to the current line while the next one still fits. Matching it
 * means `npm run format` leaves the generated JSON alone.
 *
 * @param {string[]} parts Rendered values, without separators.
 * @param {string} indent Leading whitespace for every line.
 * @param {number} width Maximum line width.
 * @returns {string} The filled lines, joined by newlines.
 */
function fill(parts, indent, width) {
  const lines = [];
  let current = '';
  for (const [i, part] of parts.entries()) {
    const piece = i < parts.length - 1 ? `${part},` : part;
    if (current === '') current = piece;
    else if (indent.length + current.length + 1 + piece.length <= width) current += ` ${piece}`;
    else {
      lines.push(indent + current);
      current = piece;
    }
  }
  if (current !== '') lines.push(indent + current);
  return lines.join('\n');
}

/**
 * Serialise `value`, inlining arrays of primitives that fit inside `width`.
 *
 * @param {unknown} value The value to serialise.
 * @param {number} depth Current nesting depth.
 * @param {number} width Maximum line width for an inlined array.
 * @returns {string} JSON text.
 */
function write(value, depth, width) {
  const pad = '  '.repeat(depth);
  const inner = '  '.repeat(depth + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isPrimitive)) {
      const parts = value.map((v) => JSON.stringify(v));
      const oneLine = `[${parts.join(', ')}]`;
      if (pad.length + oneLine.length <= width) return oneLine;
      return `[\n${fill(parts, inner, width)}\n${pad}]`;
    }
    const items = value.map((v) => `${inner}${write(v, depth + 1, width)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const items = keys.map(
      (k) => `${inner}${JSON.stringify(k)}: ${write(value[k], depth + 1, width)}`,
    );
    return `{\n${items.join(',\n')}\n${pad}}`;
  }

  return JSON.stringify(value);
}

/**
 * Serialise `value` as JSON. Objects are always expanded, one key per line;
 * arrays of primitives are inlined when they fit.
 *
 * @param {unknown} value The document to serialise.
 * @param {{ width?: number }} [options] `width` is the inlining threshold.
 * @returns {string} JSON text, without a trailing newline.
 */
export function stringifyCompact(value, options = {}) {
  return write(value, 0, options.width ?? DEFAULT_WIDTH);
}
