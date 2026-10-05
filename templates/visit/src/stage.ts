/**
 * Where the character lives: the owner's place, or the white world.
 *
 * A place is three files from the studio: the splat (what you see), the
 * collision mesh (what you walk on and bump into) and the panorama (drawn
 * behind the splat, so the edges of the world are never a void). It stands
 * exactly where the owner put it in the studio (`placeTransform`). The splat
 * goes through the engine's own splat module; nothing here draws a gaussian.
 *
 * Without a place: an infinite white world, with nothing there until something
 * is built in it. White all round, fog to white, a soft
 * even light, no floor, no horizon, no walls; the character bridge's own
 * shadows, at the contact level (main.ts), draw a see-through ground that shows
 * only a soft pool under each foot, so it stands on the white without an edge
 * or a cast shape ever showing.
 */
import type { Engine } from 'gameable/core';
import { loadJolt, meshShapeFromGeometry, type PhysicsService } from 'gameable/physics';
import { SPLAT_RENDER_ORDER, type SplatAsset } from 'gameable/splat';
import joltWasmUrl from 'jolt-physics/jolt-physics.wasm.wasm?url';
import {
  Color,
  EquirectangularReflectionMapping,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  Plane,
  Quaternion,
  Raycaster,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  type Camera,
  type Object3D,
} from 'three/webgpu';
import { placeTransform, type VisitSetting } from './visit';

/** Body ids for the world's own collision; the game mints its bodies from 1 up. */
const PLACE_BODY = 1_000_000;
/** `staticGeometry` is bit 1 of the WIT collision layers. */
const STATIC = 1 << 1;

/** What the rest of the page needs from the stage. */
export interface Stage {
  /** The floor point under a screen position (-1..1 both ways), or null. */
  pick(ndcX: number, ndcY: number, camera: Camera): Vector3 | null;
  /**
   * The room the camera must stay in, in stage metres: `[minX, maxX, minZ, maxZ, top]`,
   * from where most of the place's splats are (a few far-off specks do not count). Null in
   * the white world, which has no walls.
   */
  room: [number, number, number, number, number] | null;
}

/**
 * Where most of a place is: the 3rd and 97th percentile of its splat centres along x and
 * z, and the 97th up, after the place's transform. A sample of 20,000 is plenty.
 */
function roomOf(positions: ArrayLike<number>, count: number, splat: Object3D): Stage['room'] {
  const step = Math.max(1, Math.floor(count / 20000));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const v = new Vector3();
  for (let i = 0; i < count; i += step) {
    v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(
      splat.matrixWorld,
    );
    xs.push(v.x);
    ys.push(v.y);
    zs.push(v.z);
  }
  const at = (list: number[], q: number): number => {
    list.sort((a, b) => a - b);
    return list[Math.min(list.length - 1, Math.floor(q * list.length))] ?? 0;
  };
  return [at(xs, 0.03), at(xs, 0.97), at(zs, 0.03), at(zs, 0.97), at(ys, 0.97)];
}

/**
 * A floor picker shared by both stages. A tap on the character (who stands at the
 * origin) answers the origin, so the game can walk the visitor up to her.
 */
function floorPicker(meshes: Object3D[]): Stage['pick'] {
  const ray = new Raycaster();
  const floor = new Plane(new Vector3(0, 1, 0), 0);
  const at = new Vector2();
  return (ndcX, ndcY, camera) => {
    at.set(ndcX, ndcY);
    ray.setFromCamera(at, camera);
    const { origin: o, direction: d } = ray.ray;
    const flat = d.x * d.x + d.z * d.z;
    const t = flat > 1e-6 ? -(o.x * d.x + o.z * d.z) / flat : -1;
    if (t > 0 && Math.hypot(o.x + t * d.x, o.z + t * d.z) < 0.45) {
      const y = o.y + t * d.y;
      if (y > 0 && y < 2.2) return new Vector3(0, 0, 0);
    }
    for (const hit of ray.intersectObjects(meshes, true)) {
      // Floors only: a surface facing up. A wall or a table edge is not somewhere to walk to.
      const n = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld);
      if (n && n.y > 0.7) return hit.point;
    }
    return ray.ray.intersectPlane(floor, new Vector3());
  };
}

/** The white world's one colour: the sky, the fog and the page behind the canvas. */
export const WHITE = 0xffffff;

/**
 * The white world: nothing there but the character (no place was published with it).
 *
 * Nothing is drawn here but the light. The sky is white, the fog turns anything far off to
 * white, and one soft even light. The see-through ground that shows the character's contact
 * shadow is the character bridge's (its `shadows`, set to the contact level by main.ts), so
 * there is no floor, no horizon and no wall to see; a tap on the floor still lands on y = 0.
 *
 * @param engine The engine.
 * @returns The stage.
 */
