/**
 * Put an error card on the page. The fallback `onDead` of `createHostLoop`.
 *
 * Styled as the Gameable `.gm-card` + `.gm-error` (STYLE.md):
 * pink text on the `--s1` surface with a hairline, never a red box.
 *
 * Without a `document` (a server, a test) the message goes to
 * `console.error` alone.
 *
 * @param message What to show.
 * @returns Nothing.
 *
 * @example
 * ```ts
 * import { showErrorOverlay } from './adapter/index';
 *
 * showErrorOverlay('the game module died: unreachable');
 * ```
 */
export function showErrorOverlay(message: string): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.body) {
    console.error(message);
    return;
  }
  const box = doc.createElement('div');
  box.setAttribute('data-aos-error', '');
  box.textContent = message;
  box.style.cssText = [
    'position:fixed',
    'left:28px',
    'right:28px',
    'bottom:28px',
    'max-height:45%',
    'overflow:auto',
    'z-index:1000',
    'padding:14px 16px',
    'background:#1c1d22',
    'border:1px solid #2e2f36',
    'border-radius:16px',
    'box-shadow:0 30px 80px rgba(0,0,0,0.55)',
    'color:#ff7ab8',
    'white-space:pre-wrap',
    'word-break:break-word',
    'font:500 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  ].join(';');
  doc.body.append(box);
  console.error(message);
}
