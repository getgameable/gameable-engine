/**
 * The input contract: what the studio's exporter hands this page, read once.
 *
 * A published character's page frames this template and tells it what to show.
 * Two ways in, and they combine (a query parameter wins over the same field in
 * the JSON):
 *
 * 1. `?visit=<address>` — a same-origin JSON document, for example the publish
 *    lookup `/companion/public/<org>/<slug>`. Its fields are the ones below.
 * 2. Query parameters, one per field. The four the hello world already takes
 *    keep their names: `character`, `talk`, `id`, `name`.
 *
 * | Parameter   | JSON field              | What                                                       |
 * | ----------- | ----------------------- | ---------------------------------------------------------- |
 * | `character` | `character`             | The character package's `character.json` (or a folder name) |
 * | `level`     | `level`                 | A lighter package's `character.json`: phones load it alone, |
 * |             |                         | computers first, the full one taking over once it is drawn |
 * | —           | `packages.full.bytes`   | Each package's size, for the progress bar (files that come  |
 * |             | `packages.level.bytes`  | compressed carry no usable length of their own)             |
 * | `talk`      | `talk`                  | The conversation relay's base address                       |
 * | `id`        | `id`                    | The name the relay knows the character by                   |
 * | `name`      | `name`                  | The character's name, shown on the page                     |
 * | `greeting`  | `greeting`              | What the character says when a visitor arrives              |
 * | `mode`      | `mode`                  | `chat`, `hangout` or `show`                                 |
 * | `view`      | `view`                  | `portrait`, `half`, `body` or `room`                        |
 * | `place`     | `setting.splat`         | The place's splat file (`.spz` or `.ply`)                   |
 * | `placeLite` | `setting.lite`          | A lighter splat of the same place, loaded on phones         |
 * | `collider`  | `setting.collider`      | The place's collision mesh (`.glb`), for walking            |
 * | `pano`      | `setting.pano`          | The place's panorama, drawn behind the splat                |
 * | `placeBase` | `setting.base`          | `scale,floor,flip`: file units to metres, as the place came |
 * | `placeAt`   | `setting.placement`     | `scale,height,turn,x,z`: where the owner put the place      |
 * | `placeColorSpace` | `setting.colorSpace` | `srgb` (default: the studio's places) or `linear`     |
 * | `lite`      | —                       | `1` forces the phone load, `0` refuses it                   |
 * | `thing`     | `thing.splat`           | A thing to show instead of a character (see VisitThing)     |
 * | `thingSize` | `thing.sizeM`           | Its longest side, metres (`thing.heightM`: its height)      |
 * | —           | `badge`                 | The page's credit: `{show, href, text}` (see VisitBadge)    |
 * | `visit`     | —                       | The address of the JSON document itself                     |
 *
 * Every address must be on this page's own origin; anything else is ignored.
 * With no `character` the page shows the engine's sample character; with no
 * `place` it shows the white world. Pure: tested in node.
 */

/** What visitors get. */
export type VisitMode = 'chat' | 'hangout' | 'show';
/** The named camera a visitor starts on. */
export type StartView = 'portrait' | 'half' | 'body' | 'room';

/** What takes the place's file to metres (the studio's environment `base`). */
export interface PlaceBase {
  /** File units to metres. */
  scale: number;
  /** The floor's height in those metres once up is up (negative: under the file's origin). */
  floor: number;
  /** The file's y points down: turned over (180 degrees about x) to stand. */
  flip: boolean;
}

/** Where the owner put the place (the studio's `host.environment.placement`). */
export interface PlacePlacement {
  /** Times the real size. */
  scale: number;
  /** Metres up or down from floor-on-floor. */
  height: number;
  /** Degrees about the vertical, counter-clockwise seen from above. */
  turn: number;
  /** Metres along x. */
  x: number;
  /** Metres along z. */
  z: number;
}

/** A place around the character. */
export interface VisitSetting {
  splat: string;
  /** What the splat's colour bytes mean; studio places are `srgb` (the default). */
  colorSpace: 'srgb' | 'linear';
  lite: string | null;
  collider: string | null;
  pano: string | null;
  base: PlaceBase;
  placement: PlacePlacement;
}

