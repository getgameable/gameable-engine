/**
 * Upgrading an exported character to a fuller copy of itself (`CharacterBridge.upgrade`): the
 * copy loads and builds behind the one on screen, then takes over between two frames, or
 * dissolves in over it (`stepFade`, each frame), and the old points go (`retireSplats`).
 */
import type { Animator } from '@gameable/animation';
import type { Engine } from '@gameable/core';
import type { AosrigSplatRuntime } from '@gameable/character';
import type { AnimatedSplat, SplatShadows } from '@gameable/splat';
import type { Camera, WebGPURenderer } from 'three/webgpu';

import type { LiveCharacter } from './live.js';
import { profileFor } from './profiles.js';
import type { CharacterBridgeOptions, CharacterUpgradeOptions } from './types.js';

/** What an upgrade needs of the bridge. */
export interface UpgradeContext {
  readonly engine: Engine;
  readonly renderer: WebGPURenderer;
  /** The renderer is on the WebGL2 fallback. */
  readonly webgl: boolean;
  readonly options: CharacterBridgeOptions;
  /** Whether the character was despawned (or the bridge disposed) meanwhile. */
  cancelled(character: LiveCharacter): boolean;
  /** The bridge's shadows, when they run. */
  shadows(): SplatShadows | null;
}

/**
 * Swap a fuller copy of an exported character in for the one drawing.
 *
 * @param ctx The bridge.
 * @param character The character (undefined when the entity has none).
 * @param src The fuller copy's `character.json`.
 * @param upgradeOptions The fade and the stage callback.
 * @returns Resolves once the copy has taken over (and, with a fade, faded in).
 * @throws {Error} When the character is not an exported one already drawing, or still fading in.
 */
