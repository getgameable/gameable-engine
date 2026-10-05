/**
 * The default HUD renderer.
 *
 * `frame-output.hud` is `option<string>`: the guest sends JSON only on the
 * frames the model actually changed, and `undefined` on every other frame.
 * This module turns that string into DOM.
 *
 * Two properties matter more than the styling:
 *
 * 1. **Nothing happens on an unchanged frame.** `set(undefined)` — and
 *    `set(json)` with a string identical to the last one — returns before it
 *    allocates or touches the document. The common case costs one comparison.
 * 2. **Elements are reused.** A row per text key and a bar per bar key are
 *    created once and then mutated, so a HUD that changes every frame still
 *    does no DOM churn.
 *
 * The DOM types here are the narrow structural slice the renderer actually
 * uses, not `Document` and `HTMLElement`. A real document satisfies them, and
 * so does a twenty-line fake in a node test — which is why this file has unit
 * tests without a jsdom dependency.
 */

/** The HUD model the default renderer understands. */
export interface HudModel {
  /** Label to value rows, drawn top-left in declaration order. */
  text?: Record<string, string | number>;
  /** Label to `{ value, max }` meters, drawn bottom-left in declaration order. */
  bars?: Record<string, { value: number; max: number }>;
  /** Draw the centre crosshair. */
  crosshair?: boolean;
  /** A single centred line, for "You win" and friends. Empty or absent hides it. */
  message?: string;
}

/** The slice of `HTMLElement` the renderer uses. */
export interface HudElement {
  /** Class name, set once per element at creation. */
  className: string;
  /** Text content; the renderer only ever writes it. */
  textContent: string | null;
  /** Inline style, written through `setProperty` so a fake needs one method. */
  readonly style: { setProperty(name: string, value: string): void };
  /**
   * Append children.
   *
   * The parameter is `unknown` rather than `HudElement` on purpose: the real
   * `HTMLElement.append` takes `(string | Node)[]`, and only a parameter type
   * that a `Node` is assignable *to* makes a real element satisfy this
   * interface under method bivariance.
   *
   * @param nodes Children to append; always {@link HudElement}s here.
   */
  append(...nodes: unknown[]): void;
  /** Detach from the parent, if any. */
  remove(): void;
}

/** The slice of `Document` the renderer uses. */
export interface HudDocument {
  /**
   * Create an element.
   *
   * @param tag Tag name, always `'div'` here.
   * @returns The new element.
   */
  createElement(tag: string): HudElement;
}

/** Options accepted by {@link createDomHud}. */
export interface DomHudOptions {
  /** Where the overlay is appended. Defaults to `document.body`. */
  container?: HudElement;
  /** Document used to create elements. Defaults to the global `document`. */
  document?: HudDocument;
  /** Class name given to the root element. Defaults to `aos-hud`. */
  className?: string;
}

/** What {@link createDomHud} returns, and what the adapter drives. */
export interface HudRenderer {
  /** The overlay root, for tests and for callers that want to restyle it. */
  readonly element: HudElement;
  /** The model currently on screen, or `null` before the first payload. */
  readonly model: HudModel | null;
  /**
   * Apply one `frame-output.hud` value.
   *
   * @param json The JSON the guest sent, or `undefined` when nothing changed.
   * @returns True when the DOM was touched.
   */
  set(json: string | undefined): boolean;
  /** Hide everything and forget the model. */
  clear(): void;
  /** Detach the overlay from its container. */
  dispose(): void;
}

/*
 * Colours and type below are the Gameable tokens (STYLE.md):
 * text `#f2f2f4`, muted `#9a9ba3`, mint `#74ecc6` for healthy, pink
 * `#ff7ab8` for low. The HUD has no stylesheet, so the values are literal.
 */

/** The bar colour above the low threshold. */
const BAR_MINT = '#74ecc6';
/** The bar colour at or below the low threshold. */
const BAR_PINK = '#ff7ab8';
/** Below this fraction a bar turns pink. */
const BAR_LOW = 0.34;

