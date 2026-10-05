/**
 * A THING's page (the Gameable studio's create-anything: a car, a chair, a tree made from a picture). A thing
 * has no skeleton, no face and no voice: the page shows it standing on the floor at its real size, and nothing else.
 * No character is loaded (not even the sample), no greeting is said and there is no conversation; the camera goes slowly
 * round it and a visitor may drag to look (OrbitControls). It stands in the owner's place when there is one, else in
 * the white world.
 *
 * The studio's thing package is the engine's own static shape: a splat asset with a box
 * collider, its ground at y = 0, metres; the lookup's `thing` names its points (`thing.splat`) and its size.
 */
import { parseManifest } from 'gameable/assets';
import { createEngine, type EngineContext, type EngineModule } from 'gameable/core';
import { input } from 'gameable/input';
import { splat, SPLAT_RENDER_ORDER } from 'gameable/splat';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Vector3 } from 'three/webgpu';
import { placeStage, whiteWorld } from './stage';
import logoUrl from '../public/brand/icon-mint.png?url';
import { wantsLite, type VisitConfig, type VisitThing } from './visit';

/**
 * Where the camera stands for a thing of this size: back far enough that its longest side fits the frame, a little
 * above its middle, looking at its middle.
 *
 * @param thing Its size (longest side and height, metres).
 * @param fovDeg The camera's vertical field of view.
 * @param aspect The screen's width over its height.
 * @returns The target and the camera's distance and height above the target.
 */
export function thingFraming(
  thing: Pick<VisitThing, 'sizeM' | 'heightM'>,
  fovDeg: number,
  aspect: number,
): { target: [number, number, number]; distance: number; lift: number } {
  const across = Math.max(0.05, thing.sizeM);
  const tall = Math.max(0.05, Math.min(thing.heightM ?? across, across));
  const half = (fovDeg * Math.PI) / 360;
  const fitTall = tall / 2 / Math.tan(half);
  const fitAcross = across / 2 / (Math.tan(half) * Math.max(0.3, aspect));
  const distance = Math.max(fitTall, fitAcross) * 1.35 + across * 0.35;
  return { target: [0, tall / 2, 0], distance, lift: tall * 0.35 };
}

/**
 * Boot the page for a thing.
 *
 * @param config The page's inputs (config.thing is set).
 * @param canvas The page's canvas.
 * @returns Nothing; the page runs until it is closed.
 */
export async function thingPage(
  config: VisitConfig & { thing: VisitThing },
  canvas: HTMLCanvasElement,
): Promise<void> {
  const thing = config.thing;
  document.documentElement.classList.add('visit-thing');
  const name = document.getElementById('name');
  if (name) name.textContent = config.name;
  document.title = `${config.name} · Made with Gameable`;
  const logo = document.getElementById('logo') as HTMLImageElement | null;
  if (logo) logo.src = logoUrl;
  const favicon = document.getElementById('favicon') as HTMLLinkElement | null;
  if (favicon) favicon.href = logoUrl;
  const hint = document.getElementById('hint');
  if (hint) hint.textContent = 'Drag to look around.';
  // no conversation: a thing does not talk
  document.getElementById('conversation')?.setAttribute('hidden', '');
  document.getElementById('stick')?.setAttribute('hidden', '');
  const loading = document.getElementById('loading');
  // A phone takes the place's lighter splat, as a character's page does.
  const lite = wantsLite(config.lite, {
    coarse: matchMedia('(pointer: coarse)').matches,
    shortSide: Math.min(innerWidth, innerHeight),
    memoryGb: (navigator as { deviceMemory?: number }).deviceMemory ?? 8,
  });
  const place = config.setting
    ? { ...config.setting, splat: (lite && config.setting.lite) || config.setting.splat }
    : null;

  const manifest = parseManifest({
    version: 1,
    assets: [
      { id: 'thing', type: 'splat', src: thing.splat, tags: ['thing'] },
      ...(place ? [{ id: 'place', type: 'splat' as const, src: place.splat }] : []),
    ],
  });

  let controls: OrbitControls | null = null;
  const view: EngineModule = {
    id: 'thing-view',
    order: 300,
    async init(ctx: EngineContext) {
      await ctx.assets.load('thing');
      const object = ctx
        .get('splat')
        .add('thing', { renderOrder: SPLAT_RENDER_ORDER, colorSpace: thing.colorSpace });
      object.position.set(0, 0, 0);
      object.updateMatrixWorld(true);
      const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
      const f = thingFraming(thing, ctx.camera.fov, aspect);
      const target = new Vector3(...f.target);
      ctx.camera.position.set(
        target.x + f.distance * Math.sin(0.6),
        target.y + f.lift,
        target.z + f.distance * Math.cos(0.6),
      );
      ctx.camera.near = Math.max(0.01, f.distance / 400);
      ctx.camera.far = Math.max(100, f.distance * 40);
      ctx.camera.updateProjectionMatrix();
      controls = new OrbitControls(ctx.camera, ctx.renderer.domElement);
      controls.target.copy(target);
      controls.enableDamping = true;
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.6;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.minDistance = f.distance * 0.25;
      controls.maxDistance = f.distance * 4;
      const orbit = controls;
      orbit.addEventListener('start', () => (orbit.autoRotate = false));
      loading?.setAttribute('hidden', '');
    },
    update() {
      controls?.update();
    },
    dispose() {
      controls?.dispose();
    },
  };

  const engine = await createEngine({
    canvas,
    manifest,
    renderer: { backend: 'auto', antialias: false },
    modules: [input({ target: canvas }), splat(), view],
  });
  if (place) await placeStage(engine, place, null);
  else whiteWorld(engine);
  engine.start();
}
