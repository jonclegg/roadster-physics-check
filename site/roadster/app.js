// Roadster Physics Check: 3D replay, live numbers, charts and assumptions for each stunt.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FLEET_BUILDERS, buildRoadster } from './models.js?v=20261017m';
import {
  DEFAULT_PARAMS, DROP_TELEMETRY, FEET, FRAME_RATE, fullTankExhaust, GRAVITY, KICKFLIP_TELEMETRY, MPH, RAMP_LIP_DEGREES,
  RAMP_RADIUS, RIDE_HEIGHT, TOWER_MEASURED, WALL_TELEMETRY, fleetLayout, rampPoint, setTankTables, simulate, verdict,
} from './physics.js?v=20261017m';

setTankTables(window.TANK_TABLES);

const ALTITUDE_LAG = 0.25;
const NEWTONS_PER_METRE = 15000; // force arrows: 1 m per 15 kN
const VELOCITY_SCALE = 0.35;     // velocity arrow: 0.35 m per m/s
const COLORS = {
  weight: 0xf4f4f4, thrust: 0xffb54d, suction: 0xb79bff, road: 0x46d6a8, grip: 0x9fd77f, velocity: 0x5ad1ff,
};
const CSS = getComputedStyle(document.documentElement);
const ink = name => CSS.getPropertyValue(name).trim();

// ---------- formatting ----------

const number = (value, digits = 0) => (Number.isFinite(value)
  ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '–');
const kN = newtons => `${number(newtons / 1000, 1)} kN`;
const videoClock = seconds => {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
};
const degrees = radians => radians * 180 / Math.PI;
const wrapDegrees = radians => { const d = degrees(radians) % 360; return d < 0 ? d + 360 : d; };

// ---------- telemetry helpers ----------

function interpolate(rows, t) {
  if (t <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] >= t) {
      const share = (t - rows[i - 1][0]) / (rows[i][0] - rows[i - 1][0]);
      return rows[i - 1][1] + share * (rows[i][1] - rows[i - 1][1]);
    }
  }
  return rows[rows.length - 1][1];
}
const flightGauge = rows => ({
  g: rows.map(row => [row[0], row[1]]),
  altitude: rows.map(row => [row[0] - ALTITUDE_LAG, row[2]]),
});
const GAUGES = {
  wall: {
    pitch: WALL_TELEMETRY.map(row => [row[0], row[1]]),
    altitude: WALL_TELEMETRY.map(row => [row[0], row[2]]),
    downforce: WALL_TELEMETRY.map(row => [row[0], row[3]]),
  },
  drop: flightGauge(DROP_TELEMETRY.filter(row => row[0] >= 430)),
  kickflip: flightGauge(KICKFLIP_TELEMETRY),
  tower: { altitude: TOWER_MEASURED.map(([t, metres]) => [t, metres / FEET]) },
  launch: {},
};

// ---------- the five stunts: words, cameras, gauges, charts ----------

const STUNTS = [
  { id: 'wall', when: '6:28', video: 388, name: 'Wall ride', short: 'the wall ride' },
  { id: 'drop', when: '7:10', video: 430, name: 'Wall launch and drop', short: 'the wall drop' },
  { id: 'kickflip', when: '11:12', video: 672, name: 'Kickflip over the fleet', short: 'the kickflip' },
  { id: 'launch', when: '17:08', video: 1028, name: '0–60 mph in 0.81 s', short: 'the 0–60 run' },
  { id: 'tower', when: '21:53', video: 1313, name: 'Tower flip finale', short: 'the tower flip' },
];
const youtube = seconds => `https://www.youtube.com/watch?v=qt5p-_tE8d0&t=${Math.floor(seconds)}s`;

let params = { ...DEFAULT_PARAMS };
const results = {};
let current = 'kickflip';

// The Wooten Labs tracker (/w.js) is added by the site build, so it is missing in local previews and for
// automated browsers. The dashboard counts each key=value pair, so values stay short and discrete.
function track(name, properties) {
  if (window.wl) window.wl.track(name, properties);
}

function runAll() {
  for (const stunt of STUNTS) {
    const result = simulate(stunt.id, params);
    results[stunt.id] = { result, verdict: verdict(stunt.id, result, params) };
  }
}

// ---------- three.js scene ----------

const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.Fog(0x000000, 90, 260);
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 600);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enabled = false;

const environment = new THREE.PMREMGenerator(renderer);
scene.environment = environment.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
scene.add(new THREE.HemisphereLight(0x9aa4b8, 0x0a0a0a, 0.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
keyLight.position.set(-14, 34, 22);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.04;
Object.assign(keyLight.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 });
scene.add(keyLight, keyLight.target);
const rimLight = new THREE.DirectionalLight(0xc9d6ff, 1.3);
rimLight.position.set(20, 10, -25);
scene.add(rimLight);

// Ground: dark asphalt with a soft pool of light, like a studio floor
function radialTexture(inner, outer) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d');
  const gradient = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, inner); gradient.addColorStop(1, outer);
  g.fillStyle = gradient; g.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshStandardMaterial({ color: 0x0e0e10, roughness: 0.96, envMapIntensity: 0.25 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const pool = new THREE.Mesh(new THREE.CircleGeometry(36, 64), new THREE.MeshBasicMaterial({
  map: radialTexture('rgba(255,255,255,0.13)', 'rgba(255,255,255,0)'), transparent: true, depthWrite: false,
}));
pool.rotation.x = -Math.PI / 2;
pool.position.y = 0.01;
scene.add(pool);
const grid = new THREE.GridHelper(200, 100, 0x222226, 0x151518);
grid.position.y = 0.005;
scene.add(grid);

const concrete = new THREE.MeshStandardMaterial({ color: 0xa9abae, roughness: 0.9 });
const redEdge = new THREE.MeshStandardMaterial({ color: 0xff2b2b, emissive: 0xff1a1a, emissiveIntensity: 1.4 });
const steel = new THREE.MeshStandardMaterial({ color: 0x3a3c41, roughness: 0.6, metalness: 0.6 });

// The loop ramp, radius 10.5 m, from flat to 170°
const rampGroup = new THREE.Group();
{
  const pieces = 72, width = 4.8, thickness = 0.35, lip = RAMP_LIP_DEGREES * Math.PI / 180;
  for (let i = 0; i < pieces; i++) {
    const a0 = lip * i / pieces, a1 = lip * (i + 1) / pieces, mid = (a0 + a1) / 2;
    const [x, y] = rampPoint(mid);
    const inward = new THREE.Vector3(-Math.sin(mid), Math.cos(mid), 0);
    const span = RAMP_RADIUS * (a1 - a0) + 0.02;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(span, thickness, width), concrete);
    slab.position.set(x, y, 0).addScaledVector(inward, -thickness / 2);
    slab.rotation.z = mid;
    slab.receiveShadow = true;
    rampGroup.add(slab);
    for (const side of [-1, 1]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(span, 0.08, 0.12), redEdge);
      edge.position.set(x, y, side * (width / 2 - 0.06)).addScaledVector(inward, 0.03);
      edge.rotation.z = mid;
      rampGroup.add(edge);
    }
  }
  const runIn = new THREE.Mesh(new THREE.BoxGeometry(40, 0.04, 4.8), concrete);
  runIn.position.set(-20, 0.02, 0);
  runIn.receiveShadow = true;
  rampGroup.add(runIn);
  // steel frame behind the curve: columns under the lower half, a tower and outriggers for the overhang
  for (let a = 25; a <= 90; a += 13) {
    const angle = a * Math.PI / 180;
    const [x, y] = rampPoint(angle);
    const height = y - 0.3;
    for (const z of [-2, 2]) {
      const column = new THREE.Mesh(new THREE.BoxGeometry(0.25, height, 0.25), steel);
      column.position.set(x + 0.45, height / 2, z);
      rampGroup.add(column);
    }
  }
  const towerX = RAMP_RADIUS + 2.4;
  for (const z of [-2.2, 2.2]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 23.5, 0.5), steel);
    post.position.set(towerX, 11.75, z);
    rampGroup.add(post);
  }
  for (let a = 100; a <= 170; a += 14) {
    const angle = a * Math.PI / 180;
    const [x, y] = rampPoint(angle);
    const top = y + 0.55;
    const length = towerX - x;
    for (const z of [-2.2, 2.2]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(length, 0.22, 0.22), steel);
      beam.position.set(x + length / 2, top, z);
      rampGroup.add(beam);
    }
  }
}
scene.add(rampGroup);

// Five Teslas parked side by side across the path, noses toward the camera
const fleetGroup = new THREE.Group();
for (const vehicle of fleetLayout()) {
  const model = FLEET_BUILDERS[vehicle.name]();
  model.rotation.y = -Math.PI / 2;
  model.position.set(vehicle.x, 0, 0);
  fleetGroup.add(model);
}
scene.add(fleetGroup);

