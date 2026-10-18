// Procedural vehicle models for the Roadster Physics Check scene, traced from reference photos:
//   Model 3 Highland  — "Tesla Model 3 (2023), long range, Japan, left-side.jpg" by Kazyakuruma (Wikimedia Commons, CC0)
//   Cybercab          — "Tesla Cybercab at Santana Row side view dllu.jpg" by Dllu (Commons, CC BY-SA 4.0)
//   Tesla Semi        — "Tesla Semi Render.svg" by Jzh2074 (Commons, CC BY-SA 4.0), an orthographic side view
//   Model Y, Cybertruck — published dimensions, details from Commons photos (Cybertruck by Mpelas199, CC0)
//   Roadster (2026)   — our own estimate from Tesla's livestream (no licensed reference photo)
// Side-profile points were read off a grid laid over each photo, then scaled so the wheel centres sit at the
// published wheelbase and the roof at the published height. Each body is a loft: a run of cross-sections
// along the car, smooth (superellipse) for the round cars and faceted for the angular ones.
// Every vehicle is built nose toward +x, roof +y, origin on the ground under the middle of the car.
import * as THREE from 'three';
import { monotoneCubic } from './physics.js?v=20261017m';

const curve = points => monotoneCubic(points.map(p => p[0]), points.map(p => p[1]));

// ---------- materials ----------

const paint = (color, options = {}) => new THREE.MeshPhysicalMaterial({
  color, metalness: 0.4, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06, ...options,
});
const GLASS = new THREE.MeshPhysicalMaterial({ color: 0x050608, metalness: 0.7, roughness: 0.04, clearcoat: 1 });
const PANE = new THREE.MeshPhysicalMaterial({ color: 0x050608, metalness: 0.7, roughness: 0.04, clearcoat: 1, side: THREE.DoubleSide });
const GOLD_GLASS = new THREE.MeshPhysicalMaterial({ color: 0x6a4818, metalness: 0.95, roughness: 0.06, clearcoat: 1, flatShading: true });
const TYRE = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.88 });
const TRIM = new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.55, metalness: 0.2 });
const lamp = color => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.6 });

// ---------- geometry ----------

// Superellipse cross-section: exponent 2 is an ellipse, higher is boxier
const roundSection = ({ topRound = 6, bottomRound = 9, taper = 0, around = 44 } = {}) => (width, low, high) => {
  const points = [], middle = (low + high) / 2, half = (high - low) / 2;
  for (let j = 0; j < around; j++) {
    const angle = 2 * Math.PI * j / around, c = Math.cos(angle), s = Math.sin(angle);
    const exponent = 2 / (s >= 0 ? topRound : bottomRound);
    const v = Math.sign(s) * Math.abs(s) ** exponent;
    const z = Math.sign(c) * Math.abs(c) ** exponent * width * (1 - taper * Math.max(0, (v + 1) / 2) ** 1.5);
    points.push([z, middle + half * v]);
  }
  return points;
};

// Faceted cross-section for the wedge cars: flat sides, chamfered shoulders and sills, a narrower flat top.
// Points run from the +z side, over the top, down the -z side and back under.
const facetSection = ({ topWidth = 0.8, shoulder = 0.72, sill = 0.16 } = {}) => (width, low, high) => {
  const h = high - low;
  return [
    [width, low + sill * h], [width, low + shoulder * h], [width * topWidth, high],
    [-width * topWidth, high], [-width, low + shoulder * h], [-width, low + sill * h],
    [-width * 0.9, low], [width * 0.9, low],
  ];
};

