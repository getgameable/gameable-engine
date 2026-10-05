/**
 * A real client-role guest: the mystery game, run directly as player 2's
 * client against a scripted room. Being tagged plays `sfx.tag` on this page
 * (its `showRole` system calls `ctx.audio.play` outside `ctx.net.local`).
 * There is no authority guest in this realm, so nothing shares its ECS.
 */
import { createHeadlessEngine } from '@gameable/core/headless';
import type { GameDefinition, HostApi } from '@gameable/sdk';
import { createDirectSandbox, createGameSlot } from '@gameable/wasm-host';
import { describe, expect, it } from 'vitest';

import { AUTHORITY_SENDER } from '../protocol/constants.js';
import { createClientLoop } from './ClientLoop.js';
import { stubHost, testClientAdapter } from './clientTesting.js';
import { LOCAL_SOUND_BASE } from './LocalIds.js';
import { ScriptedNet } from './scriptedNet.js';

/** @returns The mystery example's definition. */
async function loadMystery(): Promise<GameDefinition> {
  const url = new URL('../../../../templates/mystery/src/game.ts', import.meta.url);
  return ((await import(url.href)) as { default: GameDefinition }).default;
}

/** @returns A host that knows the manifest's names, `sfx.tag` among them. */
function namedHost(): HostApi & { ids: Map<string, number> } {
  const ids = new Map<string, number>();
  return {
    ...stubHost(),
    ids,
    resolveId: (name: string) => {
      if (!ids.has(name)) ids.set(name, ids.size + 1);
      return ids.get(name);
    },
  };
}

describe('the mystery client guest', () => {
  it("plays the tag sound on its own page, in the client's sound range", async () => {
    const host = namedHost();
    const sandbox = createDirectSandbox({ mode: 'direct', game: await loadMystery(), host });
    const net = new ScriptedNet();
    net.maxPlayers = 6;
    const adapter = testClientAdapter();
    const slot = createGameSlot();
    const engine = await createHeadlessEngine({ modules: [slot.module], fixedHz: 60 });
    await slot.attach(createClientLoop(engine, adapter, net, sandbox), engine.ctx);
    engine.step(0);
    net.welcome(2);
    engine.step(1000 / 60);
    expect(sandbox.dead).toBe(false);
    // Someone else is tagged: no sound here. Then this player is.
    net.msg(AUTHORITY_SENDER, 'tagged', '{"player":4}');
    engine.step(2000 / 60);
    expect(adapter.by('playSound')).toEqual([]);
    net.msg(AUTHORITY_SENDER, 'tagged', '{"player":2}');
    engine.step(3000 / 60);
    const sounds = adapter.by('playSound');
    expect(sounds).toHaveLength(1);
    expect(sounds[0].args[0]).toBeGreaterThan(LOCAL_SOUND_BASE);
    expect(sounds[0].args[1]).toBe(host.ids.get('sfx.tag'));
    // A client guest makes no shared entity: the level's spawns are the authority's.
    expect(adapter.by('spawn')).toEqual([]);
    await engine.dispose();
  }, 60_000);
});
