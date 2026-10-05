---
title: Play
---

# Play the examples

The two game templates, the smallest example and the multiplayer kits, built
and hosted right here. The kits play in rooms on the hosted room server: open
**Play together**, copy the link the corner shows, and open it in two or three
more tabs (or send it to a friend).
Each one opens in a new tab as the shipping build: the game's TypeScript
compiled to a WebAssembly component, running in the wasm sandbox on a WebGPU
renderer. Nothing to install.

::: tip You need a modern browser
Any current desktop browser with WebGPU enabled. Splat worlds fall back to
WebGL where WebGPU is off. If a game shows a pink error instead of a world,
[Troubleshooting](./troubleshooting.md) has the symptom list.
:::

<div class="play-grid">

<div class="gm-card">
<h3>First-person shooter</h3>
<p>A splat arena, six animated enemies that walk at you, a hitscan weapon,
health pickups, a HUD and a win condition. The <code>fps</code> template with
zero edits.</p>
<div class="gm-chips"><span class="gm-chip">templates/fps</span><span class="gm-chip">wasm sandbox</span></div>
<p class="gm-controls">click to play · WASD move · space jump · mouse aim · LMB fire · R reload</p>
<div class="gm-actions">
<a class="gm-btn primary" href="/play/fps/" target="_blank" rel="noopener">Play</a>
<a class="gm-btn secondary" href="./start/02-first-fps">Build it yourself</a>
</div>
</div>

<div class="gm-card">
<h3>Third-person adventure</h3>
<p>A follow camera, locomotion states, a guide NPC you can talk to, and
interactables with two-choice dialogue. The <code>third-person</code> template
with zero edits.</p>
<div class="gm-chips"><span class="gm-chip">templates/third-person</span><span class="gm-chip">wasm sandbox</span></div>
<p class="gm-controls">click to play · WASD move · shift run · space jump · mouse orbit · E interact · 1/2 answer</p>
<div class="gm-actions">
<a class="gm-btn primary" href="/play/third-person/" target="_blank" rel="noopener">Play</a>
<a class="gm-btn secondary" href="./start/03-first-adventure">Build it yourself</a>
</div>
</div>

<div class="gm-card">
<h3>Hello world · a Gameable character</h3>
<p>A character exported from the Gameable studio, spawned by a small guest
that sends two commands and then goes quiet while the wave keeps looping. A HUD
counts the frames. What the wasm boundary looks like with nothing else in the
way.</p>
<div class="gm-chips"><span class="gm-chip">examples/wasm-hello</span><span class="gm-chip">wasm sandbox</span></div>
<p class="gm-controls">WebGPU required · nothing to press — watch the wave</p>
<div class="gm-actions">
<a class="gm-btn primary" href="/play/wasm-hello/" target="_blank" rel="noopener">Play</a>
<a class="gm-btn secondary" href="./start/01-hello-world">Export and import your character</a>
</div>
</div>

<div class="gm-card">
<h3>Visit · a character's page</h3>
<p>Where a character lives and how people visit: the page the Gameable studio publishes
for a character, at /&lt;org&gt;/&lt;slug&gt;. It takes the studio exporter's inputs (the
character, a lighter copy for phones, the place, the greeting, the mode and the
start view); here, with none, the engine's sample character in the white world.</p>
<div class="gm-chips"><span class="gm-chip">templates/visit</span><span class="gm-chip">wasm sandbox</span></div>
<p class="gm-controls">drag to look · type or talk</p>
<div class="gm-actions">
<a class="gm-btn primary" href="/play/visit/" target="_blank" rel="noopener">Play</a>
</div>
</div>

<div class="gm-card">
<h3>Mystery · six players, one hidden role</h3>
<p>Up to six players in the arena, one of them secretly "it", told only through their own HUD. The round starts when everyone is ready. Anyone "it" touches is out, then the rest vote on who "it" is; the crew wins by voting "it" out or outlasting the clock, and "it" wins by being the last one standing. A round needs three players. The mystery kit: <code>npm create gameable my-game -- --template mystery</code>.</p>
<div class="gm-chips"><span class="gm-chip">templates/mystery</span><span class="gm-chip">wasm sandbox</span><span class="gm-chip">multiplayer</span></div>
<p class="gm-controls">click to play · WASD move · shift run · mouse orbit · R ready · G start now (host) · 1-6 vote · Enter chat</p>
<p class="gm-controls">with friends: open <b>Play together</b>, then <b>Copy link</b> and open it in 2 more tabs (3 in all: a round needs three)</p>
<div class="gm-actions">
<a class="gm-btn primary" href="/play/mystery/?room=new" target="_blank" rel="noopener">Play together</a>
<a class="gm-btn secondary" href="/play/mystery/" target="_blank" rel="noopener">Play solo</a>
</div>
</div>

<div class="gm-card">
<h3>Survive · hold the camp at night</h3>
<p>Four to six players at a camp ringed by trees. By day, gather wood and build walls; at dusk creatures come out of the tree line, more each night, and hit whatever they reach. A downed player gets up at dawn, and every night you see out on your feet is counted and kept. The survive kit: <code>npm create gameable my-game -- --template survive</code>.</p>
<div class="gm-chips"><span class="gm-chip">templates/survive</span><span class="gm-chip">wasm sandbox</span><span class="gm-chip">multiplayer</span></div>
<p class="gm-controls">click to play · WASD move · shift run · mouse orbit · E gather wood at a tree · B build a wall (two wood)</p>
<p class="gm-controls">with friends: open <b>Play together</b>, then <b>Copy link</b> and open it in 1 or 2 more tabs</p>
<div class="gm-actions">
<a class="gm-btn primary" href="/play/survive/?room=new" target="_blank" rel="noopener">Play together</a>
<a class="gm-btn secondary" href="/play/survive/" target="_blank" rel="noopener">Play solo</a>
</div>
</div>

