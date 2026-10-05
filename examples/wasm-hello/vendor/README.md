# Voxy

`gameable-voxy-0.1.0.tgz` is `@gameable/voxy` 0.1.0, packed from
[getgameable/voxy](https://github.com/getgameable/voxy): the microphone
capture, the Silero VAD model and the RNNoise binary that wasm-hello and the
`visit` template use to hear the player.

It is vendored only until `@gameable/voxy` is on npm. Then both
`package.json` files depend on `"@gameable/voxy": "0.1.0"`, this directory
goes, and `create-gameable` ships the `visit` template again.