// stations along x; section(width, low, high) gives the outline; materialAt(x, y, z) picks a material per quad
// rounding (m) rounds the nose and tail corners in plan view; floor is the width share left at the very end
export function loft({ from, to, count = 140, bottom, top, halfWidth, section, materialAt, rounding = 0, floor = 0.6 }) {
  const rings = [], positions = [];
  let around = 0;
  const corner = x => {
    const distance = Math.min(x - from, to - x);
    if (!rounding || distance >= rounding) return 1;
    const u = 1 - distance / rounding;
    return floor + (1 - floor) * Math.sqrt(1 - u * u);
  };
  for (let i = 0; i <= count; i++) {
    const x = from + (to - from) * i / count;
    const low = bottom(x), high = Math.max(top(x), low + 0.004);
    const outline = section(halfWidth(x) * corner(x), low, high);
    around = outline.length;
    rings.push(outline.map(([z, y]) => { positions.push(x, y, z); return positions.length / 3 - 1; }));
  }
  const buckets = new Map();
  const add = (material, ...triangle) => { if (!buckets.has(material)) buckets.set(material, []); buckets.get(material).push(...triangle); };
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < around; j++) {
      const a = rings[i][j], b = rings[i][(j + 1) % around], c = rings[i + 1][j], d = rings[i + 1][(j + 1) % around];
      const material = materialAt ? materialAt((positions[a * 3] + positions[d * 3]) / 2, (positions[a * 3 + 1] + positions[d * 3 + 1]) / 2,
        (positions[a * 3 + 2] + positions[d * 3 + 2]) / 2) : 0;
      add(material, a, c, b, b, c, d);
    }
  }
  // flat end caps with their own vertices so the sides keep smooth normals
  for (const [index, flip] of [[0, true], [count, false]]) {
    const start = positions.length / 3;
    let cy = 0, cz = 0;
    for (const vertex of rings[index]) { positions.push(positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]); cy += positions[vertex * 3 + 1]; cz += positions[vertex * 3 + 2]; }
    positions.push(positions[rings[index][0] * 3], cy / around, cz / around);
    const centre = start + around;
    for (let j = 0; j < around; j++) {
      const a = start + j, b = start + (j + 1) % around;
      if (flip) add(0, centre, b, a); else add(0, centre, a, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const indices = [];
  for (const [material, list] of [...buckets.entries()].sort((p, q) => p[0] - q[0])) {
    geometry.addGroup(indices.length, list.length, material);
    for (const index of list) indices.push(index);
  }
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// Sill line that rises over each wheel: semicircular arches
function withArches(base, wheels) {
  return x => {
    let y = base(x);
    for (const wheel of wheels) {
      const dx = x - wheel.x;
      if (Math.abs(dx) < wheel.arch) y = Math.max(y, wheel.y + Math.sqrt(wheel.arch * wheel.arch - dx * dx));
    }
    return y;
  };
}

export function wheel(radius, width, { rimColor = 0x9da1a8, aero = false, spokes = 5, star = false } = {}) {
  const group = new THREE.Group();
  const inner = radius * (aero ? 0.74 : 0.7);
  const r = 0.04;
  const profile = [[inner, -width / 2], [radius - r, -width / 2], [radius, -width / 2 + r], [radius, width / 2 - r], [radius - r, width / 2], [inner, width / 2]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  const rim = new THREE.MeshStandardMaterial({ color: rimColor, metalness: 0.85, roughness: aero ? 0.35 : 0.25 });
  group.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 56), TYRE));
  group.add(new THREE.Mesh(new THREE.CylinderGeometry(inner, inner, width * 0.9, 48, 1, true), TRIM));
  const face = new THREE.Mesh(new THREE.CylinderGeometry(inner, inner, 0.02, 48), aero ? rim : TRIM);
  face.position.y = width * 0.38;
  group.add(face);
  if (aero) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(inner * 0.62, 0.012, 8, 48), TRIM);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = width * 0.4;
    group.add(ring);
  } else {
    for (let i = 0; i < spokes; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(star ? 0.09 : 0.06, 0.04, inner * 0.92), rim);
      spoke.geometry.translate(0, 0, inner * 0.46);
      spoke.position.y = width * 0.42;
      spoke.rotation.y = i * 2 * Math.PI / spokes;
      group.add(spoke);
      if (star) { // the Roadster's star spokes split into a V toward the rim
        const fork = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, inner * 0.5), rim);
        fork.geometry.translate(0, 0, inner * 0.7);
        fork.position.y = width * 0.42;
        fork.rotation.y = i * 2 * Math.PI / spokes + 0.22;
        group.add(fork);
      }
    }
    const lip = new THREE.Mesh(new THREE.TorusGeometry(inner * 0.99, 0.015, 8, 48), rim);
    lip.rotation.x = Math.PI / 2;
    lip.position.y = width * 0.42;
    group.add(lip);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(inner * 0.16, inner * 0.16, 0.05, 20), rim);
  hub.position.y = width * 0.44;
  group.add(hub);
  const holder = new THREE.Group();
  group.rotation.x = Math.PI / 2; // axis along z, outer face toward +z
  holder.add(group);
  return holder;
}

