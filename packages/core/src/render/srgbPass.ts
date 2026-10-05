/**
 * sRGB-trained splats drawn inside an app's own `renderer.render(scene, camera)`, blended as they
 * were trained.
 *
 * Gaussian splats (a Gameable character, a World Labs place) are fitted blending their stored
 * sRGB values: gsplat, PlayCanvas and Spark all composite `Σ c·α·T` on sRGB colours. three's
 * `WebGPURenderer` blends everything in a linear half-float buffer, and decoding each splat's
 * colour first cannot match: `encode(Σ decode(c)·w) ≠ Σ c·w` wherever splats overlap, which reads
 * paler and flatter. So the splats are drawn on their own and laid over the app's frame:
 *
 * 1. `scene.onBeforeRender`, before the app's pass begins (or `begin(camera)`, see
 *    {@link SrgbPassOptions.hook}): the depth of the scene's opaque meshes in one depth-only
 *    render, then the sRGB splats alone against it, colours encoded back to sRGB per splat (the
 *    splat's `srgbOutput` switch), into a target of their own. They then stay on the pass's own
 *    layer, which the app's camera does not see.
 * 2. During the app's pass, a mesh in its scene decodes that premultiplied sRGB result to linear
 *    (`srgbToLinear(rgb / a) · a`) and blends it over the frame. It is a transparent object at the
 *    nearest splat's place with that splat's `renderOrder`, sorted with the app's own as the splat
 *    itself would be. `scene.onAfterRender` (or `end()`) puts the splats back on their own layers.
 *
 * The depth has to be drawn again because three records the app's pass and submits it only when
 * the render ends: nothing drawn inside the pass can see that frame's depth. In the depth render
 * each mesh is drawn with a depth-only material of its own material's side (a wall seen from
 * behind hides nothing) and, for a cut-out (`alphaTest`), its `map`, `alphaMap` and opacity, so
 * foliage hides only where its texture is solid. Both renders pick what they draw by camera layer,
 * never by `visible`, so a mesh under a splat or under a transparent parent still counts.
 *
 * An object takes part when it has an `srgbOutput` uniform (`{ value: number }`) and is on a layer
 * the camera sees. A render of the scene nested inside the app's (a reflection, a shadow map)
 * draws no splats.
 */
