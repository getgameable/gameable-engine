/**
 * The shadow system's settings and behaviour, against a stand-in renderer: which level a device
 * gets, what each level draws, which source chooses the light, that the light never flickers
 * and turns in smoothly, and that switching levels or removing things leaves nothing behind.
 * The pictures themselves are checked in a real browser (see the hello world's `?shadowinfo=1`).
 */
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  MeshBasicNodeMaterial,
  Object3D,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import { createGaussianSplatGeometry } from 'three/addons/utils/GaussianSplatUtils.js';
import { describe, expect, it, vi } from 'vitest';

import { directionFromAngles, type KeyLightEstimate } from './keyLight.js';
import {
  clusterShadowCasters,
  createSplatShadows,
  defaultShadowQuality,
  parseShadowQuality,
  SHADOW_QUALITIES,
  shadowQualityPreset,
} from './shadows.js';
import { AnimatedGaussianSplat } from './three-fork/AnimatedGaussianSplat.js';

/** A renderer that records its draws; `webgpu: false` is the WebGL fallback. */
function stubRenderer(webgpu = true): WebGPURenderer & { render: ReturnType<typeof vi.fn> } {
  let target: unknown = null;
  return {
    backend: { isWebGPUBackend: webgpu },
    coordinateSystem: 2001,
    getRenderTarget: () => target,
    setRenderTarget: (next: unknown) => {
      target = next;
    },
    render: vi.fn(),
  } as unknown as WebGPURenderer & { render: ReturnType<typeof vi.fn> };
}

/** A two-bone body (root, head) with feet, four vertices: two body, two head. */
function rig(): { rig: Group; holder: Group; mesh: SkinnedMesh } {
  const root = new Bone();
  root.name = 'root';
  const head = new Bone();
  head.name = 'c_head';
  head.position.y = 1.5;
  const footL = new Bone();
  footL.name = 'l_foot';
  footL.position.set(0.1, 0.08, 0);
  const footR = new Bone();
  footR.name = 'r_foot';
  footR.position.set(-0.1, 0.08, 0);
  root.add(head, footL, footR);
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([0, 0.5, 0, 0, 1, 0, 0, 1.5, 0, 0, 1.7, 0], 3),
  );
  geometry.setAttribute(
    'skinIndex',
    new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0], 4),
  );
  geometry.setAttribute(
    'skinWeight',
    new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0], 4),
  );
  const mesh = new SkinnedMesh(geometry, new MeshBasicNodeMaterial());
  mesh.name = 'body';
  const group = new Group();
  group.add(root, mesh);
  group.updateMatrixWorld(true);
  mesh.bind(new Skeleton([root, head, footL, footR]));
  const holder = new Group();
  holder.add(group);
  return { rig: group, holder, mesh };
}

/** A light that a character's colours might carry, sure of itself. */
const CAPTURED: KeyLightEstimate = {
  direction: directionFromAngles(30, 45),
  azimuth: 30,
  elevation: 45,
  keyToFill: 2,
  shadowStrength: 0.5,
  confidence: 0.6,
};

/** A 6 x 3 x 6 m room of grey gaussians with one bright ceiling lamp at (1.5, 3, -1). */
function room(): AnimatedGaussianSplat {
  const centers: number[] = [];
  const colors: number[] = [];
  const add = (x: number, y: number, z: number, value: number): void => {
    centers.push(x, y, z);
    colors.push(value, value, value, 255);
  };
  for (let a = -3; a <= 3; a += 0.2) {
    for (let b = -3; b <= 3; b += 0.2) {
      add(a, 0, b, 90);
      add(a, 3, b, Math.abs(a - 1.5) < 0.5 && Math.abs(b + 1) < 0.5 ? 255 : 110);
    }
    for (let h = 0; h <= 3; h += 0.2) {
      add(a, h, -3, 100);
      add(a, h, 3, 100);
      add(-3, h, a, 100);
      add(3, h, a, 100);
    }
  }
  const count = centers.length / 3;
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i += 1) covariances.set([4e-4, 0, 0, 4e-4, 0, 4e-4], i * 6);
  return new AnimatedGaussianSplat(
    createGaussianSplatGeometry(new Float32Array(centers), covariances, new Uint8Array(colors)),
  );
}