// Launch pad with distance boards
const padGroup = new THREE.Group();
{
  const slab = new THREE.Mesh(new THREE.BoxGeometry(70, 0.05, 9), new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.9 }));
  slab.position.set(25, 0.025, 0);
  slab.receiveShadow = true;
  padGroup.add(slab);
  const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xdedede });
  const start = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.06, 9), lineMaterial);
  start.position.set(0, 0.04, 0);
  padGroup.add(start);
  for (let metres = 5; metres <= 40; metres += 5) {
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 1.2), lineMaterial);
    tick.position.set(metres, 0.04, -4);
    padGroup.add(tick);
  }
}
const sixtyLine = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 9), new THREE.MeshBasicMaterial({ color: 0xc9a66b }));
sixtyLine.position.y = 0.045;
padGroup.add(sixtyLine);
scene.add(padGroup);

// The red tower with its light fans
const towerGroup = new THREE.Group();
{
  const tower = new THREE.Mesh(new THREE.BoxGeometry(2.6, 26, 2.6), new THREE.MeshStandardMaterial({
    color: 0x8f1010, emissive: 0x6a0000, emissiveIntensity: 0.6, roughness: 0.7,
  }));
  tower.position.set(0, 13, -4.5);
  tower.castShadow = true;
  towerGroup.add(tower);
  const beamMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const beam = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 18), beamMaterial);
      beam.position.set(side * 6, 0, -3);
      beam.geometry.translate(0, 9, 0);
      beam.rotation.z = side * (0.35 + i * 0.16);
      towerGroup.add(beam);
    }
  }
}
scene.add(towerGroup);

// ---------- the car ----------

function buildCar() {
  const car = new THREE.Group();
  const model = buildRoadster();
  model.position.y = -RIDE_HEIGHT; // the group origin is the centre of gravity
  car.add(model);
  const lift = -RIDE_HEIGHT;
  // Nozzles and exhaust plumes. Cold nitrogen exhaust shows as white condensation that fades with distance.
  const nozzleMaterial = new THREE.MeshStandardMaterial({ color: 0xc9a66b, metalness: 0.9, roughness: 0.25 });
  const fade = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 128;
    const g = canvas.getContext('2d');
    const gradient = g.createLinearGradient(0, 0, 0, 128);
    gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(0.25, 'rgba(235,244,255,0.75)'); gradient.addColorStop(1, 'rgba(220,235,255,0)');
    g.fillStyle = gradient; g.fillRect(0, 0, 8, 128);
    return new THREE.CanvasTexture(canvas);
  })();
  const plumeGeometry = new THREE.ConeGeometry(1, 1, 32, 1, true);
  plumeGeometry.translate(0, -0.5, 0);
  const plumeOuter = new THREE.MeshBasicMaterial({ map: fade, color: 0xcfe0ff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const plumeInner = new THREE.MeshBasicMaterial({ map: fade, color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const makePlume = (position, direction, diamonds) => {
    const holder = new THREE.Group();
    holder.position.copy(position);
    holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), direction);
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.085, 0.12, 20), nozzleMaterial);
    nozzle.position.y = -0.02;
    const outer = new THREE.Mesh(plumeGeometry, plumeOuter);
    const inner = new THREE.Mesh(plumeGeometry, plumeInner);
    holder.add(nozzle, outer, inner);
    const shocks = [];
    if (diamonds) {
      const diamondMaterial = new THREE.MeshBasicMaterial({ color: 0xffe2b0, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
      for (let i = 0; i < 5; i++) {
        const shock = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), diamondMaterial);
        shock.scale.set(1, 1.8, 1);
        shocks.push(shock);
        holder.add(shock);
      }
    }
    car.add(holder);
    return { holder, outer, inner, shocks };
  };
  const corner = [[1.55, 0.62], [-1.55, 0.62], [1.55, -0.62], [-1.55, -0.62]]
    .map(([x, z]) => makePlume(new THREE.Vector3(x, 0.17 + lift, z), new THREE.Vector3(0, -1, 0), false));
  const rear = [0.6, 0.2, -0.2, -0.6].map(z => makePlume(new THREE.Vector3(-2.22, 0.3 + lift, z), new THREE.Vector3(-1, 0, 0), true));
  // front yaw jets: the first fires toward +z (pushing the nose to -z), the second toward -z
  const lateral = [1, -1].map(side => makePlume(new THREE.Vector3(2.0, 0.45 + lift, side * 0.95), new THREE.Vector3(0, 0, side), false));
  return { car, corner, rear, lateral };
}
const roadster = buildCar();
scene.add(roadster.car);

function setPlume(plume, newtons, time) {
  const kilonewtons = newtons / 1000;
  const on = kilonewtons > 0.3;
  plume.outer.visible = plume.inner.visible = on;
  for (const shock of plume.shocks) shock.visible = on && kilonewtons > 2;
  if (!on) return;
  const flicker = 1 + 0.06 * Math.sin(time * 90 + plume.holder.id);
  const length = (0.6 + kilonewtons * 0.14) * flicker;
  const radius = 0.08 + length * 0.1;
  plume.outer.scale.set(radius * 1.6, length, radius * 1.6);
  plume.inner.scale.set(radius * 0.5, length * 0.55, radius * 0.5);
  plume.shocks.forEach((shock, index) => { shock.position.y = -0.3 - index * length * 0.13; });
}

// Ground wash: the exhaust cloud spreading on the road when the car is low
const wash = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({
  map: radialTexture('rgba(235,242,255,0.55)', 'rgba(235,242,255,0)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
}));
wash.rotation.x = -Math.PI / 2;
wash.position.y = 0.03;
scene.add(wash);

// ---------- force arrows ----------

function makeArrow(color, radius = 0.05) {
  const material = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 10), material);
  const head = new THREE.Mesh(new THREE.ConeGeometry(radius * 3, radius * 7, 14), material);
  group.add(shaft, head);
  group.renderOrder = 10;
  shaft.renderOrder = head.renderOrder = 10;
  scene.add(group);
  const up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3(), tip = new THREE.Vector3();
  const headLength = radius * 7;
  return {
    group, tip,
    set(origin, vector, scale) {
      const length = vector.length() * scale;
      if (length < 0.08) { group.visible = false; return false; }
      group.visible = true;
      direction.copy(vector).normalize();
      group.position.copy(origin);
      group.quaternion.setFromUnitVectors(up, direction);
      const shaftLength = Math.max(length - headLength, 0.02);
      shaft.scale.set(1, shaftLength, 1);
      shaft.position.y = shaftLength / 2;
      head.position.y = shaftLength + headLength / 2;
      tip.copy(origin).addScaledVector(direction, length);
      return true;
    },
  };
}
const arrows = {
  weight: makeArrow(COLORS.weight), thrust: makeArrow(COLORS.thrust, 0.06), suction: makeArrow(COLORS.suction),
  road: makeArrow(COLORS.road), grip: makeArrow(COLORS.grip), velocity: makeArrow(COLORS.velocity, 0.035),
};
// Where each arrow starts, in the car's own frame (nose +x, roof +y, origin at the centre of gravity)
const ARROW_ANCHORS = {
  weight: new THREE.Vector3(0, 0, 0), thrust: new THREE.Vector3(0, 0, 0), suction: new THREE.Vector3(0.4, -0.3, 0),
  road: new THREE.Vector3(0.9, -RIDE_HEIGHT, 0.95), grip: new THREE.Vector3(-1.38, -RIDE_HEIGHT, -0.95), velocity: new THREE.Vector3(0, 0.75, 0),
};
// The force values live in the key in the corner, not on top of the car
const forceKey = Object.fromEntries([...document.querySelectorAll('[data-force]')].map(item => [item.dataset.force, item]));
const FORCE_TEXT = {
  weight: n => `${number(n / 1000, 0)} kN`, thrust: n => `${number(n / 1000, 0)} kN`, suction: n => `${number(n / GRAVITY, 0)} kg`,
  road: n => `${number(n / 1000, 0)} kN`, grip: n => `${number(n / 1000, 0)} kN`, velocity: n => `${number(n / MPH, 0)} mph`,
};

// Trail of where the car has been
const trailGeometry = new THREE.BufferGeometry();
const trail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }));
scene.add(trail);

// ---------- cameras ----------

const CAMERAS = {
  wall: frame => ({ position: [-27, 12, 33], target: [1, 11, 0] }),
  drop: frame => ({ position: [-29, 12, 34], target: [-2, 10.5, 0] }),
  kickflip: frame => ({ position: [frame.x * 0.7, 5.2, 23], target: [frame.x * 0.8, 3.6, 0] }),
  launch: frame => ({ position: [frame.x + 2, 3.2, 16], target: [frame.x + 3, 1.4, 0] }),
  tower: frame => ({ position: [0, 5.5, 25], target: [0, 5.5, -1] }),
};
let cameraMode = 'broadcast';
const cameraGoal = { position: new THREE.Vector3(), target: new THREE.Vector3() };
const cameraTarget = new THREE.Vector3();
function aimCamera(frame, snap) {
  if (cameraMode === 'orbit') return;
  let position, target;
  if (cameraMode === 'chase') {
    const heading = new THREE.Vector3(frame.vx, 0, 0);
    const behind = Math.abs(frame.vx) > 0.5 ? -Math.sign(frame.vx) * 9 : -9;
    position = [frame.x + behind, frame.y + 3.4, current === 'tower' ? 11 : 6.5];
    target = [frame.x + heading.x * 0.1, frame.y + 0.4, 0];
  } else {
    ({ position, target } = CAMERAS[current](frame));
  }
  cameraGoal.position.set(...position);
  cameraGoal.target.set(...target);
  if (snap) { camera.position.copy(cameraGoal.position); cameraTarget.copy(cameraGoal.target); }
  else { camera.position.lerp(cameraGoal.position, 0.08); cameraTarget.lerp(cameraGoal.target, 0.1); }
  camera.lookAt(cameraTarget);
}

