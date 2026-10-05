/**
 * The inside of an exported character's mouth, drawn: the head pack's teeth, gums, tongue
 * and mouth bag as a lit mesh, and the teeth's own points (`teeth.ply`) as a small splat of
 * their own, seen through the opening between the lips (`mouth.ts` says why, and holds every
 * number).
 *
 * THE MASK IS A SMALL OFFSCREEN TEXTURE, with a soft rim. Each frame the mouth is open:
 *
 *   1. The window: its sides follow the lips' own edge points (their motion worked on the
 *      CPU from the same 383 coefficients the face plays, through their own bindings), so it
 *      never opens wider than the splat lips do. It shows only once they are clearly apart.
 *   2. Two small renders over the mouth's rectangle of the screen (a view offset of the
 *      camera, 64 px buckets): the MASK (red: 0 on an outer ring to 1 on an inner ring about
 *      10 px in at a 1024 view — the soft rim; green: the lips' line's depth, pushed 1.5 mm
 *      back, less the window's centre depth) and the INSIDE (the mesh, opaque and lit, and
 *      the teeth's points depth-tested against it — so the bag's points behind the tongue
 *      stay hidden).
 *   3. In the frame: the inside is laid over the window's outline at the mask's opacity
 *      (draw order 997, before the character's splat at 1000), and the face's own points
 *      behind the lips' line fade by the same mask (the splat fork's edit 15), so outside the
 *      window nothing changes, inside it the lips' front points still draw over the teeth,
 *      and between the two there is no line.
 *
 * HOW IT MOVES. The mesh and the teeth's points are made by two TSL compute passes
 * (`mouthNodes.ts`) from the head pass's expressed vertices, the buffer the face's bound splats
 * read (the lower teeth ride the jaw), then the body's head joint moves them like the face
 * around them.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  HalfFloatType,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  NoBlending,
  NormalBlending,
  PerspectiveCamera,
  RenderTarget,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  type StorageInstancedBufferAttribute,
  Vector2,
  Vector3,
  Vector4,
  type Camera,
  type Material,
  type Node,
  type Object3D,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  If,
  attribute,
  dot,
  float,
  max,
  modelViewMatrix,
  normalize,
  positionView,
  pow,
  screenUV,
  select,
  smoothstep,
  sRGBTransferOETF,
  storage,
  texture,
  uniform,
  varying,
  vec3,
  vec4,
  vertexIndex,
} from 'three/tsl';
import type { AosRigPack } from '../rig/gnm/gnmPack.js';
import type { SplatSink, SlotRange } from '../splatSink.js';
import { parseGaussianPly } from './format.js';
import {
  FEATHER_OF_VIEW,
  OPEN_FULL_M,
  OPEN_START_M,
  WALL_SOFT_M,
  WINDOW_PUSH_M,
  WINDOW_SIDE,
  buildLipEdges,
  buildMouthMesh,
  createVertexExpression,
  holdLips,
  screenRings,
  featherTriangles,
  lipEdgePoints,
  mouthShade,
  moveBoundPoints,
  openStrength,
  parseTeethBinding,
  restVertices,
  teethOffsets,
  windowCorners,
  windowPoints,
  type AosrigTeethFiles,
  type FaceSplats,
} from './mouth.js';
import { createMouthMeshNode, createTeethNode, type MouthHeadInput } from './mouthNodes.js';
import { packGaussianChunk } from './packFast.js';

export type { AosrigTeethFiles } from './mouth.js';

/** Draw order of the inside laid over the window; the character's own splat draws at 1000. */
export const MOUTH_RENDER_ORDER = { inside: 997 } as const;

/** What the host supplies for a character's mouth. */
export interface AosrigMouthOptions {
  /** A second splat sink for the teeth's points, with room for `teeth.json`'s count. */
  sink: SplatSink;
  /** Told when the mouth cannot be built; the character then draws without it. */
  onError?(error: unknown): void;
}