export async function upgradeCharacter(
  ctx: UpgradeContext,
  character: LiveCharacter | undefined,
  src: string,
  upgradeOptions: CharacterUpgradeOptions,
): Promise<void> {
  const oldRuntime = character?.boundSplats;
  const oldSink = character?.sink;
  if (!character?.rig || !oldRuntime || !oldSink || character.kind !== 'aosrig-splat')
    throw new Error('gameable: upgrade needs an exported character that is already drawing');
  if (character.fading)
    throw new Error('gameable: the character is still fading in its last upgrade');
  const rig = character.rig;
  const oldTeeth = character.teethSink ?? null;
  // Read again after the awaits below: another upgrade may have started fading meanwhile.
  const fadingNow = (): boolean => character.fading !== undefined;
  const mark = (stage: string): void => upgradeOptions.onStage?.(stage, performance.now());
  mark('start');
  const [characterModule, splatModule, tsl] = await Promise.all([
    import('@gameable/character'),
    import('@gameable/splat'),
    import('three/tsl'),
  ]);
  // The old points keep drawing while the new ones load and build: the work gives the page back
  // every few milliseconds.
  const pause = characterModule.yieldingPause();
  const bundle = await characterModule.loadAosrigSplatBundle(src, undefined, {
    mouth: ctx.options.extras?.mouth ?? true,
    corrective: ctx.options.extras?.corrective ?? true,
    // The skeleton and its clips are the ones already playing: the shared pack is not read again.
    sharedClips: false,
    pause,
    ...(character.sharedFiles ? { reuse: character.sharedFiles } : {}),
    ...(ctx.options.fetch ? { fetch: ctx.options.fetch } : {}),
  });
  character.sharedFiles = undefined;
  mark('downloaded');
  if (ctx.cancelled(character)) return;
  const d = bundle.descriptor;
  // The rig and its joints are shared: a copy of another skeleton fails here, naming the joint
  // it lacks. The full copy has its own mouth, as the first copy had one.
  const {
    runtime,
    sink,
    teethSink: newTeeth,
  } = await characterModule.buildAosrigCharacter({
    bundle,
    rig,
    renderer: ctx.renderer,
    webgl: ctx.webgl,
    mouth: true,
    pause,
    // The character's points drawn after the old ones, so while they dissolve in they lie over them.
    makeSink: (request) =>
      splatModule.createAnimatedSplat(ctx.renderer, {
        ...request,
        ...(request.kernel ? { renderOrder: splatModule.SPLAT_RENDER_ORDER + 1 } : {}),
      }),
    releaseBuffer: (attribute) => {
      splatModule.releaseStorageAttribute(ctx.renderer, attribute);
    },
    onMouthError: (error) => {
      console.warn(
        `gameable: character "${character.bundleId}" upgrades without its mouth interior: ${String(error)}`,
      );
    },
  });
  character.holder.add(sink.object3D);
  bundle.files.clear();
  mark('built');
  // Despawned, or another upgrade took over or began fading meanwhile: this copy is not used.
  const superseded = (): boolean =>
    ctx.cancelled(character) || character.boundSplats !== oldRuntime || fadingNow();
  const discard = (): void => {
    runtime.dispose();
    sink.object3D.removeFromParent();
    sink.dispose();
    newTeeth?.dispose();
  };
  if (superseded()) {
    discard();
    return;
  }
  const fadeMs = upgradeOptions.fadeMs ?? 0;
  const alpha = tsl.uniform(fadeMs > 0 ? 0 : 1);
  if (fadeMs > 0) sink.setFragmentAlpha(() => alpha);
  // Compile the new points' drawing now, off the swap's frame (three compiles only what is visible,
  // so the sink shows for the call, which draws nothing).
  try {
    sink.object3D.visible = true;
    const compiling = ctx.renderer.compileAsync(sink.object3D, ctx.engine.camera, ctx.engine.scene);
    sink.object3D.visible = false;
    await compiling;
  } catch {
    sink.object3D.visible = false;
  }
  mark('compiled');
  // The compile awaited too: asked again, or a despawn or a second upgrade in that time would
  // retire the old points twice and leave this copy on a dead character.
  if (superseded()) {
    discard();
    return;
  }
  let faded: Promise<void> = Promise.resolve();
  if (fadeMs > 0) {
    faded = new Promise<void>((done) => {
      character.fading = {
        runtime: oldRuntime,
        sink: oldSink,
        teethSink: oldTeeth,
        alpha,
        start: -1,
        ms: fadeMs,
        done,
      };
    });
  } else {
    retireSplats(oldRuntime, oldSink, oldTeeth);
  }
  // The swap itself, between two frames: the next update poses and shows the new points.
  character.boundSplats = runtime;
  character.sink = sink;
  character.teethSink = newTeeth;
  mark('swapped');
  const profile = character.profile ?? profileFor(rig);
  const shadowSystem = ctx.shadows();
  if (shadowSystem) {
    shadowSystem.removeCharacter(character);
    shadowSystem.addCharacter(character, {
      rig,
      holder: character.holder,
      splat: sink.splat,
      radius: d.bounds.radius + Math.hypot(d.bounds.center[0], d.bounds.center[2]) + 0.1,
      headBone: profile.head,
      ...(profile.feet ? { footBones: profile.feet } : {}),
      captured: character.capturedLight ?? null,
    });
  }
  await faded;
  mark('faded');
}

/**
 * One frame of an upgrade's dissolve: the old points posed as the new ones are, the new ones'
 * opacity stepped; at the end the old points go.
 *
 * @param character The character.
 * @param animator Its animator, already updated this frame.
 * @param camera The camera the frame is drawn with.
 */
export function stepFade(character: LiveCharacter, animator: Animator, camera: Camera): void {
  const fade = character.fading;
  if (!fade) return;
  const now = performance.now();
  if (fade.start < 0) fade.start = now;
  const t = Math.min(1, (now - fade.start) / fade.ms);
  fade.alpha.value = t * t * (3 - 2 * t);
  if (t < 1) {
    fade.runtime.render(animator.expression, animator.gaze, camera);
    return;
  }
  fade.sink.object3D.visible = false;
  character.fading = undefined;
  retireSplats(fade.runtime, fade.sink, fade.teethSink);
  fade.done();
}

/**
 * Free a character's replaced points on the next frame, once the GPU has drawn the last frame
 * that used them.
 *
 * @param runtime The old points' runtime.
 * @param sink The old points' sink.
 * @param teethSink The old points' teeth, when they had them.
 */
export function retireSplats(
  runtime: AosrigSplatRuntime,
  sink: AnimatedSplat,
  teethSink: AnimatedSplat | null,
): void {
  sink.object3D.visible = false;
  requestAnimationFrame(() => {
    runtime.dispose();
    sink.object3D.removeFromParent();
    sink.dispose();
    teethSink?.dispose();
  });
}
