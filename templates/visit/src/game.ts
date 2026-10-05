/**
 * The visit: where the character lives and how people visit.
 *
 * **This is the file to edit.** It runs inside the wasm guest: no DOM, no
 * fetch, no clock. Every number worth changing is in `rules`. The page
 * (`src/main.ts`) loads the character and the place and tells this file what
 * happens as short status lines on the character's conversation channel:
 *
 * | Line                             | Means                                                   |
 * | -------------------------------- | ------------------------------------------------------- |
 * | `setup:<mode>,<view>,<place>`    | The owner's choices; place is 1 when there is one       |
 * | `greeting:<text>`                | What to say when a visitor arrives                      |
 * | `ready:<headY>`                  | The character is on screen; its head joint's height    |
 * | `clips:<a,b,...>`                | The animation clips its rig carries                     |
 * | `aspect:<w/h>,<bottom>,<top>`    | The screen's shape, and how much the page covers        |
 * | `room:<x0>,<x1>,<z0>,<z1>,<top>` | The place's walls and ceiling: the camera stays inside  |
 * | `goto:<x>,<z>`                   | Hangout: the visitor tapped the floor (or her) there    |
 * | `start` / `end`                  | The visitor started or ended a conversation             |
 * | `wave`, `interrupt`, `microphone-on` / `-off` | The talk panel's buttons                   |
 *
 * and `input` events carry what the visitor typed or said. What goes back:
 * the camera, the character's clips, head and facing, `character.say` for the
 * greeting line, `conversation.command` for the relay, and the HUD model
 * `{ near }` that tells the page whether talking is open.
 */
import {
  camera,
  character,
  conversation,
  defineGame,
  hud,
  input,
  markMoved,
  MOUSE_BUTTONS,
  physics,
  prefab,
  quatFromYawPitch,
  Transform,
  TRANSFORM_FLAGS,
  type GameContext,
} from 'gameable';

/** Every tuning number. Distances in metres, angles in radians, times in seconds. */
export const rules = {
  /** Seconds after the character appears before the greeting. */
  greetAfter: 0.8,
  /** How long the greeting wave plays. */
  waveFor: 2.2,
  /** Hangout: within this distance of the character the visitor can talk. */
  nearDistance: 2.4,
  /** Hangout: tapping on (or right next to) the character walks up to this distance. */
  approachDistance: 1.3,
  /** Hangout: walking speed, and how far from the character the walk may go. */
  walkSpeed: 1.5,
  walkRadius: 8,
  /** Hangout: the visitor's eye height. */
  eyeHeight: 1.6,
  /** Orbit and look sensitivity, per pixel of drag. */
  dragTurn: 0.006,
  /** Zoom per wheel line (or pinch step). */
  zoomStep: 1.1,
  /** Chat: how far round the character the visitor may orbit, either side. */
  chatYawLimit: 1.2,
  /** How far inside the place's walls the camera stays, and how wide the lens may go there. */
  wallMargin: 0.35,
  maxFov: 75,
  /** Show: the camera drifts round at this rate while nobody drags. */
  showDrift: 0.08,
  /** Seconds between life clips while the character is idle (hangout and chat). */
  lifeEvery: 11,
  /** A clip the character plays now and then while idle, if the rig has it. */
  life: ['ual_idle_look_around'],
  /** Show: the routine, in order, with seconds for each. Clips the rig lacks are skipped. */
  show: [
    ['wave', 2.4],
    ['ual_idle_look_around', 4.6],
    ['ual_dance', 6],
    ['ual_celebration', 4],
    ['ual_idle_talking', 5],
    ['ual_counter_show', 4.7],
  ] as [string, number][],
  /** Seconds of plain idle between routine clips. */
  showRest: 1.2,
  /**
   * The start views, in shares of the character's head height (so a child and
   * a giant are framed alike): the span from `low` to `high` fills the part of
   * the screen the page leaves free, and at least `width` stays in frame side
   * to side. `pitch` looks down a little; `fov` is the lens, in degrees.
   */
  views: {
    portrait: { low: 0.8, high: 1.28, width: 0.34, pitch: 0.02, fov: 30 },
    half: { low: 0.5, high: 1.28, width: 0.45, pitch: 0.04, fov: 30 },
    body: { low: -0.03, high: 1.3, width: 0.56, pitch: 0.06, fov: 35 },
    room: { low: -0.25, high: 1.9, width: 1.9, pitch: 0.2, fov: 50 },
  },
};