function placeWheels(car, wheels, makeWheel) {
  for (const spec of wheels) {
    for (const side of [1, -1]) {
      const unit = makeWheel(spec);
      unit.position.set(spec.x, spec.y, side * spec.z);
      if (side < 0) unit.rotation.y = Math.PI;
      car.add(unit);
    }
  }
}

function box(material, size, position, rotation = [0, 0, 0]) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  return mesh;
}

function finish(group) {
  group.traverse(mesh => { if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; } });
  return group;
}

// A rounded Tesla: painted body to the beltline plus a dark glass greenhouse
function roundCar({ wheels, wheelRadius, body, sill, width, cabin, cabinWidth, color, taper = 0.3, aero = true, rimColor }) {
  const car = new THREE.Group();
  const from = body[0][0], to = body[body.length - 1][0];
  const arches = wheels.map(x => ({ x, y: wheelRadius, arch: wheelRadius + 0.075 }));
  const top = curve(body);
  car.add(new THREE.Mesh(loft({
    from, to, count: 200, bottom: withArches(curve(sill), arches), top, halfWidth: curve(width), section: roundSection(), rounding: 0.6, floor: 0.32,
  }), paint(color)));
  car.add(new THREE.Mesh(loft({
    from: cabin[0][0], to: cabin[cabin.length - 1][0], count: 100,
    bottom: x => top(x) - 0.08, top: curve(cabin), halfWidth: curve(cabinWidth), section: roundSection({ topRound: 3.2, bottomRound: 12, taper }),
  }), GLASS));
  const track = curve(width)(0) - 0.15;
  placeWheels(car, wheels.map(x => ({ x, y: wheelRadius, z: track })), () => wheel(wheelRadius, 0.25, { aero, rimColor }));
  return car;
}

// ---------- the vehicles ----------

// The 2026 Roadster: a faceted wedge with a gold-glazed canopy, black louvred rear deck, a tall rear wing,
// a full-width taillight and five-point star wheels. The caller moves its origin to the centre of gravity.
export function buildRoadster() {
  const car = new THREE.Group();
  const wheels = [{ x: -1.38, y: 0.36, arch: 0.43 }, { x: 1.27, y: 0.36, arch: 0.43 }];
  const top = curve([[-2.2, 0.86], [-2.0, 0.92], [-1.5, 0.93], [-0.95, 0.92], [-0.6, 0.9], [0, 0.88], [0.85, 0.83], [1.3, 0.74], [1.8, 0.6], [2.2, 0.44]]);
  const white = paint(0xf2f3f4, { flatShading: true, metalness: 0.3 });
  car.add(new THREE.Mesh(loft({
    from: -2.2, to: 2.2, count: 120, rounding: 0.35, floor: 0.7,
    bottom: withArches(curve([[-2.2, 0.32], [-2.0, 0.16], [2.0, 0.15], [2.2, 0.27]]), wheels), top,
    halfWidth: curve([[-2.2, 0.9], [-2.0, 0.99], [-1.4, 1.01], [0, 0.96], [1.3, 0.99], [1.9, 0.88], [2.2, 0.6]]),
    section: facetSection({ topWidth: 0.78, shoulder: 0.66, sill: 0.2 }),
    materialAt: (x, y) => (y < 0.33 && x > -2.0 && x < 2.0 ? 1 : 0), // black sills
  }), [white, TRIM]));
  const canopyWidth = curve([[-1.02, 0.74], [-0.2, 0.8], [0.92, 0.7]]);
  car.add(new THREE.Mesh(loft({
    from: -1.02, to: 0.92, count: 60, bottom: x => top(x) - 0.03,
    top: curve([[-1.02, 0.93], [-0.75, 1.1], [-0.1, 1.13], [0.35, 1.05], [0.92, 0.85]]),
    halfWidth: canopyWidth, section: facetSection({ topWidth: 0.72, shoulder: 0.25, sill: 0.02 }),
    materialAt: (x, y, z) => (Math.abs(z) > canopyWidth(x) * 0.86 ? 0 : 1), // gold side glass, black screen and roof
  }), [GOLD_GLASS, GLASS]));
  // louvred black glass over the rear deck
  for (let i = 0; i < 6; i++) car.add(box(TRIM, [0.1, 0.02, 1.25], [-1.12 - i * 0.14, 0.945, 0], [0, 0, 0.05]));
  // rear wing on two swan-neck posts
  for (const z of [-0.5, 0.5]) car.add(box(TRIM, [0.08, 0.42, 0.05], [-1.98, 1.1, z], [0, 0, 0.25]));
  car.add(box(white, [0.55, 0.05, 1.96], [-2.05, 1.32, 0], [0, 0, 0.09]));
  for (const z of [-0.99, 0.99]) car.add(box(white, [0.6, 0.18, 0.03], [-2.05, 1.26, z]));
  // side intakes behind the doors, diffuser, splitter, lights
  for (const z of [-1, 1]) car.add(box(TRIM, [0.7, 0.2, 0.02], [-0.55, 0.52, z * 0.995], [0, 0, -0.12]));
  car.add(box(TRIM, [0.42, 0.22, 1.7], [-2.02, 0.3, 0]), box(TRIM, [0.45, 0.04, 1.4], [1.95, 0.17, 0]));
  car.add(box(lamp(0xff2020), [0.03, 0.05, 1.8], [-2.205, 0.8, 0]));
  for (const z of [-0.42, 0.42]) car.add(box(lamp(0xffffff), [0.04, 0.025, 0.3], [2.1, 0.5, z], [0, z > 0 ? -0.5 : 0.5, 0]));
  placeWheels(car, wheels.map(w => ({ ...w, z: 0.86 })), () => wheel(0.36, 0.3, { rimColor: 0x2b2d31, star: true }));
  return finish(car);
}