/** Degrees between the system's light and a direction. */
function angleTo(
  info: { azimuth: number; elevation: number },
  direction: ArrayLike<number>,
): number {
  const d = new Vector3(...directionFromAngles(info.azimuth, info.elevation));
  return (d.angleTo(new Vector3(direction[0], direction[1], direction[2])) * 180) / Math.PI;
}

describe('shadow levels', () => {
  it('lists the four levels, lowest first', () => {
    expect(SHADOW_QUALITIES).toEqual(['off', 'contact', 'simple', 'soft']);
  });

  it('draws nothing when off, feet only for contact, one 1024 map and 9 taps for simple, two maps (2048) and 25 taps for soft', () => {
    expect(shadowQualityPreset('simple').characterMap).toBe(false);
    expect(shadowQualityPreset('soft').characterMap).toBe(true);
    expect(shadowQualityPreset('off')).toMatchObject({ mapSize: 0, contact: false });
    expect(shadowQualityPreset('contact')).toMatchObject({ mapSize: 0, contact: true });
    const simple = shadowQualityPreset('simple');
    const soft = shadowQualityPreset('soft');
    expect(simple.mapSize).toBe(1024);
    expect(simple.taps.length / 3).toBe(9);
    expect(soft.mapSize).toBe(2048);
    expect(soft.taps.length / 3).toBe(25);
    for (const { taps } of [simple, soft]) {
      let sum = 0;
      for (let t = 2; t < taps.length; t += 3) sum += taps[t];
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it('starts a computer at soft, a phone at simple and a small-memory phone at contact', () => {
    expect(defaultShadowQuality({ coarsePointer: false, shortSide: 1080, deviceMemory: 8 })).toBe(
      'soft',
    );
    expect(defaultShadowQuality({ coarsePointer: true, shortSide: 390 })).toBe('simple');
    expect(defaultShadowQuality({ coarsePointer: true, shortSide: 412, deviceMemory: 2 })).toBe(
      'contact',
    );
    // A tablet held either way is a computer-sized screen.
    expect(defaultShadowQuality({ coarsePointer: true, shortSide: 1024, deviceMemory: 8 })).toBe(
      'soft',
    );
  });

  it('reads a level from untrusted text', () => {
    expect(parseShadowQuality('soft')).toBe('soft');
    expect(parseShadowQuality('auto')).toBe('auto');
    expect(parseShadowQuality('ultra')).toBeNull();
    expect(parseShadowQuality(null)).toBeNull();
  });
});

describe('createSplatShadows', () => {
  it('is off, and stays off, on the WebGL fallback', () => {
    const renderer = stubRenderer(false);
    const shadows = createSplatShadows(renderer, new Object3D(), { quality: 'soft' });
    expect(shadows.quality).toBe('off');
    shadows.setQuality('simple');
    expect(shadows.quality).toBe('off');
    const { rig: body, holder } = rig();
    shadows.addCharacter({}, { rig: body, holder });
    shadows.update(1 / 60);
    expect(renderer.render).not.toHaveBeenCalled();
    shadows.dispose();
  });

  it('draws two depth maps at soft, one at simple, none at contact, from its own casters', () => {
    const renderer = stubRenderer();
    const scene = new Object3D();
    const shadows = createSplatShadows(renderer, scene, { quality: 'soft' });
    const { rig: body, holder, mesh } = rig();
    scene.add(holder);
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    shadows.addCharacter({}, { rig: body, holder, splat, captured: CAPTURED });
    shadows.update(1 / 60);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    // Its own small scene, never the page's: the casters are the rig's proxies, nothing else.
    const casterScene = renderer.render.mock.calls[0][0] as Object3D;
    expect(casterScene).not.toBe(scene);
    const proxies = casterScene.children.filter((c) => c instanceof SkinnedMesh);
    expect(proxies).toHaveLength(2);
    expect((proxies[0] as SkinnedMesh).geometry).toBe(mesh.geometry);
    expect((proxies[0] as SkinnedMesh).skeleton).toBe(mesh.skeleton);
    // The head is left out of the character's own shadow: its vertices carry 0.
    const cast = mesh.geometry.getAttribute('aosShadowCast');
    expect(Array.from(cast.array)).toEqual([1, 1, 0, 0.5]);
    // The character receives; with no place, a see-through ground shows the shadow.
    expect(
      (splat as unknown as { _buffers: { shadowReceiver: unknown } })._buffers.shadowReceiver,
    ).not.toBeNull();
    expect(shadows.info.ground).toBe(true);
    // Simple: one map, the characters onto the place or the ground; they do not receive.
    renderer.render.mockClear();
    shadows.setQuality('simple');
    shadows.update(1 / 60);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(
      (splat as unknown as { _buffers: { shadowReceiver: unknown } })._buffers.shadowReceiver,
    ).toBeNull();
    renderer.render.mockClear();
    shadows.setQuality('contact');
    shadows.update(1 / 60);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(shadows.info.ground).toBe(true);
    expect(
      (splat as unknown as { _buffers: { shadowReceiver: unknown } })._buffers.shadowReceiver,
    ).toBeNull();
    shadows.setQuality('off');
    expect(shadows.info.ground).toBe(false);
    shadows.dispose();
    expect(scene.getObjectByName('gameable:shadow-ground')).toBeUndefined();
  });

  it('takes the light from the character when there is no place, turned by its facing', () => {
    const shadows = createSplatShadows(stubRenderer(), new Object3D(), { quality: 'simple' });
    const { rig: body, holder } = rig();
    holder.rotation.y = Math.PI / 2; // facing +x: the light turns 90 degrees with it
    shadows.addCharacter({}, { rig: body, holder, captured: CAPTURED });
    expect(shadows.info.route).toBe('character');
    expect(shadows.info.azimuth).toBeCloseTo(120, 3);
    expect(shadows.info.elevation).toBeCloseTo(45, 3);
    shadows.dispose();
  });

  it('uses the default light when the character carries no clear key', () => {
    const shadows = createSplatShadows(stubRenderer(), new Object3D(), { quality: 'simple' });
    const { rig: body, holder } = rig();
    shadows.addCharacter({}, { rig: body, holder, captured: { ...CAPTURED, confidence: 0.05 } });
    expect(shadows.info.route).toBe('default');
    shadows.dispose();
  });

  it('prefers a place that is sure of its light, and turns to it smoothly, never flickering', () => {
    const shadows = createSplatShadows(stubRenderer(), new Object3D(), {
      quality: 'simple',
      turnSeconds: 1,
    });
    const { rig: body, holder } = rig();
    holder.position.set(0, 0, 0);
    shadows.addCharacter({}, { rig: body, holder, captured: CAPTURED });
    shadows.update(1 / 60);
    const before = shadows.info;
    // The same frame again and again: the light does not move at all.
    for (let i = 0; i < 30; i += 1) shadows.update(1 / 60);
    expect(shadows.info.azimuth).toBe(before.azimuth);
    expect(shadows.info.elevation).toBe(before.elevation);
    // A place arrives: read from where the character stands (chest height), the lamp.
    const place = room();
    shadows.addPlace(place);
    shadows.update(1 / 60);
    const lamp = [1.5, 3 - 1.2, -1];
    expect(shadows.info.route).toBe('place gaussians');
    const first = angleTo(shadows.info, lamp);
    const start = angleTo(before, lamp);
    expect(first).toBeLessThan(start);
    expect(first).toBeGreaterThan(1); // one frame in: part of the way, not a jump
    for (let i = 0; i < 180; i += 1) shadows.update(1 / 60);
    expect(angleTo(shadows.info, lamp)).toBeLessThan(10);
    expect(
      (place as unknown as { _buffers: { shadowReceiver: unknown } })._buffers.shadowReceiver,
    ).not.toBeNull();
    expect(shadows.info.ground).toBe(false);
    shadows.removePlace(place);
    expect(
      (place as unknown as { _buffers: { shadowReceiver: unknown } })._buffers.shadowReceiver,
    ).toBeNull();
    expect(shadows.info.route).toBe('character');
    shadows.dispose();
  });

  it("lets a game's own light win, and hands back when it is cleared", () => {
    const shadows = createSplatShadows(stubRenderer(), new Object3D(), { quality: 'soft' });
    const { rig: body, holder } = rig();
    shadows.addCharacter({}, { rig: body, holder, captured: CAPTURED });
    const light = {
      ...CAPTURED,
      direction: directionFromAngles(-90, 60),
      azimuth: -90,
      elevation: 60,
    };
    shadows.setKeyLight(light);
    expect(shadows.info.route).toBe('game');
    shadows.setKeyLight(null);
    expect(shadows.info.route).toBe('character');
    shadows.dispose();
  });

  it('holds the shadow strength inside a readable range', () => {
    const shadows = createSplatShadows(stubRenderer(), new Object3D(), { quality: 'soft' });
    const { rig: body, holder } = rig();
    shadows.addCharacter(
      {},
      { rig: body, holder, captured: { ...CAPTURED, shadowStrength: 0.02 } },
    );
    expect(shadows.info.strength).toBeCloseTo(0.25, 6);
    shadows.setKeyLight({ ...CAPTURED, shadowStrength: 0.99 });
    expect(shadows.info.strength).toBeCloseTo(0.8, 6);
    shadows.dispose();
  });

  it('forgets a removed character: no casters, no receiver', () => {
    const renderer = stubRenderer();
    const shadows = createSplatShadows(renderer, new Object3D(), { quality: 'simple' });
    const { rig: body, holder } = rig();
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    const key = {};
    shadows.addCharacter(key, { rig: body, holder, splat });
    shadows.removeCharacter(key);
    expect(shadows.info.characters).toBe(0);
    expect(
      (splat as unknown as { _buffers: { shadowReceiver: unknown } })._buffers.shadowReceiver,
    ).toBeNull();
    renderer.render.mockClear();
    shadows.update(1 / 60);
    expect(renderer.render).not.toHaveBeenCalled();
    shadows.dispose();
  });
});

/** A receiver's uniform as it would read at the next render. */
function receiverValue(splat: AnimatedGaussianSplat, name: 'bias' | 'tileCount'): number {
  const receiver = (
    splat as unknown as {
      _buffers: { shadowReceiver: Record<string, { update(frame: object): void; value: number }> };
    }
  )._buffers.shadowReceiver;
  receiver[name].update({});
  return receiver[name].value;
}

describe('redraws', () => {
  it('keeps the maps while nothing moves, and draws again when a bone moves', () => {
    const renderer = stubRenderer();
    const shadows = createSplatShadows(renderer, new Object3D(), { quality: 'soft' });
    const { rig: body, holder } = rig();
    shadows.addCharacter({}, { rig: body, holder, captured: CAPTURED });
    shadows.update(1 / 60);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(shadows.info.rendered).toBe(true);
    // A frozen pose: the same maps, frame after frame.
    renderer.render.mockClear();
    for (let i = 0; i < 10; i += 1) shadows.update(1 / 60);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(shadows.info.rendered).toBe(false);
    expect(shadows.info.renders).toBe(1);
    // A clip moves one bone a little: both maps again, once.
    (body.getObjectByName('c_head') as Bone).rotation.x += 0.01;
    shadows.update(1 / 60);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(shadows.info.rendered).toBe(true);
    shadows.update(1 / 60);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    // The whole character walks.
    holder.position.x += 0.5;
    shadows.update(1 / 60);
    expect(renderer.render).toHaveBeenCalledTimes(4);
    shadows.dispose();
  });

  it('draws again while the light turns, and stops once it has', () => {
    const renderer = stubRenderer();
    const shadows = createSplatShadows(renderer, new Object3D(), {
      quality: 'simple',
      turnSeconds: 0.1,
    });
    const { rig: body, holder } = rig();
    shadows.addCharacter({}, { rig: body, holder, captured: CAPTURED });
    shadows.update(1 / 60);
    shadows.update(1 / 60);
    expect(shadows.info.rendered).toBe(false);
    shadows.setKeyLight({
      ...CAPTURED,
      direction: directionFromAngles(-90, 60),
      azimuth: -90,
      elevation: 60,
    });
    shadows.update(1 / 60);
    expect(shadows.info.rendered).toBe(true);
    let frames = 0;
    while (shadows.info.rendered && frames < 600) {
      shadows.update(1 / 60);
      frames += 1;
    }
    expect(frames).toBeGreaterThan(1); // it turned over several frames, drawing each
    expect(frames).toBeLessThan(600); // and then stopped
    expect(shadows.info.azimuth).toBeCloseTo(-90, 2);
    shadows.dispose();
  });

  it('draws again when a character or a place comes or goes, or the level changes', () => {
    const renderer = stubRenderer();
    const shadows = createSplatShadows(renderer, new Object3D(), { quality: 'simple' });
    const first = rig();
    shadows.addCharacter({}, { rig: first.rig, holder: first.holder });
    shadows.update(1 / 60);
    shadows.update(1 / 60);
    expect(shadows.info.rendered).toBe(false);
    const second = rig();
    second.holder.position.x = 0.6;
    const key = {};
    shadows.addCharacter(key, { rig: second.rig, holder: second.holder });
    shadows.update(1 / 60);
    expect(shadows.info.rendered).toBe(true);
    shadows.update(1 / 60);
    expect(shadows.info.rendered).toBe(false);
    shadows.removeCharacter(key);
    shadows.update(1 / 60);
    expect(shadows.info.rendered).toBe(true);
    const place = room();
    shadows.addPlace(place);
    shadows.update(1 / 60);
    expect(shadows.info.rendered).toBe(true);
    shadows.setQuality('soft');
    for (let i = 0; i < 300 && shadows.info.rendered; i += 1) shadows.update(1 / 60);
    shadows.setQuality('simple');
    shadows.update(1 / 60);
    expect(shadows.info.rendered).toBe(true);
    shadows.dispose();
  });

  it('draws again when a collider moves', () => {
    const renderer = stubRenderer();
    const shadows = createSplatShadows(renderer, new Object3D(), { quality: 'soft' });
    const { rig: body, holder } = rig();
    shadows.addCharacter({}, { rig: body, holder });
    const collider = new Group();
    shadows.addPlace(new AnimatedGaussianSplat({ capacity: 4 }), { collider });
    for (let i = 0; i < 300; i += 1) shadows.update(1 / 60); // the place's light turns in
    shadows.update(1 / 60);
    expect(shadows.info.rendered).toBe(false);
    collider.position.y = 0.2;
    shadows.update(1 / 60);
    expect(shadows.info.rendered).toBe(true);
    shadows.dispose();
  });
});

describe('framing characters apart', () => {
  it('keeps characters standing together in one group, a lone one in group 0', () => {
    expect(clusterShadowCasters([{ x: 3, z: -2, radius: 1 }])).toEqual([0]);
    expect(
      clusterShadowCasters([
        { x: 0, z: 0, radius: 1 },
        { x: 1, z: 0, radius: 1 },
        { x: 0.5, z: 0.8, radius: 1 },
      ]),
    ).toEqual([0, 0, 0]);
  });

  it('gives characters standing apart a group each, at most four', () => {
    expect(
      clusterShadowCasters([
        { x: 0, z: 0, radius: 1 },
        { x: 1, z: 0, radius: 1 },
        { x: 8, z: 0, radius: 1 },
      ]),
    ).toEqual([0, 0, 1]);
    const six = [0, 10, 20, 30, 40, 50].map((x) => ({ x, z: 0, radius: 1 }));
    // Six in a row, 10 m apart: neighbours pair up, down to four groups, then a third pair joins
    // as that leaves no texel coarser than the first two pairs already have.
    expect(clusterShadowCasters(six)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('splits two characters only when a tile each is sharper, and does not flicker at the limit', () => {
    // 3 m apart: one camera would need a 2.5 m circle, coarser than a tile each (twice 1 m).
    // 1.5 m apart: their circles overlap, so they share.
    const at = (gap: number): { x: number; z: number; radius: number }[] => [
      { x: 0, z: 0, radius: 1 },
      { x: gap, z: 0, radius: 1 },
    ];
    expect(clusterShadowCasters(at(3))).toEqual([0, 1]);
    expect(clusterShadowCasters(at(1.5))).toEqual([0, 0]);
    // 2.2 m apart (a 2.1 m circle, 5 % coarser): kept as they were last frame.
    expect(clusterShadowCasters(at(2.2), [0, 1])).toEqual([0, 1]);
    expect(clusterShadowCasters(at(2.2), [0, 0])).toEqual([0, 0]);
    expect(clusterShadowCasters(at(2.2))).toEqual([0, 1]);
  });

  it('gives two characters apart a light camera each in one map, one when they come together', () => {
    const renderer = stubRenderer();
    const shadows = createSplatShadows(renderer, new Object3D(), { quality: 'soft' });
    const a = rig();
    const b = rig();
    b.holder.position.x = 6;
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    shadows.addCharacter({}, { rig: a.rig, holder: a.holder, splat });
    shadows.addCharacter({}, { rig: b.rig, holder: b.holder });
    shadows.update(1 / 60);
    expect(shadows.info.tiles).toBe(2);
    // Two tiles in each of the two maps, and the receivers read two.
    expect(renderer.render).toHaveBeenCalledTimes(4);
    expect(receiverValue(splat, 'tileCount')).toBe(2);
    b.holder.position.x = 1;
    shadows.update(1 / 60);
    expect(shadows.info.tiles).toBe(1);
    expect(receiverValue(splat, 'tileCount')).toBe(1);
    shadows.dispose();
  });
});

describe('biases', () => {
  // One character at the origin, radius 1: the light camera's depth range is 40 + 1 + 2 - 0.1 m.
  const span = 42.9;

  it('defaults to 12 cm for the characters and 3 cm for the place', () => {
    const shadows = createSplatShadows(stubRenderer(), new Object3D(), { quality: 'soft' });
    const { rig: body, holder } = rig();
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    const place = room();
    shadows.addCharacter({}, { rig: body, holder, splat });
    shadows.addPlace(place);
    shadows.update(1 / 60);
    expect(receiverValue(splat, 'bias')).toBeCloseTo(0.12 / span, 9);
    expect(receiverValue(place, 'bias')).toBeCloseTo(0.03 / span, 9);
    shadows.dispose();
  });

  it('takes both in metres from the options', () => {
    const shadows = createSplatShadows(stubRenderer(), new Object3D(), {
      quality: 'soft',
      characterBias: 0.05,
      placeBias: 0.01,
    });
    const { rig: body, holder } = rig();
    const splat = new AnimatedGaussianSplat({ capacity: 4 });
    const place = room();
    shadows.addCharacter({}, { rig: body, holder, splat });
    shadows.addPlace(place);
    shadows.update(1 / 60);
    expect(receiverValue(splat, 'bias')).toBeCloseTo(0.05 / span, 9);
    expect(receiverValue(place, 'bias')).toBeCloseTo(0.01 / span, 9);
    shadows.dispose();
  });

  it('refuses a negative or non-finite bias', () => {
    expect(() => createSplatShadows(stubRenderer(), new Object3D(), { characterBias: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      createSplatShadows(stubRenderer(), new Object3D(), { placeBias: Number.NaN }),
    ).toThrow(RangeError);
  });
});
