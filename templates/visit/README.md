# Gameable Engine visit template

A character's own page, and a person's first game: **where the character lives
and how people visit.** The studio's exporter hands it a character package, a
place and the owner's choices; the page shows the character in the place,
idling with its life clips, greets the visitor, listens (microphone or typed
text) and answers with a voice and a moving face.

```sh
npm install
npm run dev          # http://localhost:5188 — the engine's sample character in the white world
```

Point it at a real export with query parameters (every address on the page's
own site), for example:

```
/?character=/local/characters/<name>/character.json&name=<Name>&greeting=Hey!&mode=hangout&view=room
  &place=/local/places/<place>/world.spz&collider=/local/places/<place>/collider.glb
  &pano=/local/places/<place>/pano.png&placeBase=<scale>,<floor>,<flip>
```

`public/local/` is ignored by git: copy packages and places there to try them.

## The three modes

| Mode      | What the visitor gets                                                                                  | Controls                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `chat`    | The character faces the visitor, greets, and talks. Looks at the camera.                               | Drag to orbit (a little way round), wheel or pinch to zoom                  |
| `hangout` | The visitor walks round the place; the character turns to them, greets when they come near, talks then | WASD / arrows or the thumb stick, drag to look, tap the floor to walk there |
| `show`    | The character performs the clips its rig carries, the camera drifts round; stops to talk               | Drag to orbit, wheel or pinch to zoom                                       |

## The input contract

Query parameters, or a same-origin JSON document named by `?visit=` (the publish
lookup), with the same fields. A parameter wins over the JSON.

| Parameter         | JSON field           | Meaning                                                                        |
| ----------------- | -------------------- | ------------------------------------------------------------------------------ |
| `visit`           | —                    | Address of the JSON document                                                   |
| `character`       | `character`          | The character package's `character.json` (or a folder under `characters/`)     |
| `level`           | `level`              | A lighter package's `character.json`: phones load it alone, computers first    |
| —                 | `packages.*.bytes`   | Each package's size (`full`, `level`), for the progress bar                    |
| `talk`            | `talk`               | The conversation relay's base (`<talk>conversation`, `<talk>transcribe`)       |
| `id`              | `id`                 | The name the relay knows the character by                                      |
| `name`            | `name`               | The character's name on the page                                               |
| `greeting`        | `greeting`           | What the character says to a visitor who arrives                               |
| `mode`            | `mode`               | `chat` (default), `hangout`, `show`; the studio's `companion` means `chat`     |
| `view`            | `view`               | `portrait`, `half` (default), `body`, `room`; `tight` / `medium` / `wide` too  |
| `place`           | `setting.splat`      | The place's splat (`.spz` or `.ply`); none means the white world               |
| `placeLite`       | `setting.lite`       | A lighter splat of the same place, loaded on phones                            |
| `collider`        | `setting.collider`   | The place's collision mesh (`.glb`), downloaded only in `hangout`              |
| `pano`            | `setting.pano`       | The place's panorama, drawn behind the splat                                   |
| `placeBase`       | `setting.base`       | `scale,floor,flip` — the place's own base (`meta.json` `base`)                 |
| `placeAt`         | `setting.placement`  | `scale,height,turn,x,z` — the owner's placement (`host.environment.placement`) |
| `placeColorSpace` | `setting.colorSpace` | `srgb` (default; a studio place) or `linear`                                   |
| `lite`            | —                    | `1` forces the phone load, `0` refuses it                                      |
| `thing`           | `thing.splat`        | A thing's points (a studio object) shown instead of a character                |
| `thingSize`       | `thing.sizeM`        | The thing's longest side, metres (`thing.heightM` too, when known)             |
| —                 | `badge`              | The page's credit, `{show, href, text}`; without one the page keeps its own    |

The place stands exactly where the owner put it in the studio: the same maths
as the studio's `envPlacement.ts` (`placeTransform` in `src/visit.ts`).

## What is here

```
index.html            the page: name card, talk panel, thumb stick
src/
  game.ts             THE FILE YOU EDIT — the rules: views, greeting, modes, the show routine
  visit.ts            the input contract, read once
  main.ts             the host: engine boot, the phone load, status lines to the game
  stage.ts            the place (splat, collision, panorama) or the white world
  thing.ts            a thing's page: no character, no talk, the camera going round it
  talk.ts             the hello world's conversation and lip-sync wiring
  controls.ts         touch drag / pinch / stick / tap, as the input the game reads
  ui.ts, style.css    words and controls
tests/                the contract and the rules, headless
```

Everything under `src/` except `game.ts` stays in the browser; `game.ts` is
compiled into the wasm guest by `npm run build`.

## Talking locally

`/services/visit/` is proxied to port 8788: run the hello world's relay
(`npm run relay -w examples/wasm-hello`, see its README) and open the page with
`?id=greeter`. A published page passes its own relay with `?talk=`.

## Gotchas

- **The page waits for nothing but the character.** The place streams in behind
  it; the panorama shows while the splat downloads.
- **Phones get the lighter load**: the `level` package alone (with its own pose
  corrections) and the place's `lite` splat. A computer draws the `level`
  package first and the full one takes over once it is ready. `?lite=1` tries
  the phone load on a desktop.
- **A place's colours are sRGB** (`placeColorSpace`, the default): `linear` is
  only for a place trained in linear light.
- **The walker needs the ground first**: in `hangout` the visitor steps in
  once the place's collision mesh is in the physics world.
