/**
 * The client loop over a scripted `net` service: the paths the 3.9a review
 * found untested (I3), the client guest's own ids (I2) and TELEPORT (I1).
 */
import { createHeadlessEngine } from '@gameable/core/headless';
import type { CameraState, Command, GameEvent } from '@gameable/sdk';
import { createGameSlot, type Sandbox } from '@gameable/wasm-host';
import { describe, expect, it } from 'vitest';

import { RowFlag } from '../protocol/constants.js';
import { createClientLoop } from './ClientLoop.js';
import {
  GUEST_CAMERA,
  StubSandbox,
  testClientAdapter,
  type TestClientAdapter,
} from './clientTesting.js';
import { LOCAL_SOUND_BASE } from './LocalIds.js';
import { ScriptedNet } from './scriptedNet.js';

const AUTHORITY_CAMERA: CameraState = { ...GUEST_CAMERA, fovYDeg: 50 };
const ONE = { x: 1, y: 1, z: 1 };
const ORIGIN = { x: 0, y: 0, z: 0 };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/**
 * @param entity The entity.
 * @param parent Its parent, if any.
 * @returns A spawn command.
 */
function spawn(entity: number, parent?: number): Command {
  const val = {
    entity,
    position: ORIGIN,
    rotation: IDENTITY,
    scale: ONE,
    visible: true,
    ...(parent ? { parent } : {}),
  };
  return { tag: 'spawn', val };
}

/**
 * @param net The scripted room.
 * @param sandbox The client guest, or null.
 * @param adapter The recording adapter.
 * @returns A page: step it by hand.
 */
async function page(
  net: ScriptedNet,
  sandbox: Sandbox | null,
  adapter: TestClientAdapter = testClientAdapter(),
) {
  const slot = createGameSlot();
  const engine = await createHeadlessEngine({ modules: [slot.module], fixedHz: 60 });
  const deaths: (Error | null)[] = [];
  await slot.attach(
    createClientLoop(engine, adapter, net, sandbox, { onDead: (e) => deaths.push(e) }),
    engine.ctx,
  );
  engine.step(0);
  let t = 0;
  return {
    adapter,
    deaths,
    steps(n = 1): void {
      for (let i = 0; i < n; i += 1) engine.step((t += 1000 / 60));
    },
  };
}

/** A guest that traps on its second tick. */
class TrappingSandbox extends StubSandbox {
  readonly trap = new Error('guest trapped');
  override tick(input: Parameters<StubSandbox['tick']>[0]): ReturnType<StubSandbox['tick']> {
    const out = super.tick(input);
    if (this.inputs.length === 2) {
      this.dead = true;
      this.error = this.trap;
    }
    return out;
  }
}

describe('the client loop starts the join', () => {
  it('once it is attached, not before: the page is seated only after it has loaded', async () => {
    const net = new ScriptedNet();
    const slot = createGameSlot();
    const engine = await createHeadlessEngine({ modules: [slot.module], fixedHz: 60 });
    const loop = createClientLoop(engine, testClientAdapter(), net, null);
    expect(net.starts).toBe(0);
    await slot.attach(loop, engine.ctx);
    expect(net.starts).toBe(1);
  });
});

