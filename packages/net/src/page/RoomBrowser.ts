/**
 * `RoomBrowser` — the "Browse rooms" panel: a game's public rooms with their
 * code, seats and phase, a Join for each, New room and Quick join. Every
 * string from the server is written as text (`textContent`), never as markup.
 */
import { browseRows } from './browseRows.js';
import type { LiveRoomList, RoomListLoader } from './roomList.js';
import { roomHref } from './roomHref.js';

/** The panel's look, injected once per document, in the badge's tokens. */
const STYLE = `
.aos-browse{position:fixed;top:72px;left:16px;z-index:26;width:min(360px,calc(100vw - 32px));
max-height:calc(100vh - 96px);overflow:auto;padding:12px;border-radius:14px;
background:var(--glass,rgba(28,29,34,.92));border:1px solid var(--border,#2e2f36);color:var(--text,#f2f2f4);
font:600 13px/1.4 var(--font,system-ui,sans-serif);backdrop-filter:blur(10px)}
.aos-browse[hidden]{display:none}
.aos-browse [data-part=status]{color:var(--muted,#9a9ba3);margin:6px 0}
.aos-browse [data-part=row]{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;padding:4px 0}
.aos-browse [data-cell=code]{font:800 15px/1 var(--mono,ui-monospace,monospace);letter-spacing:.1em;overflow-wrap:anywhere}
.aos-browse [data-cell=phase]{color:var(--muted,#9a9ba3)}
.aos-browse [data-part=actions]{display:flex;gap:8px;flex-wrap:wrap}
.aos-browse button{font:inherit;padding:6px 10px;border-radius:10px;cursor:pointer;
border:1px solid var(--border,#2e2f36);background:var(--s2,#24252b);color:inherit}
.aos-browse button:disabled{opacity:.45;cursor:default}`;

/**
 * What the panel lists and where its buttons go.
 *
 * @example
 * ```ts
 * import type { RoomBrowserOptions } from 'gameable/net/page';
 * declare const options: RoomBrowserOptions;
 * console.log(options.game);
 * ```
 */
export interface RoomBrowserOptions {
  /** The game's catalog name. */
  readonly game: string;
  /** The room server (`roomsEndpoint(location.href)`), read when the panel opens. */
  readonly endpoint: () => string;
  /** Opens the live list; called each time the panel opens, never before. */
  readonly list: RoomListLoader;
  /** The page's address now, for the `?room=` links. */
  readonly href: () => string;
  /** Go to an address. */
  readonly navigate: (href: string) => void;
}

/**
 * The panel. Hidden until `open()`, which loads the list; `close()` hides it
 * and closes the list (its lobby socket).
 *
 * @example
 * ```ts
 * import { RoomBrowser } from 'gameable/net/page';
 * declare const options: import('gameable/net/page').RoomBrowserOptions;
 * const browser = new RoomBrowser(document, options);
 * await browser.open();
 * browser.close();
 * ```
 */
export class RoomBrowser {
  /** The panel's root element, in `document.body`. */
  readonly element: HTMLElement;
  readonly #document: Document;
  readonly #status: HTMLElement;
  readonly #rows: HTMLElement;
  #list: LiveRoomList | null = null;
  #off: () => void = () => undefined;
  #opening = 0;

  /**
   * @param document The page's document.
   * @param options What to list and where the buttons go.
   */
  constructor(
    document: Document,
    private readonly options: RoomBrowserOptions,
  ) {
    this.#document = document;
    if (document.getElementById('aos-browse-style') === null) {
      const style = document.createElement('style');
      style.id = 'aos-browse-style';
      style.textContent = STYLE;
      document.head.append(style);
    }
    this.element = document.createElement('div');
    this.element.className = 'aos-browse';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Browse rooms');
    this.element.hidden = true;
    const actions = this.#part('actions');
    this.#button(actions, 'New room', () => {
      this.#go('new');
    });
    this.#button(actions, 'Quick join', () => {
      this.#go('quick');
    });
    this.#button(actions, 'Close', () => {
      this.close();
    });
    this.#status = this.#part('status');
    this.#rows = this.#part('rows');
    document.body.append(this.element);
  }

  /** @returns True while the panel is shown. */
  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** @returns Once the list has loaded, or failed to (the panel says which). */
  async open(): Promise<void> {
    if (this.isOpen) return;
    this.element.hidden = false;
    this.#say('Loading rooms…');
    this.#rows.replaceChildren();
    const opening = ++this.#opening;
    let list: LiveRoomList;
    try {
      list = await this.options.list(this.options.game, this.options.endpoint());
    } catch {
      if (opening === this.#opening) this.#say('Could not reach the room list. Try again later.');
      return;
    }
    if (opening !== this.#opening) {
      list.close(); // the panel closed while it loaded
      return;
    }
    this.#list = list;
    this.#off = list.onChange(() => {
      this.#render();
    });
    this.#render();
  }

  /** Hide the panel and close the list. */
  close(): void {
    this.#opening += 1;
    this.element.hidden = true;
    this.#off();
    this.#off = () => undefined;
    this.#list?.close();
    this.#list = null;
  }

  /** Close, and take the panel off the page. */
  dispose(): void {
    this.close();
    this.element.remove();
  }

  #render(): void {
    const list = this.#list;
    if (list === null) return;
    const rows = browseRows(list.rooms);
    if (list.state === 'closed') this.#say('The room list closed. Close and open it again.');
    else this.#say(rows.length === 0 ? 'No open rooms yet: start one with New room.' : '');
    this.#rows.replaceChildren(
      ...rows.map((row) => {
        const line = this.#document.createElement('div');
        line.dataset.part = 'row';
        for (const [cell, text] of [
          ['code', row.code],
          ['seats', row.seats],
          ['phase', row.phase],
        ] as const) {
          const span = this.#document.createElement('span');
          span.dataset.cell = cell;
          span.textContent = text;
          line.append(span);
        }
        this.#button(line, 'Join', () => {
          this.#go(row.code);
        }).disabled = row.full;
        return line;
      }),
    );
  }

  /** @param text The status line, or '' for none. */
  #say(text: string): void {
    this.#status.textContent = text;
    this.#status.hidden = text === '';
  }

  /** @param room A code, `new` or `quick`: the page's `?room=`. */
  #go(room: string): void {
    this.options.navigate(roomHref(this.options.href(), room));
  }

  #part(name: string): HTMLElement {
    const div = this.#document.createElement('div');
    div.dataset.part = name;
    this.element.append(div);
    return div;
  }

  #button(parent: HTMLElement, label: string, run: () => void): HTMLButtonElement {
    const button = this.#document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      run();
    });
    parent.append(button);
    return button;
  }
}