// ---------- playback ----------

const playButton = document.getElementById('play');
const scrub = document.getElementById('scrub');
const clockText = document.getElementById('clock');
const speedSelect = document.getElementById('speed');
let playing = false, time = 0, lastTick = performance.now(), lastPanelUpdate = 0;

const frames = () => results[current].result.frames;
const startTime = () => frames()[0].t;
const endTime = () => frames()[frames().length - 1].t;

function frameAt(t) {
  const list = frames();
  const position = (t - list[0].t) * FRAME_RATE;
  const index = Math.max(0, Math.min(list.length - 1, Math.floor(position)));
  const next = list[Math.min(list.length - 1, index + 1)];
  return { frame: list[index], next, share: Math.min(1, Math.max(0, position - index)), index };
}

function setPlaying(on) {
  playing = on;
  playButton.textContent = on ? 'Pause' : 'Play';
  if (on && time >= endTime() - 1e-3) time = startTime();
  lastTick = performance.now();
}
playButton.addEventListener('click', () => setPlaying(!playing));
document.getElementById('restart').addEventListener('click', () => { time = startTime(); setPlaying(true); });
scrub.addEventListener('input', () => {
  time = startTime() + (endTime() - startTime()) * scrub.value / 1000;
  setPlaying(false);
});
speedSelect.addEventListener('change', () => { lastTick = performance.now(); });
document.getElementById('camera').addEventListener('change', event => {
  cameraMode = event.target.value;
  controls.enabled = cameraMode === 'orbit';
  if (cameraMode === 'orbit') controls.target.copy(cameraTarget);
});
const showVectors = document.getElementById('showVectors');
document.addEventListener('keydown', event => {
  if (event.code === 'Space' && !['INPUT', 'SELECT', 'BUTTON'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    setPlaying(!playing);
  }
});

const quaternionA = new THREE.Quaternion(), quaternionB = new THREE.Quaternion();
function showForce(key, magnitude) {
  const item = forceKey[key];
  const active = magnitude > (key === 'velocity' ? 0.05 : 50);
  item.classList.toggle('idle', !active);
  item.querySelector('b').textContent = active ? FORCE_TEXT[key](magnitude) : '–';
}

function updateScene(snapCamera = false) {
  const { frame, next, share, index } = frameAt(time);
  const x = frame.x + (next.x - frame.x) * share, y = frame.y + (next.y - frame.y) * share;
  roadster.car.position.set(x, y, frame.z ?? 0);
  quaternionA.fromArray(frame.orientation); quaternionB.fromArray(next.orientation);
  roadster.car.quaternion.slerpQuaternions(quaternionA, quaternionB, share);
  roadster.corner.forEach((plume, i) => setPlume(plume, frame.nozzles.corner[i], time));
  roadster.rear.forEach((plume, i) => setPlume(plume, frame.nozzles.rear[i], time));
  roadster.lateral.forEach((plume, i) => setPlume(plume, frame.nozzles.lateral?.[i] ?? 0, time));

  const height = y - RIDE_HEIGHT;
  const washStrength = frame.corner > 500 && height < 6 ? Math.min(1, frame.corner / 40000) * (1 - height / 6) : 0;
  wash.visible = washStrength > 0.02;
  wash.position.x = x;
  wash.scale.setScalar(1.5 + washStrength * 7);
  wash.material.opacity = washStrength;

  // arrows, each drawn from where its force acts on the car
  const forces = frame.forces;
  const show = showVectors.checked;
  const set = (key, vector, scale) => {
    const v = new THREE.Vector3(...(vector ?? [0, 0, 0]));
    showForce(key, v.length());
    if (!show || !vector) { arrows[key].group.visible = false; return; }
    const origin = ARROW_ANCHORS[key].clone().applyQuaternion(roadster.car.quaternion).add(roadster.car.position);
    arrows[key].set(origin, v, scale);
  };
  set('weight', forces.weight, 1 / NEWTONS_PER_METRE);
  set('thrust', forces.thrust, 1 / NEWTONS_PER_METRE);
  set('suction', forces.suction, 1 / NEWTONS_PER_METRE);
  set('road', forces.road, 1 / NEWTONS_PER_METRE);
  set('grip', forces.grip, 1 / NEWTONS_PER_METRE);
  set('velocity', forces.velocity, VELOCITY_SCALE);

  trailGeometry.setDrawRange(0, index + 1);
  aimCamera({ ...frame, x, y }, snapCamera);
  scrub.value = Math.round(1000 * (time - startTime()) / (endTime() - startTime()));
  clockText.textContent = current === 'launch'
    ? `${(time).toFixed(2)} s from launch`
    : `${(time - startTime()).toFixed(2)} s · video ${videoClock(time)}`;
}

// ---------- HUD gauges ----------

const gaugeLeft = document.getElementById('gaugesLeft');
const gaugeRight = document.getElementById('gaugesRight');
function gaugeMarkup(key) {
  return `<div class="gauge" data-gauge="${key}"><svg viewBox="0 0 84 62"><path d="M10 54 A34 34 0 1 1 74 54" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="3"/><path class="arc" d="M10 54 A34 34 0 1 1 74 54" fill="none" stroke="#eee" stroke-width="3" pathLength="100" stroke-dasharray="0 100"/></svg><div class="v">0</div><div class="k"></div></div>`;
}
const GAUGE_SETS = { // [key, label, full-scale value]
  wall: [['suction', 'Suction kg', 5000], ['pitch', 'Pitch °', 180]],
  launch: [['g', 'G felt', 5], ['speed', 'mph', 80]],
  flight: [['g', 'G felt', 8], ['altitude', 'Altitude ft', 80]],
  right: [['thrust', 'Thrust kN', 80], ['psi', 'Tank psi', 10000]],
  wallRight: [['g', 'G felt', 3], ['altitude', 'Altitude ft', 80]],
};
function buildGauges() {
  const left = current === 'wall' ? GAUGE_SETS.wall : current === 'launch' ? GAUGE_SETS.launch : GAUGE_SETS.flight;
  const right = current === 'wall' ? GAUGE_SETS.wallRight : GAUGE_SETS.right;
  gaugeLeft.innerHTML = left.map(([key]) => gaugeMarkup(key)).join('');
  gaugeRight.innerHTML = right.map(([key]) => gaugeMarkup(key)).join('');
  for (const [key, label] of [...left, ...right]) {
    document.querySelector(`[data-gauge="${key}"] .k`).textContent = label;
  }
  const maxima = Object.fromEntries([...left, ...right].map(([key, , max]) => [key, max]));
  if (maxima.thrust) maxima.thrust = 4 * params.nozzleThrust; // kN the four nozzles of a group can make
  return maxima;
}
let gaugeMaxima = {};
function updateGauges(frame) {
  const values = {
    suction: frame.suction / GRAVITY, pitch: wrapDegrees(frame.pitch), g: frame.g, altitude: frame.height / FEET,
    speed: frame.speed / MPH, thrust: frame.thrust / 1000, psi: frame.psi,
  };
  const digits = { g: 1, altitude: 1, pitch: 1 };
  for (const [key, max] of Object.entries(gaugeMaxima)) {
    const element = document.querySelector(`[data-gauge="${key}"]`);
    const value = Math.max(0, values[key]);
    element.querySelector('.v').textContent = number(value, digits[key] ?? 0);
    const arc = element.querySelector('.arc');
    arc.setAttribute('stroke-dasharray', `${Math.min(100, 100 * value / max)} 100`);
    arc.setAttribute('stroke', key === 'thrust' && frame.saturated ? ink('--fail') : key === 'thrust' ? ink('--thrust') : '#eee');
  }
}

// ---------- live numbers ----------

const readoutList = document.getElementById('readouts');
let readoutCells = {};
function readoutRows(frame) {
  const gauge = GAUGES[current];
  const rows = [];
  const group = title => rows.push({ group: title });
  const row = (key, label, value, style = '') => rows.push({ key, label, value, style });
  const mass = frame.mass;
  group('Motion');
  row('height', 'Height', `${number(frame.height, 1)} m · ${number(frame.height / FEET, 0)} ft`);
  if (gauge.altitude) {
    const label = current === 'tower' ? 'Measured from video' : current === 'wall' ? 'Broadcast gauge' : 'Broadcast gauge (−0.25 s)';
    row('heightGauge', label, `${number(interpolate(gauge.altitude, time), 0)} ft`, 'measured');
  }
  row('speed', 'Speed', `${number(frame.speed / MPH, 0)} mph`);
  if (current !== 'launch' && current !== 'wall') row('climb', 'Climb rate', `${number(frame.vy, 1)} m/s`);
  row('g', 'G felt (simulated)', `${number(frame.g, 2)} G`);
  if (gauge.g) row('gGauge', 'G (broadcast gauge)', `${number(interpolate(gauge.g, time), 1)} G`, 'measured');
  if (current === 'launch') row('distance', 'Distance', `${number(frame.x, 1)} m`);

  if (current === 'wall' || frame.onRamp) {
    group('Fans and tyres');
    row('pitch', 'Pitch', `${number(wrapDegrees(frame.pitch), 0)}°`);
    if (gauge.pitch) row('pitchGauge', 'Pitch (gauge)', `${number(interpolate(gauge.pitch, time), 0)}°`, 'measured');
    row('suction', current === 'wall' ? 'Suction (gauge)' : 'Suction (assumed)', `${number(frame.suction / GRAVITY, 0)} kg`, current === 'wall' ? 'measured' : '');
    row('need', 'Suction needed', `${number(frame.suctionNeeded / GRAVITY, 0)} kg`);
    const margin = frame.suctionNeeded > 500 ? frame.suction / frame.suctionNeeded : Infinity;
    row('margin', 'Margin', Number.isFinite(margin) ? `${number(margin, 2)}×` : 'gravity holds it', margin < 1 ? 'warn' : margin < 1.3 ? '' : 'ok');
    row('road', 'Road push', kN(frame.roadPush));
    row('grip', 'Tyre grip used', `${number(frame.gripUsed * 100, 0)}%`, frame.gripUsed > 1 ? 'warn' : '');
    row('fan', 'Fan power', `${number(frame.fanPower / 1000, 0)} kW`);
  }
  if (current === 'launch') {
    group('Forces');
    row('tyre', 'Tyres (motors)', kN(frame.tyreForce));
    row('rearThrust', 'Rear thrusters', kN(frame.rear));
    row('push', 'Push on the driver', `${number(frame.horizontalG, 2)} G`);
  }
  if (current !== 'wall') {
    group('Thrusters');
    row('thrust', 'Thrust', kN(frame.thrust), frame.saturated ? 'warn' : '');
    row('capacity', 'Available now', kN(frame.capacity));
    if (current !== 'launch') {
      const [left, right] = frame.nozzles.lateral;
      row('downThrust', '4 down thrusters', kN(frame.corner));
      row('rearGroup', '4 rear thrusters', kN(frame.rear));
      row('yawJets', '2 yaw jets', left > right ? `${kN(left)} left` : right > 0 ? `${kN(right)} right` : kN(0));
      row('wheelSpin', 'Wheel spin', `${number(frame.wheelSpin * 60 / (2 * Math.PI), 0)} rpm`);
    }
    row('tw', 'Thrust ÷ weight', `${number(frame.thrust / (mass * GRAVITY), 2)}`);
    row('flow', 'Air flow', `${number(frame.flow, 1)} kg/s`);
    row('exhaust', 'Exhaust speed', `${number(frame.exhaustSpeed, 0)} m/s`);
    if (current !== 'launch') {
      row('roll', 'Roll', `${number(wrapDegrees(frame.roll), 0)}°`);
      row('torque', 'Turning moment', `${number(frame.torque / 1000, 1)} kN·m`, frame.wantedMoment > frame.torque * 1.2 + 500 ? 'warn' : '');
    }
  }
  group('Tank');
  row('psi', 'Pressure', `${number(frame.psi, 0)} psi`);
  row('temperature', 'Gas temperature', `${number(frame.temperature - 273.15, 0)} °C`);
  const full = results[current].result.summary.fullGas;
  row('gas', 'Air left', `${number(frame.gas, 0)} kg`);
  row('used', 'Air used', `${number(full - frame.gas, 0)} kg`);
  row('mass', 'Car + air', `${number(mass, 0)} kg`);
  return rows;
}
function buildReadouts(frame) {
  readoutList.innerHTML = '';
  readoutCells = {};
  for (const entry of readoutRows(frame)) {
    if (entry.group) {
      const dt = document.createElement('dt');
      dt.className = 'group';
      dt.textContent = entry.group;
      readoutList.append(dt);
      continue;
    }
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = entry.label;
    readoutList.append(dt, dd);
    readoutCells[entry.key] = dd;
  }
}
let readoutShape = '';
function updateReadouts(frame) {
  const rows = readoutRows(frame);
  const shape = rows.map(entry => entry.group ?? entry.key).join('|');
  if (shape !== readoutShape) { buildReadouts(frame); readoutShape = shape; }
  for (const entry of rows) {
    if (entry.group) continue;
    const cell = readoutCells[entry.key];
    cell.textContent = entry.value;
    cell.className = entry.style;
  }
}

// ---------- charts ----------

const chartsHost = document.getElementById('charts');
let charts = [];
const series = (map, every = 2) => frames().filter((_, i) => i % every === 0).map(frame => [frame.t, map(frame)]);

function chartSpecs() {
  const r = results[current].result;
  const gauge = GAUGES[current];
  const height = frame => frame.height / FEET;
  const thrust = [
    { label: 'Thrust', color: ink('--thrust'), data: series(f => f.thrust / 1000) },
    { label: 'Available', color: ink('--ink-3'), dash: true, data: series(f => f.capacity / 1000) },
  ];
  const tank = [{ label: 'Tank pressure', color: ink('--ink'), data: series(f => f.psi) }];
  const regulator = params.regulatorPsi > 0 ? [{ y: params.regulatorPsi, label: 'regulator' }] : [];
  if (current === 'wall') {
    return [
      { title: 'Pitch (°)', lines: [{ label: 'Model', color: ink('--ink'), data: series(f => wrapDegrees(f.pitch)) }], dots: gauge.pitch, dotLabel: 'Gauge' },
      { title: 'Suction (kg)', lines: [
        { label: 'Gauge', color: ink('--suction'), data: series(f => f.suction / GRAVITY) },
        { label: 'Needed', color: ink('--fail'), dash: true, data: series(f => f.suctionNeeded / GRAVITY) }] },
      { title: 'Tyre grip used (%)', lines: [{ label: 'Grip used', color: ink('--friction'), data: series(f => Math.min(f.gripUsed * 100, 150)) }], refs: [{ y: 100, label: 'limit' }] },
      { title: 'Fan power (kW)', lines: [{ label: `${params.skirtGap} mm skirt gap`, color: ink('--velocity'), data: series(f => f.fanPower / 1000) }], refs: [{ y: 80, label: '4 × 20 kW fans' }] },
    ];
  }
  if (current === 'launch') {
    return [
      { title: 'Speed (mph)', lines: [{ label: 'Speed', color: ink('--velocity'), data: series(f => f.speed / MPH) }], refs: [{ y: 60, label: '60 mph' }] },
      { title: 'Push on the driver (G)', lines: [{ label: 'Horizontal G', color: ink('--ink'), data: series(f => f.horizontalG) }] },
      { title: 'Force (kN)', lines: [
        { label: 'Rear thrusters', color: ink('--thrust'), data: series(f => f.rear / 1000) },
        { label: 'Tyres', color: ink('--friction'), data: series(f => f.tyreForce / 1000) }] },
      { title: 'Tank pressure (psi)', lines: tank, refs: regulator },
    ];
  }
  return [
    { title: 'Height (ft)', lines: [{ label: 'Simulated', color: ink('--ink'), data: series(height) }], dots: gauge.altitude, dotLabel: current === 'tower' ? 'Measured in pixels' : 'Gauge (−0.25 s)' },
    { title: 'G felt', lines: [{ label: 'Simulated', color: ink('--ink'), data: series(f => f.g) }], dots: gauge.g, dotLabel: 'Gauge' },
    { title: 'Thrust (kN)', lines: thrust },
    { title: 'Tank pressure (psi)', lines: tank, refs: regulator },
  ];
}

// The last spec number: how fast it came down, or what stopped it if it never reached the road
function touchdownSpec(s, landed) {
  if (landed) return [number(s.touchdownSpeed, 1), 'm/s', 'Touchdown speed'];
  if (s.touchdownSpeed !== null) return [number(s.touchdownSpeed, 1), 'm/s', 'Speed hitting the road'];
  return ['–', '', s.outcome.text];
}

function niceStep(range, count) {
  const raw = range / count, power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3 ? 2 : unit < 7 ? 5 : 10) * power;
}

