import { describe, expect, it } from 'vitest';

import { createDomHud, type HudDocument, type HudElement } from './hud';

/** A DOM stand-in: everything the renderer touches, and nothing else. */
class FakeElement implements HudElement {
  className = '';
  textContent: string | null = null;
  readonly declarations = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly tag: string;

  /**
   * @param tag Tag name the document was asked for.
   */
  constructor(tag: string) {
    this.tag = tag;
  }

  readonly style = {
    /**
     * @param name Property name.
     * @param value Property value.
     */
    setProperty: (name: string, value: string): void => {
      this.declarations.set(name, value);
    },
  };

  /**
   * @param nodes Children to append.
   */
  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      const child = node as FakeElement;
      child.parent = this;
      this.children.push(child);
    }
  }

  /** Detach from the parent. */
  remove(): void {
    const index = this.parent?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parent?.children.splice(index, 1);
    this.parent = null;
  }

  /**
   * Every descendant with a class name, depth first.
   *
   * @param className The class to look for.
   * @returns Matching elements.
   */
  find(className: string): FakeElement[] {
    const out: FakeElement[] = [];
    if (this.className === className) out.push(this);
    for (const child of this.children) out.push(...child.find(className));
    return out;
  }
}

/** A document that only makes {@link FakeElement}s. */
const fakeDocument: HudDocument = {
  createElement: (tag: string) => new FakeElement(tag),
};

/**
 * Build a HUD over the fake DOM.
 *
 * @returns The renderer and its container.
 */
function makeHud(): { hud: ReturnType<typeof createDomHud>; container: FakeElement } {
  const container = new FakeElement('body');
  const hud = createDomHud({ document: fakeDocument, container });
  return { hud, container };
}

describe('createDomHud', () => {
  it('attaches a root to the container', () => {
    const { hud, container } = makeHud();
    expect(container.children).toHaveLength(1);
    expect((hud.element as FakeElement).className).toBe('aos-hud');
  });

  it('ignores an unchanged frame without parsing anything', () => {
    const { hud } = makeHud();
    const json = JSON.stringify({ text: { ammo: 12 } });
    expect(hud.set(json)).toBe(true);
    expect(hud.set(json)).toBe(false);
    expect(hud.set(undefined)).toBe(false);
  });

  it('renders text rows and reuses their elements', () => {
    const { hud } = makeHud();
    hud.set(JSON.stringify({ text: { ammo: 12, health: 100 } }));
    const root = hud.element as FakeElement;
    const values = root.find('aos-hud__value');
    expect(values.map((v) => v.textContent)).toEqual(['12', '100']);

    hud.set(JSON.stringify({ text: { ammo: 11, health: 100 } }));
    const again = root.find('aos-hud__value');
    expect(again).toHaveLength(2);
    expect(again[0]).toBe(values[0]);
    expect(again[0].textContent).toBe('11');
  });

  it('renders a bar as a percentage of its maximum', () => {
    const { hud } = makeHud();
    hud.set(JSON.stringify({ bars: { health: { value: 25, max: 100 } } }));
    const fill = (hud.element as FakeElement).find('aos-hud__bar-fill')[0];
    expect(fill.declarations.get('width')).toBe('25%');
    // A quarter left is pink, not mint.
    expect(fill.declarations.get('background')).toBe('#ff7ab8');

    hud.set(JSON.stringify({ bars: { health: { value: 90, max: 100 } } }));
    expect(fill.declarations.get('width')).toBe('90%');
    expect(fill.declarations.get('background')).toBe('#74ecc6');
  });

  it('clamps a bar to its track', () => {
    const { hud } = makeHud();
    hud.set(JSON.stringify({ bars: { shield: { value: -5, max: 0 } } }));
    const fill = (hud.element as FakeElement).find('aos-hud__bar-fill')[0];
    expect(fill.declarations.get('width')).toBe('0%');
  });

  it('shows and hides the crosshair and the message', () => {
    const { hud } = makeHud();
    const root = hud.element as FakeElement;
    const crosshair = root.find('aos-hud__crosshair')[0];
    const message = root.find('aos-hud__message')[0];
    expect(crosshair.declarations.get('display')).toBe('none');

    hud.set(JSON.stringify({ crosshair: true, message: 'You win' }));
    expect(crosshair.declarations.get('display')).toBe('');
    expect(message.textContent).toBe('You win');
    expect(message.declarations.get('display')).toBe('');

    hud.set(JSON.stringify({ crosshair: false }));
    expect(crosshair.declarations.get('display')).toBe('none');
    expect(message.declarations.get('display')).toBe('none');
  });

  it('hides a text row whose key disappears', () => {
    const { hud } = makeHud();
    hud.set(JSON.stringify({ text: { ammo: 3 } }));
    const value = (hud.element as FakeElement).find('aos-hud__value')[0];
    hud.set(JSON.stringify({ text: {} }));
    expect(value.declarations.get('display')).toBe('none');
  });

  it('survives malformed JSON', () => {
    const { hud } = makeHud();
    expect(hud.set('{ not json')).toBe(false);
    expect(hud.model).toBeNull();
  });

  it('exposes the parsed model', () => {
    const { hud } = makeHud();
    hud.set(JSON.stringify({ text: { enemies: 6 } }));
    expect(hud.model).toEqual({ text: { enemies: 6 } });
    hud.clear();
    expect(hud.model).toBeNull();
  });

  it('detaches on dispose', () => {
    const { hud, container } = makeHud();
    hud.dispose();
    expect(container.children).toHaveLength(0);
  });

  it('refuses to build without a DOM', () => {
    expect(() => createDomHud({ container: new FakeElement('body') })).toThrow(/no DOM/);
  });
});
