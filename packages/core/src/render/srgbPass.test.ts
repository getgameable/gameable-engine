import { uniform } from 'three/tsl';
import {
  BackSide,
  BoxGeometry,
  Color,
  DoubleSide,
  FrontSide,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Texture,
  Vector2,
  type BufferGeometry,
  type Camera,
  type Material,
  type Object3D,
  type RenderTarget,
  type WebGPURenderer,
} from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { attachSrgbPass, isSrgbPassMember, SRGB_PASS_LAYER } from './srgbPass.js';

type Member = Mesh & { srgbOutput: { value: number } };

/** The layer masks the pass puts things on. */
const SPLATS = (1 << SRGB_PASS_LAYER) >>> 0;
const DEPTH = (1 << 30) >>> 0;
const DEFAULT = 1;

/** One object drawn by a render, with the material it was drawn with. */
interface Drawn {
  readonly object: Object3D;
  readonly material: Material;
}

interface Call {
  readonly camera: Camera;
  readonly target: RenderTarget | null;
  readonly override: boolean;
  readonly background: unknown;
  readonly cameraMask: number;
  readonly autoClear: boolean;
  readonly shadows: boolean;
  /** Each watched object's layer mask during the render. */
  readonly masks: number[];
  readonly output: number | null;
  readonly compositeVisible: boolean;
  /** What the render drew, as three would pick it: visible, on a layer the camera sees. */
  readonly drawn: Drawn[];
}

type ObjectFunction = (
  object: Object3D,
  scene: Scene,
  camera: Camera,
  geometry: BufferGeometry,
  material: Material,
  group: unknown,
) => void;

/**
 * A renderer that calls the scene's hooks and draws objects as three does (its render object
 * function taken when the render starts, per material group), and records what each render saw.
 *
 * @param scene The scene.
 * @param watch Objects whose layer masks to record.
 * @param member The splat whose `srgbOutput` to record, if any.
 * @returns The fake, its calls, and switches to nest a render or to throw in the next one.
 */
function fakeRenderer(scene: Scene, watch: Object3D[] = [], member?: Member) {
  const calls: Call[] = [];
  let target: RenderTarget | null = null;
  let nest: Camera | null = null;
  let fail: ((camera: Camera) => boolean) | null = null;
  let level = 0;
  let objectFunction: ObjectFunction | null = null;
  const hooks = scene as unknown as {
    onBeforeRender: (...args: unknown[]) => void;
    onAfterRender: (...args: unknown[]) => void;
  };
  let drawn: Drawn[] = [];
  const renderer = {
    autoClear: true,
    shadowMap: { enabled: true },
    getDrawingBufferSize: (v: Vector2) => v.set(8, 4),
    getRenderTarget: () => target,
    setRenderTarget: (t: RenderTarget | null) => {
      target = t;
    },
    getClearColor: (c: Color) => c.set(0x123456),
    getClearAlpha: () => 1,
    setClearColor: () => {},
    clear: () => {},
    getRenderObjectFunction: () => objectFunction,
    setRenderObjectFunction: (f: ObjectFunction | null) => {
      objectFunction = f;
    },
    renderObject(object: Object3D, s: Scene, _c: Camera, _g: BufferGeometry, material: Material) {
      drawn.push({ object, material: s.overrideMaterial ?? material });
    },
    render(s: Scene, camera: Camera) {
      level += 1;
      const draw = objectFunction ?? renderer.renderObject;
      hooks.onBeforeRender(renderer, s, camera, target);
      if (fail?.(camera) === true) {
        fail = null;
        level -= 1;
        throw new Error('render failed');
      }
      const mine: Drawn[] = [];
      drawn = mine;
      s.traverseVisible((o) => {
        if ((o as Partial<Mesh>).isMesh !== true || !o.layers.test(camera.layers)) return;
        const mesh = o as Mesh;
        const m = mesh.material;
        const parts: [Material | undefined, unknown][] = Array.isArray(m)
          ? mesh.geometry.groups.map((g) => [m[g.materialIndex ?? 0], g])
          : [[m, null]];
        for (const [material, group] of parts)
          if (material?.visible === true) draw(o, s, camera, mesh.geometry, material, group);
      });
      calls.push({
        camera,
        target,
        override: s.overrideMaterial !== null,
        background: s.background,
        cameraMask: camera.layers.mask,
        autoClear: renderer.autoClear,
        shadows: renderer.shadowMap.enabled,
        masks: watch.map((o) => o.layers.mask),
        output: member ? member.srgbOutput.value : null,
        compositeVisible: s.getObjectByName('gameable sRGB splats')?.visible ?? false,
        drawn: mine,
      });
      if (nest !== null && level === 1) {
        const inner = nest;
        nest = null;
        renderer.render(s, inner);
      }
      hooks.onAfterRender(renderer, s, camera, target);
      level -= 1;
    },
    nestNext(camera: Camera) {
      nest = camera;
    },
    failNext(when: (camera: Camera) => boolean) {
      fail = when;
    },
  };
  return { renderer, calls };
}