/**
 * A THING instead of a character (Gameable Studio's create-anything): an object with no skeleton, no face and no
 * voice, shown standing on the floor at its real size. The page then loads no character and has no conversation.
 * JSON field `thing: {splat, colorSpace?, sizeM, heightM?}`; query parameters `thing`, `thingSize`.
 */
export interface VisitThing {
  /** The thing's points (a `.ply` or `.spz` standing on y = 0, metres). */
  splat: string;
  colorSpace: 'srgb' | 'linear';
  /** Its longest side, metres. */
  sizeM: number;
  /** Its height, metres, when known. */
  heightM: number | null;
}

/**
 * The page's credit, as the publish lookup gives it (`badge: {show, href, text}`): the companion
 * decides `show` (false only when a paid owner hid the credit), `href` links to Gameable with
 * the page's address as its ref, `text` is the credit's wording.
 */
export interface VisitBadge {
  show: boolean;
  href: string;
  text: string;
}

/** Everything the page needs, resolved to absolute same-origin addresses. */
export interface VisitConfig {
  /** The character package, or null for the engine's sample character. */
  character: string | null;
  /** The phone package, or null. */
  level: string | null;
  talk: string;
  id: string;
  name: string;
  greeting: string;
  mode: VisitMode;
  view: StartView;
  /** The place, or null for the white world. */
  setting: VisitSetting | null;
  /** `?lite=`: true forces the phone load, false refuses it, null decides by the device. */
  lite: boolean | null;
  /** Each package's size in bytes as the lookup gives it, or null when it does not. */
  sizes: { character: number | null; level: number | null };
  /** A thing to show instead of a character, or null. */
  thing: VisitThing | null;
  /** The page's credit from the lookup, or null (a lookup without one: the page's own chip stays). */
  badge: VisitBadge | null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FOLDER = /^[a-z0-9_-]{1,64}$/i;
/** The studio's own names for the same things, accepted so its records pass through. */
const MODE_ALIASES: Record<string, VisitMode> = {
  chat: 'chat',
  companion: 'chat',
  hangout: 'hangout',
  show: 'show',
};
const VIEW_ALIASES: Record<string, StartView> = {
  portrait: 'portrait',
  tight: 'portrait',
  half: 'half',
  medium: 'half',
  body: 'body',
  wide: 'body',
  room: 'room',
};

/** A same-origin absolute URL, or null. */
function sameOrigin(value: unknown, page: URL): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value, page);
    return url.origin === page.origin ? url.href : null;
  } catch {
    return null;
  }
}

/** A package address: a folder name under public/characters/, or a same-origin URL. */
function packageAddress(value: unknown, page: URL, base: string): string | null {
  if (typeof value === 'string' && FOLDER.test(value))
    return new URL(`${base}characters/${value}/character.json`, page).href;
  return sameOrigin(value, page);
}