export function buildModel3(color = 0x1f4fa8) {
  const car = roundCar({
    wheels: [-1.4375, 1.4375], wheelRadius: 0.345, color,
    body: [[-2.36, 0.75], [-2.33, 0.99], [-2.24, 1.07], [-1.89, 1.11], [-1.42, 1.13], [-0.9, 1.1], [-0.03, 1.05], [0.73, 1.0], [1.43, 0.96], [1.84, 0.91], [2.2, 0.82], [2.31, 0.72], [2.36, 0.58]],
    sill: [[-2.36, 0.46], [-1.89, 0.29], [2.18, 0.3], [2.36, 0.46]],
    width: [[-2.36, 0.8], [-2.1, 0.9], [-1.4, 0.93], [0, 0.925], [1.4, 0.92], [2.0, 0.88], [2.36, 0.72]],
    cabin: [[-1.67, 1.14], [-1.49, 1.22], [-1.19, 1.33], [-0.96, 1.41], [-0.61, 1.44], [-0.32, 1.44], [-0.03, 1.42], [0.26, 1.36], [0.55, 1.24], [0.82, 1.02]],
    cabinWidth: [[-1.67, 0.8], [-0.5, 0.87], [0.82, 0.84]], taper: 0.24,
  });
  for (const z of [-0.62, 0.62]) car.add(box(lamp(0xffffff), [0.04, 0.03, 0.28], [2.3, 0.76, z], [0, z > 0 ? -0.45 : 0.45, 0]));
  for (const z of [-0.6, 0.6]) car.add(box(lamp(0xff2020), [0.03, 0.06, 0.32], [-2.33, 0.98, z]));
  return finish(car);
}

export function buildModelY(color = 0xe3e6ea) {
  const car = roundCar({
    wheels: [-1.445, 1.445], wheelRadius: 0.37, color,
    body: [[-2.39, 0.8], [-2.36, 1.06], [-2.25, 1.13], [-1.9, 1.17], [-1.4, 1.19], [-0.9, 1.17], [0, 1.12], [0.75, 1.07], [1.45, 1.02], [1.9, 0.96], [2.25, 0.88], [2.34, 0.78], [2.39, 0.62]],
    sill: [[-2.39, 0.5], [-1.95, 0.33], [2.2, 0.34], [2.39, 0.5]],
    width: [[-2.39, 0.84], [-2.1, 0.94], [-1.4, 0.965], [0, 0.96], [1.4, 0.955], [2.0, 0.91], [2.39, 0.75]],
    cabin: [[-2.2, 1.17], [-2.0, 1.33], [-1.6, 1.5], [-1.1, 1.6], [-0.5, 1.624], [0, 1.6], [0.3, 1.52], [0.6, 1.32], [0.88, 1.08]],
    cabinWidth: [[-2.2, 0.82], [-0.5, 0.9], [0.88, 0.86]], taper: 0.24,
  });
  car.add(box(lamp(0xffffff), [0.03, 0.025, 1.5], [2.36, 0.87, 0]));      // Juniper's full-width light bar
  car.add(box(lamp(0xff2020), [0.03, 0.04, 1.55], [-2.37, 1.02, 0]));
  return finish(car);
}