export function whiteWorld(engine: Engine): Stage {
  engine.scene.background = new Color(WHITE);
  engine.scene.fog = new Fog(WHITE, 8, 40);
  engine.renderer.setClearColor(WHITE, 1);
  document.documentElement.classList.add('white-world');
  engine.scene.add(new HemisphereLight(0xffffff, 0xf4f4f4, 1));
  return { pick: floorPicker([]), room: null };
}

/**
 * The owner's place.
 *
 * @param engine The engine; its manifest has the splat as `place`.
 * @param setting The place's files and where it stands.
 * @param physics The physics service, when visitors walk (hangout).
 * @returns The stage, once the splat is drawing.
 */
export async function placeStage(
  engine: Engine,
  setting: VisitSetting,
  physics: PhysicsService | null,
): Promise<Stage> {
  const t = placeTransform(setting);
  const quaternion = new Quaternion(...t.quaternion);
  engine.scene.background = new Color(
    getComputedStyle(document.documentElement).getPropertyValue('--canvas'),
  );

  // The panorama first: it is the whole room at a glance while the splat streams.
  if (setting.pano) {
    void new TextureLoader()
      .loadAsync(setting.pano)
      .then((texture) => {
        texture.mapping = EquirectangularReflectionMapping;
        texture.colorSpace = SRGBColorSpace;
        engine.scene.background = texture;
        // The panorama is lined up with the file's axes; turn it with the place.
        engine.scene.backgroundRotation.y = (setting.placement.turn * Math.PI) / 180;
      })
      .catch(() => undefined);
  }

  const colliders: Object3D[] = [];
  // The collision mesh only matters to walkers (hangout): nobody else downloads it.
  const collide = (async () => {
    if (!setting.collider || !physics) return;
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(setting.collider);
    const holder = new Group();
    holder.position.set(...t.position);
    holder.quaternion.copy(quaternion);
    holder.scale.setScalar(t.scale);
    holder.add(gltf.scene);
    holder.visible = false;
    engine.scene.add(holder);
    holder.updateMatrixWorld(true);
    colliders.push(holder);
    // One static body from every triangle, already in stage metres.
    const positions: number[] = [];
    const indices: number[] = [];
    const v = new Vector3();
    gltf.scene.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute('position');
      const base = positions.length / 3;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        positions.push(v.x, v.y, v.z);
      }
      const index = mesh.geometry.getIndex();
      const count = index ? index.count : pos.count;
      for (let i = 0; i < count; i++) indices.push(base + (index ? index.getX(i) : i));
    });
    const jolt = await loadJolt({ wasmUrl: joltWasmUrl });
    const shape = meshShapeFromGeometry(
      jolt,
      new Float32Array(positions),
      new Uint32Array(indices),
    );
    physics.addBody({
      id: PLACE_BODY,
      shape: 'mesh',
      dims: [],
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      mass: 0,
      kind: 'static',
      layer: STATIC,
      mask: 0xffff,
      friction: 0.8,
      restitution: 0,
      geometry: shape,
    });
    shape.Release();
  })();

  const asset = (await engine.assets.load('place')) as SplatAsset;
  // The place draws before the character (splats do not sort across objects), in its own
  // colours: a studio place is sRGB, as the studio shows it.
  const splat = engine.get('splat').add('place', {
    renderOrder: SPLAT_RENDER_ORDER - 1,
    colorSpace: setting.colorSpace,
  });
  splat.position.set(...t.position);
  splat.quaternion.copy(quaternion);
  splat.scale.setScalar(t.scale);
  splat.updateMatrixWorld(true);
  const centres = asset.geometry.getAttribute('position');
  const room = roomOf(centres.array, centres.count, splat);
  await collide.catch(() => undefined);
  // No collision mesh: walkers still get a floor.
  if (physics && colliders.length === 0) floorBody(physics);
  return { pick: floorPicker(colliders), room };
}

/**
 * A plain floor for walking when the place has no collision mesh, or there is no place.
 *
 * @param physics The physics service.
 * @returns Nothing.
 */
export function floorBody(physics: PhysicsService): void {
  physics.addBody({
    id: PLACE_BODY + 1,
    shape: 'box',
    dims: [30, 0.5, 30],
    position: [0, -0.5, 0],
    rotation: [0, 0, 0, 1],
    mass: 0,
    kind: 'static',
    layer: STATIC,
    mask: 0xffff,
    friction: 0.8,
    restitution: 0,
  });
}