/** A finite number within limits, or the fallback. */
function num(value: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** A name from one of the alias tables, or undefined. */
function alias<T>(table: Record<string, T>, value: unknown): T | undefined {
  const key = text(value, 16).toLowerCase();
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Plain text, trimmed and capped. */
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * The lookup's `badge`, or null when it has none (or an unusable link): only an http(s) link is
 * taken, and the credit shows unless `show` is exactly false.
 *
 * @param value The lookup's `badge` field.
 * @returns The credit, or null.
 */
export function readBadge(value: unknown): VisitBadge | null {
  if (value === null || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>;
  let href: string;
  try {
    const url = new URL(typeof b.href === 'string' ? b.href : '');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    href = url.href;
  } catch {
    return null;
  }
  return { show: b.show !== false, href, text: text(b.text, 80) || 'I made this with Gameable' };
}

/**
 * Draw the page's credit from the lookup on its chip: its words, linking to its address in a new
 * tab; hidden when the lookup says so. With no credit in the lookup the chip stays as it is.
 *
 * @param chip The chip: its link, and the element holding its words.
 * @param chip.link The chip's link.
 * @param chip.label The element holding its words.
 * @param badge The lookup's credit, or null.
 * @returns Nothing.
 */
export function applyBadge(
  chip: {
    link: { href: string; target: string; rel: string; hidden: boolean | 'until-found' };
    label: { textContent: string | null };
  },
  badge: VisitBadge | null,
): void {
  if (badge === null) return;
  chip.link.hidden = !badge.show;
  if (!badge.show) return;
  chip.link.href = badge.href;
  chip.link.target = '_blank';
  chip.link.rel = 'noopener';
  chip.label.textContent = badge.text;
}

/** `scale,floor,flip` or `{scale, floor, flip}` as a base. */
export function readBase(value: unknown): PlaceBase {
  const r = listOrRecord(value, ['scale', 'floor', 'flip']);
  const flip = r.flip;
  return {
    scale: num(r.scale, 1, 1e-4, 1e4),
    floor: num(r.floor, 0, -1e4, 1e4),
    flip: !(flip === false || flip === 0 || flip === '0' || flip === 'false'),
  };
}

/** `scale,height,turn,x,z` or `{scale, height, turn, x, z}` as a placement, within the studio's limits. */
export function readPlacement(value: unknown): PlacePlacement {
  const r = listOrRecord(value, ['scale', 'height', 'turn', 'x', 'z']);
  return {
    scale: num(r.scale, 1, 0.1, 10),
    height: num(r.height, 0, -5, 5),
    turn: num(r.turn, 0, -360, 360),
    x: num(r.x, 0, -25, 25),
    z: num(r.z, 0, -25, 25),
  };
}

function listOrRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value === 'string') {
    const parts = value.split(',');
    const out: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      if (parts[i] !== undefined) out[k] = parts[i].trim();
    });
    return out;
  }
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Read the page's inputs.
 *
 * @param href The page's address.
 * @param base Vite's BASE_URL, where bundled characters live.
 * @param doc The `?visit=` document, when there is one (already fetched).
 * @returns The resolved configuration.
 */