/** Inline style of the overlay root. */
const ROOT_STYLE: readonly (readonly [string, string])[] = [
  ['position', 'absolute'],
  ['inset', '0'],
  ['pointer-events', 'none'],
  ['user-select', 'none'],
  ['z-index', '10'],
  ['color', '#f2f2f4'],
  [
    'font',
    "600 13px/1.45 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  ],
  ['font-variant-numeric', 'tabular-nums'],
  ['text-shadow', '0 1px 2px rgba(0, 0, 0, 0.85)'],
];

/** Inline style of the top-left text block. */
const TEXT_STYLE: readonly (readonly [string, string])[] = [
  ['position', 'absolute'],
  ['top', '28px'],
  ['left', '28px'],
  ['display', 'grid'],
  ['grid-template-columns', 'auto auto'],
  ['column-gap', '12px'],
  ['row-gap', '2px'],
];

/** Inline style of the bottom-left bar block. */
const BARS_STYLE: readonly (readonly [string, string])[] = [
  ['position', 'absolute'],
  ['bottom', '28px'],
  ['left', '28px'],
  ['display', 'flex'],
  ['flex-direction', 'column'],
  ['gap', '10px'],
  ['min-width', '200px'],
];

/** Inline style of the centred message line. */
const MESSAGE_STYLE: readonly (readonly [string, string])[] = [
  ['position', 'absolute'],
  ['left', '0'],
  ['right', '0'],
  ['top', '38%'],
  ['text-align', 'center'],
  ['font-size', '40px'],
  ['font-weight', '800'],
  ['line-height', '1'],
  ['letter-spacing', '-0.045em'],
];

/** Inline style of the crosshair dot. */
const CROSSHAIR_STYLE: readonly (readonly [string, string])[] = [
  ['position', 'absolute'],
  ['left', '50%'],
  ['top', '50%'],
  ['width', '6px'],
  ['height', '6px'],
  ['margin', '-3px 0 0 -3px'],
  ['border-radius', '50%'],
  ['background', '#f2f2f4'],
  ['box-shadow', '0 0 0 1px rgba(0, 0, 0, 0.7)'],
];

/**
 * Apply a list of declarations to an element.
 *
 * @param element The element to style.
 * @param declarations Property/value pairs.
 * @returns Nothing.
 */
function style(element: HudElement, declarations: readonly (readonly [string, string])[]): void {
  for (const [name, value] of declarations) element.style.setProperty(name, value);
}

/**
 * Resolve the document to build elements with.
 *
 * @param explicit The `document` option, when the caller passed one.
 * @returns A document.
 * @throws {Error} When there is no DOM and none was supplied.
 */
function resolveDocument(explicit: HudDocument | undefined): HudDocument {
  if (explicit) return explicit;
  const global = (globalThis as { document?: HudDocument }).document;
  if (!global) {
    throw new Error(
      'createDomHud: no DOM in this environment; pass { document } (and { container })',
    );
  }
  return global;
}

/**
 * Resolve the element the overlay is appended to.
 *
 * @param explicit The `container` option, when the caller passed one.
 * @returns A container, or null when there is nothing to append to.
 */
function resolveContainer(explicit: HudElement | undefined): HudElement | null {
  if (explicit) return explicit;
  return (globalThis as { document?: { body?: HudElement } }).document?.body ?? null;
}

/** One text row: a label cell and a value cell. */
interface TextRow {
  /** The label cell. */
  key: HudElement;
  /** The value cell. */
  value: HudElement;
  /** Last rendered value; `null` until the row has ever been drawn. */
  last: string | null;
}

/** One bar: a label, a track and the fill inside it. */
interface BarRow {
  /** The whole row, so it can be hidden or removed. */
  root: HudElement;
  /** The label above the track. */
  label: HudElement;
  /** The coloured fill whose width is the fraction. */
  fill: HudElement;
  /** Last rendered label text; `null` until the bar has ever been drawn. */
  lastLabel: string | null;
  /** Last rendered fill percentage, rounded to whole percent. */
  lastPercent: number;
}

/**
 * Create the default DOM HUD.
 *
 * The renderer is deliberately dumb: it knows four keys and draws them the
 * same way for every game. A game that wants its own look passes its own
 * renderer to `createEngineAdapter({ hud })`, or turns this one off with
 * `{ hud: false }` and reads `adapter.hudModel` itself.
 *
 * @param options Container, document and root class name.
 * @returns A renderer, already attached to its container.
 *
 * @example
 * ```ts
 * import { createDomHud } from 'gameable/host';
 *
 * const hud = createDomHud();
 * hud.set(JSON.stringify({ text: { ammo: 12 }, crosshair: true }));
 * ```
 */
export function createDomHud(options: DomHudOptions = {}): HudRenderer {
  const doc = resolveDocument(options.document);
  const container = resolveContainer(options.container);

  const root = doc.createElement('div');
  root.className = options.className ?? 'aos-hud';
  style(root, ROOT_STYLE);

  const crosshair = doc.createElement('div');
  crosshair.className = 'aos-hud__crosshair';
  style(crosshair, CROSSHAIR_STYLE);
  crosshair.style.setProperty('display', 'none');

  const textBlock = doc.createElement('div');
  textBlock.className = 'aos-hud__text';
  style(textBlock, TEXT_STYLE);

  const barBlock = doc.createElement('div');
  barBlock.className = 'aos-hud__bars';
  style(barBlock, BARS_STYLE);

  const message = doc.createElement('div');
  message.className = 'aos-hud__message';
  style(message, MESSAGE_STYLE);
  message.style.setProperty('display', 'none');

  root.append(crosshair, textBlock, barBlock, message);
  container?.append(root);

  const textRows = new Map<string, TextRow>();
  const barRows = new Map<string, BarRow>();

  /** The JSON last applied; identical strings are ignored. */
  let lastJson: string | undefined;
  let model: HudModel | null = null;
  let crosshairShown = false;
  let messageShown = false;

  /**
   * Get or create the row for a text key.
   *
   * @param key The model key.
   * @returns The row, appended to the text block on first use.
   */
  function textRow(key: string): TextRow {
    const existing = textRows.get(key);
    if (existing) return existing;
    const keyCell = doc.createElement('div');
    keyCell.className = 'aos-hud__key';
    keyCell.style.setProperty('color', '#9a9ba3');
    keyCell.textContent = key;
    const valueCell = doc.createElement('div');
    valueCell.className = 'aos-hud__value';
    valueCell.style.setProperty('text-align', 'right');
    textBlock.append(keyCell, valueCell);
    const row: TextRow = { key: keyCell, value: valueCell, last: null };
    textRows.set(key, row);
    return row;
  }

  /**
   * Get or create the bar for a key.
   *
   * @param key The model key.
   * @returns The bar, appended to the bar block on first use.
   */
  function barRow(key: string): BarRow {
    const existing = barRows.get(key);
    if (existing) return existing;
    const rowRoot = doc.createElement('div');
    rowRoot.className = 'aos-hud__bar';

    const label = doc.createElement('div');
    label.className = 'aos-hud__bar-label';
    label.style.setProperty('color', '#9a9ba3');
    label.style.setProperty('font-size', '12px');
    label.style.setProperty('margin-bottom', '4px');

    const track = doc.createElement('div');
    track.className = 'aos-hud__bar-track';
    style(track, [
      ['height', '4px'],
      ['background', 'rgba(46, 47, 54, 0.9)'],
      ['border-radius', '2px'],
      ['overflow', 'hidden'],
    ]);

    const fill = doc.createElement('div');
    fill.className = 'aos-hud__bar-fill';
    style(fill, [
      ['height', '100%'],
      ['width', '0%'],
      ['border-radius', '2px'],
      ['background', BAR_MINT],
      ['box-shadow', '0 0 12px rgba(116, 236, 198, 0.6)'],
    ]);

    track.append(fill);
    rowRoot.append(label, track);
    barBlock.append(rowRoot);
    const row: BarRow = { root: rowRoot, label, fill, lastLabel: null, lastPercent: -1 };
    barRows.set(key, row);
    return row;
  }

  /**
   * Draw one parsed model.
   *
   * @param next The model to show.
   * @returns Nothing.
   */
  function render(next: HudModel): void {
    const text = next.text;
    for (const [key, row] of textRows) {
      if (text === undefined || !Object.hasOwn(text, key)) {
        if (row.last !== '') {
          row.key.style.setProperty('display', 'none');
          row.value.style.setProperty('display', 'none');
          row.last = '';
        }
      }
    }
    if (text !== undefined) {
      for (const key of Object.keys(text)) {
        const row = textRow(key);
        const value = String(text[key]);
        if (row.last === value) continue;
        row.last = value;
        row.value.textContent = value;
        row.key.style.setProperty('display', '');
        row.value.style.setProperty('display', '');
      }
    }

    const bars = next.bars;
    for (const [key, row] of barRows) {
      if (bars === undefined || !Object.hasOwn(bars, key)) {
        row.root.style.setProperty('display', 'none');
      }
    }
    if (bars !== undefined) {
      for (const key of Object.keys(bars)) {
        const row = barRow(key);
        const entry = bars[key];
        const max = entry.max > 0 ? entry.max : 1;
        const fraction = Math.min(1, Math.max(0, entry.value / max));
        const percent = Math.round(fraction * 100);
        const label = `${key} ${String(Math.round(entry.value))}/${String(Math.round(entry.max))}`;
        row.root.style.setProperty('display', '');
        if (row.lastPercent !== percent) {
          row.lastPercent = percent;
          row.fill.style.setProperty('width', `${String(percent)}%`);
          // Mint above a third, pink at or below it. The palette has no amber.
          const low = fraction <= BAR_LOW;
          row.fill.style.setProperty('background', low ? BAR_PINK : BAR_MINT);
          row.fill.style.setProperty(
            'box-shadow',
            low ? '0 0 12px rgba(255, 122, 184, 0.6)' : '0 0 12px rgba(116, 236, 198, 0.6)',
          );
        }
        if (row.lastLabel !== label) {
          row.lastLabel = label;
          row.label.textContent = label;
        }
      }
    }

    const wantCrosshair = next.crosshair === true;
    if (wantCrosshair !== crosshairShown) {
      crosshairShown = wantCrosshair;
      crosshair.style.setProperty('display', wantCrosshair ? '' : 'none');
    }

    const line = next.message ?? '';
    const wantMessage = line !== '';
    if (wantMessage) message.textContent = line;
    if (wantMessage !== messageShown) {
      messageShown = wantMessage;
      message.style.setProperty('display', wantMessage ? '' : 'none');
    }
  }

  return {
    element: root,
    get model() {
      return model;
    },

    set(json: string | undefined): boolean {
      // The guest already suppresses unchanged models; this is the second
      // gate, for hosts that replay a recorded frame stream.
      if (json === undefined || json === lastJson) return false;
      lastJson = json;
      let parsed: HudModel;
      try {
        parsed = JSON.parse(json) as HudModel;
      } catch {
        // A malformed HUD must not take the frame down with it.
        return false;
      }
      model = parsed;
      render(parsed);
      return true;
    },

    clear(): void {
      lastJson = undefined;
      model = null;
      for (const row of textRows.values()) {
        row.key.style.setProperty('display', 'none');
        row.value.style.setProperty('display', 'none');
        row.last = '';
      }
      for (const row of barRows.values()) row.root.style.setProperty('display', 'none');
      crosshairShown = false;
      crosshair.style.setProperty('display', 'none');
      messageShown = false;
      message.style.setProperty('display', 'none');
    },

    dispose(): void {
      root.remove();
      textRows.clear();
      barRows.clear();
    },
  };
}
