# wasm-hello

One character exported from the **Gameable studio**, spawned by the guest, with a real render
FPS counter, Gameable branding and voice or text conversation. Follow the [hello-world tutorial](../../docs/start/01-hello-world.md)
for the complete Studio export → engine import → wasm build walkthrough.

The public repository includes no character: export and import your own below
before starting the example.

## Export and import

In the Gameable studio, finish merging the selected head and body, then choose
**Export** on the finished character. Wait for **Export ready**, download the
ZIP and extract it. Keep every file, including `NOTICE.md`.

From the engine repository root, pass the extracted folder containing
`character.json`:

```sh
npm run import:character -w examples/wasm-hello -- "/absolute/path/to/extracted-character"
npm run dev -w examples/wasm-hello      # http://localhost:5180, direct sandbox
npm test -w examples/wasm-hello         # the guest, headless
npm run build -w examples/wasm-hello    # componentize + bundle
npm run preview -w examples/wasm-hello  # http://localhost:4180, wasm sandbox
```

The importer verifies SHA-256 hashes and copies the export into
`public/characters/greeter/`, replacing the tracked demo. Vite includes it in
builds; keep the export's notices and
distribution restrictions. Re-import to replace the character, then reload
(or rebuild for production).

**WebGPU is required**, in both sandbox modes. The status card reports loading
failures and only announces readiness after the exported character attaches.

## What it proves

`src/main.ts` maps `char.greeter` to the exported `character.json` with the
`aosrig-splat` backend. It installs the splat module and character bridge.
The export supplies the splats, body rig, face pack and bindings; a standalone
PLY or GLB is not enough.

`src/game.ts` uses only `char.greeter`. It spawns the character and starts idle
once. Chat controls become semantic events for the same guest in direct and
wasm mode; the host runs Voxy capture, the hosted conversation service, spoken
replies and synchronized facial animation. Wave plays briefly and returns to idle.
No asset URLs cross the wasm boundary.

The host measures rendered frames, not simulation ticks.

## Talk to the character

Copy `.env.example` to `.env.local` in this example and set `GAMEABLE_API_KEY`
to the API key from your [Gameable account](https://app.gameable.com). It stays
server-side, in the relay. From the repository root:

```sh
npm run provision -w examples/wasm-hello
npm run relay -w examples/wasm-hello
```

Leave the relay running, then run dev or preview in another terminal. Click
**Start conversation**, type a question, or turn **Microphone on**. Voxy loads
its local models only when you enable capture. Replies play audio and animate
the face; **Interrupt** stops playback. **End conversation** closes the session
and microphone. Denying microphone permission leaves typed chat available.

Microphone access requires HTTPS or localhost. Add the exact HTTPS origin to
`HELLO_ORIGINS` for LAN testing. Vite proxies `/services/hello/` to the local
relay on port 8788; the docs image includes the same relay behind nginx. Supply
its credentials as runtime environment variables, never `VITE_` variables.
Without configured services the character, FPS display and Wave still work.

The authored guide is `stories/engine-hello.yaml`; provision it once per service
environment and again after changing the story. It identifies itself as a
fictional Gameable guide. Microphone capture is [`@getgameable/voxy`](https://github.com/getgameable/voxy).

`tests/game.test.ts` checks session gating, command routing and idle/wave
transitions; `tests/presentation.test.ts` checks FPS timing and keyboard insets.

## See also

- [Hello-world tutorial](../../docs/start/01-hello-world.md)
- [Character formats](../../docs/concepts/characters.md)
- [The wasm boundary](../../docs/concepts/wasm-boundary.md)
