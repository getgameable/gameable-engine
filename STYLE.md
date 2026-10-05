# Style guide

Every surface Gameable Engine draws — the docs site, the template shells, the HUD,
the debug overlay, the error banner — follows the **Gameable** look: the dark
desktop UI of the `aos-gameable-cc` character creator
(`webapp/src/studio/gameable.css`, from the September 2026 brand handoff).
Copy from here, not from memory. When something is not covered, open
`gameable.css` in that repository and match the nearest component.

> **For agents.** If you are styling anything in this repository, read the
> **Tokens**, **Type** and **Rules** sections below and use the values verbatim.
> Do not invent a new colour, radius or font size. The tokens are also in
> `docs/.vitepress/theme/tokens.css` as CSS custom properties.

## Tokens

Dark mode only. `color-scheme: dark` on the root.

| Token         | Value                                   | Use                                                                      |
| ------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| `--canvas`    | `#141519`                               | The page and viewport background                                         |
| `--s1`        | `#1c1d22`                               | Surface 1: cards, panels, menus, toasts, modals                          |
| `--s2`        | `#24252b`                               | Surface 2: secondary buttons, the "on" rail item, tracks                 |
| `--border`    | `#2e2f36`                               | Every hairline and border                                                |
| `--text`      | `#f2f2f4`                               | Primary text                                                             |
| `--muted`     | `#9a9ba3`                               | Secondary text, labels, hints                                            |
| `--dim`       | `#5f6069`                               | Tertiary text, caps labels, placeholders, disabled                       |
| `--mint`      | `#74ecc6`                               | The accent: primary CTA, "on" state, progress, links                     |
| `--onmint`    | `#0e1f1a`                               | Text on a mint background                                                |
| `--pink`      | `#ff7ab8`                               | Errors, the current-step ring, focus outline, CTA glow                   |
| `--mint-tint` | `rgba(116, 236, 198, 0.12)`             | Selected rows, soft highlights                                           |
| `--glass`     | `rgba(28, 29, 34, 0.6)`                 | Translucent surfaces over the viewport (+ `backdrop-filter: blur(10px)`) |
| `--glow`      | `0 12px 30px rgba(255, 122, 184, 0.45)` | The primary CTA's shadow                                                 |
| `--float`     | `0 30px 80px rgba(0, 0, 0, 0.55)`       | Floating cards, modals                                                   |

Hover borders lighten to `#3a3b44`. Selection is
`rgba(116, 236, 198, 0.35)`. Nothing else in the palette exists; a "warning"
is pink, a "success" is mint.

```css
:root {
  --canvas: #141519;
  --s1: #1c1d22;
  --s2: #24252b;
  --border: #2e2f36;
  --text: #f2f2f4;
  --muted: #9a9ba3;
  --dim: #5f6069;
  --mint: #74ecc6;
  --onmint: #0e1f1a;
  --pink: #ff7ab8;
  --mint-tint: rgba(116, 236, 198, 0.12);
  --glass: rgba(28, 29, 34, 0.6);
  --glow: 0 12px 30px rgba(255, 122, 184, 0.45);
  --float: 0 30px 80px rgba(0, 0, 0, 0.55);
  --font: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: dark;
}
```

## Type

The face is **Plus Jakarta Sans** (weights 500, 600, 700, 800), loaded from
Google Fonts with a system fallback stack. Body weight is 500; UI labels are
600 or 700; titles are 800 with tight tracking. Numbers that change every
frame use `font-variant-numeric: tabular-nums`; a stats readout may use the
mono stack.

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap"
  rel="stylesheet"
/>
```

| Role    | Size | Weight | Tracking   | Colour                      |
| ------- | ---- | ------ | ---------- | --------------------------- |
| `h1`    | 40px | 800    | `-0.045em` | `--text`                    |
| title   | 22px | 800    | `-0.035em` | `--text`                    |
| section | 20px | 700    | `-0.01em`  | `--text`                    |
| body    | 14px | 500    | 0          | `--text`                    |
| label   | 13px | 600    | 0          | `--muted`                   |
| note    | 12px | 500    | 0          | `--muted` (line-height 1.5) |
| meta    | 12px | 500    | 0          | `--dim`                     |
| caps    | 10px | 700    | `0.14em`   | `--dim`, uppercase          |

## Shape

| Element                                | Radius           |
| -------------------------------------- | ---------------- |
| Pills, chips, segmented controls, CTAs | `999px`          |
| Cards, menus, toasts                   | `16px`           |
| Modals                                 | `20px`           |
| Inputs, icon buttons, rail items       | `12px`           |
| Text boxes, thumbnails                 | `14px`           |
| Progress bars                          | `2px` (4px tall) |

Borders are always `1px solid var(--border)` (`1.5px` on pills and dashed
drop slots). Line icons sit in a 24-box with a 1.8–2 stroke, round caps and
joins, `stroke: currentColor`, no fill.

## Components

Class names are the reference's; keep them so a search in either repository
finds the same thing.

**Primary CTA** (`.gm-cta`, `.gm-btn.primary`): mint on `--onmint`, 800 /
16px, `padding: 18px 28px`, pill, `box-shadow: var(--glow)`; hover lifts
`translateY(-1px)` and deepens the glow to `0.7` alpha. One per view,
bottom-right (`right: 28px; bottom: 28px`).

**Secondary button** (`.gm-btn.secondary`): `--s2` on `--text`, same shape,
no glow. **Disabled**: `--s1` background, `--dim` text, hairline border, no
shadow, no transform.

**Pill** (`.gm-pill`): transparent, `1.5px` border, 700 / 13px,
`padding: 8px 14px`. **Chip** (`.gm-chip`): same but 12px and
`padding: 7px 12px`; `.on` fills mint.

**Segmented** (`.gm-seg`): `rgba(36, 37, 43, 0.9)` pill with `3px` padding;
the `.on` segment is `--text` on `#151515`.

