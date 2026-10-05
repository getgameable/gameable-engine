# three-character

An ordinary three.js app, a floor and two lights on its own `WebGPURenderer`, with a
character published from the Gameable studio standing in it, through
`gameable/three`: the guide's app (`docs/three/gameable-character.md`) with its
advice taken (the scene draws while the character loads, a progress line, the credit) plus shadows
and a few buttons (clips, a smile, look away, a warm tint).

```sh
npm run dev -w examples/three-character
# open http://localhost:5191/?character=<a character.json URL>
```

`?character=` is the character's `character.json` (its stable address in the studio's "Use in
your app" panel). Needs a browser with WebGPU.
