# Hello world with your Gameable character

Export a finished character from the [Gameable studio](https://app.gameable.com), import it
into `examples/wasm-hello`, then wave and talk to it. The guest spawns the
character by asset id. The host animates the exported splats, displays render
FPS and connects Voxy microphone input to the character's spoken replies.

## Before you start

Follow [Install](./01-install.md) to set up the engine checkout with Node 24+
and `npm install`. You also need a finished character in the Gameable studio
and a WebGPU-enabled browser. This character format requires WebGPU in both
direct and wasm mode.

The hosted [hello-world example](https://engine.gameable.com/play/wasm-hello/)
runs a demo character. The public repository does not include one: follow the
export steps below to bring your own.

## 1. Export from the Gameable studio

1. Open your character in the Gameable studio and select the head version you
   want to use.
2. Finish the body and merge the selected head and body. Apply any body
   adjustments before merging. If you change the head version or body
   adjustments, merge again before exporting.
3. On the finished character, choose **Export**. The companion fits the rig,
   bakes the face and binds the splats. Wait for **Export ready** and the ZIP
   download. Progress and errors appear beside the button; a disabled Export
   button means the selected head and body still need merging.
4. Extract the complete ZIP into a folder. Use the folder containing
   `character.json`, rather than a parent folder created by your unzip tool.

The export contains:

| File                                   | Purpose                                                      |
| -------------------------------------- | ------------------------------------------------------------ |
| `character.json`                       | Descriptor, relative file paths and SHA-256 hashes           |
| `character.ply`                        | Merged character's original splats                           |
| `rig.glb`                              | Fitted body skeleton and `idle`, `walk`, `run`, `wave` clips |
| `head.aosrig`                          | Fitted face data                                             |
| `bindings.bin`                         | Splats' body and face bindings                               |
| `assets.json`                          | Manifest entry for importing into a game                     |
| `NOTICE.md`, `README.md`, `example.ts` | Notices and loading example                                  |

Keep these files together, including the notices. A standalone PLY or mesh
export does not contain the rig and bindings needed to animate this character.

## 2. Import the character

From the **engine repository root**, run this command with your extracted
folder (quote paths containing spaces):

```sh
npm run import:character -w examples/wasm-hello -- "/absolute/path/to/extracted-character"
```

On Windows, `"C:/Users/you/Downloads/my-character"` works in cmd and Git Bash.
The importer checks the descriptor's file hashes and copies the export,
including notices, into `examples/wasm-hello/public/characters/greeter/`.
Importing again replaces the bundled demo there. These files are tracked with
Git LFS so clean deployment checkouts include the character. Vite copies them
into production builds, so retain
the export's notices and distribution restrictions when sharing a build.

## 3. Run hello world

```sh
npm run dev -w examples/wasm-hello
```

Open `http://localhost:5180`. Your exported character should appear with
**Made with Gameable** branding, the Gameable logo, an FPS counter and a status
reading **Gameable character**. Click **Wave** to try its animation. Loading can take a while for a large export. The card reports
errors if a file is missing, a hash disagrees or WebGPU is unavailable.

## 4. Follow the asset into the guest

`examples/wasm-hello/src/main.ts` registers the exported descriptor:

```ts
const manifest = parseManifest({
  version: 1,
  assets: [
    {
      id: 'char.greeter',
      type: 'character',
      src: `${import.meta.env.BASE_URL}characters/greeter/character.json`,
      tags: ['character'],
      rig: { backend: 'aosrig-splat' },
    },
  ],
});
```

This adapts the ZIP's `assets.json` entry: `char.exported` becomes the example's
`char.greeter`, and `src` points into the imported folder. `BASE_URL` keeps the
path working under `/play/wasm-hello/`. The descriptor's own file paths remain
relative to `character.json`; do not edit them or its hashes.

The host installs `splat()` and creates the character bridge. In
`examples/wasm-hello/src/game.ts`, the guest refers only to the asset id:

```ts
const Greeter = prefab({ name: 'greeter', character: 'char.greeter' });
// Inside init(ctx):
greeter = ctx.spawn(Greeter, { x: 0, y: 0, z: 0 });
character.setClipWeights(greeter, ['idle', 'wave'], [1, 0], 1);
```

Those initial commands cross the sandbox boundary once. The host continues
animating while the guest handles conversation and Wave events. The example
preallocates the clip arrays outside `update`; no animation command is sent
every idle frame. Import a different character and reload to use the same guest.

## 5. Build and verify the wasm version

```sh
npm test -w examples/wasm-hello
npm run build -w examples/wasm-hello
npm run preview -w examples/wasm-hello
```

Open `http://localhost:4180`. The same character, FPS counter and controls now
run with the compiled wasm guest. The headless tests check spawn, animation
transitions and conversation routing; checking the browser verifies that the
actual exported character loads.
Import before building, and rebuild after replacing the character. To build
the docs site's playable version, use `node tools/docs/build-games.mjs wasm-hello`.

If the character does not appear, read the status card and browser console.
Re-extract and re-import the complete ZIP for missing files or hash mismatches;
enable WebGPU for this format. See [Troubleshooting](../troubleshooting.md) for
toolchain issues.

## 6. Enable voice and text conversation

Talking characters run on Gameable's hosted conversation and transcription
services. Copy `examples/wasm-hello/.env.example` to `.env.local` beside it and
set `GAMEABLE_API_KEY` to the API key from your
[Gameable account](https://app.gameable.com). It is a server credential; never
put it in a `VITE_` variable or game source. From the engine root:

```sh
npm run provision -w examples/wasm-hello
npm run relay -w examples/wasm-hello
```

Provision installs the included `engine-hello` guide story in your account. Leave
the relay running and start dev or preview in a second terminal. Both proxy
`/services/hello/` to port 8788. Click **Start conversation**, then type a
question or turn **Microphone on**. Allow microphone access to speak. Voxy
shows a waveform from actual input; replies carry the character's voice and
facial animation. **Interrupt** stops a reply; **End conversation** disconnects and
stops capture. You can still type if microphone permission is denied.

Use HTTPS or localhost for microphone access. For another browser origin, add
it explicitly to `HELLO_ORIGINS`. The docs container includes the relay and
needs the same key at runtime; without it, character playback and Wave work
but conversation cannot connect. The browser receives no service keys.

Next: [your first FPS](./02-first-fps.md), [your first adventure](./03-first-adventure.md),
or [how the wasm boundary works](../concepts/wasm-boundary.md).