type Mode = 'chat' | 'hangout' | 'show';
type View = keyof typeof rules.views;

const Visited = prefab({ name: 'visited', character: 'char.visit' });
/** The visitor's body, hangout only: a capsule the physics world walks. */
const VISITOR_RADIUS = 0.25;
const VISITOR_HALF = 0.55;
const Visitor = prefab({
  name: 'visitor',
  body: {
    shape: 'capsule',
    dims: [VISITOR_RADIUS, VISITOR_HALF],
    kind: 'character',
    mass: 70,
    layer: { player: true },
    mask: { defaultLayer: true, staticGeometry: true, character: true },
    flags: { lockRotation: true, noSleep: true },
  },
});

// ---- state (reset in init: module scope is frozen into the wasm build)
let npc = 0;
let visitor = 0;
let mode: Mode = 'chat';
let hasPlace = false;
let view: View = 'half';
let greeting = '';
let head = 1.6;
let aspect = 1;
/** How much of the screen the page's panels cover, bottom and top, as shares of its height. */
let coverBottom = 0;
let coverTop = 0;
/** The place's walls and ceiling (the white world has none). */
const room = { x0: -1e3, x1: 1e3, z0: -1e3, z1: 1e3, top: 1e3 };
let shown = false;
let greetIn = -1;
let greeted = false;
let talking = false;
let near = false;
/** The clip playing now, how long it has left, and where the routine is. */
let clip = 'idle';
let clipLeft = 0;
let step = -1;
let lifeIn = 0;
const clipsHere = new Set<string>();
/** Orbit camera: angles round the look target and distance. */
let yaw = 0;
let pitch = 0;
let dist = 2;
let dragQuiet = 0;
/** Hangout: the visitor's look and where a tap sent them (NaN: nowhere). */
let lookYaw = 0;
let lookPitch = 0;
let goX = Number.NaN;
let goZ = Number.NaN;
let faceYaw = 0;
let looking = false;
let hudSent = false;

const target = { x: 0, y: 1, z: 0 };
const eye = { x: 0, y: 1, z: 2 };
const turn = { x: 0, y: 0, z: 0, w: 1 };
const lookPoint = { x: 0, y: 1.6, z: 2 };
const NAMES = ['idle'];
const WEIGHTS = new Float32Array([1]);

/** Play one clip, alone, for `seconds` (0: until told otherwise). */
function play(name: string, seconds = 0): void {
  if (name !== 'idle' && !clipsHere.has(name)) return;
  clip = name;
  clipLeft = seconds;
  NAMES[0] = name;
  character.setClipWeights(npc, NAMES, WEIGHTS, 1);
}

/**
 * The view's framing for this character and this screen: stand back until the
 * span fits the free part of the screen (and the width fits across), then aim
 * so the span sits in the middle of that free part.
 */
function frame(v: View): void {
  const f = rules.views[v];
  const tan = Math.tan((f.fov * Math.PI) / 360);
  const free = Math.max(0.3, 1 - coverBottom - coverTop);
  const span = (f.high - f.low) * head;
  const seen = Math.max(span / free, (f.width * head) / Math.max(0.2, aspect));
  dist = seen / (2 * tan);
  // Where the free part's middle is, as a share of the screen height above the centre.
  const middle = (coverBottom + 1 - coverTop) / 2 - 0.5;
  target.x = 0;
  target.z = 0;
  target.y = ((f.low + f.high) / 2) * head - middle * seen;
  yaw = 0;
  pitch = f.pitch;
}

/** A drag this step: the button is held, or a quick flick let go of it during the step. */
function dragging(): boolean {
  return input.mouseDown(MOUSE_BUTTONS.LEFT) || input.mouseReleased(MOUSE_BUTTONS.LEFT);
}