export function buildCybercab() {
  const car = roundCar({
    wheels: [-1.36, 1.45], wheelRadius: 0.38, color: 0xcdb991, aero: true, rimColor: 0xcdb991,
    body: [[-2.02, 0.74], [-1.98, 0.93], [-1.86, 0.99], [-1.55, 1.08], [-1.03, 1.18], [-0.45, 1.13], [0.28, 1.06], [1.01, 0.99], [1.25, 0.95], [1.62, 0.85], [1.93, 0.72], [2.01, 0.52]],
    sill: [[-2.02, 0.42], [-1.8, 0.27], [1.8, 0.27], [2.01, 0.42]],
    width: [[-2.02, 0.8], [-1.7, 0.95], [0, 0.97], [1.6, 0.95], [2.01, 0.78]],
    cabin: [[-1.13, 1.17], [-0.94, 1.23], [-0.64, 1.31], [-0.33, 1.34], [0.03, 1.34], [0.4, 1.28], [0.77, 1.14], [1.04, 0.98]],
    cabinWidth: [[-1.13, 0.84], [0, 0.9], [1.04, 0.86]], taper: 0.3,
  });
  for (const z of [-0.975, 0.975]) car.add(box(TRIM, [2.4, 0.1, 0.03], [0.05, 0.33, z]));   // black rocker band
  car.add(box(TRIM, [0.05, 0.3, 1.5], [-2.03, 0.42, 0]));
  car.add(box(lamp(0xffffff), [0.03, 0.025, 1.6], [2.0, 0.66, 0]), box(lamp(0xff2020), [0.03, 0.03, 1.6], [-2.03, 0.9, 0]));
  return finish(car);
}

// Cybertruck: flat stainless sides from an extruded profile, black trapezoid fender flares and rockers
export function buildCybertruck() {
  const truck = new THREE.Group();
  const flat = ([x, y]) => new THREE.Vector2(x, y);
  const outline = [
    [2.84, 0.6], [2.84, 1.07], [0.2, 1.79], [-2.84, 1.3], [-2.84, 0.6], [-2.48, 0.6], [-2.36, 0.98], [-1.44, 0.98], [-1.32, 0.6],
    [1.32, 0.6], [1.44, 0.98], [2.36, 0.98], [2.48, 0.6],
  ];
  const depth = 1.96;
  const body = new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(flat)), { depth, bevelEnabled: true, bevelSize: 0.025, bevelThickness: 0.025, bevelSegments: 2 });
  body.translate(0, 0, -depth / 2);
  truck.add(new THREE.Mesh(body, new THREE.MeshStandardMaterial({ color: 0xb6babf, metalness: 1, roughness: 0.34 })));
  // fender flares: trapezoid frames sticking out past the body
  for (const centre of [-1.9, 1.9]) {
    const outer = new THREE.Shape([[centre - 0.7, 0.55], [centre - 0.56, 1.1], [centre + 0.56, 1.1], [centre + 0.7, 0.55]].map(flat));
    outer.holes.push(new THREE.Path([[centre - 0.58, 0.55], [centre - 0.46, 0.98], [centre + 0.46, 0.98], [centre + 0.58, 0.55]].map(flat)));
    const flare = new THREE.ExtrudeGeometry(outer, { depth: 2.12, bevelEnabled: false });
    flare.translate(0, 0, -1.06);
    truck.add(new THREE.Mesh(flare, TRIM));
  }
  for (const z of [-1, 1]) truck.add(box(TRIM, [2.6, 0.2, 0.06], [0, 0.66, z * 1.0]));
  // glass: windshield on the slope, side windows
  const slope = x => 1.07 + (x - 2.84) * (1.79 - 1.07) / (0.2 - 2.84);
  const windshield = new THREE.BufferGeometry();
  const glassPoints = [[2.15, -0.92], [2.15, 0.92], [0.38, 0.86], [2.15, -0.92], [0.38, 0.86], [0.38, -0.86]];
  windshield.setAttribute('position', new THREE.Float32BufferAttribute(glassPoints.flatMap(([x, z]) => [x, slope(x) + 0.03, z]), 3));
  windshield.computeVertexNormals();
  truck.add(new THREE.Mesh(windshield, PANE));
  const pane = new THREE.ShapeGeometry(new THREE.Shape([[1.72, 1.2], [0.28, 1.68], [-1.32, 1.48], [-1.32, 1.2]].map(flat)));
  for (const side of [1, -1]) {
    const mesh = new THREE.Mesh(pane, PANE);
    mesh.position.z = side * (depth / 2 + 0.03);
    truck.add(mesh);
  }
  truck.add(box(lamp(0xffffff), [0.03, 0.03, 1.95], [2.87, 1.06, 0]), box(lamp(0xff2020), [0.03, 0.04, 1.95], [-2.87, 1.28, 0]));
  placeWheels(truck, [{ x: -1.9, y: 0.43, z: 0.9 }, { x: 1.9, y: 0.43, z: 0.9 }], () => wheel(0.43, 0.32, { aero: true, rimColor: 0x55595f }));
  return finish(truck);
}

