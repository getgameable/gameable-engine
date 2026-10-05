/**
 * `RoomBadge` — the room's corner of the screen: the code, a copy-link
 * button, the net state and why a room closed; on a solo page, the
 * "Play Solo" / "Play with friends" choice; and, given a room list, "Browse rooms".
 */

/** The badge's look, injected once per document. Uses the page's tokens when it has them. */
const STYLE = `
.aos-room{position:fixed;top:16px;left:16px;z-index:25;display:flex;flex-wrap:wrap;align-items:center;
gap:8px;max-width:calc(100vw - 32px);padding:10px 12px;border-radius:14px;
background:var(--glass,rgba(28,29,34,.7));border:1px solid var(--border,#2e2f36);color:var(--text,#f2f2f4);
font:600 13px/1.4 var(--font,system-ui,sans-serif);backdrop-filter:blur(10px)}
.aos-room [data-part=code]{font:800 18px/1 var(--mono,ui-monospace,monospace);letter-spacing:.12em}
.aos-room [data-part=code]:empty{display:none}
.aos-room [data-part=status]{color:var(--muted,#9a9ba3)}
.aos-room[data-state=closed] [data-part=status]{color:var(--pink,#ff7ab8)}
.aos-room button{font:inherit;padding:6px 10px;border-radius:10px;cursor:pointer;
border:1px solid var(--border,#2e2f36);background:var(--s2,#24252b);color:inherit}
.aos-room button[aria-pressed=true]{background:var(--mint,#74ecc6);color:var(--onmint,#0e1f1a)}
.aos-room button[hidden]{display:none}`;

/** What the badge shows; the owner decides when it changed. */
export interface RoomBadgeView {
  /** `net.state`, as a data attribute for styling. */
  readonly state: string;
  /** The room code, or `''` for none. */
  readonly code: string;
  /** The status line. */
  readonly status: string;
}

/** What the badge's buttons do. */
export interface RoomBadgeActions {
  /** Copy the room's link. Absent on a solo page. */
  readonly copyLink?: () => void;
  /** Go to "Play with friends". Present only on a solo page. */
  readonly playWithFriends?: () => void;
  /** Open or close the "Browse rooms" panel. Absent when the page lists no rooms. */
  readonly browse?: () => void;
}

/**
 * The badge element. It writes the DOM only in `show`, and its owner calls
 * that only on a change.
 *
 * @example
 * ```ts
 * import { RoomBadge } from 'gameable/net/page';
 * const badge = new RoomBadge(document, { copyLink: () => undefined });
 * badge.show({ state: 'joined', code: 'KQTX', status: 'Joined' });
 * badge.dispose();
 * ```
 */
export class RoomBadge {
  /** The badge's root element, in `document.body`. */
  readonly element: HTMLElement;
  readonly #code: HTMLElement;
  readonly #status: HTMLElement;
  readonly #copy: HTMLButtonElement | null;
  readonly #friends: HTMLButtonElement | null = null;
  readonly #browse: HTMLButtonElement | null = null;

  /**
   * @param document The page's document.
   * @param actions What the buttons do; which are given decides which exist.
   */
  constructor(document: Document, actions: RoomBadgeActions) {
    if (document.getElementById('aos-room-style') === null) {
      const style = document.createElement('style');
      style.id = 'aos-room-style';
      style.textContent = STYLE;
      document.head.append(style);
    }
    this.element = document.createElement('div');
    this.element.className = 'aos-room';
    this.element.setAttribute('role', 'status');
    this.#code = this.#part(document, 'code');
    this.#status = this.#part(document, 'status');
    if (actions.playWithFriends !== undefined) {
      const solo = this.#button(document, 'Play Solo', () => undefined);
      solo.setAttribute('aria-pressed', 'true');
      // Hidden until the page knows a room server answers (`offerFriends`).
      this.#friends = this.#button(document, 'Play with friends', actions.playWithFriends);
      this.#friends.hidden = true;
    }
    this.#copy =
      actions.copyLink === undefined ? null : this.#button(document, 'Copy link', actions.copyLink);
    if (this.#copy !== null) this.#copy.hidden = true;
    if (actions.browse !== undefined) {
      this.#browse = this.#button(document, 'Browse rooms', actions.browse);
      // A solo page shows it with "Play with friends" (`offerFriends`); a room page at once.
      this.#browse.hidden = actions.playWithFriends !== undefined;
    }
    document.body.append(this.element);
  }

  /**
   * Show a new state.
   *
   * @param view What to show.
   */
  show(view: RoomBadgeView): void {
    this.element.dataset.state = view.state;
    this.#code.textContent = view.code;
    this.#status.textContent = view.status;
    if (this.#copy !== null) this.#copy.hidden = view.code === '';
  }

  /**
   * Show or hide "Play with friends" and "Browse rooms" (a solo page only).
   *
   * @param yes True once a room server answered.
   */
  offerFriends(yes: boolean): void {
    if (this.#friends !== null) this.#friends.hidden = !yes;
    if (this.#browse !== null) this.#browse.hidden = !yes;
  }

  /** Take the badge off the page. */
  dispose(): void {
    this.element.remove();
  }

  #part(document: Document, name: string): HTMLElement {
    const span = document.createElement('span');
    span.dataset.part = name;
    this.element.append(span);
    return span;
  }

  #button(document: Document, label: string, run: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      run();
    });
    this.element.append(button);
    return button;
  }
}