/** Orbit: drag turns, wheel zooms; show drifts round on its own. */
function orbit(ctx: GameContext): void {
  const mouse = input.mouse;
  const f = rules.views[view];
  if (dragging() && (mouse.dx !== 0 || mouse.dy !== 0)) {
    yaw -= mouse.dx * rules.dragTurn;
    pitch = Math.min(0.9, Math.max(-0.25, pitch + mouse.dy * rules.dragTurn));
    dragQuiet = 3;
  } else if (dragQuiet > 0) dragQuiet -= ctx.dt;
  else if (mode === 'show' && !talking) yaw += rules.showDrift * ctx.dt;
  if (mouse.wheel !== 0) dist = Math.min(12, Math.max(0.5, dist * rules.zoomStep ** mouse.wheel));
  if (mode === 'chat') yaw = Math.min(rules.chatYawLimit, Math.max(-rules.chatYawLimit, yaw));
  const cp = Math.cos(pitch);
  eye.x = target.x + dist * Math.sin(yaw) * cp;
  eye.y = target.y + dist * Math.sin(pitch);
  eye.z = target.z + dist * Math.cos(yaw) * cp;
  inside(eye, rules.wallMargin);
  // A wall stopped the camera short: widen the lens so the same span stays in frame.
  const reach = Math.hypot(eye.x - target.x, eye.y - target.y, eye.z - target.z);
  let fov = f.fov;
  if (reach < dist * 0.98) {
    const wider = 2 * Math.atan((Math.tan((f.fov * Math.PI) / 360) * dist) / Math.max(0.3, reach));
    fov = Math.min(rules.maxFov, (wider * 180) / Math.PI);
  }
  camera.set(eye, turn, fov);
  camera.lookAt(target);
}

/** Hangout: walk with WASD or the arrows (the page's joystick presses the same keys), drag to look, tap to go. */
function walk(ctx: GameContext): void {
  const mouse = input.mouse;
  if (dragging() && (mouse.dx !== 0 || mouse.dy !== 0)) {
    lookYaw -= mouse.dx * rules.dragTurn;
    lookPitch = Math.min(1.1, Math.max(-1.1, lookPitch - mouse.dy * rules.dragTurn));
  }
  const x = Transform.x[visitor];
  const z = Transform.z[visitor];
  const move = input.axis2('A', 'D', 'S', 'W');
  let mx = move.x + (input.isDown('ArrowRight') ? 1 : 0) - (input.isDown('ArrowLeft') ? 1 : 0);
  let my = move.y + (input.isDown('ArrowUp') ? 1 : 0) - (input.isDown('ArrowDown') ? 1 : 0);
  let vx = 0;
  let vz = 0;
  if (mx !== 0 || my !== 0) {
    goX = Number.NaN;
    const n = Math.hypot(mx, my);
    mx /= n;
    my /= n;
    // Forward is where the visitor looks (yaw 0 looks toward -z).
    vx = (mx * Math.cos(lookYaw) - my * Math.sin(lookYaw)) * rules.walkSpeed;
    vz = (-mx * Math.sin(lookYaw) - my * Math.cos(lookYaw)) * rules.walkSpeed;
  } else if (!Number.isNaN(goX)) {
    const dx = goX - x;
    const dz = goZ - z;
    const d = Math.hypot(dx, dz);
    if (d < 0.15) goX = Number.NaN;
    else {
      const s = Math.min(rules.walkSpeed, d * 2.5);
      vx = (dx / d) * s;
      vz = (dz / d) * s;
      // Turn toward where we are going, gently.
      lookYaw += wrap(Math.atan2(-dx, -dz) - lookYaw) * Math.min(1, ctx.dt * 3);
    }
  }
  // Stay within reach of the character.
  const r = Math.hypot(x + vx * ctx.dt, z + vz * ctx.dt);
  if (r > rules.walkRadius) {
    vx -= (x / r) * rules.walkSpeed;
    vz -= (z / r) * rules.walkSpeed;
  }
  physics.moveCharacter(visitor, vx, 0, vz, false);
  eye.x = x;
  eye.y = Transform.y[visitor] - VISITOR_HALF - VISITOR_RADIUS + rules.eyeHeight;
  eye.z = z;
  quatFromYawPitch(turn, lookYaw, lookPitch);
  camera.set(eye, turn, 60);
  camera.lookAt(null);
}

/** Keep a point inside the place's walls, `margin` metres in. */
function inside(p: { x: number; y: number; z: number }, margin: number): void {
  p.x = Math.min(room.x1 - margin, Math.max(room.x0 + margin, p.x));
  p.z = Math.min(room.z1 - margin, Math.max(room.z0 + margin, p.z));
  p.y = Math.min(room.top - margin, Math.max(0.3, p.y));
}