/**
 * A scene with a splat, a pane of glass and an opaque wall.
 *
 * @returns The scene and its objects.
 */
function setup() {
  const scene = new Scene();
  const background = new Color(0x806040);
  scene.background = background;
  const splat = Object.assign(new Mesh(), { srgbOutput: uniform(0) }) as Member;
  const glass = new Mesh(undefined, new MeshBasicNodeMaterial({ transparent: true }));
  const wall = new Mesh(undefined, new MeshBasicNodeMaterial());
  scene.add(splat, glass, wall);
  return { scene, background, splat, glass, wall };
}

/**
 * The material a render drew an object with.
 *
 * @param call The render.
 * @param object The object.
 * @returns Its materials there, one per group drawn.
 */
function drawnWith(call: Call, object: Object3D): Material[] {
  return call.drawn.filter((d) => d.object === object).map((d) => d.material);
}

describe('isSrgbPassMember', () => {
  it('is true only for an object with an srgbOutput uniform', () => {
    expect(isSrgbPassMember(new Mesh())).toBe(false);
    expect(isSrgbPassMember(Object.assign(new Mesh(), { srgbOutput: null }))).toBe(false);
    expect(isSrgbPassMember(Object.assign(new Mesh(), { srgbOutput: uniform(0) }))).toBe(true);
  });
});

