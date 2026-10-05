# gameable/audio

## What

The audio `EngineModule`: a four-bus WebAudio graph (`master` over `sfx`,
`music`, `voice`), pooled one-shot playback by sound handle, positional voices
through an HRTF `PannerNode`, a listener driven by a position and a quaternion,
and an `ended` pool the host turns into `sound-ended` events.

It has no three.js dependency — positions and rotations are plain
`[x, y, z]` / `[x, y, z, w]` arrays.

## When to use

Your game plays sound. Put `audio()` in the engine's module list; the guest
emits `play-sound`, `stop-sound` and `set-listener` commands and the host maps
them onto `engine.get('audio')`.

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install.

## Minimal example

```ts
import { audio } from 'gameable/audio';

// `init` builds the engine and returns it, so it is published as the 'audio'
// service. Before `init` there is no engine and no AudioContext at all.
const mod = audio({ masterVolume: 0.8 });
const engine = mod.init(ctx);

// A play-sound command carries an asset handle, never a URL. The first shot
// awaits the decode; every later one reads the settled buffer straight back.
const buffer = mod.decodedAsset(pistolHandle) ?? (await mod.decodeAsset(pistolHandle));
engine.play({ id: 1, buffer, pos: [3, 0, -4], volume: 0.9, bus: 'sfx' });
engine.setListener([0, 1.7, 0], [0, 0, 0, 1]);

// Once per frame: pump the engine, then drain the ended pool.
mod.update(1 / 60, 0);
for (const soundId of engine.ended) emitSoundEnded(soundId);
engine.ended.length = 0;
```

## API

- `audio(options?)` — the `EngineModule` factory. `id` is `'audio'`, `order`
  defaults to 30, and `init` returns the engine (so it is published as the
  `'audio'` service) and installs a one-time `pointerdown`/`keydown` listener
  that calls `resume()`. `service` is the same engine, and is `null` before
  `init` and after `dispose`; `decodeAsset(idOrHandle)` bridges a manifest asset
  to an `AudioBuffer`, and `decodedAsset(idOrHandle)` returns that buffer
  synchronously once the decode has settled — that is what lets the host play a
  repeated sound inside the frame that asked for it.
- `createAudioEngine({ context?, masterVolume? })` — the engine on its own, for
  tests and for hosts that already own an `AudioContext`.
- Engine surface: `context`, `buses.{master,sfx,music,voice}`,
  `decode(id, data)`, `play({ id, buffer, pos?, volume?, loop?, bus? })`,
  `stop(id)`, `setListener(pos, rotQuat)`, `setVolume(id, v)`, `update()`,
  `ended`, `resume()`, `dispose()`.
- `gameable/audio/testing` — `createFakeAudioContext()`,
  `createFakeAudioBuffer(duration)` and `asAudioContext(fake)`, a
  dependency-free fake for node tests in any package.
- Commands: `play-sound`, `stop-sound`, `set-listener`.
- Events: `sound-ended` arrives in the next `frame-input`.

## Gotchas

- Browsers keep the context suspended until a user gesture. The module resumes
  it on the first `pointerdown` or `keydown`; before that, `play` is silent.
- `ended` is a pool, not a stream. `update` appends to it and never clears it —
  the host must do `ended.length = 0` after turning it into events. It stops
  growing at 256 handles, so a host that never drains it cannot leak.
- `ended` lists only voices that ran to their **natural end**, which is why the
  host can report `completed: true` for every one of them. A voice the game
  stopped itself — `stop(id)`, or a `play` reusing a live handle — is not
  listed: the game already knows, and the list has no field to say
  "stopped early" with.
- Looping voices never end on their own. Only `stop(id)` retires them, and that
  reports nothing.
- `update()` times voices on `context.currentTime`, not on the frame delta it
  used to take: a long frame, a background tab or a `timeScale` change cannot
  drift playback and bookkeeping apart. A suspended context does not advance,
  and neither does playback.
- Sounds are addressed by manifest id, never by URL. `decode` caches by that id,
  so decoding the same asset twice costs nothing.
- Voices are pooled and `update` allocates nothing, so it is safe in the frame
  loop. Do not hold on to the `GainNode` behind a voice: it is recycled.
- `dispose()` closes the `AudioContext` only when the engine created it. A
  context you passed in stays yours. `dispose()` before `init` is a no-op —
  there is nothing to close.

## See also

- [Play a sound](../../docs/recipes/play-a-sound.md)
- [Engine modules](../../docs/concepts/modules.md)
