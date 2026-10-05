# Build your first adventure

Twenty minutes from nothing to a third-person game you can play, and one file to
change.

## 1. Scaffold

```sh
npm create gameable my-adventure -- --template third-person
cd my-adventure
npm run dev
```

Open the page, click the canvas, and play: WASD to move, shift to run, space to
jump, the mouse to swing the camera, `E` to interact, `1` and `2` to answer a
question. A skinned character walks around a gaussian-splat arena with the
camera on a boom behind it; two people will talk to you, two chests will open, one of them
has the key, and the door in the north wall opens when you bring it.

That is the starting point, not the destination. The rest of this page explains
what you were given so you can change it.

Working inside the engine repository instead? The same template is a workspace
member:

```sh
npm install
npm run dev -w templates/third-person
```

## 2. What the template contains

```
my-adventure/
├─ index.html
├─ vite.config.ts       one plugin: gameable()
├─ src/
│  ├─ main.ts           the host: engine boot, lights, arena collider, sandbox
│  ├─ game.ts           THE FILE YOU EDIT
│  ├─ prefabs.ts        what things are made of, and the tags that say what they are
│  ├─ arena.ts          where things spawn
│  ├─ dialogue.json     what people say
│  ├─ hud.ts            what the HUD shows
│  ├─ assets.json       asset ids to files
│  └─ systems/
│     ├─ locomotion.ts  idle -> walk -> run -> jump -> fall, and the orbit camera
│     ├─ interact.ts    the E prompt, chests, the key, the door
│     └─ dialogue.ts    walking a conversation, expressions, gaze
├─ tests/game.test.ts   the whole game, driven headlessly
└─ AGENTS.md            these rules, scoped to your game
```

`game.ts` and everything it imports are compiled into the **wasm guest**. It
may not touch the DOM, fetch anything, or ask for the time. `main.ts` and the
host files it loads stay in the browser. That is the same split as
[the FPS template](./02-first-fps.md); if you have read that page, skip to
section 4.

## 3. The shape of `game.ts`

```ts
import { defineGame } from 'gameable';

export default defineGame({
  assets: ['env.arena', 'char.guide', 'sfx.key', 'sfx.door', 'sfx.talk', 'sfx.step'],
  world: { gravity: -9.81, maxEntities: 256 },

  player: {
    prefab: HeroPrefab,
    spawn: HERO_SPAWN,
    camera: 'thirdPerson',
    distance: 4.5,
    height: 1.5,
  },

  spawns: [
    place(GuidePrefab, arenaSpawns.npcs[0], NPC_CENTRE),
    place(WandererPrefab, arenaSpawns.npcs[1], NPC_CENTRE),
    place(KeyChestPrefab, arenaSpawns.chests[0], CHEST_CENTRE),
    place(ChestPrefab, arenaSpawns.chests[1], CHEST_CENTRE),
    place(DoorPrefab, arenaSpawns.door, DOOR_CENTRE),
  ],

  rules: {
    walkSpeed: 1.6,
    runSpeed: 4,
    cameraDistance: 4.5,
    interactRange: 2,
    doorTravel: 2.4,
    winMessage: 'You escaped',
  },

  systems: [locomotionSystem, interactSystem, dialogueSystem, updateHud],
});
```

The level is a `spawns` list rather than a loop in `init`, and that is worth a
sentence. Every prefab says what it is with **tags** — `Interactable` plus one
of `Chest`, `Door`, `Npc`, `Key` — so nothing has to be looked up and patched
after the spawn. `classifyInteractables` turns those tags into one integer per
entity once, during `init`, and the interact system reads that integer instead
of asking the ECS four questions sixty times a second.

## 4. The camera is the interesting part

In a first-person game the camera is the player's eyes. In a third-person game
it is a machine, and the guest does not own it. `src/systems/locomotion.ts`
states an intent:

```ts
ctx.camera.follow(hero, { yaw, pitch, distance: 4.5, height: 1.5 });
```