/** A character's mouth interior, while it draws. */
export interface AosrigMouth {
  /** The inside laid over the window; already under the character's splat object. */
  readonly object3D: Object3D;
  /** The teeth's splat sink (drawn into the inside's own small render). */
  readonly teeth: SplatSink;
  /** Sizes: the teeth's points, the mesh, the rim, the lips' edge points and what moving them reads. */
  readonly stats: {
    points: number;
    vertices: number;
    triangles: number;
    rim: number;
    edgePoints: number;
    edgeVertices: number;
    coefficients: number;
  };
  /** How far apart the lips' points were in the middle of the mouth on the last frame, metres. */
  readonly opening: number;
  /** How much of the inside showed on the last frame, 0..1. */
  readonly strength: number;
  /** Whether the inside was drawn on the last frame. */
  readonly open: boolean;
  /** The mouth's rectangle of the screen on the last open frame, drawing-buffer pixels. */
  readonly rect: { x: number; y: number; width: number; height: number };
  /** Draw the mouth interior at all. Off, the character draws exactly as one without it. */
  enabled: boolean;
  /** Turn the mesh or the teeth's points off (for comparisons); the mask stays. */
  layers: { mesh: boolean; teeth: boolean };
  /**
   * How far apart the lips' points must be in the middle of the mouth for the inside to show,
   * metres: nothing below `start`, all from `full`. The package's defaults are
   * `OPEN_START_M` and `OPEN_FULL_M`; a page may tune them.
   */
  thresholds: { start: number; full: number };
  /**
   * The outline on the last open frame, in the world: the outer ring (mask 0) and the inner
   * ring (mask 1), x y z per rim point.
   *
   * @returns Copies of both.
   */
  outline(): { outer: Float32Array; inner: Float32Array };
  /**
   * Follow this frame's face, head joint and camera. Allocation-free.
   *
   * @param controls The head's control vector (expression first).
   * @param skin The head joint's skin matrix, column-major 4x4, into the splat's frame.
   * @param camera The camera the frame is drawn with.
   * @returns Whether the inside is drawn this frame.
   */
  update(controls: ArrayLike<number>, skin: ArrayLike<number>, camera: Camera): boolean;
  /** Run the two passes (teeth, mesh) with `renderer.compute`, after the head pass. */
  dispatch(): void;
  /** The two small renders (mask, inside), after the dispatches were submitted. */
  drawOffscreen(): void;
  /** Free what the mouth owns and take its objects out of the scene. */
  dispose(): void;
}

/** The light: from the camera, a little above, warm white; plus a fill of each part's own colour. */
const LIGHT = { tiltDeg: 22, intensity: 0.95, color: [1, 0.97, 0.92] as const };
const FILL = 0.3;
/** How much each part shines (the pack's look has only colour and gloss). */
const SPECULAR: Record<string, number> = { teeth: 0.28, gums: 0.18, tongue: 0.15 };
const SPECULAR_DEFAULT = 0.05;
/** The mouth's rectangle is rounded up to this many pixels, so its targets rarely resize. */
const RECT_STEP = 64;
/** And kept this far clear of the outline. */
const RECT_MARGIN = 8;

/**
 * Build a character's mouth interior. Called by `createAosrigSplat` when the package
 * carries the teeth's files and the head pack its mouth.
 *
 * @param o The head pass's output, the renderer, the head pack, the teeth's files, the face's
 *   own points, the character's splat sink and the host's options.
 * @returns The running mouth.
 */
