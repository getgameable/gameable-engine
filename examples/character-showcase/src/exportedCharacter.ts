import { ARKIT_COUNT, arkitIndex } from 'gameable/animation';
import { createEngine } from 'gameable/core';
import { splat } from 'gameable/splat';
import { createCharacterBridge, type CharacterBridge } from 'gameable/host/characters';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Overlay } from './ui';

/**
 * Load an extracted creator ZIP through the same bridge used by games.
 *
 * @param canvas Render target.
 * @param descriptor URL of the exported character.json.
 * @param overlay Existing showcase controls.
 * @returns Resolves after engine startup.
 */
export async function showExportedCharacter(
  canvas: HTMLCanvasElement,
  descriptor: string,
  overlay: Overlay,
): Promise<void> {
  const state: { characters?: CharacterBridge; orbit?: OrbitControls } = {};
  const engine = await createEngine({
    canvas,
    manifest: {
      version: 1,
      assets: [
        {
          id: 'char.exported',
          type: 'character',
          src: descriptor,
          rig: { backend: 'aosrig-splat' },
        },
      ],
    },
    renderer: { backend: 'webgpu', antialias: false },
    modules: [
      splat(),
      {
        id: 'exported-character',
        init() {},
        update(dt) {
          state.orbit?.update();
          state.characters?.update(dt);
        },
        dispose() {
          state.characters?.dispose();
          state.orbit?.dispose();
        },
      },
    ],
  });
  // The camera the Gameable studio frames a finished character with, for side-by-side looks:
  // ?view=tight (the default, the head), medium (the chest) or wide (the body).
  const view = await studioView(descriptor, new URLSearchParams(location.search).get('view'));
  engine.camera.fov = view.fov;
  engine.camera.near = 0.01;
  engine.camera.far = 200;
  engine.camera.position.set(...view.position);
  engine.camera.updateProjectionMatrix();
  const orbit = new OrbitControls(engine.camera, canvas);
  orbit.target.set(...view.target);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.minDistance = 0.18;
  orbit.maxDistance = view.maxDistance;
  orbit.update();
  const bridge = createCharacterBridge({
    engine,
    renderer: engine.renderer,
    scene: engine.scene,
    warn: (message) => overlay.fail(new Error(message)),
  });
  state.characters = bridge;
  state.orbit = orbit;
  overlay.setStats(['Loading exported character…']);
  bridge.spawn({
    entity: 1,
    bundle: engine.assets.resolve('char.exported'),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    onAttached() {
      overlay.setStats(['Exported character', 'aosrig_v0 body + GNM face', 'WebGPU']);
      engine.start();
      window.__AOS_READY__ = {
        rig: 'gnm',
        pack: descriptor,
        vertices: 0,
        coefficients: 383,
        backend: 'webgpu',
      };
    },
  });
  const expression = new Float32Array(ARKIT_COUNT);
  overlay.setControls(
    [
      {
        title: 'Face',
        sliders: [
          {
            id: 'export-jaw',
            label: 'Jaw open',
            min: 0,
            max: 1,
            step: 0.01,
            value: 0,
            onChange(value) {
              expression[arkitIndex('JawOpen')] = value;
              bridge.setExpression(1, 'arkit52', expression);
            },
          },
          {
            id: 'export-blink',
            label: 'Blink',
            min: 0,
            max: 1,
            step: 0.01,
            value: 0,
            onChange(value) {
              expression[arkitIndex('EyeBlinkLeft')] = value;
              expression[arkitIndex('EyeBlinkRight')] = value;
              bridge.setExpression(1, 'arkit52', expression);
            },
          },
        ],
      },
    ],
    ['idle', 'walk', 'run', 'wave'].map((clip) => ({
      label: clip,
      onClick() {
        bridge.setClipWeights(1, [clip], [1], 1);
      },
    })),
  );
}

/** A framing of the studio's finished view: how much height it takes in at the character. */
const STUDIO_FRAMES = {
  // the studio's old lens settings, kept as the height each takes in: 16° at 2.5 m, 27° at 2.9 m,
  // 38° at 3.7 m
  tight: 2 * 2.5 * Math.tan((8 * Math.PI) / 180),
  medium: 2 * 2.9 * Math.tan((13.5 * Math.PI) / 180),
  wide: 2 * 3.7 * Math.tan((19 * Math.PI) / 180),
} as const;

/**
 * The Gameable studio's camera for a finished character (its desktop lens, 35 mm on a 24 mm
 * sensor; a phone's 8.9 mm on 3 mm), in the engine's frame.
 *
 * The studio stands a character in its PLY's own frame, crown at y = 0.41 and the floor where
 * `plyToCharacter` lifts it from; the engine stands it on y = 0. The camera sits level with the
 * eyes (0.31 m below the crown) straight in front, aimed at the head (tight), the chest (medium)
 * or the body's middle (wide).
 *
 * @param descriptor The character.json URL.
 * @param framing `tight`, `medium` or `wide`; anything else is tight.
 * @returns The lens, the camera's place, what it looks at, and how far the orbit may pull back.
 */
async function studioView(
  descriptor: string,
  framing: string | null,
): Promise<{
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
  maxDistance: number;
}> {
  let lift = 1.3;
  try {
    const d = (await (await fetch(descriptor)).json()) as { plyToCharacter?: number[] };
    if (typeof d.plyToCharacter?.[7] === 'number') lift = d.plyToCharacter[7];
  } catch {
    // the studio's default floor stands
  }
  const phone = innerWidth <= 760;
  const fovRad = 2 * Math.atan(phone ? 3 / (2 * 8.9) : 24 / (2 * 35));
  const frame = framing === 'medium' || framing === 'wide' ? framing : 'tight';
  const crown = 0.41;
  const floor = -lift;
  const eye = 0.1;
  const bodyMid = (crown + floor) / 2;
  let distance = STUDIO_FRAMES[frame] / (2 * Math.tan(fovRad / 2));
  if (frame === 'wide')
    distance = Math.max(
      distance,
      Math.min(25, (crown - floor) / (0.66 * 2 * Math.tan(fovRad / 2))),
    );
  const targetY = frame === 'tight' ? 0.14 : frame === 'wide' ? bodyMid : bodyMid + 0.3;
  const dy = Math.max(-0.9 * distance, Math.min(0.9 * distance, eye - targetY));
  return {
    fov: (fovRad * 180) / Math.PI,
    position: [0, targetY + dy + lift, Math.sqrt(distance * distance - dy * dy)],
    target: [0, targetY + lift, 0],
    maxDistance: Math.max(9, distance),
  };
}
