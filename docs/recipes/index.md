# Recipes

A recipe answers exactly one question and is completable by editing **at most
two files**. Every one has the same five headings — Goal, Files you will edit,
Steps, Verify, See also — so you can skim straight to the part you need.

## Getting started

The path from nothing to a game you are editing.

- [Scaffold a new game](./scaffold-a-new-game.md) — `npm create gameable`, a
  playable game in its own directory with nothing to configure.
- [Create an engine around a canvas](./create-an-engine.md) — boot
  `gameable/core` yourself, for a custom host rather than a template.
- [Debug with doctor](./debug-with-doctor.md) — take `gameable doctor` from red
  to green, one check at a time.
- [Use the placeholder assets](./use-the-placeholder-assets.md) — render the CC0
  arena and its spawn points before you have content of your own.

## Game logic

Inside the guest: systems, input, the HUD, and the component that ships them.

- [Write a game system](./write-a-game-system.md) — one more function per fixed
  step, allocating nothing.
- [Read player input](./read-player-input.md) — named actions, so no key code
  ever appears in game code.
- [Add a HUD element](./add-a-hud-element.md) — a value on screen that only
  crosses the boundary on the frames it changed.
- [Build the wasm guest](./build-the-wasm-guest.md) — the shipping path:
  `jco componentize`, `jco transpile`, and what each step is for.
- [Write a guest in Rust](./write-a-guest-in-rust.md) — the same WIT world from a
  Rust crate; the host cannot tell the difference.

## First-person

Recipes that build on `templates/fps`.

- [Add a weapon](./add-a-weapon.md) — a second fire mode with its own ammunition,
  rate and sound.
- [Add an enemy](./add-an-enemy.md) — a heavier variant sharing the existing
  chase-and-attack behaviour.
- [Change the level](./change-the-level.md) — your own splat environment, your
  own collider, your own spawns.

## Third-person

Recipes that build on `templates/third-person`.

- [Add an interactable](./add-an-interactable.md) — a lever the hero walks up to
  and presses `E` at, declared with a tag, with a HUD prompt when it is in reach.
- [Add NPC dialogue](./add-npc-dialogue.md) — a third person with a script of
  their own, in a JSON file and a prefab, without touching the dialogue system.
- [Tune the follow camera](./tune-the-follow-camera.md) — boom length, shoulder
  height, pitch range, an over-the-shoulder offset, and who owns the collision.
- [Add a locomotion state](./add-a-locomotion-state.md) — a crouch on `Ctrl` that
  halves walk speed, reported to the animator the way idle, walk and run are.
- [Play with friends](./play-with-friends.md) — one line in `src/game.ts`, a
  room server beside the dev server, two tabs in one room.
- [Send a message](./send-a-message.md) — `V` waves: a message declared once,
  read on the room's authority and answered to everyone.
- [Add a lobby](./add-a-lobby.md) — nothing starts until every connected player
  has pressed `R`: the ready set and the start rule.
- [Add a vote](./add-a-vote.md) — an emergency meeting in the mystery kit: `M`
  opens the vote at once, once a round per player.
- [Add a night cycle](./add-a-night-cycle.md) — a day/night clock in the rules,
  `day` or `night` on the room list, and chests that stay shut in the dark.

## Hangout

Recipes that build on `templates/hangout`.

- [Park another car](./park-another-car.md) — one more spot on the street, and
  a third car anyone can drive.

## Steal

Recipes that build on `templates/steal`.

- [Save player progress](./save-player-progress.md) — a daily bonus kept in
  the player's document: read at join, saved with `ctx.data.save`.

## Brawl

Recipes that build on `templates/brawl`.

- [Add a kick](./add-a-kick.md) — a fourth move on `I`, checked on the
  authority like the punch: farther, harder, slower.

## Collect

Recipes that build on player documents, as `templates/collect` does.

- [Trade with another player](./trade-with-another-player.md) — an offer and an
  accept that become one all-or-nothing exchange of coins for a gem.

## World and physics

- [Load a splat environment](./load-a-splat-environment.md) — a gaussian-splat
  capture as the world, by id, drawn in the right order.
- [Add a physics body](./add-a-physics-body.md) — a crate that falls, lands and
  reports its collisions.
- [Play a sound](./play-a-sound.md) — positional audio that falls off with
  distance and tells you when it ended.

## Characters and animation

- [Turn on a feature](./turn-on-a-feature.md) — declare `characters` in the
  game definition and the page loads the rig stack only because you did.
- [Use the sample character](./use-the-sample-character.md) — the `aosrig_v0`
  skinned body in place of a capsule, idling, walking and running from the
  state the game already publishes.
- [Load a character](./load-a-character.md) — a splat avatar in the scene, by id,
  with a graceful answer on a machine without WebGPU.
- [Load a character from the Asset Manager](./load-a-character-from-asset-manager.md)
  — the same, sourced from AAM, without a URL ever being written down.
- [Play an animation on a character](./play-an-animation.md) — idle, walk and a
  one-shot wave, driven from the character state game logic already produces.
- [Preview a rig without decoders](./preview-a-rig-without-decoders.md) — a
  freshly baked rig on screen as one gaussian per vertex, months before anyone
  has trained a decoder for it.
- [Give an NPC a face](./give-an-npc-a-face.md) — wire the guest's character
  commands to a real splat head, so dialogue expressions and look-at are drawn
  rather than recorded.

## The rules, in one line each

- **Two files maximum.** A third file means two recipes, or a design problem.
- **Never `packages/`.** A recipe that needs an engine change is a missing
  feature; file it instead of documenting it.
- **Assets by id.** Recipes add manifest entries; they never hardcode a URL.
- **No allocation in systems.** Recipe code is copied verbatim, by humans and by
  language models. Preallocate.
- **Runnable code only.** Every snippet is checked against the engine's real exports.

## See also

- [Concepts](../concepts/index.md) — the model a recipe assumes you have
- [Build your first FPS](../start/02-first-fps.md) — the long-form version
- [Troubleshooting](../troubleshooting.md) — when a recipe does not do what it says