import { float, max, positionGeometry, screenUV, sRGBTransferEOTF, texture, vec4 } from 'three/tsl';
import {
  AddEquation,
  BackSide,
  Color,
  CustomBlending,
  DepthTexture,
  DoubleSide,
  FrontSide,
  HalfFloatType,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  RenderTarget,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Material,
  type Node,
  type Object3D,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';

/** The layer the splat pass draws on: the splats alone, with no light or shadow work. */
export const SRGB_PASS_LAYER = 31;

/** The layer the depth pre-pass draws on: the opaque meshes, all at once. */
const DEPTH_LAYER = 30;

/** An object the sRGB pass draws: its `srgbOutput` is 1 while it does. */
export type SrgbPassMember = Object3D & { readonly srgbOutput: { value: number } };

/**
 * Whether an object is drawn by the sRGB pass.
 *
 * @param object Any object in the scene.
 * @returns True when it carries an `srgbOutput` uniform.
 * @example
 * ```ts
 * isSrgbPassMember(character.object3D.children[0]);
 * ```
 */
export function isSrgbPassMember(object: Object3D): object is SrgbPassMember {
  const s = (object as { srgbOutput?: unknown }).srgbOutput;
  return (
    typeof s === 'object' && s !== null && typeof (s as { value?: unknown }).value === 'number'
  );
}

/** How {@link attachSrgbPass} joins the app's renders. */
export interface SrgbPassOptions {
  /**
   * True (the default): the pass hooks the scene's `onBeforeRender` / `onAfterRender`, and every
   * `renderer.render(scene, camera)` draws the splats with no change to the app's loop. False: no
   * hook; the app calls `begin(camera)` just before its render and `end()` just after. For an app
   * that assigns `scene.onBeforeRender` itself, or renders the scene through something that
   * bypasses the hook.
   */
  readonly hook?: boolean;
}

/** One attachment of the sRGB splat pass to a scene. */
export interface SrgbPass {
  /** The mesh that lays the splats over the frame (a child of the scene). */
  readonly composite: Mesh;
  /**
   * Draw this frame's depth pre-pass and splats for `camera`, into the renderer's current render
   * target's size, and lay them over the next `renderer.render(scene, camera)`. Call it just
   * before that render, with `end()` just after (in the same task: a frame left open is closed
   * once the current task's code has run). Not needed with the scene hook, which does the same;
   * with it, the hook then leaves the render to this frame.
   *
   * @param camera The camera the app is about to render the scene with.
   * @returns Nothing.
   */
  begin(camera: Camera): void;
  /**
   * Close the frame `begin` opened: the splats go back on their own layers and the composite
   * away. Does nothing when no frame is open.
   *
   * @returns Nothing.
   */
  end(): void;
  /**
   * Release this attachment. The pass comes off the scene (its hooks, its mesh, its targets, its
   * depth materials) when every attachment to it has been released.
   *
   * @returns Nothing.
   */
  dispose(): void;
}

/**
 * Whether a material writes nothing to the depth the splats test against: transparent,
 * `depthWrite: false`, or drawing nothing to the screen (a shadow proxy with `colorWrite: false`).
 *
 * @param material A material of a mesh.
 * @returns True to leave it out of the depth pre-pass.
 */
function writesNoDepth(material: Material): boolean {
  return material.transparent || !material.depthWrite || !material.colorWrite;
}

/**
 * Whether an object stays out of the depth pre-pass: every material writes no depth, or it is not
 * a mesh (points, lines and sprites would draw as solid shapes).
 *
 * @param object A visible object.
 * @returns True to leave it out of the pre-pass.
 */
function skipsDepth(object: Object3D): boolean {
  const kind = object as Object3D & {
    isMesh?: boolean;
    isPoints?: boolean;
    isLine?: boolean;
    isSprite?: boolean;
  };
  if (kind.isPoints === true || kind.isLine === true || kind.isSprite === true) return true;
  if (kind.isMesh !== true) return false;
  const material = (object as Mesh).material;
  const materials: readonly Material[] = Array.isArray(material) ? material : [material];
  return materials.every(writesNoDepth);
}

/** What the depth pre-pass reads from a mesh's own material (any material, node or not). */
type DepthSource = Material & {
  map?: Texture | null;
  alphaMap?: Texture | null;
  colorNode?: Node | null;
  opacityNode?: Node | null;
  positionNode?: Node | null;
  displacementMap?: Texture | null;
  displacementScale?: number;
  displacementBias?: number;
};

/** A depth-only material. */
type DepthMaterial = MeshBasicNodeMaterial;

/**
 * A depth-only material for one side.
 *
 * @param side FrontSide, BackSide or DoubleSide.
 * @returns A material that writes depth and no colour.
 */
function depthMaterial(side: Material['side']): DepthMaterial {
  const m = new MeshBasicNodeMaterial();
  m.colorWrite = false;
  m.side = side;
  return m;
}

/**
 * Whether a material needs a depth material of its own rather than its side's shared one: a
 * cut-out, or one that moves its vertices.
 *
 * @param source A mesh's material.
 * @returns True for a cut-out or a displaced material.
 */
function needsOwnDepth(source: DepthSource): boolean {
  return (
    source.alphaTest > 0 ||
    (source.positionNode ?? null) !== null ||
    (source.displacementMap ?? null) !== null
  );
}

/**
 * Bring a material's own depth material up to date with it: its side and shape (position node,
 * displacement) and, for a cut-out, what makes its alpha (`map`, `alphaMap`, opacity and a node
 * material's colour and opacity nodes) and its `alphaTest`.
 *
 * @param material The depth material.
 * @param source The mesh's own material.
 */
function syncDepth(material: DepthMaterial, source: DepthSource): void {
  // the same fields, typed as loosely as the source's (any material, node or not)
  const depth = material as unknown as DepthSource;
  depth.side = source.side;
  depth.positionNode = source.positionNode ?? null;
  depth.displacementMap = source.displacementMap ?? null;
  depth.displacementScale = source.displacementScale ?? 1;
  depth.displacementBias = source.displacementBias ?? 0;
  const cut = source.alphaTest > 0;
  depth.alphaTest = source.alphaTest;
  depth.map = cut ? (source.map ?? null) : null;
  depth.alphaMap = cut ? (source.alphaMap ?? null) : null;
  depth.opacity = cut ? source.opacity : 1;
  depth.colorNode = cut ? (source.colorNode ?? null) : null;
  depth.opacityNode = cut ? (source.opacityNode ?? null) : null;
}

/** A scene's render hook as three's renderer calls it (the Object3D typing does not say so). */
type SceneHook = (
  this: Scene,
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  target: RenderTarget | null,
) => void;

/** three's per-object draw, as `renderer.setRenderObjectFunction` takes it. */
type RenderObjectFunction = (
  object: Object3D,
  scene: Scene,
  camera: Camera,
  geometry: BufferGeometry,
  material: Material,
  group: unknown,
  lightsNode: unknown,
  clippingContext: unknown,
  passId?: string | null,
) => void;

/** The renderer calls the depth pre-pass uses, typed as three r186 has them. */
type ObjectRenderer = WebGPURenderer & {
  getRenderObjectFunction(): RenderObjectFunction | null;
  setRenderObjectFunction(f: RenderObjectFunction | null): void;
  renderObject: RenderObjectFunction;
};

/** The pass on one scene, shared by its attachments. */
interface Attached {
  attachments: number;
  readonly composite: Mesh;
  /** Hook the scene, once, for the first attachment that asks. */
  hook(): void;
  /** Stop the hook drawing (an attachment that hooked it has gone). */
  unhook(): void;
  begin(camera: Camera): void;
  end(): void;
  teardown(): void;
}

const attached = new WeakMap<Scene, Attached>();

/**
 * Attach the sRGB splat pass to a scene: from then on, `renderer.render(scene, camera)` draws
 * the scene's sRGB splats blended on sRGB values, depth-tested against the scene. One pass per
 * scene: a second attachment shares the first, and the pass comes off when every attachment has
 * been disposed. `gameable/three` and the engine attach it themselves.
 *
 * Each frame costs two extra renders of the scene before the app's: its opaque meshes, depth
 * only, then the splats. With `{ hook: false }` nothing is hooked: the app wraps its render in
 * `begin(camera)` / `end()` itself.
 *
 * @param renderer The initialised `WebGPURenderer` that draws the scene.
 * @param scene The scene.
 * @param options `hook: false` to call `begin` / `end` instead of hooking the scene.
 * @returns This attachment.
 * @example
 * ```ts
 * const pass = attachSrgbPass(renderer, scene);
 * renderer.setAnimationLoop(() => renderer.render(scene, camera));
 * // later: pass.dispose();
 *
 * // An app that owns scene.onBeforeRender: no hook, begin and end around the render.
 * const manual = attachSrgbPass(renderer, scene, { hook: false });
 * renderer.setAnimationLoop(() => {
 *   manual.begin(camera);
 *   try {
 *     renderer.render(scene, camera);
 *   } finally {
 *     manual.end();
 *   }
 * });
 * ```
 */
export function attachSrgbPass(
  renderer: WebGPURenderer,
  scene: Scene,
  options: SrgbPassOptions = {},
): SrgbPass {
  const state = attached.get(scene) ?? createPass(renderer, scene);
  const hooked = options.hook !== false;
  state.attachments += 1;
  if (hooked) state.hook();
  let released = false;
  return {
    composite: state.composite,
    begin(camera) {
      state.begin(camera);
    },
    end() {
      state.end();
    },
    dispose() {
      if (released) return;
      released = true;
      state.attachments -= 1;
      if (hooked) state.unhook();
      if (state.attachments === 0) state.teardown();
    },
  };
}

/**
 * Build the pass on a scene. It hooks the scene when an attachment asks for the hook.
 *
 * @param renderer The renderer that draws the scene.
 * @param scene The scene.
 * @returns The shared state, with no attachment yet.
 */
function createPass(renderer: WebGPURenderer, scene: Scene): Attached {
  // One target: the depth pre-pass writes its depth, the splats test against it and write colour.
  const target = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: true });
  target.depthTexture = new DepthTexture(1, 1);

  // The depth materials, made once: one per side, shared by every plain opaque material of that
  // side; one of its own for a cut-out or displaced material, dropped when that one is disposed.
  const sideDepth = new Map<Material['side'], DepthMaterial>(
    [FrontSide, BackSide, DoubleSide].map((side) => [side, depthMaterial(side)]),
  );
  const ownDepth = new Map<Material, { depth: DepthMaterial; release(): void }>();
  /**
   * The material a mesh's material is drawn with in the depth pre-pass.
   *
   * @param source The mesh's material (one group's, for several).
   * @returns Its depth material, the material itself when it refuses overrides, or null to draw
   *   nothing for it.
   */
  const depthOf = (source: DepthSource): Material | null => {
    if (writesNoDepth(source)) return null;
    if (!source.allowOverride) return source; // as a scene override would leave it
    if (!needsOwnDepth(source)) return sideDepth.get(source.side) ?? null;
    let own = ownDepth.get(source);
    if (own === undefined) {
      const depth = depthMaterial(source.side);
      const release = (): void => {
        source.removeEventListener('dispose', release);
        ownDepth.delete(source);
        depth.dispose();
      };
      source.addEventListener('dispose', release);
      own = { depth, release };
      ownDepth.set(source, own);
    }
    syncDepth(own.depth, source);
    return own.depth;
  };
  const objects = renderer as ObjectRenderer;
  /**
   * The depth pre-pass's per-object draw: each mesh with its material's depth material.
   *
   * @param object The mesh.
   * @param sc The scene.
   * @param view The camera.
   * @param geometry Its geometry.
   * @param material Its material (one group's, for several).
   * @param group Its group, or null.
   * @param lightsNode The render's lights.
   * @param clippingContext The render's clipping.
   * @param passId three's pass id.
   */
  const drawDepth: RenderObjectFunction = (
    object,
    sc,
    view,
    geometry,
    material,
    group,
    lightsNode,
    clippingContext,
    passId,
  ) => {
    const depth = depthOf(material);
    if (depth === null) return;
    objects.renderObject(
      object,
      sc,
      view,
      geometry,
      depth,
      group,
      lightsNode,
      clippingContext,
      passId,
    );
  };

  // premultiplied sRGB splats -> premultiplied linear, blended over the frame
  const material = new MeshBasicNodeMaterial();
  const texel = texture(target.texture, screenUV);
  const a = texel.a;
  const straight = max(texel.rgb.div(max(a, float(1e-6))), 0);
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);
  material.colorNode = vec4((sRGBTransferEOTF(straight) as unknown as Node<'vec3'>).mul(a), a);
  material.transparent = true;
  material.premultipliedAlpha = true;
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneMinusSrcAlphaFactor;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  const composite = new Mesh(new PlaneGeometry(2, 2), material);
  composite.name = 'gameable sRGB splats';
  composite.frustumCulled = false;
  // A full-screen quad in the scene: never hit by the app's raycasts (picking, pointer events).
  composite.raycast = () => undefined;
  composite.visible = false;
  // placed each frame after three has updated the scene's matrices: its world matrix is set directly
  composite.matrixAutoUpdate = false;
  composite.matrixWorldAutoUpdate = false;
  scene.add(composite);

  const members: SrgbPassMember[] = [];
  const opaque: Mesh[] = [];
  const memberMasks: number[] = [];
  const meshMasks: number[] = [];
  const size = new Vector2();
  const eye = new Vector3();
  const at = new Vector3();
  const clearColor = new Color();
  let camera: Camera | null = null;
  const collect = (object: Object3D): void => {
    if (object === composite || camera === null || !object.layers.test(camera.layers)) return;
    if (isSrgbPassMember(object)) members.push(object);
    else if ((object as Partial<Mesh>).isMesh === true && !skipsDepth(object))
      opaque.push(object as Mesh);
  };
  const hooks = scene as unknown as { onBeforeRender: SceneHook; onAfterRender: SceneHook };
  const quiet: SceneHook = () => {};
  let renders = 0; // the app's renders of this scene in progress, seen through the hook
  let open = false; // a frame is drawn and laid over the app's pass
  let manual = false; // that frame was opened by begin()
  let hookUsers = 0; // attachments that asked for the hook
  let live = true;

  /**
   * Put the splats back on their own layers and take the composite away: after the app's render,
   * after `end()`, or after a render that threw before its end.
   *
   * @returns Nothing.
   */
  const settle = (): void => {
    renders = 0;
    manual = false;
    if (open) for (let i = 0; i < members.length; i += 1) members[i].layers.mask = memberMasks[i];
    open = false;
    composite.visible = false;
  };

  /**
   * Draw the depth pre-pass and the splats for this frame, and leave the splats on the pass's
   * layer for the app's pass.
   *
   * @param view The app's camera.
   * @param output The app's render target, or null for the canvas.
   * @returns Nothing.
   */
  const draw = (view: Camera, output: RenderTarget | null): void => {
    if (output !== null) size.set(output.width, output.height);
    else renderer.getDrawingBufferSize(size);
    const w = Math.max(1, size.x);
    const h = Math.max(1, size.y);
    if (w !== target.width || h !== target.height) target.setSize(w, h);
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clearColor);
    const shadows = renderer.shadowMap.enabled;
    const s = scene as Scene & { backgroundNode?: unknown };
    const background = s.background;
    const backgroundNode = s.backgroundNode;
    const override = s.overrideMaterial;
    const cameraMask = view.layers.mask;
    const objectFunction = objects.getRenderObjectFunction();
    // the pass's own renders call no scene hook: not the app's, not the pass again
    const before = hooks.onBeforeRender;
    const after = hooks.onAfterRender;
    hooks.onBeforeRender = quiet;
    hooks.onAfterRender = quiet;
    try {
      renderer.shadowMap.enabled = false;
      s.background = null;
      if (backgroundNode !== undefined) s.backgroundNode = null;
      renderer.setRenderTarget(target);
      // 1. the depth of what hides the splats in the app's pass, in one render: every opaque mesh
      // on the depth layer, nothing else on it, each drawn with its own material's depth material
      view.layers.set(DEPTH_LAYER);
      for (let k = 0; k < opaque.length; k += 1) {
        meshMasks[k] = opaque[k].layers.mask;
        opaque[k].layers.set(DEPTH_LAYER);
      }
      try {
        s.overrideMaterial = null;
        objects.setRenderObjectFunction(drawDepth);
        renderer.autoClear = true;
        renderer.render(scene, view);
      } finally {
        objects.setRenderObjectFunction(objectFunction);
        for (let k = 0; k < opaque.length; k += 1) opaque[k].layers.mask = meshMasks[k];
      }
      s.overrideMaterial = override;
      // 2. the splats alone, encoded to sRGB, tested against that depth; they stay on the pass's
      // layer until the app's render has ended
      for (let i = 0; i < members.length; i += 1) {
        memberMasks[i] = members[i].layers.mask;
        members[i].layers.set(SRGB_PASS_LAYER);
        members[i].srgbOutput.value = 1;
      }
      open = true;
      view.layers.set(SRGB_PASS_LAYER);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.autoClear = false;
      renderer.render(scene, view);
    } finally {
      hooks.onBeforeRender = before;
      hooks.onAfterRender = after;
      objects.setRenderObjectFunction(objectFunction);
      view.layers.mask = cameraMask;
      for (const m of members) m.srgbOutput.value = 0;
      s.overrideMaterial = override;
      s.background = background;
      if (backgroundNode !== undefined) s.backgroundNode = backgroundNode;
      renderer.shadowMap.enabled = shadows;
      renderer.autoClear = autoClear;
      renderer.setClearColor(clearColor, clearAlpha);
      renderer.setRenderTarget(previous);
    }
  };

  /**
   * Open a frame: find the splats and the opaque meshes, draw them, and place the composite.
   *
   * @param view The app's camera.
   * @param output The app's render target, or null for the canvas.
   */
  const start = (view: Camera, output: RenderTarget | null): void => {
    // A render that throws never reaches its end; renders are synchronous, so this runs after it
    // either way and puts things back if it did not end.
    queueMicrotask(() => {
      if (open || manual || renders > 0) settle();
    });
    members.length = 0;
    opaque.length = 0;
    camera = view;
    scene.traverseVisible(collect);
    camera = null;
    if (members.length === 0) {
      composite.visible = false;
      return;
    }
    draw(view, output);
    // sorted with the app's transparent objects as the nearest splat would be (a splat, not a
    // helper such as a mouth's composite, which has an order of its own among the splats)
    view.getWorldPosition(eye);
    let best = Infinity;
    let bestIsSplat = false;
    for (const m of members) {
      const splat = (m as { isGaussianSplat?: boolean }).isGaussianSplat === true;
      m.getWorldPosition(at);
      const d = at.distanceToSquared(eye);
      if ((splat && !bestIsSplat) || (splat === bestIsSplat && d < best)) {
        best = d;
        bestIsSplat = splat;
        composite.matrixWorld.makeTranslation(at);
        composite.renderOrder = m.renderOrder;
      }
    }
    composite.visible = true;
  };

  let before: SceneHook | null = null;
  let after: SceneHook | null = null;
  const ownBefore: SceneHook = function (r, sc, view, output) {
    before?.call(this, r, sc, view, output);
    if (!live || hookUsers === 0) return;
    renders += 1;
    if (renders > 1) {
      // a reflection or a shadow map inside the app's pass: no splats there
      composite.visible = false;
      return;
    }
    if (manual) return; // begin() drew this frame already
    start(view, output);
  };
  const ownAfter: SceneHook = function (r, sc, view, output) {
    after?.call(this, r, sc, view, output);
    if (!live || renders === 0) return;
    renders -= 1;
    if (renders > 0) {
      composite.visible = members.length > 0;
      return;
    }
    if (!manual) settle();
  };

  const state: Attached = {
    attachments: 0,
    composite,
    hook() {
      hookUsers += 1;
      if (before !== null) return;
      before = hooks.onBeforeRender;
      after = hooks.onAfterRender;
      hooks.onBeforeRender = ownBefore;
      hooks.onAfterRender = ownAfter;
    },
    unhook() {
      hookUsers -= 1;
    },
    begin(view) {
      if (!live) return;
      if (manual || open) settle(); // a frame never ended
      manual = true;
      start(view, renderer.getRenderTarget());
    },
    end() {
      if (manual) settle();
    },
    teardown() {
      if (!live) return;
      live = false;
      attached.delete(scene);
      settle();
      // an app that wrapped the hooks since keeps its wrappers; ours then only pass through
      if (before !== null && hooks.onBeforeRender === ownBefore) hooks.onBeforeRender = before;
      if (after !== null && hooks.onAfterRender === ownAfter) hooks.onAfterRender = after;
      composite.removeFromParent();
      composite.geometry.dispose();
      material.dispose();
      for (const m of sideDepth.values()) m.dispose();
      for (const own of [...ownDepth.values()]) own.release();
      target.depthTexture?.dispose();
      target.dispose();
    },
  };
  attached.set(scene, state);
  return state;
}