/** Angle into (-PI, PI]. */
function wrap(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

/** Where the visitor's eyes are, for the character's gaze and facing. */
function visitorEye(): { x: number; y: number; z: number } {
  return eye;
}

/** Hangout: the visitor steps in where the start view's camera stands, inside the walls. */
function arrive(ctx: GameContext): void {
  if (visitor !== 0) return;
  const z = Math.max(1, Math.min(dist, room.z1 - rules.wallMargin - VISITOR_RADIUS));
  visitor = ctx.spawn(Visitor, { x: 0, y: VISITOR_HALF + VISITOR_RADIUS + 0.05, z }, turn);
  lookYaw = 0;
  lookPitch = -0.08;
}

/** A status line from the page. */
function status(textIn: string, ctx: GameContext): void {
  const at = textIn.indexOf(':');
  const key = at < 0 ? textIn : textIn.slice(0, at);
  const value = at < 0 ? '' : textIn.slice(at + 1);
  if (key === 'setup') {
    const [m, v, place] = value.split(',');
    mode = m === 'hangout' || m === 'show' ? m : 'chat';
    view = v in rules.views ? (v as View) : 'half';
    hasPlace = place === '1';
    frame(view);
    // A walker waits for the ground: the place's collision arrives with its walls.
    if (mode === 'hangout' && !hasPlace) arrive(ctx);
  } else if (key === 'greeting') greeting = value;
  else if (key === 'aspect') {
    const [a, bottom, top] = value.split(',').map(Number);
    aspect = a > 0 ? a : 1;
    coverBottom = bottom >= 0 && bottom < 0.7 ? bottom : 0;
    coverTop = top >= 0 && top < 0.5 ? top : 0;
    if (mode !== 'hangout') frame(view);
  } else if (key === 'ready') {
    head = Number(value) > 0.3 ? Number(value) : 1.6;
    if (mode !== 'hangout') frame(view);
    shown = true;
    greetIn = mode === 'hangout' ? -1 : rules.greetAfter;
    lifeIn = rules.lifeEvery;
  } else if (key === 'room') {
    const [x0, x1, z0, z1, top] = value.split(',').map(Number);
    if ([x0, x1, z0, z1, top].every(Number.isFinite) && x1 > x0 && z1 > z0) {
      room.x0 = x0;
      room.x1 = x1;
      room.z0 = z0;
      room.z1 = z1;
      room.top = top;
      if (mode === 'hangout') arrive(ctx);
    }
  } else if (key === 'clips') {
    clipsHere.clear();
    for (const name of value.split(',')) if (name) clipsHere.add(name);
  } else if (key === 'goto') {
    const [gx, gz] = value.split(',').map(Number);
    if (!Number.isFinite(gx) || !Number.isFinite(gz) || visitor === 0) return;
    // A tap on or right beside the character: walk up to talking distance, facing her.
    const d = Math.hypot(gx, gz);
    if (d < rules.approachDistance) {
      const vx = Transform.x[visitor];
      const vz = Transform.z[visitor];
      const k = rules.approachDistance / Math.max(0.01, Math.hypot(vx, vz));
      goX = vx * k;
      goZ = vz * k;
    } else {
      goX = Math.min(room.x1 - rules.wallMargin, Math.max(room.x0 + rules.wallMargin, gx));
      goZ = Math.min(room.z1 - rules.wallMargin, Math.max(room.z0 + rules.wallMargin, gz));
    }
  } else if (key === 'start') {
    talking = true;
    conversation.command(npc, 'start', 'visit');
    if (clip !== 'idle' && mode === 'show') play('idle');
  } else if (key === 'end') {
    talking = false;
    conversation.command(npc, 'end', 'visit');
  } else if (key === 'wave') play('wave', rules.waveFor);
  else if (
    talking &&
    (key === 'interrupt' || key === 'microphone-on' || key === 'microphone-off')
  ) {
    conversation.command(npc, key, 'visit');
  }
}

/** Greet: wave and say the greeting. */
function greet(): void {
  greeted = true;
  step = 0; // the routine's first clip is the wave; the greeting just did it

  play('wave', rules.waveFor);
  if (greeting) character.say(npc, greeting);
}

/** What the character does with its body this step. */
function behave(ctx: GameContext): void {
  if (clipLeft > 0) {
    clipLeft -= ctx.dt;
    if (clipLeft <= 0) {
      play('idle');
      clipLeft = mode === 'show' && !talking ? -rules.showRest : 0;
    }
    return;
  }
  if (clipLeft < 0) {
    clipLeft += ctx.dt;
    if (clipLeft < 0) return;
    clipLeft = 0;
  }
  if (mode === 'show' && greeted && !talking) {
    // The routine: the next clip the rig has.
    for (let i = 0; i < rules.show.length; i++) {
      step = (step + 1) % rules.show.length;
      const [name, seconds] = rules.show[step];
      if (clipsHere.has(name)) {
        play(name, seconds);
        return;
      }
    }
    return;
  }
  lifeIn -= ctx.dt;
  if (lifeIn <= 0 && !talking) {
    lifeIn = rules.lifeEvery;
    for (const name of rules.life) if (clipsHere.has(name)) return play(name, 4.6);
  }
}

/** Hangout: turn to face a visitor who comes near, and say whether talking is open. */
function attend(ctx: GameContext): void {
  const v = visitorEye();
  const d = Math.hypot(v.x, v.z);
  const nowNear = mode !== 'hangout' || d < rules.nearDistance;
  if (nowNear !== near || !hudSent) {
    near = nowNear;
    hudSent = true;
    hud.set({ near: near ? 1 : 0 });
  }
  if (mode === 'hangout') {
    if (near && !greeted && shown) greet();
    // Face the visitor while they are near; back to the front when they leave.
    const want = d < rules.nearDistance * 1.6 ? Math.atan2(v.x, v.z) : 0;
    const next = faceYaw + wrap(want - faceYaw) * Math.min(1, ctx.dt * 2.5);
    if (Math.abs(next - faceYaw) > 1e-4) {
      faceYaw = next;
      Transform.qx[npc] = 0;
      Transform.qy[npc] = Math.sin(faceYaw / 2);
      Transform.qz[npc] = 0;
      Transform.qw[npc] = Math.cos(faceYaw / 2);
      markMoved(npc, TRANSFORM_FLAGS.ROTATION);
    }
  }
  // Eyes and head on the visitor while they are in front and close enough.
  lookPoint.x = v.x;
  lookPoint.y = v.y;
  lookPoint.z = v.z;
  const facing = Math.abs(wrap(Math.atan2(v.x, v.z) - faceYaw)) < 1.2;
  if (near && facing) character.lookAt(npc, lookPoint, 1);
  else if (looking) character.lookAt(npc, null, 0);
  looking = near && facing;
}

export default defineGame({
  // Optional engine features this game opts into; the page resolves each by name.
  features: { characters: true },
  assets: ['char.visit'],
  world: { maxEntities: 16 },
  rules,
  init(ctx) {
    visitor = 0;
    mode = 'chat';
    hasPlace = false;
    view = 'half';
    greeting = '';
    head = 1.6;
    aspect = 1;
    coverBottom = coverTop = 0;
    shown = greeted = talking = near = false;
    greetIn = -1;
    clip = 'idle';
    clipLeft = 0;
    step = -1;
    lifeIn = rules.lifeEvery;
    clipsHere.clear();
    room.x0 = room.z0 = -1e3;
    room.x1 = room.z1 = room.top = 1e3;
    goX = goZ = Number.NaN;
    faceYaw = 0;
    looking = false;
    hudSent = false;
    npc = ctx.spawn(Visited, { x: 0, y: 0, z: 0 });
    play('idle');
    frame(view);
  },
  update(ctx) {
    for (const event of ctx.events) {
      if (event.tag !== 'conversation-event' || event.val.entity !== npc) continue;
      const { kind, text } = event.val;
      if (kind === 'status') status(text, ctx);
      else if (kind === 'input' && talking && near) conversation.command(npc, 'ask', 'visit', text);
    }
    if (mode === 'hangout' && visitor !== 0) walk(ctx);
    else orbit(ctx);
    if (!shown) return;
    if (greetIn > 0) {
      greetIn -= ctx.dt;
      if (greetIn <= 0) greet();
    }
    behave(ctx);
    attend(ctx);
  },
});