// Tesla Semi tractor, traced from the orthographic render: tall cab with a raked nose and wrap-around
// windscreen, a dark aero fairing over the drive axles
export function buildSemi() {
  const semi = new THREE.Group();
  const white = paint(0xf1f2f3, { metalness: 0.2 });
  const steer = { x: 1.95, y: 0.54, arch: 0.66 };
  const cab = loft({
    from: -1.02, to: 3.4, count: 260,
    bottom: withArches(curve([[-1.02, 3.6], [-0.97, 2.4], [-0.88, 1.2], [-0.8, 0.92], [-0.45, 0.58], [0.2, 0.52], [3.4, 0.5]]), [steer]),
    top: curve([[-1.02, 4.06], [-0.39, 4.11], [0.12, 4.05], [0.73, 3.88], [1.34, 3.57], [1.95, 3.11], [2.46, 2.5], [2.87, 1.89], [3.12, 1.38], [3.33, 1.02], [3.4, 0.82]]),
    halfWidth: curve([[-1.02, 1.2], [0, 1.27], [2.4, 1.27], [3.1, 1.2], [3.4, 1.05]]),
    section: roundSection({ topRound: 7, bottomRound: 14, around: 160 }), rounding: 0.5, floor: 0.75,
    materialAt: (x, y, z) => {
      const windscreen = x > 1.73 && y > 1.6 && y < 2.76 && y > 2.75 - 1.7 * (x - 1.73); // side edge runs diagonally down the A-pillar
      const sideWindow = x > 0.32 && x < 1.24 && y > 2.0 && y < 2.78 && Math.abs(z) > 1.0;
      return windscreen || sideWindow ? 1 : 0;
    },
  });
  semi.add(new THREE.Mesh(cab, [white, GLASS]));
  const fairing = loft({
    from: -3.4, to: -0.75, count: 40, bottom: () => 0.16,
    top: curve([[-3.4, 0.55], [-3.25, 0.9], [-2.9, 0.97], [-0.75, 0.97]]), halfWidth: () => 1.24,
    section: roundSection({ topRound: 8, bottomRound: 12 }),
  });
  semi.add(new THREE.Mesh(fairing, new THREE.MeshStandardMaterial({ color: 0x4a4d53, roughness: 0.5, metalness: 0.4 })));
  semi.add(box(TRIM, [0.05, 0.05, 2.3], [-0.2, 2.81, 0]));
  for (const z of [-1.0, 1.0]) semi.add(box(TRIM, [2.7, 0.02, 0.02], [0.35, 2.81, z * 1.26]));
  semi.add(box(lamp(0xffffff), [0.03, 0.03, 1.9], [3.38, 1.08, 0]));
  for (const z of [-0.85, 0.85]) semi.add(box(lamp(0xffffff), [0.12, 0.05, 0.3], [3.2, 1.2, z], [0, 0, 0.6]));
  placeWheels(semi, [{ x: steer.x, y: 0.54, z: 1.02 }], () => wheel(0.54, 0.3, { aero: true, rimColor: 0xb8bcc2 }));
  placeWheels(semi, [{ x: -1.75, y: 0.52, z: 0.98 }, { x: -3.0, y: 0.52, z: 0.98 }], () => wheel(0.52, 0.3, { aero: true, rimColor: 0x6d7076 }));
  return finish(semi);
}

export const FLEET_BUILDERS = {
  Cybercab: buildCybercab, Cybertruck: buildCybertruck, Semi: buildSemi, 'Model Y': () => buildModelY(), 'Model 3': () => buildModel3(),
};