describe('attachSrgbPass', () => {
  it('adds nothing to a render when the scene has no sRGB splat', () => {
    const scene = new Scene();
    scene.add(new Mesh());
    const { renderer, calls } = fakeRenderer(scene);
    attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    renderer.render(scene, new PerspectiveCamera());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.compositeVisible).toBe(false);
  });

  it('draws the depth, then the splats in sRGB, before the app pass, and restores everything', () => {
    const { scene, background, splat, glass, wall } = setup();
    const { renderer, calls } = fakeRenderer(scene, [splat, glass, wall], splat);
    attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    const camera = new PerspectiveCamera();

    renderer.render(scene, camera);

    expect(calls).toHaveLength(3);
    const [depth, splats, app] = calls as [Call, Call, Call];
    // 1. depth only: the opaque wall on the depth layer, the splat and the glass off it
    expect(depth.target).not.toBeNull();
    expect(depth.cameraMask).toBe(DEPTH);
    expect(depth.masks).toEqual([DEFAULT, DEFAULT, DEPTH]);
    expect(depth.drawn.map((d) => d.object)).toEqual([wall]);
    expect(depth.drawn[0]?.material.colorWrite).toBe(false);
    expect(depth.autoClear).toBe(true);
    expect(depth.background).toBeNull();
    expect(depth.shadows).toBe(false);
    // 2. the splat alone on its layer, encoded, into the same target, against that depth
    expect(splats.override).toBe(false);
    expect(splats.target).toBe(depth.target);
    expect(splats.cameraMask).toBe(SPLATS);
    expect(splats.masks).toEqual([SPLATS, DEFAULT, DEFAULT]);
    expect(splats.drawn.map((d) => d.object)).toEqual([splat]);
    expect(splats.drawn[0]?.material).toBe(splat.material);
    expect(splats.output).toBe(1);
    expect(splats.autoClear).toBe(false);
    // 3. the app's own pass: its own materials, the splat still on its layer (unseen), the
    // composite laid over
    expect(app.target).toBeNull();
    expect(app.masks).toEqual([SPLATS, DEFAULT, DEFAULT]);
    expect(drawnWith(app, wall)).toEqual([wall.material]);
    expect(app.output).toBe(0);
    expect(app.compositeVisible).toBe(true);
    expect(app.background).toBe(background);
    expect(app.cameraMask).toBe(DEFAULT);
    expect(app.autoClear).toBe(true);
    expect(app.shadows).toBe(true);
    // after
    expect(splat.layers.mask).toBe(DEFAULT);
    expect(renderer.getRenderObjectFunction()).toBeNull();
    expect(scene.getObjectByName('gameable sRGB splats')?.visible).toBe(false);
  });

  it('counts an opaque mesh parented under a splat or under a transparent object', () => {
    const { scene, splat, glass } = setup();
    const onSplat = new Mesh(undefined, new MeshBasicNodeMaterial());
    const behindGlass = new Mesh(undefined, new MeshBasicNodeMaterial());
    splat.add(onSplat);
    glass.add(behindGlass);
    const { renderer, calls } = fakeRenderer(scene, [onSplat, behindGlass]);
    attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    renderer.render(scene, new PerspectiveCamera());
    expect(calls[0].masks).toEqual([DEPTH, DEPTH]);
    expect(drawnWith(calls[0], onSplat)).toHaveLength(1);
    expect(drawnWith(calls[0], behindGlass)).toHaveLength(1);
    expect(calls[2].masks).toEqual([DEFAULT, DEFAULT]);
  });

  it('draws the depth in one render whatever the sides, each mesh culled as its own material is', () => {
    const { scene, splat, wall } = setup();
    const front = new Mesh(undefined, new MeshBasicNodeMaterial({ side: FrontSide }));
    // a wall seen from behind: drawn BackSide it would hide the splat, FrontSide-culled it hides
    // nothing, as in the app's pass
    const back = new Mesh(undefined, new MeshBasicNodeMaterial({ side: BackSide }));
    const both = new Mesh(undefined, new MeshBasicNodeMaterial({ side: DoubleSide }));
    scene.add(front, back, both);
    const { renderer, calls } = fakeRenderer(scene, [front, back, both], splat);
    attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    renderer.render(scene, new PerspectiveCamera());
    // the depth, the splats, the app's pass
    expect(calls).toHaveLength(3);
    const depth = calls[0];
    expect(depth.masks).toEqual([DEPTH, DEPTH, DEPTH]);
    const [f] = drawnWith(depth, front);
    const [b] = drawnWith(depth, back);
    const [d] = drawnWith(depth, both);
    expect([f.side, b.side, d.side]).toEqual([FrontSide, BackSide, DoubleSide]);
    for (const m of [f, b, d]) expect(m.colorWrite).toBe(false);
    // plain materials of one side share one depth material, made once
    expect(drawnWith(depth, wall)[0]).toBe(f);
    renderer.render(scene, new PerspectiveCamera());
    expect(drawnWith(calls[3], back)[0]).toBe(b);
    expect(calls[5].masks).toEqual([DEFAULT, DEFAULT, DEFAULT]);
  });

  it('draws each group of a multi-material mesh with its own side, and none that writes no depth', () => {
    const { scene, splat } = setup();
    const geometry = new BoxGeometry();
    const faces = [
      new MeshBasicNodeMaterial({ side: BackSide }),
      new MeshBasicNodeMaterial({ transparent: true }),
      new MeshBasicNodeMaterial({ depthWrite: false }),
      new MeshBasicNodeMaterial(),
      new MeshBasicNodeMaterial(),
      new MeshBasicNodeMaterial(),
    ];
    const box = new Mesh(geometry, faces);
    scene.add(box);
    const { renderer, calls } = fakeRenderer(scene, [box], splat);
    attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    renderer.render(scene, new PerspectiveCamera());
    const sides = drawnWith(calls[0], box).map((m) => m.side);
    expect(sides).toEqual([BackSide, FrontSide, FrontSide, FrontSide]);
    expect(drawnWith(calls[2], box)).toHaveLength(6);
    expect(box.material).toBe(faces);
  });

  it("gives a cut-out its map's alpha and its alphaTest, so it writes no depth where the texture is clear", () => {
    const { scene, splat } = setup();
    const leaves = new Texture();
    const mask = new Texture();
    const foliage = new Mesh(
      undefined,
      new MeshBasicNodeMaterial({ map: leaves, alphaTest: 0.5, side: DoubleSide }),
    );
    const fence = new Mesh(
      undefined,
      new MeshBasicNodeMaterial({ alphaMap: mask, alphaTest: 0.3, opacity: 0.8 }),
    );
    const painted = new Mesh(undefined, new MeshBasicNodeMaterial({ map: leaves }));
    scene.add(foliage, fence, painted);
    const { renderer, calls } = fakeRenderer(scene, [], splat);
    attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    renderer.render(scene, new PerspectiveCamera());
    type Cut = Material & { map: Texture | null; alphaMap: Texture | null };
    const [f] = drawnWith(calls[0], foliage) as Cut[];
    expect(f.map).toBe(leaves);
    expect(f.alphaTest).toBe(0.5);
    expect(f.side).toBe(DoubleSide);
    expect(f.colorWrite).toBe(false);
    const [n] = drawnWith(calls[0], fence) as Cut[];
    expect(n.alphaMap).toBe(mask);
    expect(n.alphaTest).toBe(0.3);
    expect(n.opacity).toBe(0.8);
    expect(n).not.toBe(f);
    // a textured material with no alphaTest is solid: the plain depth material, no texture read
    const [p] = drawnWith(calls[0], painted) as Cut[];
    expect(p.map).toBeNull();
    expect(p.alphaTest).toBe(0);
    // made once: the same material next frame, following a change to the source
    foliage.material.alphaTest = 0.25;
    renderer.render(scene, new PerspectiveCamera());
    const [again] = drawnWith(calls[3], foliage);
    expect(again).toBe(f);
    expect(again.alphaTest).toBe(0.25);
  });

  it("drops a cut-out's depth material when the cut-out is disposed, and all of them with the pass", () => {
    const { scene, splat } = setup();
    const cut = new MeshBasicNodeMaterial({ map: new Texture(), alphaTest: 0.5 });
    const other = new MeshBasicNodeMaterial({ map: new Texture(), alphaTest: 0.5 });
    scene.add(new Mesh(undefined, cut), new Mesh(undefined, other));
    const { renderer, calls } = fakeRenderer(scene, [], splat);
    const pass = attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    renderer.render(scene, new PerspectiveCamera());
    const disposed: Material[] = [];
    const depths = calls[0].drawn.map((d) => d.material).filter((m) => m !== splat.material);
    for (const m of depths)
      m.addEventListener('dispose', () => {
        disposed.push(m);
      });
    cut.dispose();
    expect(disposed).toHaveLength(1);
    pass.dispose();
    expect(new Set(disposed).size).toBe(depths.length);
  });

  it('draws no splats in a render nested inside the app pass', () => {
    const { scene, splat } = setup();
    const { renderer, calls } = fakeRenderer(scene, [splat], splat);
    attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    const camera = new PerspectiveCamera();
    const mirror = new PerspectiveCamera();
    renderer.nestNext(mirror);
    renderer.render(scene, camera);
    // depth, splats, app pass, then the nested render with nothing more drawn for it
    expect(calls).toHaveLength(4);
    const nested = calls[3];
    expect(nested.camera).toBe(mirror);
    expect(nested.compositeVisible).toBe(false);
    expect(nested.masks).toEqual([SPLATS]);
    expect(splat.layers.mask).toBe(DEFAULT);
  });

  it('sorts the composite where the splat is, with its render order, in the same frame', () => {
    const { scene, splat } = setup();
    splat.position.set(0, 1, -3);
    splat.renderOrder = 1000;
    scene.updateMatrixWorld(true); // as three does before the scene's onBeforeRender
    const { renderer } = fakeRenderer(scene);
    const pass = attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    renderer.render(scene, new PerspectiveCamera());
    const e = pass.composite.matrixWorld.elements;
    expect([e[12], e[13], e[14]]).toEqual([0, 1, -3]);
    expect(pass.composite.renderOrder).toBe(1000);
  });

  it("is never hit by the app's raycasts, even while it is drawn", () => {
    const { scene } = setup();
    const { renderer } = fakeRenderer(scene);
    const pass = attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    pass.composite.visible = true;
    // Straight at the quad's plane, from in front: a plain mesh there would be hit.
    const camera = new PerspectiveCamera();
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld();
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(0, 0), camera);
    const plain = new Mesh(pass.composite.geometry, new MeshBasicNodeMaterial());
    plain.updateMatrixWorld();
    expect(ray.intersectObject(plain).length).toBeGreaterThan(0);
    expect(ray.intersectObject(pass.composite).length).toBe(0);
  });

  it('leaves out a splat on a layer the camera does not see', () => {
    const { scene, splat } = setup();
    splat.layers.set(3);
    const { renderer, calls } = fakeRenderer(scene, [], splat);
    attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    renderer.render(scene, new PerspectiveCamera());
    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBe(0);
  });

  it("calls the app's own hooks once per render, not for the pass's own renders", () => {
    const { scene } = setup();
    let befores = 0;
    let afters = 0;
    scene.onBeforeRender = () => {
      befores += 1;
    };
    scene.onAfterRender = () => {
      afters += 1;
    };
    const { renderer } = fakeRenderer(scene);
    attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    renderer.render(scene, new PerspectiveCamera());
    expect([befores, afters]).toEqual([1, 1]);
  });

  it('puts the splats back after a render that threw before its end', async () => {
    const { scene, splat } = setup();
    const { renderer, calls } = fakeRenderer(scene, [splat], splat);
    attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    const hooks = scene as unknown as { onBeforeRender: (...args: unknown[]) => void };
    hooks.onBeforeRender(renderer, scene, new PerspectiveCamera(), null);
    expect(splat.layers.mask).toBe(SPLATS); // off the app's pass, which then never ends
    await Promise.resolve();
    expect(splat.layers.mask).toBe(DEFAULT);
    // and the next render is a top-level one again: it draws the splat through the pass
    const count = calls.length;
    renderer.render(scene, new PerspectiveCamera());
    expect(calls.length - count).toBe(3);
    expect(splat.layers.mask).toBe(DEFAULT);
  });

  it('puts everything back when the depth render throws', async () => {
    const { scene, splat, wall } = setup();
    const own: typeof scene.onBeforeRender = () => {};
    scene.onBeforeRender = own;
    const { renderer, calls } = fakeRenderer(scene, [splat, wall], splat);
    attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    const hooked = scene.onBeforeRender;
    const camera = new PerspectiveCamera();
    renderer.failNext((c) => c.layers.mask === DEPTH);
    expect(() => {
      renderer.render(scene, camera);
    }).toThrow('render failed');
    expect(wall.layers.mask).toBe(DEFAULT);
    expect(camera.layers.mask).toBe(DEFAULT);
    expect(renderer.getRenderObjectFunction()).toBeNull();
    expect(renderer.getRenderTarget()).toBeNull();
    expect(renderer.autoClear).toBe(true);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(scene.onBeforeRender).toBe(hooked);
    await Promise.resolve();
    expect(splat.layers.mask).toBe(DEFAULT);
    renderer.render(scene, camera);
    expect(calls).toHaveLength(3);
    expect(calls[2].compositeVisible).toBe(true);
  });

  it('shares one pass per scene, taken off when every attachment is disposed', () => {
    const { scene } = setup();
    const { renderer } = fakeRenderer(scene);
    const before = scene.onBeforeRender;
    const first = attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    const second = attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    expect(second.composite).toBe(first.composite);
    first.dispose();
    first.dispose(); // idempotent
    expect(first.composite.parent).toBe(scene);
    second.dispose();
    expect(scene.onBeforeRender).toBe(before);
    expect(first.composite.parent).toBeNull();
    expect(attachSrgbPass(renderer as unknown as WebGPURenderer, scene).composite).not.toBe(
      first.composite,
    );
  });

  it('keeps a hook the app wrapped around the pass when the pass comes off', () => {
    const { scene } = setup();
    const { renderer } = fakeRenderer(scene);
    const pass = attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    const ours = scene.onBeforeRender;
    const wrapper: typeof ours = function (this: Scene, ...args) {
      ours.apply(this, args);
    };
    scene.onBeforeRender = wrapper;
    pass.dispose();
    expect(scene.onBeforeRender).toBe(wrapper);
  });
});