That writes one `camera-state` record: the orbit pivot, the direction the player
is looking, and how long the boom should be. The **host** builds a spring arm
from it, casts a ray from the pivot towards where the camera wants to sit, and
pulls the boom in to just short of whatever it hits. You never write the
collision, and the guest never learns the geometry of your level.

Two consequences worth knowing:

1. **Forward is away from the camera.** That is why one system owns both the
   walk direction and the orbit — they are the same number.
2. **The declarative rig re-states the camera after your systems run**, out of
   the built-in look accumulator. `orbit()` clamps `ctx.camera.look.pitch` in
   place so the two cannot disagree. Copy that pattern if you take the pitch
   somewhere else.

## 5. A state machine, in outline

```ts
locomotionState.state = grounded
  ? planar < STILL_SPEED
    ? IDLE
    : running
      ? RUN
      : WALK
  : wantsJump || vy > 0
    ? JUMP
    : FALL;

character.setState(hero, locomotionState.state, vx, vy, vz, grounded);
```

`grounded` comes from the vertical velocity the host wrote into this frame's
body rows, plus a short lock after a jump is requested — a jump is a request,
not a teleport, and the upward speed only arrives on the next frame.

`character.setState` is the line that matters. It is the contract the
character's animator blends from: the planar speed picks idle, walk or run, and
the name is your own vocabulary. The hero prefab's `character: 'char.hero'` is
what puts the sample rig on the capsule's body; the NPCs' `character:
'char.guide'` does the same, and the `setExpression` and `lookAt` the dialogue
system sends per line are recorded against them. **Nothing in `src/` changes
when a splat character replaces the mesh.**

## 6. Talking to people

`src/dialogue.json` is data:

```json
{
  "guide": {
    "speaker": "Guide",
    "lines": [{ "text": "You are awake. Good.", "face": "smile" }],
    "question": {
      "text": "Shall I tell you which chest?",
      "face": "smile",
      "yes": { "text": "The one in the middle of the floor.", "face": "smile" },
      "no": { "text": "Suit yourself.", "face": "neutral" }
    }
  }
}
```

A JSON import is bundled into the wasm guest along with everything else, so this
file ships in the component; there is no fetch and no loading state. Which script
an NPC runs is a tag on its prefab, so adding a character with something new to
say is an entry in this file and a prefab, and no change to the system that
walks it.

While anyone is talking, `dialogueState.active` is true and the locomotion
system stops driving the hero. You cannot walk away mid-sentence.

## 7. Change something

Pick one; each is a recipe of its own:

- [Add an interactable](../recipes/add-an-interactable.md) — a lever, in two files.
- [Add NPC dialogue](../recipes/add-npc-dialogue.md) — a third person with their own script.
- [Tune the follow camera](../recipes/tune-the-follow-camera.md) — boom, height, pitch range, shoulder.
- [Add a locomotion state](../recipes/add-a-locomotion-state.md) — a crouch, reported to the animator.

## 8. Test it

```sh
npm test
```

`tests/game.test.ts` runs the real systems against a mock host — no browser, no
renderer, no physics engine. It walks the hero at both speeds, jumps it, checks
that the camera rides a boom behind it, opens a chest, refuses the door without
the key and opens it with one, takes both branches of the guide's question,
asserts that the character commands go out, and checks that the same seed
produces the same frames twice.

That is the loop to work in. The browser is for looking at it.

## 9. Ship it

```sh
npm run build     # guest component + production bundle
npm run preview
```

`npm run dev` runs your TypeScript directly; `npm run build` compiles the very
same TypeScript — `src/dialogue.json` included — into a QuickJS WebAssembly
component. The host code is identical and `import.meta.env.GAMEABLE_MODE` is the only
difference. If the two behave differently, that is an engine bug — report it
rather than working around it.

## See also

- [Build your first FPS](./02-first-fps.md) — the same engine, the other genre
- [ECS and game code](../concepts/ecs.md)
- [The wasm boundary](../concepts/wasm-boundary.md)
- [Characters](../concepts/characters.md)
- [Recipes](../recipes/index.md)