<div class="gm-card">
<h3>Hangout · a street with friends</h3>
<p>Up to twelve friends on a street of six houses, two to a house: chat, pick a colour (it is kept for your next visit), sit on benches, open doors and drive the cars. No win condition. The hangout kit: <code>npm create gameable my-game -- --template hangout</code>.</p>
<div class="gm-chips"><span class="gm-chip">templates/hangout</span><span class="gm-chip">wasm sandbox</span><span class="gm-chip">multiplayer</span></div>
<p class="gm-controls">click to play · WASD walk · shift run · mouse orbit · E door or car · F sit · 1-6 colour · Enter chat</p>
<p class="gm-controls">with friends: open <b>Play together</b>, then <b>Copy link</b> and open it in 1 or 2 more tabs</p>
<div class="gm-actions">
<a class="gm-btn primary" href="/play/hangout/?room=new" target="_blank" rel="noopener">Play together</a>
<a class="gm-btn secondary" href="/play/hangout/" target="_blank" rel="noopener">Play solo</a>
</div>
</div>

<div class="gm-card">
<h3>Brawl · first to three knockouts</h3>
<p>Two to four fighters in an arena with a punch, a dash and a ground slam. A fighter at 0 health is knocked out and comes back; the first to three knockouts wins the round. Your own fighter moves the moment you press a key (client prediction). The brawl kit: <code>npm create gameable my-game -- --template brawl</code>.</p>
<div class="gm-chips"><span class="gm-chip">templates/brawl</span><span class="gm-chip">wasm sandbox</span><span class="gm-chip">multiplayer</span></div>
<p class="gm-controls">click to play · WASD move · J punch · K dash · L ground slam</p>
<p class="gm-controls">with friends: open <b>Play together</b>, then <b>Copy link</b> and open it in 1 or 2 more tabs</p>
<div class="gm-actions">
<a class="gm-btn primary" href="/play/brawl/?room=new" target="_blank" rel="noopener">Play together</a>
<a class="gm-btn secondary" href="/play/brawl/" target="_blank" rel="noopener">Play solo</a>
</div>
</div>

<div class="gm-card">
<h3>Steal · grab, steal and save</h3>
<p>Up to six players, each with a base. Brainrots ride a conveyor every 8 seconds: walk into one to grab it, stand 3 seconds in another player's base to steal their newest. Every brainrot you own pays coins every 10 seconds, and your coins, brainrots and shield are saved, with income for the time you were away (up to 8 hours). The steal kit: <code>npm create gameable my-game -- --template steal</code>.</p>
<div class="gm-chips"><span class="gm-chip">templates/steal</span><span class="gm-chip">wasm sandbox</span><span class="gm-chip">multiplayer</span><span class="gm-chip">saved progress</span></div>
<p class="gm-controls">click to play · WASD walk · shift run · mouse orbit · Q shield (10 coins) · R rebirth (100 coins)</p>
<p class="gm-controls">with friends: open <b>Play together</b>, then <b>Copy link</b> and open it in 1 or 2 more tabs</p>
<div class="gm-actions">
<a class="gm-btn primary" href="/play/steal/?room=new" target="_blank" rel="noopener">Play together</a>
<a class="gm-btn secondary" href="/play/steal/" target="_blank" rel="noopener">Play solo</a>
</div>
</div>

<div class="gm-card">
<h3>Collect · eggs, pets and trades</h3>
<p>Up to eight players pick up coins, buy eggs that hatch into pets of random rarity, combine four of a kind into the next tier and trade pets with each other. Each trade moves both sides at once or not at all, and your pets and bucks are saved. The collect kit: <code>npm create gameable my-game -- --template collect</code>.</p>
<div class="gm-chips"><span class="gm-chip">templates/collect</span><span class="gm-chip">wasm sandbox</span><span class="gm-chip">multiplayer</span><span class="gm-chip">saved progress</span></div>
<p class="gm-controls">click to play · WASD walk · B buy an egg (25) · C combine · T offer a trade to the nearest player · Y accept</p>
<p class="gm-controls">with friends: open <b>Play together</b>, then <b>Copy link</b> and open it in 1 or 2 more tabs</p>
<div class="gm-actions">
<a class="gm-btn primary" href="/play/collect/?room=new" target="_blank" rel="noopener">Play together</a>
<a class="gm-btn secondary" href="/play/collect/" target="_blank" rel="noopener">Play solo</a>
</div>
</div>

</div>

## Run them yourself

Hello world needs a character exported from the Gameable studio; the
[export and import tutorial](./start/01-hello-world.md) brings yours in.

Every one of these is a directory in the engine checkout, and the same build you
just played is what `npm run build` in that directory produces:

```sh
npm run dev -w templates/fps            # http://localhost:5179
npm run dev -w templates/third-person   # http://localhost:5181
npm run dev -w examples/wasm-hello      # http://localhost:5180
npm run dev -w templates/visit          # http://localhost:5188
npm run dev -w templates/mystery        # http://localhost:5192
npm run dev -w templates/survive        # http://localhost:5195
npm run dev -w templates/hangout        # http://localhost:5196
npm run dev -w templates/brawl          # http://localhost:5199
```

A kit's room server on your machine is `npx gameable serve --direct` in its
directory; [Make a multiplayer game](./start/05-make-a-multiplayer-game.md)
walks one from scaffold to two tabs.

[Install](./start/01-install.md) covers getting the checkout running.