function buildCharts() {
  chartsHost.innerHTML = '';
  charts = chartSpecs().map(spec => {
    const box = document.createElement('div');
    box.className = 'chart';
    const keys = spec.lines.map(line => `<span><i class="${line.dash ? 'dash' : ''}" style="background:${line.dash ? '' : line.color};color:${line.color}"></i>${line.label}</span>`);
    if (spec.dots) keys.push(`<span><i class="dot"></i>${spec.dotLabel}</span>`);
    box.innerHTML = `<h3>${spec.title}</h3><canvas></canvas><div class="key">${keys.join('')}</div>`;
    chartsHost.append(box);
    return { spec, canvas: box.querySelector('canvas'), cache: null };
  });
  for (const chart of charts) renderChartCache(chart);
}

function renderChartCache(chart) {
  const { canvas, spec } = chart;
  const ratio = Math.min(window.devicePixelRatio, 2);
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width) return;
  const cache = document.createElement('canvas');
  cache.width = width * ratio; cache.height = height * ratio;
  canvas.width = cache.width; canvas.height = cache.height;
  const g = cache.getContext('2d');
  g.scale(ratio, ratio);
  const t0 = startTime(), t1 = endTime();
  let low = Infinity, high = -Infinity;
  for (const line of spec.lines) for (const [, y] of line.data) { low = Math.min(low, y); high = Math.max(high, y); }
  for (const [t, y] of spec.dots ?? []) if (t >= t0 && t <= t1) { low = Math.min(low, y); high = Math.max(high, y); }
  for (const ref of spec.refs ?? []) high = Math.max(high, ref.y * 1.08);
  low = Math.min(low, 0);
  if (high - low < 1e-6) high = low + 1;
  const step = niceStep(high - low, 3);
  low = Math.floor(low / step) * step; high = Math.ceil(high / step) * step;
  const left = 40, right = 8, top = 6, bottom = 18;
  const sx = t => left + (t - t0) / (t1 - t0) * (width - left - right);
  const sy = y => top + (1 - (y - low) / (high - low)) * (height - top - bottom);
  g.font = '10px "IBM Plex Mono", monospace';
  g.fillStyle = ink('--ink-3');
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = 1;
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let y = low; y <= high + step / 2; y += step) {
    g.beginPath(); g.moveTo(left, Math.round(sy(y)) + 0.5); g.lineTo(width - right, Math.round(sy(y)) + 0.5); g.stroke();
    g.fillText(number(y, step < 1 ? 1 : 0), left - 5, sy(y));
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  // seconds count from the stunt's own zero: the launch for 0-60, the start of the replay otherwise
  const origin = results[current].result.summary.timeOrigin ?? t0;
  const tStep = niceStep(t1 - t0, 4);
  for (let s = Math.ceil((t0 - origin) / tStep - 1e-9) * tStep; origin + s <= t1 + 1e-6; s += tStep) {
    g.fillText(`${number(s + 0, tStep < 1 ? 1 : 0)}s`, sx(origin + s), height - bottom + 4);
  }
  for (const ref of spec.refs ?? []) {
    g.strokeStyle = ink('--ink-3'); g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(left, sy(ref.y)); g.lineTo(width - right, sy(ref.y)); g.stroke(); g.setLineDash([]);
    g.textAlign = 'right'; g.textBaseline = 'bottom';
    g.fillText(ref.label, width - right, sy(ref.y) - 2);
  }
  for (const line of spec.lines) {
    g.strokeStyle = line.color; g.lineWidth = 1.6;
    g.setLineDash(line.dash ? [4, 3] : []);
    g.beginPath();
    line.data.forEach(([t, y], i) => (i ? g.lineTo(sx(t), sy(y)) : g.moveTo(sx(t), sy(y))));
    g.stroke();
  }
  g.setLineDash([]);
  g.strokeStyle = ink('--gold'); g.lineWidth = 1.5;
  for (const [t, y] of spec.dots ?? []) {
    if (t < t0 || t > t1) continue;
    g.beginPath(); g.arc(sx(t), sy(y), 3, 0, Math.PI * 2); g.stroke();
  }
  chart.cache = cache;
  chart.scale = { sx, sy, ratio, height };
}