export function readVisit(href: string, base = '/', doc: unknown = null): VisitConfig {
  const page = new URL(href);
  const q = page.searchParams;
  const d = (doc !== null && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const s = (d.setting !== null && typeof d.setting === 'object' ? d.setting : {}) as Record<
    string,
    unknown
  >;
  const pick = (param: string, field: unknown): unknown => q.get(param) ?? field;
  const th = (d.thing !== null && typeof d.thing === 'object' ? d.thing : {}) as Record<
    string,
    unknown
  >;
  const thingSplat = sameOrigin(pick('thing', th.splat), page);

  let talk = sameOrigin(pick('talk', d.talk), page) ?? new URL(`${base}services/visit/`, page).href;
  if (!talk.endsWith('/')) talk += '/';
  const id = text(pick('id', d.id), 64);
  const splat = sameOrigin(pick('place', s.splat), page);
  const liteParam = q.get('lite');
  const packages = (
    d.packages !== null && typeof d.packages === 'object' ? d.packages : {}
  ) as Record<string, unknown>;
  const size = (entry: unknown): number | null => {
    const n =
      entry !== null && typeof entry === 'object' ? (entry as { bytes?: unknown }).bytes : null;
    return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
  };

  return {
    character: packageAddress(pick('character', d.character), page, base),
    level: packageAddress(pick('level', d.level), page, base),
    talk,
    id: ID.test(id) ? id : 'greeter',
    name: text(pick('name', d.name), 64) || 'Your character',
    greeting: text(pick('greeting', d.greeting), 280),
    mode: alias(MODE_ALIASES, pick('mode', d.mode)) ?? 'chat',
    view: alias(VIEW_ALIASES, pick('view', d.view)) ?? 'half',
    setting:
      splat === null
        ? null
        : {
            splat,
            colorSpace: pick('placeColorSpace', s.colorSpace) === 'linear' ? 'linear' : 'srgb',
            lite: sameOrigin(pick('placeLite', s.lite), page),
            collider: sameOrigin(pick('collider', s.collider), page),
            pano: sameOrigin(pick('pano', s.pano), page),
            base: readBase(pick('placeBase', s.base)),
            placement: readPlacement(pick('placeAt', s.placement)),
          },
    lite: liteParam === '1' ? true : liteParam === '0' ? false : null,
    sizes: { character: size(packages.full), level: size(packages.level) },
    thing:
      thingSplat === null
        ? null
        : {
            splat: thingSplat,
            colorSpace: th.colorSpace === 'linear' ? 'linear' : 'srgb',
            sizeM: num(pick('thingSize', th.sizeM), 1, 0.05, 200),
            heightM:
              th.heightM === undefined || th.heightM === null
                ? null
                : num(th.heightM, 1, 0.01, 200),
          },
    badge: readBadge(d.badge),
  };
}

/**
 * What this device loads, in order. A phone: the lighter package alone (the full one when there
 * is no lighter one). A computer: the lighter package first, so the character is on screen in a
 * few seconds, then the full one, which takes over between two frames once it is ready; the full
 * one alone when there is no lighter one.
 *
 * @param config The page's inputs.
 * @param lite Whether this device takes the phone load (`wantsLite`).
 * @returns The package drawn first, the one that takes over after it (or null), and their sizes.
 */
export function loadPlan(
  config: Pick<VisitConfig, 'character' | 'level' | 'sizes'>,
  lite: boolean,
): { first: string | null; then: string | null; firstBytes: number | null } {
  const { character, level, sizes } = config;
  if (lite && level) return { first: level, then: null, firstBytes: sizes.level };
  if (!lite && level && character && level !== character)
    return { first: level, then: character, firstBytes: sizes.level };
  return { first: character, then: null, firstBytes: sizes.character };
}

/**
 * Read the inputs, fetching the `?visit=` document first when there is one.
 * A document that does not load is said in the returned `error` and the query
 * parameters still apply.
 *
 * @param href The page's address.
 * @param base Vite's BASE_URL.
 * @returns The configuration, and what went wrong fetching the document.
 */
export async function loadVisit(
  href: string = location.href,
  base: string = import.meta.env.BASE_URL,
): Promise<{ config: VisitConfig; error: string | null }> {
  const page = new URL(href);
  const address = sameOrigin(page.searchParams.get('visit'), page);
  if (address === null) return { config: readVisit(href, base), error: null };
  try {
    const response = await fetch(address, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    return { config: readVisit(href, base, await response.json()), error: null };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { config: readVisit(href, base), error: `The page's settings did not load (${why}).` };
  }
}

/**
 * Where the place sits on the stage: the studio's own maths (envPlacement.ts),
 * so a place stands here exactly as it stood in the studio. The character's
 * floor is y = 0.
 *
 *   p = T + Ry(turn) Rx(flip ? 180 : 0) (base.scale * placement.scale) p_file
 *   T = (x, height - placement.scale * base.floor, z)
 *
 * @param setting The place.
 * @returns Position, quaternion (x, y, z, w) and uniform scale.
 */
export function placeTransform(setting: Pick<VisitSetting, 'base' | 'placement'>): {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
} {
  const { base, placement } = setting;
  const half = (placement.turn * Math.PI) / 360;
  const c = Math.cos(half);
  const s = Math.sin(half);
  return {
    position: [placement.x, placement.height - placement.scale * base.floor, placement.z],
    // Ry(turn) * Rx(180) = (c, 0, -s, 0); Ry(turn) alone = (0, s, 0, c)
    quaternion: base.flip ? [c, 0, -s, 0] : [0, s, 0, c],
    scale: base.scale * placement.scale,
  };
}

/**
 * Should this device take the phone load? A phone-sized touch screen or a
 * small-memory device does, unless `?lite=` says otherwise.
 *
 * @param forced The `?lite=` answer, or null.
 * @param device What the browser says about itself.
 * @returns True for the phone load.
 */
export function wantsLite(
  forced: boolean | null,
  device: { coarse: boolean; shortSide: number; memoryGb: number },
): boolean {
  if (forced !== null) return forced;
  return (device.coarse && device.shortSide < 900) || device.memoryGb <= 4;
}