describe('attachSrgbPass without the hook', () => {
  it("leaves the scene's hooks alone and draws the splats between begin and end", () => {
    const { scene, splat, wall } = setup();
    let befores = 0;
    const own: typeof scene.onBeforeRender = () => {
      befores += 1;
    };
    scene.onBeforeRender = own;
    const { renderer, calls } = fakeRenderer(scene, [splat, wall], splat);
    const pass = attachSrgbPass(renderer as unknown as WebGPURenderer, scene, { hook: false });
    expect(scene.onBeforeRender).toBe(own);
    const camera = new PerspectiveCamera();

    pass.begin(camera);
    expect(calls).toHaveLength(2);
    const [depth, splats] = calls as [Call, Call];
    expect(depth.masks).toEqual([DEFAULT, DEPTH]);
    expect(drawnWith(depth, wall)[0]?.colorWrite).toBe(false);
    expect(splats.output).toBe(1);
    expect(befores).toBe(0); // the pass's own renders call no scene hook
    renderer.render(scene, camera);
    const app = calls[2];
    expect(app.compositeVisible).toBe(true);
    expect(app.masks).toEqual([SPLATS, DEFAULT]);
    expect(app.output).toBe(0);
    expect(befores).toBe(1);
    pass.end();
    expect(splat.layers.mask).toBe(DEFAULT);
    expect(pass.composite.visible).toBe(false);
    pass.end(); // nothing open: nothing to do
    // without begin, a render draws no splats
    renderer.render(scene, camera);
    expect(calls).toHaveLength(4);
    expect(calls[3].compositeVisible).toBe(false);
    pass.dispose();
    expect(scene.onBeforeRender).toBe(own);
    expect(pass.composite.parent).toBeNull();
  });

  it('closes a frame left open once the task has run', async () => {
    const { scene, splat } = setup();
    const { renderer, calls } = fakeRenderer(scene, [splat], splat);
    const pass = attachSrgbPass(renderer as unknown as WebGPURenderer, scene, { hook: false });
    const camera = new PerspectiveCamera();
    pass.begin(camera);
    renderer.render(scene, camera);
    expect(splat.layers.mask).toBe(SPLATS);
    await Promise.resolve();
    expect(splat.layers.mask).toBe(DEFAULT);
    expect(pass.composite.visible).toBe(false);
    // a begin that throws is put back too
    renderer.failNext((c) => c.layers.mask === SPLATS);
    expect(() => {
      pass.begin(camera);
    }).toThrow('render failed');
    expect(camera.layers.mask).toBe(DEFAULT);
    await Promise.resolve();
    expect(splat.layers.mask).toBe(DEFAULT);
    const count = calls.length;
    pass.begin(camera);
    renderer.render(scene, camera);
    pass.end();
    expect(calls.length - count).toBe(3);
    expect(calls[calls.length - 1].compositeVisible).toBe(true);
  });

  it('shares the pass with a hooked attachment: begin draws the frame, the hook adds nothing', () => {
    const { scene, splat } = setup();
    const { renderer, calls } = fakeRenderer(scene, [splat], splat);
    const hooked = attachSrgbPass(renderer as unknown as WebGPURenderer, scene);
    const manual = attachSrgbPass(renderer as unknown as WebGPURenderer, scene, { hook: false });
    expect(manual.composite).toBe(hooked.composite);
    const camera = new PerspectiveCamera();
    const mirror = new PerspectiveCamera();
    manual.begin(camera);
    renderer.nestNext(mirror);
    renderer.render(scene, camera);
    // depth, splats (from begin), the app's pass, a nested render with no splats
    expect(calls).toHaveLength(4);
    expect(calls[2].compositeVisible).toBe(true);
    expect(calls[3].compositeVisible).toBe(false);
    expect(splat.layers.mask).toBe(SPLATS); // until end
    manual.end();
    expect(splat.layers.mask).toBe(DEFAULT);
    // the hook alone again
    renderer.render(scene, camera);
    expect(calls).toHaveLength(7);
    expect(calls[6].compositeVisible).toBe(true);
    expect(splat.layers.mask).toBe(DEFAULT);
  });
});