function drawPlayheads() {
  for (const chart of charts) {
    if (!chart.cache) continue;
    const g = chart.canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, chart.canvas.width, chart.canvas.height);
    g.drawImage(chart.cache, 0, 0);
    const { sx, ratio, height } = chart.scale;
    g.scale(ratio, ratio);
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(sx(time), 4); g.lineTo(sx(time), height - 18); g.stroke();
  }
}

// ---------- verdicts, specs and the reasoning ----------

const verdictCard = document.getElementById('verdictCard');
const specsHost = document.getElementById('specs');
const reasonTitle = document.getElementById('reasonTitle');
const reasonCols = document.getElementById('reasonCols');
const chip = v => `<span class="chip ${v.status}">${v.label}</span>`;

function hoverFlow() {
  const frame = results.drop.result.frames.find(f => f.airborne) ?? results.drop.result.frames[0];
  return (params.dryMass + frame.gas) * GRAVITY / frame.exhaustSpeed;
}

function stuntWords(id) {
  const { result, verdict: v } = results[id];
  const s = result.summary;
  const mass = params.dryMass + s.fullGas;
  const used = `${number(s.gasUsed, 0)} kg`, usable = `${number(s.usableGas, 0)} kg`;
  const landed = s.outcome?.kind === 'landed';
  const touchdown = landed ? `${number(s.touchdownSpeed, 1)} m/s` : null;
  const ending = landed ? `touches down at ${touchdown}` : s.outcome ? s.outcome.text.charAt(0).toLowerCase() + s.outcome.text.slice(1) : '';
  const spare = `${number(100 - 100 * (v.gasShare ?? 0), 0)}%`;
  const airLine = v.gasShare === undefined ? '' : v.gasShare > 0.99 ? 'That is the whole tank.' : v.gasShare > 0.5 ? `That leaves ${spare}, so one tank covers one stunt, not two.` : `That leaves ${spare}.`;
  if (id === 'wall') {
    const worst = s.worstMarginAt;
    const worstAngle = number(wrapDegrees(worst.pitch), 0);
    const ratio = s.invertedNeed / (mass * GRAVITY);
    return {
      title: 'Wall ride: parked upside down 69 ft up',
      verdict: [s.outcome.kind === 'held'
        ? `The fans pull up to ${number(s.peakSuction / GRAVITY, 0)} kg; the most it ever needs is ${number(worst.suctionNeeded / GRAVITY, 0)} kg (at ${worstAngle}°).`
        : `${s.outcome.text}.`,
      `Fans can hold at most ${number(s.suctionLimit / GRAVITY, 0)} kg with ${params.skirtGap} mm skirt gaps; they use up to ${number(s.peakFan / 1000, 0)} kW.`],
      specs: [[number(s.peakSuction / GRAVITY, 0), 'kg', 'Peak fan suction'], [number(s.worstMargin, 2), '×', 'Suction margin, worst moment'],
        [number(s.peakFan / 1000, 0), 'kW', 'Fan power used (of ~80)'], [number(Math.min(s.peakGrip, 9) * 100, 0), '%', 'Most tyre grip used']],
      cols: [
        ['What the video shows', `<p>From 6:28 the car crawls up a loop-shaped ramp at 2–5 m/s, pauses at vertical, then parks at 170° with its roof toward the ground for about ten seconds, 69 ft up. The downforce gauge rises with the angle and tops out at 4,700 kg. No thrusters fire.</p><p>Pitch against altitude fits a loop of radius 9.5–10.6 m. We use 10.5 m, which puts the lip at the 69 ft the gauge settles on.</p>`],
        ['How the simulation runs it', `<p>The motors try to drive the speed the video shows, but the tyres can only push ${number(params.tyreGrip, 2)} × the road push, and most of the road push comes from the fans. The fans try to pull what the gauge showed, up to what 80 kW can hold through a ${params.skirtGap} mm leak gap: ${number(s.suctionLimit / GRAVITY, 0)} kg. If the road push drops below zero the car falls off; if the tyres can't hold it, it slides.</p><div class="math">road push = m·v²/R + suction + m·g·cos θ\ntyre force = m·a + m·g·sin θ ≤ ${number(params.tyreGrip, 2)} × road push</div><p>Parked at 170° it needs ${number(ratio, 2)} × its own weight in suction: ${number(s.invertedNeed / GRAVITY, 0)} kg.</p>`],
        ['Verdict', `<p>${chip(v)}</p><p>${s.outcome.kind === 'held'
          ? `It stays on. The tightest moment is at ${worstAngle}° (video ${videoClock(worst.t)}), with ${number(s.worstMargin, 2)}× the suction it needs. ${s.slipTime > 0.2 ? `The tyres slip for ${number(s.slipTime, 1)} s along the way.` : ''}`
          : `${s.outcome.text}: the fans and tyres can't keep a ${number(mass, 0)} kg car on the loop with these settings.`}
          Holding 4,700 kg through a ~4 m² floor is a pressure drop of about 11.5 kPa, a tenth of an atmosphere. The catch is the seal: double the gap and the fans can hold only about two-thirds as much.</p>`],
      ],
    };
  }
  if (id === 'drop') {
    const launched = Number.isFinite(s.lipTime);
    return {
      title: 'Wall launch: off the lip at 68 ft',
      verdict: [launched ? `Leaves the lip at ${number(s.launchSpeed, 1)} m/s, uses ${used} of ${usable} of usable air and ${ending}.` : `${s.outcome.text}.`,
        launched && s.catchG ? `The catch peaks at ${number(s.catchG, 1)} G (the broadcast gauge showed 3.1–3.3).` : ''],
      specs: [[number((s.lipHeight ?? 0) / FEET, 0), 'ft', 'Height leaving the lip'], [number(s.catchG ?? 0, 1), 'G', 'Peak G in the catch'],
        [number(s.gasUsed, 0), 'kg', `Air used, of ${usable} usable`], touchdownSpec(s, landed)],
      cols: [
        ['What the video shows', `<p>The second run (7:10) takes the same loop faster, 4–7 m/s. The car leaves the lip at 68 ft upside down and drifting backwards, half-rolls to wheels-down, and falls. At about 30 ft the G gauge jumps to 3.1–3.3 G, the fall stops by about 10 ft, and the car eases down the last few feet over about two seconds.</p><p>The G gauge reads 0.3–0.6 G during the roll, the push the roll itself needs.</p>`],
        ['How the simulation runs it', `<p>The car drives the loop with the same fan and grip limits as the wall ride and flies off the lip with whatever speed it has. Then the flight computer runs the program from the video: a half roll at up to 3.5 rad/s, then a landing burn that plans on 1.8 g of braking down to 10 ft, a 1.5 m/s let-down, and a 0.3 m/s touchdown. It brakes as late as it safely can with the thrust the nozzles have at that moment, so a weaker car starts braking higher. The roll is made by one side pushing harder; starting it upside down pushes the car down a little, so the simulated car falls slightly faster than the real one.</p><div class="math">air used = thrust ÷ exhaust speed, added up\nroll: ${number(s.rollGas ?? 0, 0)} kg · catch: ${number(s.catchGas ?? 0, 0)} kg · let-down: ${number(s.letDownGas ?? 0, 0)} kg</div>`],
        ['Verdict', `<p>${chip(v)}</p><p>${landed
          ? `It ${ending}, using ${used} of the ${usable} of usable air. ${airLine} The slow let-down costs the most: holding the car up burns about ${number(hoverFlow(), 0)} kg of air a second.`
          : `${s.outcome.text}${s.outOfAir ? ', out of air' : ''}. With these settings the program can't bring the car down safely.`}
          The kickflip comes about four minutes later in the stream; if it was the same car, a 6–7 hour refill (Moravy) means a fast fill from a ground bank, a second car, or footage not flown in that order.</p>`],
      ],
    };
  }
  if (id === 'kickflip') {
    const hit = s.outcome?.kind === 'hit';
    return {
      title: 'Kickflip over the fleet',
      verdict: [hit ? `${s.outcome.text}.` : `Tops out at ${number(s.apex / FEET, 0)} ft, clears the ${s.clearanceOver} by ${number(s.clearance, 1)} m and ${ending}.`,
        `Uses ${used} of ${usable} of usable air.`],
      specs: [[number(s.apex / FEET, 0), 'ft', 'Peak height'], [hit ? '0' : number(s.clearance, 1), 'm', hit ? s.outcome.text : `Clearance over the ${s.clearanceOver}`],
        [number(s.gasUsed, 0), 'kg', `Air used, of ${usable} usable`], touchdownSpec(s, landed)],
      cols: [
        ['What the video shows', `<p>At 11:12 the car rolls toward five Teslas parked side by side: Cybercab, Cybertruck, a Semi roughly 13.5 ft tall, Model Y and Model 3. It fires its corner thrusters at 2.4–3.5 G, rises to about 26 ft, and does a full barrel roll on the way up. It crosses the Semi, brakes at up to 2.4 G, and lands on the far side about four seconds after lift-off.</p>`],
        ['How the simulation runs it', `<p>The program from the video: roll up at 6.2 m/s, lift off 12 m before the middle of the lineup, burn at 2.4 G until it is fast enough to coast to 26 ft, spin a full roll at up to 5 rad/s, stay above 2 m until it is past the last car, then a landing burn that plans on 0.66 g of braking and a 0.6 m/s touchdown. The roll needs one side to push harder than the other, which also pushes the car up, so the program stops its burn early to allow for it.</p><div class="math">climb (burn and roll): ${number(s.climbGas, 0)} kg · landing: ${number(s.landingGas, 0)} kg\nfastest fall: ${number(s.fallSpeed, 1)} m/s</div>`],
        ['Verdict', `<p>${chip(v)}</p><p>${hit ? `${s.outcome.text}: with these settings it can't get high enough, or stay high enough, over the lineup.`
          : landed ? `It clears the ${s.clearanceOver} by ${number(s.clearance, 1)} m and ${ending}, using ${used} of the ${usable} of usable air. ${airLine}`
            : `${s.outcome.text}${s.outOfAir ? ', out of air' : ''}.`}</p>`],
      ],
    };
  }
  if (id === 'launch') {
    const versus = s.fullThrustTime === null ? '' : s.fullThrustTime < 0.55 ? 'quicker than' : s.fullThrustTime <= 0.65 ? 'close to' : 'slower than';
    return {
      title: '0–60 mph in 0.81 seconds',
      verdict: [`Needs ${kN(s.neededThrust)} from the rear nozzles on top of the motors, ${number(100 * Math.min(1, s.neededThrust / s.fullCapacity), 0)}% of what they can make.`,
        s.fullThrustTime === null ? '' : `With all ${kN(s.fullCapacity)} it would take ${number(s.fullThrustTime, 2)} s.`],
      specs: [[number(s.neededThrust / 1000, 0), 'kN', 'Rear thrust needed'], [s.fullThrustTime === null ? '–' : number(s.fullThrustTime, 2), 's', `0–60 with all ${number(s.fullCapacity / 1000, 0)} kN`],
        [number(s.gasUsed, 0), 'kg', 'Air used'], [`${number(s.peakG, 1)} / ${number(s.peakBrakeG, 1)}`, 'G', 'On the driver: launch / braking']],
      cols: [
        ['What the video shows', `<p>At 17:08 the car runs 0–60 on a short pad and is timed at 0.81 s; there wasn't much room, so the run was "cut short". Tesla said on stage that the four rear nozzles make over 80 kN. You can see shock diamonds in the exhaust, which means the air leaves the nozzles faster than sound.</p>`],
        ['What physics needs', `<p>0.81 s means 3.4 G on average. Two rear motors with over 1,400 N·m between them, through an 8.4:1 gear, give about ${kN(s.motorForce)} at the tyres, and the fans add grip so the tyres can carry it. On their own the motors would take ${s.motorOnlyTime === null ? 'more than 1.9' : number(s.motorOnlyTime, 2)} s. The rear thrusters add ${kN(s.neededThrust)} for ${number(s.actualTime, 2)} s, covering ${number(s.distanceAtSixty, 1)} m.</p><div class="math">a = 26.8 m/s ÷ ${number(s.actualTime, 2)} s = ${number(26.82 / s.actualTime, 0)} m/s² = ${number(26.82 / s.actualTime / GRAVITY, 1)} G\nF = m·a = ${number(mass, 0)} × ${number(26.82 / s.actualTime, 0)} = ${kN(mass * 26.82 / s.actualTime)}</div>`],
        ['Verdict', `<p>${chip(v)}</p><p>This is the easiest stunt for the hardware. It uses ${used} of air. ${s.fullThrustTime === null ? '' : `With every newton of rear thrust it would run 0–60 in ${number(s.fullThrustTime, 2)} s, ${versus} Tesla's target of under 0.59 s for the Rocket trim.`} The limit is the person: ${number(s.peakG, 1)} G is as hard a shove as a carrier catapult launch, and because the pad is short, braking from 60 mph hits ${number(s.peakBrakeG, 1)} G the other way.</p>`],
      ],
    };
  }
  return {
    title: 'Tower flip finale',
    verdict: [landed ? `Tops out at ${number(s.apex, 1)} m and ${ending}, using ${used} of ${usable} of usable air.` : `${s.outcome?.text}.`,
      `The program's boost asks for ${number(s.plannedBoostG, 1)} G; this car got ${number(s.boostG, 1)} G.`],
    specs: [[number(s.boostG, 1), 'G', 'Boost it managed (asked for 4.0)'], [number(s.apex, 1), 'm', 'Peak height (video ~7)'],
      [number(s.gasUsed, 0), 'kg', `Air used, of ${usable} usable`], touchdownSpec(s, landed)],
    cols: [
      ['What the video shows', `<p>The last stunt (21:53) has no gauges. The car lifts off beside a red tower, rolls a full turn near the top, and lands about three seconds later in a cloud of its own exhaust. Measured in pixels it is 6.4 m up only 0.6 s after lift-off, then 5.4 m up and falling at about 6 m/s at 21:55.6. The camera cuts in between, so treat these heights as ±30%.</p>`],
      ['How the simulation runs it', `<p>The program: a hard boost of 3 g net (4 G felt) until it can coast to about 7 m, a full roll at up to 4.5 rad/s, then a late landing burn planned at 1.8 g of braking. The corner nozzles make 4 × ${number(params.nozzleThrust, 0)} = ${number(4 * params.nozzleThrust, 0)} kN, so the full boost is only possible if the car and its air weigh ${number(s.heaviestForBoost, 0)} kg or less. A heavier car gets a gentler boost and burns longer.</p><div class="math">max mass for the boost = thrust ÷ (4 × g) = ${number(4 * params.nozzleThrust * 1000, 0)} ÷ 39.2</div>`],
      ['Verdict', `<p>${chip(v)}</p><p>${landed ? `It ${ending} after topping out at ${number(s.apex, 1)} m, using ${used} of ${usable} of usable air. ${airLine}` : `${s.outcome?.text}${s.outOfAir ? ', out of air' : ''}.`} This is the only stunt that leans on our pixel measurements, which could be off by 30% if the car moved toward the camera as it climbed.</p>`],
    ],
  };
}

function renderWords() {
  const words = stuntWords(current);
  const v = results[current].verdict;
  const stunt = STUNTS.find(s => s.id === current);
  verdictCard.innerHTML = `<h2>${stunt.name}</h2>${chip(v)}<p class="why">${v.reason}</p>${words.verdict.map(line => `<p>${line}</p>`).join('')}<p><a href="${youtube(stunt.video)}" target="_blank" rel="noopener">Watch it in Tesla's stream at ${stunt.when}</a></p>`;
  specsHost.innerHTML = words.specs.map(([big, unit, what]) => `<div class="spec"><div class="big">${big}<small>${unit}</small></div><div class="what">${what}</div></div>`).join('');
  reasonTitle.textContent = words.title;
  reasonCols.innerHTML = words.cols.map(([heading, html]) => `<div class="col"><h3>${heading}</h3>${html}</div>`).join('');
  document.getElementById('hudTitle').textContent = stunt.name;
}

function renderHeadline() {
  const by = status => STUNTS.filter(stunt => results[stunt.id].verdict.status === status).map(stunt => stunt.short);
  const list = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
  const capital = text => text.charAt(0).toUpperCase() + text.slice(1);
  const good = by('good'), tight = by('tight'), fail = by('fail');
  const parts = [];
  if (good.length) parts.push(`${capital(list(good))} ${good.length > 1 ? 'are' : 'is'} plausible, with room to spare.`);
  if (tight.length) parts.push(`${capital(list(tight))} ${tight.length > 1 ? 'are' : 'is'} barely plausible: possible, with almost nothing left over.`);
  if (fail.length) parts.push(`${capital(list(fail))} ${fail.length > 1 ? 'are' : 'is'} implausible as shown, with these assumptions.`);
  const flights = ['drop', 'kickflip', 'tower'].filter(id => results[id].verdict.status !== 'fail')
    .map(id => 100 * results[id].result.summary.gasUsed / results[id].result.summary.usableGas);
  if (flights.length) {
    const low = Math.round(Math.min(...flights)), high = Math.round(Math.max(...flights));
    const range = low === high ? `${low}%` : `${low}–${high}%`;
    const noun = flights.length > 1 ? 'Each flight that works uses' : 'The flight that works uses';
    const tail = low > 50 ? ', so a full tank covers one jump, not two' : '';
    parts.push(`${noun} ${range} of the usable air${tail}${high >= 99 ? ', and one empties it' : ''}.`);
  }
  const lead = fail.length === 0 ? (good.length >= tight.length ? 'Mostly yes.' : 'Yes, just.') : fail.length >= 3 ? 'Mostly no.' : 'Partly.';
  document.getElementById('headlineText').innerHTML = `<strong style="font-weight:500">${lead}</strong> ${parts.join(' ')}`;
}

// ---------- stunt picker ----------

const picker = document.getElementById('picker');
function renderPicker() {
  picker.innerHTML = STUNTS.map(stunt => {
    const v = results[stunt.id].verdict;
    return `<button class="stunt" type="button" data-id="${stunt.id}" aria-pressed="${stunt.id === current}" title="${v.reason}" data-track="Stunt: ${stunt.name}"><span class="name">${stunt.name}</span>${chip(v)}</button>`;
  }).join('');
}
picker.addEventListener('click', event => {
  const button = event.target.closest('[data-id]');
  if (!button) return;
  select(button.dataset.id, true);
  track('roadster_stunt', { stunt: current, verdict: results[current].verdict.status });
});

const ticksHost = document.getElementById('ticks');
function renderTicks() {
  const r = results[current].result, s = r.summary;
  const marks = {
    wall: [[392, 'On ramp'], [397, 'Vertical'], [402, '170°'], [413, 'Down']],
    drop: [[431, 'Run'], [s.lipTime, 'Lip'], [s.catchStart, 'Catch'], [s.touchdownTime, s.outcome?.kind === 'landed' ? 'Down' : 'Crash']],
    kickflip: [[s.liftoffTime, 'Lift-off'], [s.boostEnd, 'Roll'], [s.apexTime, 'Apex'], [s.touchdownTime, s.outcome?.kind === 'landed' ? 'Down' : 'Crash']],
    launch: [[0, 'Go'], [s.actualTime, '60 mph']],
    tower: [[s.liftoffTime, 'Lift-off'], [s.boostEnd, 'Roll'], [s.apexTime, 'Apex'], [s.touchdownTime, s.outcome?.kind === 'landed' ? 'Down' : 'Crash']],
  }[current].filter(([t]) => Number.isFinite(t));
  if (current === 'kickflip' && s.outcome?.kind === 'hit') marks.push([s.crashTime, 'Hit']);
  marks.sort((a, b) => a[0] - b[0]);
  const t0 = startTime(), t1 = endTime();
  // a label too close to the one before keeps its tick but not its text, so the two don't overlap
  const width = ticksHost.clientWidth, characterWidth = 6.2;
  let last = null;
  ticksHost.innerHTML = marks.map(([t, label]) => {
    const at = (t - t0) / (t1 - t0);
    const crowded = last !== null && (at - last.at) * width < (last.label.length + label.length) * characterWidth / 2 + 6;
    if (!crowded) last = { at, label };
    return `<span style="left:${100 * at}%" title="${label}">${crowded ? '' : label}</span>`;
  }).join('');
}

function select(id, autoplay) {
  current = id;
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  const stunt = STUNTS.find(s => s.id === id);
  rampGroup.visible = id === 'wall' || id === 'drop';
  fleetGroup.visible = id === 'kickflip';
  padGroup.visible = id === 'launch';
  towerGroup.visible = id === 'tower';
  refreshStunt();
  time = startTime();
  updateScene(true);
  setPlaying(Boolean(autoplay));
}

function refreshStunt() {
  const list = frames();
  const points = new Float32Array(list.length * 3);
  list.forEach((frame, i) => points.set([frame.x, frame.y, frame.z ?? 0], i * 3));
  trailGeometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
  trailGeometry.computeBoundingSphere();
  if (current === 'launch') sixtyLine.position.x = results.launch.result.summary.distanceAtSixty;
  const centre = current === 'kickflip' ? [0, 0] : current === 'launch' ? [12, 0] : current === 'tower' ? [0, 0] : [0, 0];
  pool.position.set(centre[0], 0.01, centre[1]);
  keyLight.target.position.set(centre[0], 0, 0);
  renderPicker();
  renderWords();
  renderTicks();
  gaugeMaxima = buildGauges();
  readoutShape = '';
  buildCharts();
  time = Math.min(Math.max(time, startTime()), endTime());
}

// ---------- assumptions ----------

const airMass = psi => window.TANK_TABLES.isentropes.find(entry => entry.fillPsi === psi).fillDensity * 0.6;
const CONTROLS = [
  { key: 'dryMass', label: 'Car without air', min: 1300, max: 2600, step: 50,
    show: v => `${number(v)} kg · ${number(v + airMass(params.fillPsi))} with air`,
    help: 'Lars Moravy told Hagerty the car weighs "just under 1,700 kilos", without naming a trim or saying whether that includes the air. We read it as the car ready to fly, air and all: 1,500 kg of car plus about 247 kg of air is about 1,750 kg at take-off. If his figure is the car without its air, set this to 1,700 (about 1,950 kg at take-off) and the jumps get much harder. The air is counted separately because the car burns it and gets lighter during a stunt.' },
  { key: 'fillPsi', label: 'Tank fill', min: 4000, max: 10000, step: 500,
    show: v => `${number(v)} psi · ${number(airMass(v), 0)} kg`,
    help: 'Tesla said on stage that two tanks hold 600 litres "with about 250 kilos of air". That is a lot: about 545 lb of air in the space of three bathtubs. It works out to about 410 kg per cubic metre, roughly 340 times denser than the air you breathe. Squeezing nitrogen that hard takes about 7,000 psi at room temperature, from its measured real-gas properties (at that pressure it resists squeezing about 35% more than an ideal gas would). For scale, a scuba tank holds about 3,000 psi and a hydrogen car\'s tank 10,000. Moravy said the tank is rated to 10,000 psi; a "Thruster 5,500 psi" readout in Tesla\'s photos would mean about 213 kg.' },
  { key: 'nozzleThrust', label: 'Thrust per nozzle', min: 5, max: 30, step: 1, show: v => `${v} kN each`,
    help: 'Tesla said on stage that the four rear nozzles make "over 80 kN" together, so about 20 kN each. We assume the four lift nozzles at the corners are the same. The two small front jets that turn the car get a quarter of that. 20 kN is about the weight of two tonnes, so four of them can lift a car of up to about 8 tonnes for a moment.' },
  { key: 'nozzleEfficiency', label: 'Exhaust efficiency', min: 0.7, max: 1, step: 0.01,
    show: v => `${Math.round(v * 100)}% · ${number(fullTankExhaust({ ...params, nozzleEfficiency: v }), 0)} m/s`,
    help: 'How much push each kilo of air gives, compared with a perfect nozzle. Real systems lose some to friction in the nozzle, to the gas cooling as it passes through the regulator, and to the exhaust starting to condense once it gets very cold. Cold-gas thrusters usually reach 80–90% of ideal; we use 80% to be careful. The number shown is how fast the air leaves a full tank: about 523 m/s, faster than sound, which is why the exhaust shows shock diamonds.' },
  { key: 'regulatorPsi', label: 'Pressure regulator', type: 'select',
    options: [[0, 'None: thrust falls with the tank'], [500, '500 psi'], [1000, '1,000 psi'], [2000, '2,000 psi'], [3000, '3,000 psi']],
    help: 'A regulator steps the tank\'s pressure down to a steady level for the nozzles, so thrust stays at full strength until the tank itself drops below that level. Most cold-gas thruster systems use one. Tesla hasn\'t said what the Roadster uses; 1,000 psi is our guess. With none, thrust fades as the tank empties and the landings fail.' },
  { key: 'blowdown', label: 'Tank as it empties', type: 'select',
    options: [['adiabatic', 'Chills (fast use, our default)'], ['isothermal', 'Stays at 20 °C (best case)']],
    help: 'When gas rushes out of a tank, what stays behind expands and gets cold, the way a spray can chills in your hand. A stunt lasts a few seconds, too short for the tank walls to warm it, so from 7,000 psi the gas reaches about −160 °C near empty. Cold gas leaves more slowly, so each kilo gives less push, and the last ~40 kg is too cold to use. "Stays at 20 °C" is the best case, as if the walls kept it warm.' },
  { key: 'skirtGap', label: 'Fan skirt gap', min: 1, max: 30, step: 0.5, show: v => `${v} mm`,
    help: 'For the wall ride, fans suck air out from under the car and flexible skirts seal its edges against the ramp. Air leaks back in through any gap, and the fans have to keep pumping it out. Moravy described four fans of about 20 kW, so 80 kW in all. With a 3 mm gap that holds up to about 7,400 kg of suction; double the gap and it holds only about two-thirds as much. 3 mm is our guess for a smooth purpose-built ramp. The wall ride needs about 2,300 kg of suction at its worst moment, so the gap can open to about 16 mm before the fans run out, and past about 20 mm the tyres slip and the car slides back down. That assumes the skirts flex to follow the ramp: the floor is flat and the loop is curved, so with stiff skirts the gap under the middle of the car would be roughly 8 cm and the fans couldn\'t hold it.' },
  { key: 'tyreGrip', label: 'Tyre grip', min: 0.5, max: 1.6, step: 0.02, show: v => `${v.toFixed(2)} μ`,
    help: 'Tesla said on stage that the tyres alone are good for 1.26 G. That means the tyres can push the car along or sideways with 1.26 times the force pressing them into the road. On the wall the fans supply most of that pressing force, so grip and suction work together. Around 0.5, like a wet or dusty ramp, the wall ride slides back down.' },
];
const controlsHost = document.getElementById('controls');
function renderControls() {
  controlsHost.innerHTML = CONTROLS.map(control => {
    const id = `param-${control.key}`;
    const input = control.type === 'select'
      ? `<select id="${id}">${control.options.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select>`
      : `<input type="range" id="${id}" min="${control.min}" max="${control.max}" step="${control.step}">`;
    return `<div class="knob"><div class="knob-head"><label for="${id}">${control.label}</label><button class="info" type="button" aria-expanded="false" aria-controls="${id}-why" aria-label="How we got this" data-track="Info: ${control.label}">i</button><output id="${id}-out"></output></div>${input}<p class="why-note" id="${id}-why" hidden>${control.help}</p></div>`;
  }).join('');
  for (const button of controlsHost.querySelectorAll('.info')) {
    button.addEventListener('click', () => {
      const note = document.getElementById(button.getAttribute('aria-controls'));
      note.hidden = !note.hidden;
      button.setAttribute('aria-expanded', String(!note.hidden));
    });
  }
  document.getElementById('controlHelp').innerHTML = CONTROLS.map(control => `<div><dt>${control.label}</dt><dd>${control.help}</dd></div>`).join('');
  syncControls();
  for (const control of CONTROLS) {
    document.getElementById(`param-${control.key}`).addEventListener('input', event => {
      const raw = event.target.value;
      params[control.key] = control.key === 'blowdown' ? raw : Number(raw);
      syncControls();
      scheduleRerun(control.key);
    });
  }
}
function syncControls() {
  for (const control of CONTROLS) {
    const input = document.getElementById(`param-${control.key}`);
    input.value = String(params[control.key]);
    document.getElementById(`param-${control.key}-out`).textContent = control.show ? control.show(params[control.key]) : '';
  }
}
let rerunTimer = null;
function scheduleRerun(dial) {
  clearTimeout(rerunTimer);
  rerunTimer = setTimeout(() => {
    runAll();
    // The dashboard counts each property on its own and shows an event's top five values, so each
    // event carries one property: the dial with the result it led to, and the setting it was moved to.
    track('roadster_dial', { result: `${dial} ${results[current].verdict.status}` });
    track('roadster_dial_value', { value: dial === 'reset' ? 'reset' : `${dial} ${params[dial]}` });
    renderHeadline();
    refreshStunt();
    // fly the stunt again from the start with the new hardware
    time = startTime();
    updateScene(true);
    updatePanels();
    setPlaying(true);
  }, 200);
}
document.getElementById('resetParams').addEventListener('click', () => {
  params = { ...DEFAULT_PARAMS };
  syncControls();
  scheduleRerun('reset');
});

// ---------- side panel tabs ----------

const tabs = { tabHardware: 'hardwarePanel', tabNumbers: 'numbersPanel' };
for (const [tabId, panelId] of Object.entries(tabs)) {
  document.getElementById(tabId).addEventListener('click', () => {
    for (const [otherTab, otherPanel] of Object.entries(tabs)) {
      document.getElementById(otherTab).setAttribute('aria-selected', String(otherTab === tabId));
      document.getElementById(otherPanel).hidden = otherTab !== tabId;
    }
  });
}

// ---------- main loop ----------

const banner = document.getElementById('banner');
function updatePanels() {
  const { frame } = frameAt(time);
  document.getElementById('hudPhase').textContent = frame.phase;
  const s = results[current].result.summary;
  if (frame.crashed) { banner.hidden = false; banner.className = 'banner'; banner.textContent = `Crash · ${frame.phase}`; }
  else if (current === 'wall' && s.outcome?.kind !== 'held' && time >= endTime() - 0.05) { banner.hidden = false; banner.className = 'banner'; banner.textContent = s.outcome.text; }
  else if (frame.landed) { banner.hidden = false; banner.className = 'banner ok'; banner.textContent = `Landed · ${number(s.touchdownSpeed ?? 0, 1)} m/s`; }
  else banner.hidden = true;
  updateGauges(frame);
  updateReadouts(frame);
  drawPlayheads();
}

function resize() {
  const width = viewport.clientWidth, height = viewport.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.fov = camera.aspect < 1.3 ? 58 : 40; // keep the same width of scene on tall phone screens
  camera.updateProjectionMatrix();
  for (const chart of charts) renderChartCache(chart);
  renderTicks();
}
new ResizeObserver(resize).observe(viewport);

function loop(now) {
  const elapsed = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  if (playing) {
    time += elapsed * Number(speedSelect.value);
    if (time >= endTime()) {
      time = endTime();
      setPlaying(false);
      track('roadster_replay_end', { stunt: current, speed: speedSelect.value });
    }
  }
  updateScene();
  if (cameraMode === 'orbit') controls.update();
  renderer.render(scene, camera);
  if (now - lastPanelUpdate > 60) { updatePanels(); lastPanelUpdate = now; }
  requestAnimationFrame(loop);
}

runAll();
renderHeadline();
renderControls();
const requested = location.hash.slice(1);
select(STUNTS.some(s => s.id === requested) ? requested : current, false);
resize();
requestAnimationFrame(loop);
