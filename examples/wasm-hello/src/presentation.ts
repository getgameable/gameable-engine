/** Wall-clock render rate; simulation ticks do not enter this counter. */
export class FrameRate {
  private start = 0;
  private frames = 0;
  private previous = 0;

  /** Return a new sample twice a second; discard suspension gaps. */
  sample(now: number): number | null {
    if (!this.previous || now - this.previous > 2000) {
      this.start = now;
      this.frames = 0;
      this.previous = now;
      return null;
    }
    this.previous = now;
    this.frames++;
    const elapsed = now - this.start;
    if (elapsed < 500) return null;
    const fps = (this.frames * 1000) / elapsed;
    this.frames = 0;
    this.start = now;
    return Math.round(fps);
  }
}

/** Ignore browser toolbar motion: only a keyboard-sized inset moves the chat. */
export function keyboardInset(
  layoutHeight: number,
  visibleHeight: number,
  offsetTop: number,
): number {
  const inset = Math.round(layoutHeight - visibleHeight - offsetTop);
  return inset >= 120 ? inset : 0;
}

/** Keep the stage fixed while the phone keyboard raises only the conversation. */
export function watchKeyboard(): () => void {
  const viewport = window.visualViewport;
  if (!viewport || navigator.maxTouchPoints === 0) return () => {};
  const root = document.documentElement;
  const update = (): void => {
    const editing = document.activeElement?.id === 'question-text';
    const inset = editing
      ? keyboardInset(window.innerHeight, viewport.height, viewport.offsetTop)
      : 0;
    root.style.setProperty('--keyboard-inset', `${inset}px`);
    root.toggleAttribute('data-keyboard', inset > 0);
    if (editing && inset > 0 && window.scrollY !== 0) window.scrollTo(0, 0);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', update);
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    document.removeEventListener('focusin', update);
    document.removeEventListener('focusout', update);
    root.style.removeProperty('--keyboard-inset');
    root.removeAttribute('data-keyboard');
  };
}