**Card** (`.gm-card`): `--s1`, hairline, `16px` radius, `padding: 14px 16px`,
column flex with `gap: 10px`. `.glass` swaps the background for `--glass`
with a 10px blur.

**Input** (`.gm-input`): `rgba(20, 21, 25, 0.6)` on a hairline, `12px`
radius, `padding: 9px 12px`, 600 / 13px; focus lightens the border to
`#3a3b44` and removes the outline. Placeholders are `--dim`.

**Progress** (`.gm-bar`): 4px track in `--border`, mint fill with
`box-shadow: 0 0 12px rgba(116, 236, 198, 0.6)`, `width` transitions
`0.4s linear`.

**Toast** (`.gm-toast`): 360px wide `--s1` card, `padding: 10px 14px 10px 10px`,
`box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55)`, slides in over `0.28s
cubic-bezier(0.2, 0.8, 0.2, 1)` from `translateY(-8px)`.

**Modal** (`.gm-modal`): 480px, `--s1`, `20px` radius, `padding: 26px 28px 20px`,
`--float` shadow, over a `rgba(10, 11, 14, 0.55)` backdrop with a 6px blur.

**Error** (`.gm-error`): 12px pink text, `line-height: 1.45`,
`word-break: break-word` — inside a card, never a red box.

**Focus**: `outline: 2px solid var(--pink); outline-offset: 3px` on
`:focus-visible`; inputs drop the outline and change border instead.

**Scrollbars**: `scrollbar-width: thin`, thumb `rgba(255, 255, 255, 0.12)`,
6px wide, `3px` radius, transparent track.

## The frame

A viewport-first layout: the 3D view is the whole main area and everything
floats on it with no hard edges. Rail 64px on the left, top bar 64px, a
right stack 330px wide at `right: 28px; top: 96px`, the CTA bottom-right,
stages (a numbered vertical stepper) at `left: 28px; top: 96px`. Overlays
are `pointer-events: none` with `auto` on each control so drags reach the
viewport. Under 760px the rail hides and the wordmark carries its own icon.

## Brand

The mark is the mint bunny (`docs/public/brand/icon-mint.png`, a 256px copy
of the reference's `brand/icon-mint.png`). It is the docs logo and favicon,
the rail mark, and the Gizmo avatar. The wordmark is the product name at
22px / 800 / `-0.035em`, with a `--dim` separator when a subject follows
("Gameable / Ada"). The mark leans `rotate(-8deg)` when shown inline with
the wordmark.

## Rules

1. **Dark only.** Set `color-scheme: dark`; never ship a light variant.
2. **Tokens, not literals.** New CSS reads `var(--mint)`, not `#74ecc6`. The
   only literal colours allowed are the hover border `#3a3b44`, the
   segmented "on" text `#151515`, and the alpha variants listed above.
3. **Mint means primary and on; pink means error, current and focus.** There
   is no third accent, no amber, no red.
4. **Pills for actions, 16px for surfaces, 12px for fields.** Nothing is
   square.
5. **Plus Jakarta Sans for UI, tabular numerals for counters.** The mono
   stack is for code, stack traces and the frame-time readout.
6. **Nothing has a hard edge over the viewport.** Floating things use
   `--s1` or `--glass` and a hairline; they never span the full width.
7. **Copy the class names.** `.gm-card`, `.gm-chip.on`, `.gm-cta` — the
   same word for the same thing in both repositories.

## Where the style is applied here

| Surface            | File                                             |
| ------------------ | ------------------------------------------------ |
| Docs site          | `docs/.vitepress/theme/tokens.css`, `custom.css` |
| Template shells    | `templates/*/index.html`                         |
| Example viewers    | `examples/*/index.html`                          |
| Default HUD        | `packages/wasm-host/src/hud.ts`                  |
| Fatal-error banner | `packages/wasm-host/src/engineAdapter.ts`        |
| Debug overlay      | `packages/core/src/debug/overlay.ts`             |

## See also

- [Add a HUD element](./docs/recipes/add-a-hud-element.md) — how the guest drives
  the HUD the host styles.
- [Glossary](./docs/glossary.md)
