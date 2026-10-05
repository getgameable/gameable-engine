import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Timer,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadGameableCharacter, type GameableCharacter } from 'gameable/three';

// A published character's character.json: ?character=<its URL>.
const CHARACTER_URL = new URLSearchParams(location.search).get('character');

const status = document.getElementById('status')!;
const ui = document.getElementById('ui')!;

// The app's own renderer, scene, camera and lights.
const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new Scene();
scene.background = new Color(0x20232a);
const camera = new PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.4, 4.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.95, 0);
controls.update();

const floor = new Mesh(
  new PlaneGeometry(12, 12),
  new MeshStandardNodeMaterial({ color: 0x5b6470, roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
scene.add(new HemisphereLight(0xffffff, 0x404040, 1.2));
const sun = new DirectionalLight(0xffffff, 2);
sun.position.set(3, 5, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// The scene draws from the start; the character joins it when it has loaded.
let character: GameableCharacter | null = null;
const timer = new Timer();
void renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = timer.getDelta();
  controls.update();
  character?.update(dt, camera);
  renderer.render(scene, camera);
});

// The character.
try {
  if (CHARACTER_URL === null)
    throw new Error("Add ?character=<a character.json URL> to this page's address.");
  const loaded = await loadGameableCharacter(renderer, CHARACTER_URL, {
    castShadow: true,
    onProgress: (bytes, total) => {
      const mb = (n: number): string => (n / 1e6).toFixed(1);
      status.textContent = `Loading… ${mb(bytes)} of ${mb(total)} MB`;
    },
  });
  scene.add(loaded.object3D);
  character = loaded;
  loaded.lookAt(camera);
  status.textContent = `${loaded.clips.length} clips`;
  for (const name of ['idle', 'walk', 'run', 'wave'].filter((n) => loaded.clips.includes(n))) {
    const button = document.createElement('button');
    button.textContent = name;
    button.onclick = () => loaded.play(name);
    ui.appendChild(button);
  }
  const more = document.createElement('select');
  more.append(new Option('more clips…', ''), ...loaded.clips.map((n) => new Option(n, n)));
  more.onchange = () => {
    if (more.value) loaded.play(more.value);
  };
  ui.appendChild(more);
  const smile = document.createElement('button');
  smile.textContent = 'smile';
  smile.onclick = () =>
    loaded.setExpression('arkit52', { mouthSmileLeft: 0.8, mouthSmileRight: 0.8 });
  ui.appendChild(smile);
  let looking = true;
  const look = document.createElement('button');
  look.textContent = 'look away';
  look.onclick = () => {
    looking = !looking;
    loaded.lookAt(looking ? camera : null);
    look.textContent = looking ? 'look away' : 'look at me';
  };
  ui.appendChild(look);
  let warm = false;
  const tint = document.createElement('button');
  tint.textContent = 'warm light';
  tint.onclick = () => {
    warm = !warm;
    loaded.setTint(warm ? '#ffe0c0' : '#ffffff');
    tint.textContent = warm ? 'captured light' : 'warm light';
  };
  ui.appendChild(tint);
} catch (error) {
  status.textContent = String(error instanceof Error ? error.message : error);
  console.error(error);
}
