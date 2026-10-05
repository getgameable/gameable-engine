# gameable:engine changes

## Package rename

The package is `gameable:engine` (it was `aos:engine`), at the same version. A guest
built against `aos:engine` exports interfaces this host does not look for: rebuild it
(`npm run build:guest`). A Rust guest's generated bindings move from `aos::engine` to
`gameable::engine`.

## 0.2.0 (multiplayer)

- `frame-input.players`: per-player input for a room. `frame-input.input` stays and is player 0.
- Events `player-joined`, `player-left`, `message`, `exchange-result`, `game-data`.
- Commands `send`, `set-player-camera`, `set-player-hud`, `save-player-data`, `save-game-data`, `exchange`, `set-player-entity` (which entity a player controls; amended into 0.2.0 before its release).
- `frame-output.local-commands`: applied on the authority only.

A 0.1.0 guest is not loadable by a 0.2.0 host: `createSandbox` refuses a component that exports
`gameable:engine/game` at any other version, naming it. Rebuild the guest (`npm run build:guest`).

## 0.1.0

- The first world: `game-module` with `init`, `tick`, `shutdown`, `snapshot`, `restore`,
  importing `env`, `physics-query` and `assets`.
