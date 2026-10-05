/**
 * The overlay: a stats panel, a slider panel and an error box. No dependencies.
 *
 * dat.gui is the obvious thing to reach for and is deliberately not used: it is another
 * dependency in an example whose whole job is to isolate one chain, and `<input
 * type="range">` is four lines. It also keeps the e2e suite reading real DOM values
 * rather than a library's canvas-drawn widgets.
 */

/** One slider on the panel. */
export interface SliderSpec {
  /** Stable id, used by the e2e suite and as the input's `id`. */
  id: string;
  /** Label text. */
  label: string;
  /** Inclusive range. */
  min: number;
  max: number;
  step: number;
  /** Starting value. */
  value: number;
  /** Called with the new value on every input event. */
  onChange: (value: number) => void;
  /** Decimals shown next to the slider. Defaults to 2. */
  decimals?: number;
}

/** A group of sliders under one heading. */
export interface SliderGroup {
  title: string;
  sliders: SliderSpec[];
}

/** The overlay handle. */
export interface Overlay {
  /** Replace the stats panel's lines. */
  setStats(lines: readonly string[]): void;
  /** Show the report panel (self-test output, bake status). */
  setReport(text: string | null): void;
  /** Append to the error box and make it visible. */
  fail(error: unknown): void;
  /** Build the control panel. Calling it again replaces the panel. */
  setControls(
    groups: readonly SliderGroup[],
    buttons?: readonly { label: string; onClick: () => void }[],
  ): void;
  /** Set every slider back to its starting value, firing `onChange`. */
  resetControls(): void;
}

/**
 * Wire the overlay to the elements in `index.html`.
 *
 * @returns The overlay handle.
 */
export function createOverlay(): Overlay {
  const statsElement = document.getElementById('stats') as HTMLElement;
  const controlsElement = document.getElementById('controls') as HTMLElement;
  const reportElement = document.getElementById('report') as HTMLElement;
  const errorElement = document.getElementById('error') as HTMLElement;
  const resets: (() => void)[] = [];

  return {
    setStats(lines) {
      statsElement.textContent = lines.join('\n');
    },

    setReport(text) {
      if (text === null) {
        reportElement.classList.remove('visible');
        reportElement.textContent = '';
        return;
      }
      reportElement.textContent = text;
      reportElement.classList.add('visible');
    },

    fail(error) {
      // Walk the cause chain: `createEngine` wraps a module failure in a `ModuleError`, so
      // the reason a character refused to boot is one level down and would be lost.
      const parts: string[] = [];
      let current: unknown = error;
      for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
        if (!(current instanceof Error)) {
          parts.push(
            typeof current === 'string' ? current : (JSON.stringify(current) ?? 'unknown'),
          );
          break;
        }
        parts.push(
          depth === 0 ? `${current.name}: ${current.message}` : `caused by: ${current.message}`,
        );
        current = current.cause;
      }
      if (error instanceof Error && error.stack !== undefined) parts.push(error.stack);
      window.__AOS_ERROR__ = (window.__AOS_ERROR__ ?? '') + parts.join('\n') + '\n';
      errorElement.classList.add('visible');
      errorElement.textContent = window.__AOS_ERROR__;
      console.error(error);
    },

    setControls(groups, buttons = []) {
      controlsElement.textContent = '';
      resets.length = 0;
      for (const group of groups) {
        const heading = document.createElement('h2');
        heading.textContent = group.title;
        controlsElement.append(heading);
        for (const spec of group.sliders) {
          const label = document.createElement('label');
          const name = document.createElement('span');
          name.textContent = spec.label;
          const input = document.createElement('input');
          input.type = 'range';
          input.id = spec.id;
          input.min = String(spec.min);
          input.max = String(spec.max);
          input.step = String(spec.step);
          input.value = String(spec.value);
          const readout = document.createElement('span');
          readout.className = 'value';
          const decimals = spec.decimals ?? 2;
          const show = (value: number): void => {
            readout.textContent = value.toFixed(decimals);
          };
          show(spec.value);
          input.addEventListener('input', () => {
            const value = Number(input.value);
            show(value);
            spec.onChange(value);
          });
          resets.push(() => {
            input.value = String(spec.value);
            show(spec.value);
            spec.onChange(spec.value);
          });
          label.append(name, input, readout);
          controlsElement.append(label);
        }
      }
      for (const button of buttons) {
        const element = document.createElement('button');
        element.textContent = button.label;
        element.addEventListener('click', button.onClick);
        controlsElement.append(element);
      }
      controlsElement.hidden = false;
    },

    resetControls() {
      for (const reset of resets) reset();
    },
  };
}

/**
 * Nearest-rank percentile.
 *
 * @param values Sample. Not mutated.
 * @param p Quantile in `[0, 1]`.
 * @returns The value, or `NaN` when the sample is empty.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? Number.NaN;
}

/**
 * Fixed-decimal text, or `--` for a non-finite measurement.
 *
 * @param value The measurement.
 * @param decimals Decimals to show. Defaults to 2.
 * @returns Text for the overlay.
 */
export function fixed(value: number, decimals = 2): string {
  return Number.isFinite(value) ? value.toFixed(decimals) : '--';
}