export function createAosrigMouth(o: {
  /** The head pass's output (its expressed vertices), which both passes read. */
  head: MouthHeadInput;
  /** True on the WebGL2 fallback. */
  webgl?: boolean;
  /** The renderer: runs the passes and the mask's and the inside's two small renders. */
  renderer: WebGPURenderer;
  /** Gives a storage attribute's buffers back (`@gameable/splat`'s `releaseStorageAttribute`). */
  releaseBuffer?(attribute: StorageInstancedBufferAttribute): void;
  pack: AosRigPack;
  /** The teeth's own points. */
  teeth: AosrigTeethFiles;
  plyShift: [number, number, number];
  face: FaceSplats;
  character: SplatSink;
  options: AosrigMouthOptions;
}): AosrigMouth {
  const { pack, teeth, character, options, renderer } = o;
  const head = o.head;
  const webgl = o.webgl === true;
  if (!pack.mouth) throw new Error('aosrig-splat: the head pack has no mouth');
  if (!character.setFragmentAlpha)
    throw new Error("aosrig-splat: the character's splat cannot fade its points");
  let range: SlotRange | undefined;
  const attributes: StorageInstancedBufferAttribute[] = [];
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const targets: RenderTarget[] = [];
  let composite: Mesh | undefined;
  let faceFaded = false;
  try {
    // ---- the data
    const mesh = buildMouthMesh(pack.mouth);
    const rest = restVertices(pack);
    const edges = buildLipEdges({ pack, mesh, rest, splats: o.face });
    const edgeExpression = createVertexExpression(pack, edges.verts);
    const binding = parseTeethBinding(teeth.binding, pack.vertexCount);
    if (binding.count !== teeth.info.points)
      throw new Error('aosrig-splat: teeth.json and teeth.bin disagree on the count');
    const ply = parseGaussianPly(teeth.ply, binding.count);
    const n = binding.count;
    const { records } = packGaussianChunk(
      ply,
      new Float32Array(n * 28),
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      0,
      n,
    );
    const centres = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) centres.set(records.subarray(i * 44, i * 44 + 3), i * 3);
    const fitted = teethOffsets(centres, binding, rest, o.plyShift);
    // The mesh sits where the points were fitted (`shift`): the studio's set-back plus the
    // millimetre between its registration of the head and the pack's. The set-back alone is taken
    // off again to find the lips' line.
    const shift = fitted.mean;
    const setBack = [binding.setBack[0], binding.setBack[1], binding.setBack[2]];

    // ---- the teeth's points: 24 lanes each (tri, bary + height, offset, covariance, colour)
    const points = new Float32Array(n * 24);
    const pointsU = new Uint32Array(points.buffer);
    for (let i = 0; i < n; i++) {
      const o24 = i * 24,
        o44 = i * 44;
      pointsU.set(binding.tri.subarray(i * 3, i * 3 + 3), o24);
      points.set(binding.bary.subarray(i * 3, i * 3 + 3), o24 + 4);
      points[o24 + 7] = binding.height[i];
      points.set(fitted.offsets.subarray(i * 3, i * 3 + 3), o24 + 8);
      points.set(records.subarray(o44 + 4, o44 + 12), o24 + 12);
      points.set(records.subarray(o44 + 12, o44 + 16), o24 + 20);
    }
    const teethSink = options.sink;
    if (teethSink.capacity < n) throw new Error('aosrig-splat: the teeth sink is too small');
    range = teethSink.allocate(n);
    let cx = 0,
      cy = 0,
      cz = 0;
    for (let i = 0; i < n; i++) {
      cx += centres[i * 3];
      cy += centres[i * 3 + 1];
      cz += centres[i * 3 + 2];
    }
    // The head moves within the character's frame as it animates; half a metre covers it
    // and still gives the sort a quarter-millimetre per depth bin.
    teethSink.setBoundingSphere([cx / n, cy / n, cz / n], 0.5);
    if (!teethSink.nodes || teethSink.storageCapacity === undefined)
      throw new Error('aosrig-splat: the teeth sink has no storage nodes');
    const teethNode = createTeethNode({
      points,
      count: n,
      offset: range.offset,
      head,
      outputs: teethSink.nodes,
      storageCapacity: teethSink.storageCapacity,
      webgl,
    });
    attributes.push(...teethNode.attributes);
    // The teeth splat is depth-tested against the mesh in the inside's render.
    const teethMaterial = (teethSink.object3D as Partial<Mesh>).material as Material | undefined;
    if (teethMaterial) {
      teethMaterial.depthTest = true;
      teethMaterial.depthWrite = false;
    }
    // An sRGB teeth splat (fork edit 20) draws only while its `srgbOutput` is 1, and leaves the
    // vertex stage encoded to sRGB. The inside's render is not the sRGB pass, so it turns the teeth
    // on itself, and the mesh is encoded too: the inside's target then holds sRGB values
    // throughout, the teeth blended over the mesh on them as the studio does.
    const teethSrgbOutput =
      (teethSink.object3D as { srgbOutput?: { value: number } | null }).srgbOutput ?? null;

    // ---- the mesh: its vertices on the GPU, two vec4 each
    const nv = mesh.ids.length;
    const shade = mouthShade(mesh, rest);
    const meshNode = createMouthMeshNode({
      ids: mesh.ids,
      shade,
      adjStart: mesh.adjStart,
      adjTris: mesh.adjTris,
      shift,
      head,
      webgl,
    });
    attributes.push(...meshNode.attributes);

    // ---- the inside's render: the mesh (opaque, lit from the camera) and the teeth's points
    const read = storage(meshNode.output, 'vec4', meshNode.capacity).toReadOnly();
    if (webgl) read.setPBO(true);
    const atVertex = read.element(vertexIndex.mul(2));
    const normalView = varying(
      modelViewMatrix.mul(vec4(read.element(vertexIndex.mul(2).add(1)).xyz, 0)).xyz,
    );
    const shadeV = varying(atVertex.w);
    const tilt = (LIGHT.tiltDeg * Math.PI) / 180;
    const lightDir = vec3(0, Math.sin(tilt), Math.cos(tilt));
    const lightRgb = vec3(
      LIGHT.color[0] * LIGHT.intensity,
      LIGHT.color[1] * LIGHT.intensity,
      LIGHT.color[2] * LIGHT.intensity,
    );
    const partMaterials = mesh.groups.map((g) => {
      const c = new Color().setRGB(g.color[0], g.color[1], g.color[2], SRGBColorSpace);
      const specular = SPECULAR[g.name] ?? SPECULAR_DEFAULT;
      // The studio's gloss 0..1 as a Blinn exponent (2^(11 g)).
      const shininess = Math.pow(2, 11 * g.gloss);
      const m = new MeshBasicNodeMaterial();
      m.name = `aosrig-mouth ${g.name}`;
      m.positionNode = atVertex.xyz;
      const n0 = normalize(normalView);
      const view = normalize(positionView.negate());
      // Lit from whichever side is seen: the bag and tongue are seen from inside and behind.
      const nf = select(dot(n0, view).lessThan(0), n0.negate(), n0);
      const diffuse = max(dot(nf, lightDir), 0);
      const spec = pow(max(dot(nf, normalize(lightDir.add(view))), 0), float(shininess)).mul(
        specular,
      );
      const rgb = vec3(c.r, c.g, c.b)
        .mul(shadeV)
        .mul(lightRgb.mul(diffuse).add(FILL))
        .add(lightRgb.mul(spec).mul(shadeV));
      m.colorNode = vec4(
        teethSrgbOutput ? (sRGBTransferOETF(max(rgb, 0)) as unknown as Node<'vec3'>) : rgb,
        1,
      );
      m.side = DoubleSide;
      m.fog = false;
      m.depthTest = true;
      m.depthWrite = true;
      materials.push(m);
      return m;
    });
    const meshGeometry = new BufferGeometry();
    geometries.push(meshGeometry);
    const restPos = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++)
      for (let c = 0; c < 3; c++) restPos[i * 3 + c] = rest[mesh.ids[i] * 3 + c] + shift[c];
    meshGeometry.setAttribute('position', new BufferAttribute(restPos, 3));
    meshGeometry.setIndex(new BufferAttribute(mesh.tris, 1));
    for (let k = 0; k < mesh.groups.length; k++)
      meshGeometry.addGroup(
        mesh.partStart[k] * 3,
        (mesh.partStart[k + 1] - mesh.partStart[k]) * 3,
        k,
      );
    const meshObject = new Mesh(meshGeometry, partMaterials);
    meshObject.name = 'aosrig-mouth mesh';
    meshObject.frustumCulled = false;
    const insideScene = new Scene();
    insideScene.name = 'aosrig-mouth inside';
    const insideRoot = new Group();
    insideRoot.matrixAutoUpdate = false;
    insideRoot.add(meshObject);
    insideRoot.add(teethSink.object3D);
    insideScene.add(insideRoot);

    // ---- the window's geometry: outer ring (mask 0), inner ring (mask 1), centre
    const nr = mesh.rim.length;
    const ringVerts = 2 * nr + 1;
    const ringPositions = new BufferAttribute(new Float32Array(ringVerts * 3), 3);
    ringPositions.setUsage(DynamicDrawUsage);
    const ringDepth = new BufferAttribute(new Float32Array(ringVerts), 1);
    ringDepth.setUsage(DynamicDrawUsage);
    const ringAlpha = new BufferAttribute(new Float32Array(ringVerts), 1);
    ringAlpha.setUsage(DynamicDrawUsage);
    const innerValue = (ringAlpha.array as Float32Array).subarray(nr, 2 * nr);
    const ringGeometry = new BufferGeometry();
    geometries.push(ringGeometry);
    ringGeometry.setAttribute('position', ringPositions);
    ringGeometry.setAttribute('maskAlpha', ringAlpha);
    ringGeometry.setAttribute('wallDepth', ringDepth);
    const restT = new Float64Array(nr);
    for (let k = 0; k < nr; k++)
      restT[k] =
        edges.base[k * 3] * edges.across[0] +
        edges.base[k * 3 + 1] * edges.across[1] +
        edges.base[k * 3 + 2] * edges.across[2];
    ringGeometry.setIndex(new BufferAttribute(featherTriangles(edges.lip, restT), 1));

    // the mask: red the soft rim (times how open the lips are), green the lips' line's depth
    const strengthU = uniform(0);
    const maskMaterial = new MeshBasicNodeMaterial();
    materials.push(maskMaterial);
    maskMaterial.name = 'aosrig-mouth mask';
    maskMaterial.colorNode = vec4(
      attribute('maskAlpha', 'float').mul(strengthU),
      attribute('wallDepth', 'float'),
      0,
      1,
    );
    maskMaterial.blending = NoBlending;
    maskMaterial.depthTest = false;
    maskMaterial.depthWrite = false;
    maskMaterial.side = DoubleSide;
    maskMaterial.fog = false;
    const maskObject = new Mesh(ringGeometry, maskMaterial);
    maskObject.name = 'aosrig-mouth mask';
    maskObject.frustumCulled = false;
    const maskScene = new Scene();
    maskScene.name = 'aosrig-mouth mask';
    const maskRoot = new Group();
    maskRoot.matrixAutoUpdate = false;
    maskRoot.add(maskObject);
    maskScene.add(maskRoot);

    const makeTarget = (depth: boolean): RenderTarget => {
      const t = new RenderTarget(RECT_STEP, RECT_STEP, {
        type: HalfFloatType,
        format: RGBAFormat,
        depthBuffer: depth,
        generateMipmaps: false,
      });
      targets.push(t);
      return t;
    };
    const maskTarget = makeTarget(false);
    const insideTarget = makeTarget(true);
    // the mouth's rectangle in screen uv (x, y from the top, width, height)
    const rectU = uniform(new Vector4(0, 0, 1, 1));
    const refU = uniform(0);
    const activeU = uniform(0);
    const rectUv = screenUV.sub(rectU.xy).div(rectU.zw);

    // laid over the window in the frame: the inside at the mask's opacity
    const compositeMaterial = new MeshBasicNodeMaterial();
    materials.push(compositeMaterial);
    compositeMaterial.name = 'aosrig-mouth inside';
    const insideTexel = texture(insideTarget.texture, rectUv);
    const maskTexel = texture(maskTarget.texture, rectUv);
    // Beside an sRGB character, whose splat only the sRGB pass (gameable/core's attachSrgbPass)
    // draws, the inside is drawn there too, as sRGB values as the splats are: `srgbOutput` is 1
    // while the pass draws it and 0 (nothing drawn) otherwise. Beside a linear one it stays in the
    // app's pass, as it is.
    const srgbSplats: object[] = [];
    character.object3D.traverse((node) => {
      if ((node as { srgbOutput?: unknown }).srgbOutput != null) srgbSplats.push(node);
    });
    const srgbOutput = srgbSplats.length > 0 ? uniform(0) : null;
    const insideAlpha = smoothstep(0, 1, maskTexel.r).mul(insideTexel.a);
    // The inside's target is already sRGB when the teeth are (see teethSrgbOutput); a linear
    // inside beside an sRGB character is encoded here.
    const insideRgb = (srgbOutput && !teethSrgbOutput
      ? sRGBTransferOETF(max(insideTexel.rgb, 0))
      : insideTexel.rgb) as unknown as Node<'vec3'>;
    compositeMaterial.colorNode = srgbOutput
      ? vec4(insideRgb, insideAlpha.mul(srgbOutput))
      : vec4(insideTexel.rgb, insideAlpha);
    compositeMaterial.transparent = true;
    compositeMaterial.blending = NormalBlending;
    compositeMaterial.depthTest = true;
    compositeMaterial.depthWrite = false;
    compositeMaterial.side = DoubleSide;
    compositeMaterial.fog = false;
    const compositeMesh = new Mesh(ringGeometry, compositeMaterial);
    if (srgbOutput) Object.assign(compositeMesh, { srgbOutput });
    composite = compositeMesh;
    compositeMesh.name = 'aosrig-mouth inside';
    compositeMesh.renderOrder = MOUTH_RENDER_ORDER.inside;
    compositeMesh.frustumCulled = false;
    compositeMesh.visible = false;
    character.object3D.add(compositeMesh);

    // the face's points behind the lips' line fade by the mask where the inside shows
    const faceMask = texture(maskTarget.texture);
    character.setFragmentAlpha((view: Node) =>
      Fn(() => {
        const factor = float(1).toVar();
        const uv = rectUv.toVar();
        If(
          activeU
            .greaterThan(0.5)
            .and(uv.x.greaterThan(0))
            .and(uv.x.lessThan(1))
            .and(uv.y.greaterThan(0))
            .and(uv.y.lessThan(1)),
          () => {
            const s = faceMask.sample(uv).level(float(0)).toVar();
            const depth = (view as unknown as ReturnType<typeof vec3>).z.negate();
            // behind the lips' line by up to WALL_SOFT_M, a point fades by part of the mask
            const behind = smoothstep(0, WALL_SOFT_M, depth.sub(refU).sub(s.g));
            factor.assign(float(1).sub(smoothstep(0, 1, s.r).mul(behind)));
          },
        );
        return factor;
      })(),
    );
    faceFaded = true;

    // ---- per frame, on the CPU: the window from the lips' edge points
    const cornerIds = [...edges.lip.keys()].filter((k) => edges.lip[k] === 2);
    const corners: [number, number] =
      cornerIds.length === 2 ? [cornerIds[0], cornerIds[1]] : windowCorners(edges.base);
    const windowLip = edges.lip;
    const vpos = new Float32Array(edges.verts.length * 3);
    const movedPts = new Float64Array(edges.blend.length * 3);
    const stationPts = new Float64Array(nr * 3);
    const scratch = new Float64Array(nr * 7);
    const win = new Float32Array((nr + 1) * 3);
    const bound = new Float32Array(nr * 3),
      middle = new Float32Array(nr * 3);
    const boundPx = new Float32Array(nr * 2),
      middlePx = new Float32Array(nr * 2);
    const boundClip = new Float32Array(nr * 4);
    const outerPx = new Float32Array(nr * 2),
      innerPx = new Float32Array(nr * 2);
    const local = new Float32Array(ringVerts * 3);
    const clip = new Vector4(),
      toLocal = new Matrix4(),
      fromClip = new Matrix4();
    const worldOuter = new Float32Array(nr * 3),
      worldInner = new Float32Array(nr * 3);
    const lastControls = new Float32Array(pack.coeffCount).fill(Number.NaN);
    const toWorld = new Matrix4(),
      toView = new Matrix4(),
      viewProj = new Matrix4();
    const v3 = new Vector3(),
      size = new Vector2(),
      savedColor = new Color();
    const subCamera = new PerspectiveCamera();
    const rect = { x: 0, y: 0, width: 0, height: 0 };
    let opening = 0;
    let strength = 0;
    let open = false;
    let disposed = false;

    const mouth: AosrigMouth = {
      object3D: compositeMesh,
      teeth: teethSink,
      stats: {
        points: n,
        vertices: nv,
        triangles: mesh.tris.length / 3,
        rim: nr,
        edgePoints: edges.blend.length,
        edgeVertices: edges.verts.length,
        coefficients: edgeExpression.coefficients,
      },
      get opening() {
        return opening;
      },
      get strength() {
        return strength;
      },
      get open() {
        return open;
      },
      rect,
      enabled: true,
      layers: { mesh: true, teeth: true },
      thresholds: { start: OPEN_START_M, full: OPEN_FULL_M },
      outline() {
        return { outer: worldOuter.slice(), inner: worldInner.slice() };
      },
      update(controls, skin, camera) {
        if (disposed) return false;
        let moved = false;
        for (let e = 0; e < lastControls.length; e++) {
          const c = e < controls.length ? controls[e] : 0;
          if (c !== lastControls[e]) {
            lastControls[e] = c;
            moved = true;
          }
        }
        if (moved) {
          edgeExpression.evaluate(controls, vpos);
          moveBoundPoints(edges, vpos, movedPts);
          opening = lipEdgePoints(edges, movedPts, stationPts, scratch);
        }
        strength = openStrength(opening, mouth.thresholds.start, mouth.thresholds.full);
        activeU.value = 0;
        compositeMesh.visible = false;
        const cam = camera as PerspectiveCamera;
        open = mouth.enabled && strength > 0 && cam.isPerspectiveCamera;
        if (!open) return false;
        // the window where the splat lips are (the mesh's shift: set back to meet them),
        // each lip held on its side of the middle line
        windowPoints(stationPts, win, null, corners, WINDOW_SIDE, 0);
        for (let j = 0; j < win.length; j += 3) {
          win[j] += shift[0];
          win[j + 1] += shift[1];
          win[j + 2] += shift[2];
        }
        holdLips(win, windowLip, edges.across, edges.up, bound, middle);
        const splatObject = character.object3D;
        splatObject.updateWorldMatrix(true, false);
        toWorld.copy(splatObject.matrixWorld);
        toLocal.copy(toWorld).invert();
        const scale = Math.cbrt(Math.abs(toWorld.determinant())) || 1;
        cam.updateMatrixWorld();
        renderer.getDrawingBufferSize(size);
        toView.multiplyMatrices(cam.matrixWorldInverse, toWorld);
        viewProj.multiplyMatrices(cam.projectionMatrix, toView);
        fromClip.copy(viewProj).invert();
        // on the screen: the held points and their middle-line points, in pixels
        const project = (
          src: Float32Array,
          k: number,
          px: Float32Array,
          keepClip: boolean,
        ): boolean => {
          const x = src[k * 3],
            y = src[k * 3 + 1],
            z = src[k * 3 + 2];
          clip
            .set(
              skin[0] * x + skin[4] * y + skin[8] * z + skin[12],
              skin[1] * x + skin[5] * y + skin[9] * z + skin[13],
              skin[2] * x + skin[6] * y + skin[10] * z + skin[14],
              1,
            )
            .applyMatrix4(viewProj);
          if (!(clip.w > 1e-6)) return false;
          px[k * 2] = ((clip.x / clip.w + 1) / 2) * size.x;
          px[k * 2 + 1] = ((1 - clip.y / clip.w) / 2) * size.y;
          if (keepClip) boundClip.set([clip.x, clip.y, clip.z, clip.w], k * 4);
          return true;
        };
        let visible = true;
        for (let k = 0; k < nr; k++) {
          visible =
            project(bound, k, boundPx, true) && project(middle, k, middlePx, false) && visible;
        }
        if (!visible) {
          open = false;
          return false;
        }
        // the soft rim: a fraction of the view's height, in pixels, from every side
        screenRings(
          boundPx,
          middlePx,
          windowLip,
          FEATHER_OF_VIEW * size.y,
          outerPx,
          innerPx,
          innerValue,
        );
        ringAlpha.needsUpdate = true;
        // back into the splat's frame, each ring point at its window point's depth
        const unproject = (px: Float32Array, k: number, at: number): void => {
          const w = boundClip[k * 4 + 3];
          clip
            .set(
              ((px[k * 2] / size.x) * 2 - 1) * w,
              (1 - (px[k * 2 + 1] / size.y) * 2) * w,
              boundClip[k * 4 + 2],
              w,
            )
            .applyMatrix4(fromClip);
          v3.set(clip.x / clip.w, clip.y / clip.w, clip.z / clip.w);
          local[at] = v3.x;
          local[at + 1] = v3.y;
          local[at + 2] = v3.z;
        };
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (let k = 0; k < nr; k++) {
          unproject(outerPx, k, k * 3);
          unproject(innerPx, k, (nr + k) * 3);
          x0 = Math.min(x0, outerPx[k * 2]);
          x1 = Math.max(x1, outerPx[k * 2]);
          y0 = Math.min(y0, outerPx[k * 2 + 1]);
          y1 = Math.max(y1, outerPx[k * 2 + 1]);
        }
        (ringPositions.array as Float32Array).set(local);
        ringPositions.needsUpdate = true;
        // the depths: the lips' line (the set-back undone) pushed back, less the window
        // centre's, in the view
        const [sbx, sby, sbz] = setBack;
        const viewDepthOf = (x: number, y: number, z: number): number =>
          -v3
            .set(
              skin[0] * x + skin[4] * y + skin[8] * z + skin[12],
              skin[1] * x + skin[5] * y + skin[9] * z + skin[13],
              skin[2] * x + skin[6] * y + skin[10] * z + skin[14],
            )
            .applyMatrix4(toView).z;
        const ref = viewDepthOf(win[nr * 3], win[nr * 3 + 1], win[nr * 3 + 2]);
        const depths = ringDepth.array as Float32Array;
        for (let k = 0; k < nr; k++) {
          const d =
            viewDepthOf(bound[k * 3] - sbx, bound[k * 3 + 1] - sby, bound[k * 3 + 2] - sbz) +
            WINDOW_PUSH_M * scale -
            ref;
          depths[k] = d;
          depths[nr + k] = d;
        }
        depths[2 * nr] =
          viewDepthOf(win[nr * 3] - sbx, win[nr * 3 + 1] - sby, win[nr * 3 + 2] - sbz) +
          WINDOW_PUSH_M * scale -
          ref;
        ringDepth.needsUpdate = true;
        refU.value = ref;
        for (let k = 0; k < nr; k++) {
          const i = k * 3,
            j = (nr + k) * 3;
          v3.set(local[i], local[i + 1], local[i + 2]).applyMatrix4(toWorld);
          worldOuter[i] = v3.x;
          worldOuter[i + 1] = v3.y;
          worldOuter[i + 2] = v3.z;
          v3.set(local[j], local[j + 1], local[j + 2]).applyMatrix4(toWorld);
          worldInner[i] = v3.x;
          worldInner[i + 1] = v3.y;
          worldInner[i + 2] = v3.z;
        }
        if (!(x1 > 0 && y1 > 0 && x0 < size.x && y0 < size.y)) {
          open = false;
          return false;
        }
        const w = Math.min(size.x, Math.ceil((x1 - x0 + 2 * RECT_MARGIN) / RECT_STEP) * RECT_STEP);
        const h = Math.min(size.y, Math.ceil((y1 - y0 + 2 * RECT_MARGIN) / RECT_STEP) * RECT_STEP);
        const x = Math.max(0, Math.min(size.x - w, Math.round((x0 + x1) / 2 - w / 2)));
        const y = Math.max(0, Math.min(size.y - h, Math.round((y0 + y1) / 2 - h / 2)));
        rect.x = x;
        rect.y = y;
        rect.width = w;
        rect.height = h;
        rectU.value.set(x / size.x, y / size.y, w / size.x, h / size.y);
        if (maskTarget.width !== w || maskTarget.height !== h) {
          maskTarget.setSize(w, h);
          insideTarget.setSize(w, h);
        }
        subCamera.copy(cam, false);
        cam.matrixWorld.decompose(subCamera.position, subCamera.quaternion, subCamera.scale);
        subCamera.setViewOffset(size.x, size.y, x, y, w, h);
        subCamera.updateMatrixWorld(true);
        strengthU.value = strength;
        maskRoot.matrix.copy(toWorld);
        maskRoot.matrixWorldNeedsUpdate = true;
        insideRoot.matrix.copy(toWorld);
        insideRoot.matrixWorldNeedsUpdate = true;
        meshObject.visible = mouth.layers.mesh;
        teethSink.object3D.visible = mouth.layers.teeth;
        teethNode.setSkin(skin);
        meshNode.setSkin(skin);
        return true;
      },
      dispatch() {
        if (disposed || !open) return;
        const nodes = [];
        if (mouth.layers.teeth) nodes.push(teethNode.compute);
        if (mouth.layers.mesh) nodes.push(meshNode.compute);
        if (nodes.length > 0) void renderer.compute(nodes);
      },
      drawOffscreen() {
        if (disposed || !open) return;
        const previous = renderer.getRenderTarget();
        renderer.getClearColor(savedColor);
        const savedAlpha = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(maskTarget);
        renderer.render(maskScene, subCamera);
        renderer.setRenderTarget(insideTarget);
        if (teethSrgbOutput) teethSrgbOutput.value = 1;
        try {
          renderer.render(insideScene, subCamera);
        } finally {
          if (teethSrgbOutput) teethSrgbOutput.value = 0;
        }
        renderer.setRenderTarget(previous);
        renderer.setClearColor(savedColor, savedAlpha);
        activeU.value = 1;
        compositeMesh.visible = true;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        release();
      },
    };
    return mouth;
  } catch (error) {
    release();
    throw error;
  }

  function release(): void {
    if (faceFaded) character.setFragmentAlpha?.(null);
    composite?.removeFromParent();
    options.sink.object3D.removeFromParent();
    for (const g of geometries) g.dispose();
    geometries.length = 0;
    for (const m of materials) m.dispose();
    materials.length = 0;
    for (const t of targets) t.dispose();
    targets.length = 0;
    for (const attribute of attributes) o.releaseBuffer?.(attribute);
    attributes.length = 0;
    if (range) options.sink.free(range);
    range = undefined;
  }
}