describe('the client loop, scripted', () => {
  it('starts no guest, ticks nothing and sends no INPUT before the first welcome', async () => {
    const net = new ScriptedNet();
    net.state = 'joined'; // even if the service said so: the loop waits for a welcome
    const sandbox = new StubSandbox();
    const p = await page(net, sandbox);
    p.steps(3);
    expect(sandbox.inits).toEqual([]);
    expect(sandbox.inputs).toEqual([]);
    expect(net.inputs).toEqual([]);
    net.welcome(2);
    p.steps(1);
    expect(JSON.parse(sandbox.inits[0].options ?? '{}')).toMatchObject({ net: { localPlayer: 2 } });
  });

  it('reports a guest that traps in tick once, then ticks it no more and sends no more INPUT', async () => {
    const net = new ScriptedNet();
    net.welcome(0);
    const sandbox = new TrappingSandbox();
    const p = await page(net, sandbox);
    p.steps(5);
    expect(p.deaths).toEqual([sandbox.trap]);
    expect(sandbox.inputs).toHaveLength(2);
    expect(net.inputs).toEqual([1, 2]);
  });

  it("shows the authority's camera for this player every step, over the guest's", async () => {
    const net = new ScriptedNet();
    net.welcome(0, [{ tag: 'set-player-camera', val: { player: 0, camera: AUTHORITY_CAMERA } }]);
    const p = await page(net, new StubSandbox());
    p.steps(3);
    expect(p.adapter.cameras.map((c) => c.fovYDeg)).toEqual([50, 50, 50]);
  });

  it("shows the guest's camera when the authority set none", async () => {
    const net = new ScriptedNet();
    net.welcome(0);
    const p = await page(net, new StubSandbox());
    p.steps(2);
    expect(p.adapter.cameras.map((c) => c.fovYDeg)).toEqual([33, 33]);
  });

  it("ignores another player's HUD, and the authority's HUD wins over the guest's", async () => {
    const net = new ScriptedNet();
    net.welcome(0, [{ tag: 'set-player-hud', val: { player: 3, hud: '{"other":1}' } }]);
    const sandbox = new StubSandbox();
    sandbox.output.hud = '{"guest":1}';
    const p = await page(net, sandbox);
    p.steps(1);
    const huds = (): unknown[] => p.adapter.by('setHud').map((c) => c.args[0]);
    expect(huds()).toEqual(['{"guest":1}']);
    net.cmd({ tag: 'set-player-hud', val: { player: 0, hud: '{"mine":1}' } });
    p.steps(2);
    expect(huds()).toEqual(['{"guest":1}', '{"mine":1}']);
  });

  it('takes the old world down children first when a new welcome arrives', async () => {
    const net = new ScriptedNet();
    net.welcome(0, [spawn(1), spawn(2, 1), spawn(3, 2)]);
    const p = await page(net, null);
    p.steps(1);
    net.welcome(0, []);
    p.steps(1);
    expect(p.adapter.by('despawn').map((c) => c.args[0])).toEqual([3, 2, 1]);
  });

  it('snaps on a TELEPORT row instead of blending to it', async () => {
    const net = new ScriptedNet();
    net.welcome(0, [spawn(1)]);
    const p = await page(net, null);
    net.pushRows(10, [{ entity: 1, flags: RowFlag.POSITION, position: [0, 0, 0] }]);
    p.steps(1);
    net.pushRows(13, [{ entity: 1, flags: RowFlag.POSITION, position: [3, 0, 0] }]);
    p.steps(1);
    net.pushRows(16, [
      { entity: 1, flags: RowFlag.POSITION | RowFlag.TELEPORT, position: [100, 0, 0] },
    ]);
    p.steps(1);
    const last = p.adapter.rows.at(-1);
    expect(last?.position[0]).toBe(100);
    expect((last?.flags ?? 0) & RowFlag.TELEPORT).toBe(RowFlag.TELEPORT);
  });
});

describe("a client guest's own world", () => {
  it('applies all its commands locally, in an id range the authority never uses', async () => {
    const net = new ScriptedNet();
    net.welcome(0, [spawn(1)]); // the authority's entity 1
    const sandbox = new StubSandbox();
    sandbox.output.commands = [
      spawn(1), // the guest's own entity 1: a different entity
      {
        tag: 'play-sound',
        val: { sound: 1, asset: 3, entity: 1, volume: 1, pitch: 1, looping: false, bus: 'sfx' },
      },
      { tag: 'apply-impulse', val: { body: 1, impulse: ORIGIN } },
    ];
    const p = await page(net, sandbox);
    p.steps(1);
    sandbox.output.commands = [];
    expect(p.adapter.by('spawn').map((c) => c.args[0])).toEqual([1, 4097]);
    const sounds = p.adapter.by('playSound');
    expect(sounds).toHaveLength(1);
    expect(sounds[0].args[0]).toBe(LOCAL_SOUND_BASE + 1);
    expect(sounds[0].args[2]).toBe(4097);
    expect(p.adapter.by('applyImpulse')).toEqual([]);
  });

  it("hands the guest the page's events about its own entities, never the authority's", async () => {
    const net = new ScriptedNet();
    net.welcome(0);
    const sandbox = new StubSandbox();
    const adapter = testClientAdapter();
    const p = await page(net, sandbox, adapter);
    const events = adapter.events as GameEvent[];
    events.push(
      { tag: 'anim-event', val: { entity: 4097, clip: 'wave', name: 'end', time: 1 } },
      { tag: 'anim-event', val: { entity: 1, clip: 'run', name: 'step', time: 1 } },
      { tag: 'sound-ended', val: { sound: LOCAL_SOUND_BASE + 2, completed: true } },
      { tag: 'sound-ended', val: { sound: 2, completed: true } },
    );
    p.steps(1);
    expect(sandbox.events[0]).toEqual([
      { tag: 'anim-event', val: { entity: 1, clip: 'wave', name: 'end', time: 1 } },
      { tag: 'sound-ended', val: { sound: 2, completed: true } },
    ]);
  });
});
