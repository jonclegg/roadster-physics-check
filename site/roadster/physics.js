// Physics for the Roadster Physics Check page. Pure functions, no DOM: each stunt is simulated at
// 240 Hz and recorded at 60 Hz for playback. Units are SI unless a name says otherwise.
//
// Nothing here follows the video's path. Each stunt is a program for the car's flight computer, read off
// the video, and the car flies it as a rigid body with real nozzles, a real tank and real grip. Change the
// hardware and the same program may come up short.

export const GRAVITY = 9.81;
export const FEET = 0.3048;
export const MPH = 0.44704;
export const RAMP_RADIUS = 10.5;
export const RAMP_LIP_DEGREES = 170;
export const RIDE_HEIGHT = 0.45; // centre of gravity above the road
export const FRAME_RATE = 60;

const ATMOSPHERE_PSI = 14.696;
const NITROGEN_SPECIFIC_HEAT = 1039;
const GAMMA = 1.4;
const TANK_VOLUME = 0.6;
const STEP = 1 / 240;
const RECORD_EVERY = 4;
const ALTITUDE_LAG = 0.25; // the broadcast altitude gauge trails the G gauge by about this much
const FLOOR_AREA = 4.0;
const SKIRT_PERIMETER = 8.5; // around ~4 m² of sealed floor
const AIR_DENSITY = 1.2;
const FAN_EFFICIENCY = 0.6;

export const DEFAULT_PARAMS = {
  dryMass: 1500,          // car without the gas; with its ~250 kg of air it weighs ~1,750 kg
  fillPsi: 7000,          // 7,000 psi of nitrogen in 600 L is 247 kg, matching Tesla's "about 250 kilos"
  nozzleEfficiency: 0.8,  // share of the ideal exhaust speed delivered: nozzle losses, regulator (Joule-Thomson)
                          // cooling and late-blowdown condensation together cost about 15-20%
  blowdown: 'adiabatic',  // tank gas chills as it expands (no heat from the walls)
  nozzleThrust: 20,       // kN per nozzle; four rear nozzles = Tesla's "over 80 kN"
  regulatorPsi: 1000,     // 0 = no regulator: thrust falls with tank pressure
  skirtGap: 3,            // mm of leak gap under the fan skirts
  tyreGrip: 1.26,         // Tesla's quoted tyre-only limit
};

let tables = null;
export function setTankTables(tankTables) { tables = tankTables; }

// ---------- interpolation ----------

export function linear(xs, ys) {
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let index = 1;
    while (xs[index] < x) index++;
    const share = (x - xs[index - 1]) / (xs[index] - xs[index - 1]);
    return ys[index - 1] + share * (ys[index] - ys[index - 1]);
  };
}

// Monotone cubic (Fritsch-Carlson): smooth, no overshoot between readings
export function monotoneCubic(xs, ys) {
  const count = xs.length;
  const slopes = [];
  for (let i = 0; i < count - 1; i++) slopes.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const tangents = [slopes[0]];
  for (let i = 1; i < count - 1; i++) {
    if (slopes[i - 1] * slopes[i] <= 0) { tangents.push(0); continue; }
    const before = xs[i] - xs[i - 1], after = xs[i + 1] - xs[i];
    const weightA = 2 * after + before, weightB = after + 2 * before;
    tangents.push((weightA + weightB) / (weightA / slopes[i - 1] + weightB / slopes[i]));
  }
  tangents.push(slopes[count - 2]);
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[count - 1]) return ys[count - 1];
    let i = 1;
    while (xs[i] < x) i++;
    i -= 1;
    const span = xs[i + 1] - xs[i], u = (x - xs[i]) / span;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * span * tangents[i]
      + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * span * tangents[i + 1];
  };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// ---------- quaternions (x, y, z, w); world y is up, the car's nose is +x and its roof +y ----------

function axisAngle(axis, angle) {
  const half = angle / 2, s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}
function multiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function rotate(q, vector) {
  const [x, y, z, w] = q;
  const ix = w * vector[0] + y * vector[2] - z * vector[1];
  const iy = w * vector[1] + z * vector[0] - x * vector[2];
  const iz = w * vector[2] + x * vector[1] - y * vector[0];
  const iw = -x * vector[0] - y * vector[1] - z * vector[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = a => Math.hypot(a[0], a[1], a[2]);

// Attitude from yaw (about world up), pitch (nose up, about the car's right-hand axis) and roll (about the nose)
export function attitude(yaw, pitch, roll) {
  return multiply(multiply(axisAngle([0, 1, 0], yaw), axisAngle([0, 0, 1], pitch)), axisAngle([1, 0, 0], roll));
}

// ---------- the tank ----------

function exhaustSpeed(nozzlePsi, temperature, efficiency) {
  if (nozzlePsi <= ATMOSPHERE_PSI) return 0;
  const expansion = 1 - (ATMOSPHERE_PSI / nozzlePsi) ** ((GAMMA - 1) / GAMMA);
  return efficiency * Math.sqrt(2 * NITROGEN_SPECIFIC_HEAT * temperature * expansion);
}

export class Tank {
  constructor(params) {
    this.params = params;
    this.isentrope = tables.isentropes.find(entry => entry.fillPsi === params.fillPsi);
    if (!this.isentrope) throw new Error(`No tank table for ${params.fillPsi} psi`);
    this.fullGas = this.isentrope.fillDensity * TANK_VOLUME;
    this.gas = this.fullGas;
    const lastRow = this.isentrope.rows[this.isentrope.rows.length - 1];
    // Adiabatic blowdown chills the last of the gas toward liquefaction; below this it can't be used
    this.strandedGas = params.blowdown === 'adiabatic' ? lastRow[0] * TANK_VOLUME : 0;
    this.densities = this.isentrope.rows.map(row => row[0]).reverse();
    this.pressureOf = monotoneCubic(this.densities, this.isentrope.rows.map(row => row[1]).reverse());
    this.temperatureOf = monotoneCubic(this.densities, this.isentrope.rows.map(row => row[2]).reverse());
    this.isothermPressure = linear(tables.isotherm.map(row => row[0]), tables.isotherm.map(row => row[1]));
    this.update();
  }

  update() {
    const density = this.gas / TANK_VOLUME;
    if (this.params.blowdown === 'isothermal') {
      this.psi = this.isothermPressure(density);
      this.temperature = tables.fillTemperature;
    } else {
      this.psi = this.pressureOf(Math.max(density, this.densities[0]));
      this.temperature = this.temperatureOf(Math.max(density, this.densities[0]));
    }
    const regulator = this.params.regulatorPsi;
    this.nozzlePsi = regulator > 0 ? Math.min(this.psi, regulator) : this.psi;
    const designPsi = regulator > 0 ? Math.min(regulator, this.params.fillPsi) : this.params.fillPsi;
    const usable = this.gas > this.strandedGas + 0.05;
    this.capacityShare = usable ? Math.min(1, this.nozzlePsi / designPsi) : 0;
    this.exhaustSpeed = usable ? exhaustSpeed(this.nozzlePsi, this.temperature, this.params.nozzleEfficiency) : 0;
  }

  // Burn gas to make `force` newtons for `seconds`; returns the mass flow in kg/s
  burn(force, seconds) {
    if (force <= 0 || this.exhaustSpeed <= 0) return 0;
    const flow = force / this.exhaustSpeed;
    this.gas = Math.max(this.strandedGas, this.gas - flow * seconds);
    this.update();
    return flow;
  }
}

// ---------- the car as a rigid body ----------
//
// Body frame: nose +x, roof +y, right-hand z. Origin at the centre of gravity, 0.45 m above the road.
// Four lift nozzles near the corners push along +y, four rear nozzles push along +x, and two front
// jets push sideways for yaw. Every push is applied where its nozzle is, so it makes a turning moment
// as well as a force; rolling the car means one side pushing harder than the other. The wheels keep
// spinning after lift-off, and like a gyroscope they swing the nose sideways when the car rolls: the
// yaw jets cancel that.

const CORNER_NOZZLES = [[1.55, -0.3, 0.62], [-1.55, -0.3, 0.62], [1.55, -0.3, -0.62], [-1.55, -0.3, -0.62]];
const CORNER_X = 1.55, CORNER_Z = 0.62;
const REAR_NOZZLE_DROP = 0.15;   // rear nozzles sit this far below the centre of gravity
const YAW_NOZZLE_X = 2.0;        // front yaw jets sit this far ahead of it
const YAW_NOZZLE_SHARE = 0.25;   // each yaw jet makes a quarter of a main nozzle's thrust
const WHEEL_RADIUS = 0.36;
const WHEEL_SPIN_INERTIA = 6;    // kg·m²: four wheels and tyres at about 1.3 each, plus three motor rotors geared 8.4:1
const ROLL_GYRATION = 0.6, YAW_GYRATION = 1.3, PITCH_GYRATION = 1.25; // m: battery-floor cars carry mass low
const ATTITUDE_FREQUENCY = 10;   // rad/s: how stiffly the flight computer holds the attitude it wants
const ATTITUDE_DAMPING = 0.9;
const MAX_LEAN = 15 * Math.PI / 180;
const LEVEL_BY = 1.5;            // m: the lean fades to level over the last 1.5 m so the car lands flat
const UPRIGHT = Math.cos(25 * Math.PI / 180);
const SAFE_TOUCHDOWN = 3;        // m/s: harder than this and the suspension doesn't save it
const MOTOR_FORCE = 32700;       // N at the tyres: over 1,400 N·m through 8.4:1 on 0.36 m wheels
const FAN_POWER = 80000;         // W: four fans of about 20 kW (Moravy)
const FLOOR_BELOW_CENTRE = 0.3;
// Points on the body used for ground contact and for hitting the parked cars
const BODY_POINTS = [];
for (const x of [-2.2, 0, 2.2]) for (const y of [-RIDE_HEIGHT, 0.1, 0.7]) for (const z of [-0.95, 0, 0.95]) BODY_POINTS.push([x, y, z]);

function conjugate(q) { return [-q[0], -q[1], -q[2], q[3]]; }
function normalise(q) { const n = Math.hypot(q[0], q[1], q[2], q[3]); return q.map(v => v / n); }

// Rotation (as a body-frame rotation vector) that takes attitude q to attitude target
function attitudeError(q, target) {
  const e = multiply(conjugate(q), target);
  const sign = e[3] < 0 ? -1 : 1;
  const s = Math.hypot(e[0], e[1], e[2]);
  if (s < 1e-9) return [0, 0, 0];
  const angle = 2 * Math.atan2(s, Math.abs(e[3]));
  return [e[0] * sign / s * angle, e[1] * sign / s * angle, e[2] * sign / s * angle];
}

// Yaw, pitch and roll for attitude(yaw, pitch, roll); roll is unwrapped to stay near the previous value
function anglesOf(q, previousRoll) {
  const nose = rotate(q, [1, 0, 0]);
  const pitch = Math.asin(clamp(nose[1], -1, 1));
  const yaw = Math.atan2(-nose[2], nose[0]);
  const rest = multiply(conjugate(multiply(axisAngle([0, 1, 0], yaw), axisAngle([0, 0, 1], pitch))), q);
  let roll = 2 * Math.atan2(rest[0], rest[3]);
  if (previousRoll !== undefined) roll += 2 * Math.PI * Math.round((previousRoll - roll) / (2 * Math.PI));
  return { yaw, pitch, roll };
}

// Attitude that points the roof along `up` (world) while facing `yaw`, near roll `rollBase`
function attitudeToward(up, yaw, rollBase = 0) {
  const c = Math.cos(-yaw), s = Math.sin(-yaw);
  const local = [c * up[0] + s * up[2], up[1], -s * up[0] + c * up[2]];
  const pitch = Math.atan2(-local[0], local[1]);
  const roll = Math.asin(clamp(local[2], -1, 1));
  return attitude(yaw, pitch, rollBase + roll);
}

// Share a wanted lift and roll/pitch moments between the four corner nozzles. Nozzles only push, and
// each makes at most `perNozzle`, so the moments win first and the lift gets what's left.
function allocateCorners(lift, rollMoment, pitchMoment, perNozzle) {
  const parts = CORNER_NOZZLES.map(([x, , z]) => -rollMoment * z / (4 * CORNER_Z * CORNER_Z) + pitchMoment * x / (4 * CORNER_X * CORNER_X));
  const spread = Math.max(...parts) - Math.min(...parts);
  const scale = spread > perNozzle ? perNozzle / spread : 1;
  const shares = parts.map(part => part * scale);
  const base = clamp(lift / 4, -Math.min(...shares), perNozzle - Math.max(...shares));
  return shares.map(share => clamp(base + share, 0, perNozzle));
}

// Height of the car's floor above the road: 0 for a parked car, whichever way up it is
function floorHeight(y, up) {
  return y - FLOOR_BELOW_CENTRE * up[1] - (RIDE_HEIGHT - FLOOR_BELOW_CENTRE);
}

function inertiaOf(mass) {
  return [mass * ROLL_GYRATION ** 2, mass * YAW_GYRATION ** 2, mass * PITCH_GYRATION ** 2];
}

function record(frames, entry) { frames.push(entry); }

// ---------- flight: the car flies its own program ----------
//
// program(ctx) is the flight computer. It sees the car's state and its hardware right now and returns
// { lift, rear, target, rateRef, accelRef, groundSpeed, phase }: the lift it wants from the corner
// nozzles, the rear thrust, the attitude it wants (with an optional rate and acceleration to follow),
// and for a car still on the road, the speed its motors hold. Physics does the rest.
function flight({ params, tank, start, end, program, fleet = null }) {
  const frames = [];
  let p = [...start.position], v = [...start.velocity], q = [...start.orientation], w = [...(start.spin ?? [0, 0, 0])];
  let airborne = start.airborne, outcome = null, endTime = end, roll = anglesOf(q).roll;
  // rad/s, about the car's left: rolling forward on the road, then spinning free once airborne
  let wheelSpin = Math.hypot(...start.velocity) / WHEEL_RADIUS;
  let clearance = Infinity, clearanceOver = null;
  const done = { landed: false, crashed: false };
  const fleetBoxes = fleet ? fleetLayout() : [];
  const summary = { touchdownSpeed: null, touchdownTime: null, liftoffTime: airborne ? start.time : null };
  for (let step = 0, t = start.time; t <= endTime + 1e-9; step++, t = start.time + step * STEP) {
    const mass = params.dryMass + tank.gas, weight = mass * GRAVITY, inertia = inertiaOf(mass);
    const angles = anglesOf(q, roll); roll = angles.roll;
    const up = rotate(q, [0, 1, 0]);
    const height = floorHeight(p[1], up);
    const perNozzle = params.nozzleThrust * 1000 * tank.capacityShare;
    const finished = done.landed || done.crashed;
    const command = finished ? { lift: 0, rear: 0, target: q, phase: done.landed ? 'Down' : outcome.text }
      : program({ t, position: p, velocity: v, orientation: q, spin: w, angles, up, height, mass, weight, perNozzle, inertia, airborne, tank });

    // attitude control: a stiff, damped pull toward the wanted attitude, plus any manoeuvre it is following
    let corner = [0, 0, 0, 0], rearEach = 0, sideForce = 0, wantedMoment = [0, 0, 0];
    if (!finished && !command.passive && (airborne || command.lift > 0)) {
      const error = attitudeError(q, command.target);
      const rateRef = command.rateRef ?? [0, 0, 0], accelRef = command.accelRef ?? [0, 0, 0];
      const kp = ATTITUDE_FREQUENCY ** 2, kd = 2 * ATTITUDE_DAMPING * ATTITUDE_FREQUENCY;
      wantedMoment = [0, 1, 2].map(i => inertia[i] * (kp * error[i] + kd * (rateRef[i] - w[i]) + accelRef[i]));
      corner = allocateCorners(Math.max(0, command.lift), wantedMoment[0], wantedMoment[2], perNozzle);
      const yawCap = perNozzle * YAW_NOZZLE_SHARE;
      sideForce = clamp(-wantedMoment[1] / YAW_NOZZLE_X, -yawCap, yawCap);
    }
    if (!finished) rearEach = clamp((command.rear ?? 0) / 4, 0, perNozzle);
    const lift = corner.reduce((sum, value) => sum + value, 0);
    const rear = 4 * rearEach;
    const thrust = lift + rear + Math.abs(sideForce);
    const flow = tank.burn(thrust, STEP);

    // forces and moments in the body frame, from where each nozzle is
    const bodyForce = [rear, lift, sideForce];
    const moment = [
      CORNER_NOZZLES.reduce((sum, [, , z], i) => sum - z * corner[i], 0),
      -YAW_NOZZLE_X * sideForce,
      CORNER_NOZZLES.reduce((sum, [x], i) => sum + x * corner[i], 0) + REAR_NOZZLE_DROP * rear,
    ];
    const thrustWorld = rotate(q, bodyForce);
    const accel = [thrustWorld[0] / mass, thrustWorld[1] / mass - GRAVITY, thrustWorld[2] / mass];
    let roadPush = 0;

    if (!airborne && !finished) {
      // on the road: the motors hold the program's speed and the road holds the car up until thrust wins
      v = [command.groundSpeed ?? v[0], 0, 0];
      wheelSpin = Math.abs(v[0]) / WHEEL_RADIUS;
      if (thrustWorld[1] > weight) { airborne = true; summary.liftoffTime = t; }
      else { roadPush = weight - thrustWorld[1]; accel[1] = 0; accel[0] = 0; accel[2] = 0; }
    }
    if (finished && done.landed) {
      const braking = Math.min(Math.abs(v[0]), 0.5 * GRAVITY * STEP);
      v = [v[0] - Math.sign(v[0]) * braking, 0, 0]; roadPush = weight;
    }
    if (finished && done.crashed) { v = [0, 0, 0]; roadPush = weight; }
    if (!finished) {
      for (let i = 0; i < 3; i++) v[i] += accel[i] * STEP;
      const spinMomentum = [0, 1, 2].map(i => inertia[i] * w[i]);
      if (airborne) spinMomentum[2] -= WHEEL_SPIN_INERTIA * wheelSpin;
      const gyro = [w[1] * spinMomentum[2] - w[2] * spinMomentum[1], w[2] * spinMomentum[0] - w[0] * spinMomentum[2], w[0] * spinMomentum[1] - w[1] * spinMomentum[0]];
      for (let i = 0; i < 3; i++) w[i] += (moment[i] - gyro[i]) / inertia[i] * STEP;
      const turn = multiply(q, [w[0], w[1], w[2], 0]);
      q = normalise(q.map((value, i) => value + 0.5 * turn[i] * STEP));
    }
    for (let i = 0; i < 3; i++) p[i] += v[i] * STEP;

    // contact with the road and with the parked cars
    if (airborne && !finished) {
      const world = BODY_POINTS.map(point => { const r = rotate(q, point); return [p[0] + r[0], p[1] + r[1], p[2] + r[2]]; });
      const lowest = Math.min(...world.map(point => point[1]));
      for (const vehicle of fleetBoxes) {
        for (const point of world) {
          if (Math.abs(point[0] - vehicle.x) < vehicle.width / 2 && Math.abs(point[2]) < vehicle.length / 2) {
            const gap = point[1] - vehicle.height;
            if (gap < clearance) { clearance = gap; clearanceOver = vehicle.name; }
            if (gap < 0 && !done.crashed) { done.crashed = true; summary.crashTime = t; outcome = { kind: 'hit', text: `Hits the ${vehicle.name}` }; }
          }
        }
      }
      if (!done.crashed && lowest <= 0 && t > (summary.liftoffTime ?? start.time) + 0.2) {
        const upright = rotate(q, [0, 1, 0])[1];
        summary.touchdownSpeed = Math.max(0, -v[1]); summary.touchdownTime = t;
        if (upright >= UPRIGHT && -v[1] <= SAFE_TOUCHDOWN) {
          done.landed = true; outcome = { kind: 'landed', text: 'Down' };
          p[1] = RIDE_HEIGHT; v[1] = 0; v[2] = 0; w = [0, 0, 0]; q = attitude(angles.yaw, 0, 0);
        } else {
          done.crashed = true; summary.crashTime = t;
          outcome = upright < 0 ? { kind: 'roof', text: 'Lands on its roof' }
            : upright < UPRIGHT ? { kind: 'side', text: 'Lands tipped over' }
              : { kind: 'hard', text: `Hits the road at ${(-v[1]).toFixed(1)} m/s` };
        }
        if (done.crashed) p[1] -= lowest; // rest on whatever part hit the road
      }
      if (done.landed || done.crashed) endTime = Math.min(end, t + 1.2);
    }

    if (step % RECORD_EVERY === 0) {
      const upNow = rotate(q, [0, 1, 0]);
      const felt = airborne && !finished ? Math.hypot(accel[0], accel[1] + GRAVITY, accel[2]) / GRAVITY : 1;
      record(frames, {
        t, x: p[0], y: p[1], z: p[2], vx: v[0], vy: v[1], speed: Math.hypot(...v), orientation: [...q],
        roll: angles.roll, pitch: angles.pitch, height: floorHeight(p[1], upNow),
        wheelSpin, mass, gas: tank.gas, psi: tank.psi, nozzlePsi: tank.nozzlePsi, temperature: tank.temperature,
        exhaustSpeed: tank.exhaustSpeed, flow, corner: lift, rear, thrust, capacity: 4 * perNozzle,
        saturated: !finished && (command.lift > 4 * perNozzle * 0.995 || Math.max(...corner) >= perNozzle * 0.999),
        torque: Math.hypot(...moment), wantedMoment: Math.hypot(...wantedMoment), g: felt,
        weight, airborne: airborne && !finished, landed: done.landed, crashed: done.crashed, phase: command.phase,
        forces: { weight: [0, -weight, 0], thrust: thrustWorld, road: [0, roadPush, 0], velocity: [...v] },
        nozzles: { corner: [...corner], rear: [rearEach, rearEach, rearEach, rearEach], lateral: [Math.max(0, -sideForce), Math.max(0, sideForce)] },
      });
    }
  }
  const fallback = airborne ? { kind: 'airborne', text: 'Still in the air when the clip ends' } : { kind: 'grounded', text: "Can't lift off" };
  return { frames, tank, outcome: outcome ?? fallback, clearance, clearanceOver, ...summary };
}

function summariseFlight(run, extra = {}) {
  const frames = run.frames, tank = run.tank;
  let peakThrust = 0, peakG = 0, saturatedTime = 0, peakShare = 0, peakSharePhase = '', apex = -Infinity, apexTime = null, widestDrift = 0;
  for (const frame of frames) {
    peakThrust = Math.max(peakThrust, frame.thrust);
    if (frame.airborne) peakG = Math.max(peakG, frame.g);
    if (frame.saturated) saturatedTime += 1 / FRAME_RATE;
    if (frame.capacity > 0 && frame.airborne && frame.corner / frame.capacity > peakShare) { peakShare = frame.corner / frame.capacity; peakSharePhase = frame.phase; }
    if (frame.height > apex) { apex = frame.height; apexTime = frame.t; }
    widestDrift = Math.max(widestDrift, Math.abs(frame.z));
  }
  const last = frames[frames.length - 1];
  return {
    outcome: run.outcome, touchdownSpeed: run.touchdownSpeed, touchdownTime: run.touchdownTime, liftoffTime: run.liftoffTime, crashTime: run.crashTime ?? null,
    gasUsed: tank.fullGas - last.gas, fullGas: tank.fullGas, usableGas: tank.fullGas - tank.strandedGas,
    outOfAir: last.gas <= tank.strandedGas + 0.5,
    peakThrust, peakG, saturatedTime, peakShare, peakSharePhase, endPsi: last.psi, apex, apexTime, widestDrift,
    clearance: run.clearance, clearanceOver: run.clearanceOver, ...extra,
  };
}

// Air burned between two moments of a run
function gasBetween(frames, from, to) {
  const at = t => frames.reduce((best, frame) => (Math.abs(frame.t - t) < Math.abs(best.t - t) ? frame : best), frames[0]).gas;
  return at(from) - at(to);
}

// ---------- the flight computer's building blocks ----------

// A roll from one angle to another: spin up, hold a steady rate, spin down
function rollProgram(start, from, to, rate, acceleration) {
  const sweep = Math.abs(to - from), direction = Math.sign(to - from) || 1;
  const peak = Math.min(rate, Math.sqrt(sweep * acceleration));
  const ramp = peak / acceleration, cruise = Math.max(0, (sweep - peak * ramp) / peak);
  const span = 2 * ramp + cruise;
  return {
    start, end: start + span, target: to,
    at(t) {
      const u = clamp(t - start, 0, span);
      let angle, speed, accel;
      if (u < ramp) { angle = acceleration * u * u / 2; speed = acceleration * u; accel = acceleration; }
      else if (u < ramp + cruise) { angle = peak * ramp / 2 + peak * (u - ramp); speed = peak; accel = 0; }
      else { const left = span - u; angle = sweep - acceleration * left * left / 2; speed = acceleration * left; accel = -acceleration; }
      if (t >= start + span) { speed = 0; accel = 0; }
      return { angle: from + direction * angle, rate: direction * speed, accel: direction * accel };
    },
  };
}

// The steepest safe roll acceleration with the nozzles available now: one side's two nozzles flat out
function rollAuthority(perNozzle, inertia) {
  return 2 * perNozzle * CORNER_Z / inertia[0];
}

// Landing burn. It waits, then follows the descent speed the car can still stop from, aiming for a
// gentle touchdown. `brake` is the deceleration the program plans on; it shrinks to what the nozzles
// can actually give right now, so a weaker car starts braking higher up.
function landingLift(ctx, { brake, catchHeight, letDown, touchdown }) {
  const h = ctx.height, vy = ctx.velocity[1];
  const tilt = Math.max(ctx.up[1], 0.3);
  const available = 4 * ctx.perNozzle * tilt / ctx.mass - GRAVITY;
  const decel = Math.max(0.3, Math.min(brake, 0.85 * available));
  // ease down at `letDown` until the last 0.6 m, then slow to `touchdown` for the wheels
  const base = height => touchdown + (letDown - touchdown) * clamp((height - 0.05) / 0.6, 0, 1);
  const desired = height => -Math.sqrt(base(height) ** 2 + 2 * decel * Math.max(0, height - catchHeight));
  const target = desired(h);
  if (vy > target + 0.05 && !ctx.state.braking) return 0; // still falling slower than it can stop from: coast
  ctx.state.braking = true;
  const slope = (desired(h + 0.01) - desired(Math.max(h - 0.01, 0))) / (h > 0.01 ? 0.02 : 0.01);
  const wanted = 8 * (target - vy) + slope * vy;
  return Math.max(0, ctx.mass * (wanted + GRAVITY) / tilt);
}

// Lean the lift a little to steer horizontally, levelling out near the ground
function leanUp(ctx, wantX, wantZ) {
  const limit = MAX_LEAN * clamp(ctx.height / LEVEL_BY, 0, 1);
  const lean = Math.min(limit, Math.atan(Math.hypot(wantX, wantZ) / GRAVITY));
  const heading = Math.atan2(wantZ, wantX);
  return [Math.sin(lean) * Math.cos(heading), Math.cos(lean), Math.sin(lean) * Math.sin(heading)];
}

// ---------- the loop ramp (wall ride and the run-up to the drop) ----------

export function rampPoint(angle) {
  return [RAMP_RADIUS * Math.sin(angle), RAMP_RADIUS * (1 - Math.cos(angle))];
}

// The most suction the fans can hold: about 80 kW pushing air out through the skirt gap
function suctionLimit(params) {
  const leakPerRootPressure = 0.6 * SKIRT_PERIMETER * (params.skirtGap / 1000) * Math.sqrt(2 / AIR_DENSITY);
  const pressure = (FAN_POWER * FAN_EFFICIENCY / leakPerRootPressure) ** (2 / 3);
  return pressure * FLOOR_AREA;
}
function fanPowerFor(suction, params) {
  const pressureDrop = suction / FLOOR_AREA;
  const leak = 0.6 * SKIRT_PERIMETER * (params.skirtGap / 1000) * Math.sqrt(2 * Math.max(pressureDrop, 0) / AIR_DENSITY);
  return pressureDrop * leak / FAN_EFFICIENCY;
}

// Drive on the loop. The motors chase the speed the video shows; the tyres can only push as hard as grip
// allows, and grip comes from the road push, most of which the fans make. If the road push goes
// negative the car leaves the ramp.
function rampDrive({ params, tank, start, end, angleStart, speedAt, suctionAt, exitAngle, phase }, frames) {
  let angle = angleStart, speed = 0, slipTime = 0;
  const limit = suctionLimit(params);
  for (let step = 0, t = start; t <= end + 1e-9; step++, t = start + step * STEP) {
    const mass = params.dryMass + tank.gas, weight = mass * GRAVITY;
    const wanted = speedAt(t);
    const suction = Math.min(suctionAt(t, angle), limit);
    const centripetal = mass * speed * speed / RAMP_RADIUS;
    const roadPush = centripetal + suction + weight * Math.cos(angle);
    const inward = [-Math.sin(angle), Math.cos(angle), 0], tangent = [Math.cos(angle), Math.sin(angle), 0];
    const [surfaceX, surfaceY] = rampPoint(angle);
    const x = surfaceX + inward[0] * RIDE_HEIGHT, y = surfaceY + inward[1] * RIDE_HEIGHT;
    if (roadPush < 0) return { left: true, t, angle, speed, x, y };
    const wantedDrive = mass * (wanted.accel + 4 * (wanted.speed - speed)) + weight * Math.sin(angle);
    const grip = Math.min(params.tyreGrip * roadPush, MOTOR_FORCE);
    const drive = clamp(wantedDrive, -grip, grip);
    if (Math.abs(wantedDrive) > grip) slipTime += STEP;
    speed += (drive - weight * Math.sin(angle)) / mass * STEP;
    angle += speed / RAMP_RADIUS * STEP;
    if (angle < 0) { angle = 0; speed = Math.max(speed, 0); }
    if (exitAngle !== undefined && angle >= exitAngle) return { left: false, launched: true, t, angle, speed, x, y };
    if (step % RECORD_EVERY === 0) {
      const suctionNeeded = Math.max(0, Math.abs(wantedDrive) / params.tyreGrip - centripetal - weight * Math.cos(angle));
      const properX = ((roadPush - suction) * inward[0] + drive * tangent[0]) / mass;
      const properY = ((roadPush - suction) * inward[1] + drive * tangent[1]) / mass;
      record(frames, {
        t, x, y, z: 0, vx: speed * tangent[0], vy: speed * tangent[1], speed: Math.abs(speed),
        orientation: attitude(0, angle, 0), roll: 0, pitch: angle, height: floorHeight(y, inward),
        wheelSpin: Math.abs(speed) / WHEEL_RADIUS, mass, gas: tank.gas, psi: tank.psi, nozzlePsi: tank.nozzlePsi, temperature: tank.temperature,
        exhaustSpeed: tank.exhaustSpeed, flow: 0, corner: 0, rear: 0, thrust: 0,
        capacity: 4 * params.nozzleThrust * 1000 * tank.capacityShare, saturated: false, torque: 0,
        g: Math.hypot(properX, properY) / GRAVITY, weight, onRamp: true, angle,
        suction, suctionWanted: suctionAt(t, angle), suctionLimit: limit, suctionNeeded, roadPush, traction: drive,
        gripUsed: params.tyreGrip * roadPush > 0 ? Math.abs(wantedDrive) / (params.tyreGrip * roadPush) : Infinity,
        fanPower: fanPowerFor(suction, params), airborne: false, landed: false, crashed: false, phase: phase(t, angle),
        forces: {
          weight: [0, -weight, 0],
          suction: [-inward[0] * suction, -inward[1] * suction, 0],
          road: [inward[0] * roadPush, inward[1] * roadPush, 0],
          grip: [tangent[0] * drive, tangent[1] * drive, 0],
          velocity: [speed * tangent[0], speed * tangent[1], 0],
        },
        nozzles: { corner: [0, 0, 0, 0], rear: [0, 0, 0, 0], lateral: [0, 0] },
      });
    }
  }
  return { left: false, launched: false, t: end, angle, speed, slipTime };
}

// The car's state the moment it leaves the ramp at `angle` with `speed`
function leavingRamp(angle, speed) {
  const [surfaceX, surfaceY] = rampPoint(angle);
  const inward = [-Math.sin(angle), Math.cos(angle)];
  return {
    position: [surfaceX + inward[0] * RIDE_HEIGHT, surfaceY + inward[1] * RIDE_HEIGHT, 0],
    velocity: [speed * Math.cos(angle), speed * Math.sin(angle), 0],
    orientation: attitude(0, angle, 0), spin: [0, 0, speed / RAMP_RADIUS], airborne: true,
  };
}

// No program: nothing fires (a car that has fallen off the wall)
const unpowered = ctx => ({ lift: 0, rear: 0, target: ctx.orientation, passive: true, phase: 'Falling, nothing firing' });

// ---------- telemetry read off the broadcast (video seconds) ----------

// Wall ride, 6:28-7:03: [video s, pitch deg, altitude ft, downforce kg]
export const WALL_TELEMETRY = [
  [388, 0.8, 0.0, 0.6], [392, 20.3, 1.8, 386], [393, 45.0, 8.0, 714], [394, 69.3, 18.4, 1359], [395, 85.8, 27.5, 2293],
  [396, 89.6, 30.4, 3220], [397, 90.2, 30.8, 3874], [398, 99.5, 35.1, 4263], [399, 121, 45.4, 4475], [400, 145, 55.6, 4588],
  [401, 164, 61.2, 4645], [402, 170, 63.5, 4668], [403, 170, 65.1, 4683], [404, 170, 66.4, 4693], [405, 170, 67.1, 4697],
  [406, 170, 67.6, 4697], [407, 170, 68.2, 4698], [408, 170, 68.7, 4700], [409, 170, 68.8, 4700], [410, 170, 68.9, 4697],
  [411, 170, 69.1, 4699], [412, 169, 69.1, 4698], [413, 164, 68.9, 4698], [414, 147, 66.1, 4699], [415, 127, 60.1, 4703],
  [416, 109, 52.5, 4705], [417, 90.4, 44.0, 4707], [418, 72.0, 35.3, 4507], [419, 52.9, 27.4, 3940], [420, 33.6, 21.2, 3149],
  [421, 15.2, 18.0, 2310], [422, 2.2, 17.7, 1568], [423, 0.9, 18.6, 1032],
];

// Wall launch and drop, 7:10-7:23: [video s, G, altitude ft]
export const DROP_TELEMETRY = [
  [430, 1.1, 0.0], [430.5, 1.2, 0.1], [431, 1.5, 0.5], [431.5, 1.6, 2.5], [432, 1.4, 7.9], [432.5, 1.1, 16.8], [433, 0.9, 26.7],
  [433.5, 1.0, 36.0], [434, 0.9, 44.3], [434.5, 0.9, 51.7], [435, 0.8, 57.9], [435.5, 1.1, 62.0], [436, 1.1, 64.8],
  [436.25, 1.0, 66.2], [436.5, 0.2, 67.5], [436.75, 0.4, 68.0], [437.0, 0.4, 67.0], [437.1, 0.4, 66.6], [437.2, 0.3, 66.2],
  [437.3, 0.4, 65.5], [437.4, 0.4, 63.6], [437.5, 0.3, 62.2], [437.7, 0.5, 58.0], [437.8, 0.5, 54.8], [437.9, 0.6, 47.3],
  [438.0, 0.9, 43.3], [438.1, 1.7, 39.3], [438.2, 2.6, 35.2], [438.3, 3.1, 31.4], [438.5, 3.3, 21.4], [438.75, 2.4, 14.6],
  [439.0, 1.1, 10.9], [439.25, 1.1, 9.0], [440, 1.5, 4.5], [441, 1.0, 0.4], [442, 1.0, 1.1], [443, 1.0, 0.1],
];

// Kickflip, 11:11-11:17: [video s, G, altitude ft]
export const KICKFLIP_TELEMETRY = [
  [671.8, 1.0, 0.0], [672.0, 2.4, 0.0], [672.2, 3.5, 0.0], [672.4, 1.4, 0.9], [672.6, 0.5, 4.8], [672.8, 0.4, 9.3],
  [673.0, 0.3, 14.7], [673.2, 0.2, 18.6], [673.4, 0.2, 22.2], [673.6, 0.2, 24.6], [673.8, 0.2, 25.8], [674.0, 0.2, 26.2],
  [674.2, 0.2, 25.1], [674.4, 0.6, 22.3], [674.6, 0.9, 18.2], [674.8, 1.7, 14.3], [675.0, 2.4, 10.4], [675.2, 2.0, 7.6],
  [675.4, 1.2, 4.8], [675.6, 0.9, 2.7], [675.8, 2.2, 1.4], [676.0, 1.5, 0.6], [676.2, 0.9, 0.3], [676.4, 0.9, 0.2],
  [676.6, 1.0, 0.1], [676.8, 1.0, 0.1],
];

// Tower flip, 21:53-21:57: no gauges. [video s, height m] measured in pixels using the car's 2 m width;
// the camera cuts between 21:54.4 and 21:55.5, so the apex itself isn't measurable.
export const TOWER_MEASURED = [
  [1313.7, 0.0], [1313.8, 1.0], [1313.9, 2.1], [1314.0, 2.7], [1314.1, 4.0], [1314.2, 4.9], [1314.3, 6.4],
  [1315.6, 5.4], [1315.7, 4.9], [1315.8, 3.9], [1315.9, 3.3], [1316.0, 2.7], [1316.1, 2.2], [1316.2, 1.5],
  [1316.3, 0.76], [1316.4, 0.33], [1316.5, 0.1], [1316.6, 0.0],
];

const downforceOfTime = monotoneCubic(WALL_TELEMETRY.map(row => row[0]), WALL_TELEMETRY.map(row => row[3]));
const ascent = WALL_TELEMETRY.filter(row => row[0] <= 402);
const downforceOfPitch = linear(ascent.map(row => row[1] * Math.PI / 180), ascent.map(row => row[3]));

// Five Teslas parked side by side across the Roadster's path; the Semi is in the middle
export const FLEET = [
  { name: 'Cybercab', width: 1.94, length: 4.03, height: 1.34 },
  { name: 'Cybertruck', width: 2.12, length: 5.68, height: 1.79 },
  { name: 'Semi', width: 2.54, length: 6.8, height: 4.11 },
  { name: 'Model Y', width: 1.93, length: 4.79, height: 1.62 },
  { name: 'Model 3', width: 1.85, length: 4.72, height: 1.44 },
];
export function fleetLayout() {
  const gap = 0.75;
  const total = FLEET.reduce((sum, car) => sum + car.width, 0) + gap * (FLEET.length - 1);
  let edge = -total / 2;
  return FLEET.map(car => { const centre = edge + car.width / 2; edge += car.width + gap; return { ...car, x: centre }; });
}

// ---------- the stunt programs ----------
//
// Each program is what the car's flight computer was told to do, read off the video: where to lift off,
// how high to go, which roll to fly and how to land. The numbers are fixed; whether the car can do them
// depends on the hardware you set.

const TURN = 2 * Math.PI;
const ROLL_PUSH_SHARE = 0.5; // the spin-down push comes late, near the top, so only part of it adds height

// Speed along the loop that the video's angle trace implies
function speedFromAngles(angleOf, from, to) {
  const at = t => angleOf(clamp(t, from, to));
  return t => {
    const h = 0.04, middle = clamp(t, from + 2 * h, to - 2 * h);
    return {
      speed: RAMP_RADIUS * (at(middle + h) - at(middle - h)) / (2 * h),
      accel: RAMP_RADIUS * (at(middle + 2 * h) - 2 * at(middle) + at(middle - 2 * h)) / (4 * h * h),
    };
  };
}

// Wall ride, 6:28: crawl up the loop, park upside down at 170°, drive back down. Fans only.
function wallRide(params) {
  const tank = new Tank(params);
  const frames = [];
  const rows = [[386.5, WALL_TELEMETRY[0][1]], ...WALL_TELEMETRY.map(row => [row[0], row[1]])];
  const angleOf = monotoneCubic(rows.map(row => row[0]), rows.map(row => row[1] * Math.PI / 180));
  const run = rampDrive({
    params, tank, start: 387, end: 424, angleStart: angleOf(387), speedAt: speedFromAngles(angleOf, 386.5, 423),
    suctionAt: t => downforceOfTime(clamp(t, 388, 423)) * GRAVITY,
    phase: (t, angle) => {
      const degrees = angle * 180 / Math.PI;
      if (t < 392) return 'Rolling onto the ramp';
      if (t < 402) return degrees > 90 ? 'Past vertical: fans hold it on' : 'Climbing on fan suction';
      if (t < 412.5) return 'Parked upside down at 170°';
      return t < 422.5 ? 'Driving back down' : 'Back at the bottom';
    },
  }, frames);
  let outcome = { kind: 'held', text: 'Holds on' };
  if (run.left) {
    const fall = flight({ params, tank, start: { time: run.t, ...leavingRamp(run.angle, run.speed) }, end: run.t + 4, program: unpowered });
    frames.push(...fall.frames);
    outcome = { kind: 'fell', text: `Falls off the wall at ${Math.round(run.angle * 180 / Math.PI)}°` };
  }
  let worstLag = 0, worstMargin = Infinity, worstMarginAt = frames[0], peakGrip = 0, peakFan = 0, peakSuction = 0, capped = false;
  let slipTime = 0, slipAt = null;
  for (const frame of frames.filter(f => f.onRamp)) {
    worstLag = Math.max(worstLag, angleOf(frame.t) - frame.angle);
    if (frame.suctionNeeded > 500) {
      const margin = frame.suction / frame.suctionNeeded;
      if (margin < worstMargin) { worstMargin = margin; worstMarginAt = frame; }
    }
    peakGrip = Math.max(peakGrip, Math.min(frame.gripUsed, 9));
    if (frame.gripUsed > 1) { slipTime += RECORD_EVERY * STEP; slipAt = slipAt ?? frame; }
    peakFan = Math.max(peakFan, frame.fanPower);
    peakSuction = Math.max(peakSuction, frame.suction);
    if (frame.suction < frame.suctionWanted - 10) capped = true;
  }
  if (!run.left && worstLag > 15 * Math.PI / 180) outcome = { kind: 'slid', text: 'Tyres slip and it slides back down' };
  const inverted = frames.find(frame => frame.t >= 407 && frame.onRamp) ?? frames[frames.length - 1];
  return {
    frames, tank,
    summary: {
      outcome, worstMargin, worstMarginAt, peakGrip, peakFan, peakSuction, suctionCapped: capped, suctionLimit: suctionLimit(params),
      slipTime, slipAngle: slipAt ? slipAt.angle : null, worstLag,
      invertedNeed: inverted.suctionNeeded ?? 0, gasUsed: 0, fullGas: tank.fullGas, usableGas: tank.fullGas - tank.strandedGas,
    },
  };
}

// Wall launch and drop, 7:10: up the loop at speed, off the lip upside down, half roll, fall, catch, let down
const DROP = { lipDegrees: RAMP_LIP_DEGREES, rollDelay: 0.35, rollRate: 3.5, rollAcceleration: 12, catchHeight: 3.0, brake: 17.8, letDown: 1.5, touchdown: 0.3 };
function wallDrop(params) {
  const tank = new Tank(params);
  const frames = [];
  const lipAngle = DROP.lipDegrees * Math.PI / 180;
  const climb = DROP_TELEMETRY.filter(row => row[0] >= 431 && row[0] <= 436.5)
    .map(([t, , feet]) => [t - ALTITUDE_LAG, Math.acos(clamp(1 - (feet * FEET) / RAMP_RADIUS, -1, 1))]);
  const keys = [[429.0, 0], [430.0, 0], ...climb.filter(([t]) => t < 436.45), [436.5, lipAngle], [437.0, lipAngle + 0.15]];
  const angleOf = monotoneCubic(keys.map(k => k[0]), keys.map(k => k[1]));
  const run = rampDrive({
    params, tank, start: 429.5, end: 439, angleStart: 0, speedAt: speedFromAngles(angleOf, 429, 437),
    suctionAt: (t, angle) => downforceOfPitch(clamp(angle, 0, lipAngle)) * GRAVITY, exitAngle: lipAngle,
    phase: (t, angle) => (angle < 0.05 ? 'Lining up for the run' : 'Second run: up the loop at speed'),
  }, frames);
  if (!run.launched) {
    const fall = run.left ? flight({ params, tank, start: { time: run.t, ...leavingRamp(run.angle, run.speed) }, end: run.t + 4, program: unpowered }) : null;
    if (fall) frames.push(...fall.frames);
    const outcome = run.left ? { kind: 'fell', text: `Falls off the loop at ${Math.round(run.angle * 180 / Math.PI)}°` } : { kind: 'stalled', text: 'Never reaches the lip' };
    return { frames, tank, summary: { ...summariseFlight({ frames, tank, outcome }), outcome } };
  }

  const lipTime = run.t;
  const start = { time: lipTime, ...leavingRamp(lipAngle, run.speed) };
  const lip = anglesOf(start.orientation);
  const state = { phase: 'coast', roll: null, braking: false, catchStart: null };
  const program = ctx => {
    const hold = attitude(lip.yaw, lip.pitch, lip.roll);
    if (state.phase === 'coast') {
      if (ctx.t < lipTime + DROP.rollDelay) return { lift: 0, target: hold, phase: 'Off the lip, upside down' };
      const target = TURN * Math.ceil(ctx.angles.roll / TURN);
      const acceleration = Math.min(DROP.rollAcceleration, 0.6 * rollAuthority(ctx.perNozzle, ctx.inertia));
      state.roll = rollProgram(ctx.t, ctx.angles.roll, target === ctx.angles.roll ? target + TURN : target, DROP.rollRate, acceleration);
      state.phase = 'roll';
    }
    if (state.phase === 'roll') {
      if (ctx.t < state.roll.end) {
        const r = state.roll.at(ctx.t);
        const progress = clamp((ctx.t - state.roll.start) / (state.roll.end - state.roll.start), 0, 1);
        // the catch can start in the last 30° of the roll, with the lift tipped by what's left of it
        const nearlyUp = Math.abs(state.roll.target - ctx.angles.roll) < 0.52;
        const lift = nearlyUp ? landingLift({ ...ctx, state }, DROP) : 0;
        if (lift > 0 && state.catchStart === null) state.catchStart = ctx.t;
        return { lift, target: attitude(lip.yaw, lip.pitch * (1 - progress), r.angle), rateRef: [r.rate, 0, 0], accelRef: [r.accel, 0, 0], phase: lift > 0 ? 'Thrusters catch it' : 'Half barrel roll to wheels-down' };
      }
      state.phase = 'catch';
    }
    const up = leanUp(ctx, clamp(-1.2 * ctx.velocity[0], -3, 3), -1.0 * ctx.position[2] - 1.5 * ctx.velocity[2]);
    const lift = landingLift({ ...ctx, state }, DROP);
    if (lift > 0 && state.catchStart === null) state.catchStart = ctx.t;
    return {
      lift, target: attitudeToward(up, lip.yaw, state.roll.target),
      phase: lift === 0 ? 'Falling toward the catch' : ctx.height > DROP.catchHeight ? 'Thrusters catch it' : 'Easing down on thrust',
    };
  };
  const fly = flight({ params, tank, start, end: lipTime + 7, program });
  frames.push(...fly.frames);
  const summary = summariseFlight({ ...fly, frames });
  const catchStart = state.catchStart ?? lipTime;
  const catchFrames = fly.frames.filter(f => f.t >= catchStart && f.height > DROP.catchHeight);
  return {
    frames, tank,
    summary: {
      ...summary, lipTime, launchSpeed: run.speed, catchStart, rollEnd: state.roll?.end ?? null,
      catchG: catchFrames.reduce((best, f) => Math.max(best, f.g), 0),
      catchSpeed: Math.max(0, -(fly.frames.find(f => f.t >= catchStart)?.vy ?? 0)),
      lipHeight: fly.frames[0].height,
      rollGas: state.roll ? gasBetween(fly.frames, lipTime, state.roll.end) : 0,
      catchGas: catchFrames.length ? gasBetween(fly.frames, catchStart, catchFrames[catchFrames.length - 1].t) : 0,
      letDownGas: catchFrames.length && summary.touchdownTime ? gasBetween(fly.frames, catchFrames[catchFrames.length - 1].t, summary.touchdownTime) : 0,
    },
  };
}

// A hop with a full roll and a guided landing: the kickflip and the tower finale share this program
function hopProgram({ mission, yaw, approachSpeed = 0, liftoffX = null, liftoffTime = null, steer, state }) {
  const apexCentre = mission.apex + RIDE_HEIGHT;
  return ctx => {
    const level = attitude(yaw, 0, 0);
    if (state.phase === 'wait') {
      const go = liftoffX !== null ? ctx.position[0] >= liftoffX : ctx.t >= liftoffTime;
      if (!go) return { lift: 0, target: level, groundSpeed: approachSpeed, phase: mission.waiting };
      state.phase = 'boost'; state.boostStart = ctx.t;
    }
    if (state.phase === 'boost') {
      // The roll that follows comes from one side pushing harder, which also pushes the car up: spin-up and
      // spin-down each add about I·ω/(arm·m). The burn stops early by that much so the car tops out on target.
      const acceleration = Math.min(mission.rollAcceleration, 0.6 * rollAuthority(ctx.perNozzle, ctx.inertia));
      const peakRate = Math.min(mission.rollRate, Math.sqrt(TURN * acceleration));
      const rollPush = ROLL_PUSH_SHARE * 2 * ctx.inertia[0] * peakRate / (CORNER_Z * ctx.mass);
      const needed = Math.sqrt(2 * GRAVITY * Math.max(0, apexCentre - ctx.position[1]));
      if (!(ctx.airborne && ctx.velocity[1] + rollPush >= needed)) {
        return { lift: ctx.mass * (mission.boost + GRAVITY), target: level, groundSpeed: approachSpeed, phase: mission.boosting };
      }
      state.roll = rollProgram(ctx.t, ctx.angles.roll, ctx.angles.roll + TURN, mission.rollRate, acceleration);
      state.phase = 'roll'; state.boostEnd = ctx.t;
    }
    if (state.phase === 'roll') {
      if (ctx.t < state.roll.end) {
        const r = state.roll.at(ctx.t);
        return { lift: 0, target: attitude(yaw, 0, r.angle), rateRef: [r.rate, 0, 0], accelRef: [r.accel, 0, 0], phase: mission.rolling };
      }
      state.phase = 'land';
    }
    const [wantX, wantZ] = steer(ctx);
    const up = leanUp(ctx, wantX, wantZ);
    // over the parked cars the program treats 'stay above the roofs' as the ground until it's past them
    const floor = mission.keepAbove && ctx.position[0] < mission.keepAbove.untilX ? mission.keepAbove.height : 0;
    const lift = ctx.velocity[1] < 0 ? landingLift({ ...ctx, height: ctx.height - floor, state }, mission) : 0;
    if (lift > 0 && state.brakeStart === null) state.brakeStart = ctx.t;
    return { lift, target: attitudeToward(up, yaw, state.roll.target), phase: lift > 0 ? mission.braking : ctx.velocity[1] > 0 ? 'Coasting up' : 'Over the top, falling' };
  };
}

function hopSummary(run, state, extra) {
  const summary = summariseFlight(run);
  const touchdown = summary.touchdownTime ?? run.frames[run.frames.length - 1].t;
  return {
    ...summary, ...extra, boostStart: state.boostStart, boostEnd: state.boostEnd ?? null, rollEnd: state.roll?.end ?? null, brakeStart: state.brakeStart,
    boostG: run.frames.filter(f => state.boostStart !== null && f.t >= state.boostStart && f.t <= (state.boostEnd ?? state.boostStart)).reduce((best, f) => Math.max(best, f.g), 0),
    climbGas: state.boostStart !== null ? gasBetween(run.frames, state.boostStart, state.roll?.end ?? touchdown) : 0,
    landingGas: state.brakeStart !== null ? gasBetween(run.frames, state.brakeStart, touchdown) : 0,
    fallSpeed: Math.max(0, ...run.frames.filter(f => f.airborne).map(f => -f.vy)),
  };
}

// Kickflip, 11:12: roll up to the lineup, burn up to about 26 ft, full barrel roll, guided landing
export const KICKFLIP = {
  approachSpeed: 6.2, liftoffX: -12, apex: 8.0, boost: 14, rollRate: 5.0, rollAcceleration: 25,
  brake: 6.5, catchHeight: 0.1, letDown: 0.6, touchdown: 0.6, keepAboveHeight: 2.0,
  waiting: 'Rolling up to the lineup', boosting: 'Lift-off burn', rolling: 'Kickflip: full roll on the way up', braking: 'Thrusters brake the fall',
};
function kickflip(params) {
  const tank = new Tank(params);
  const fleetEnd = Math.max(...fleetLayout().map(vehicle => vehicle.x + vehicle.width / 2));
  const state = { phase: 'wait', roll: null, braking: false, boostStart: null, brakeStart: null };
  const start = { time: 671.95 - 1.5, position: [KICKFLIP.liftoffX - KICKFLIP.approachSpeed * 1.5, RIDE_HEIGHT, 0], velocity: [KICKFLIP.approachSpeed, 0, 0], orientation: attitude(0, 0, 0), airborne: false };
  const program = hopProgram({
    mission: { ...KICKFLIP, keepAbove: { height: KICKFLIP.keepAboveHeight, untilX: fleetEnd + 1.2 } }, yaw: 0, approachSpeed: KICKFLIP.approachSpeed, liftoffX: KICKFLIP.liftoffX, state,
    steer: ctx => [0, -1.0 * ctx.position[2] - 1.5 * ctx.velocity[2]],
  });
  const run = flight({ params, tank, start, end: 679, program, fleet: true });
  return { frames: run.frames, tank, summary: hopSummary(run, state, {}) };
}

// Tower flip, 21:53: straight up beside the tower, full roll near the top, guided landing on the spot
export const TOWER = {
  liftoffTime: 1313.6, apex: 7.2, boost: 3 * GRAVITY, rollRate: 4.5, rollAcceleration: 25,
  brake: 18, catchHeight: 0.1, letDown: 0.6, touchdown: 0.6,
  waiting: 'Parked at the base of the tower', boosting: 'Boost straight up', rolling: 'Rolling over at the top', braking: 'Thrusters brake the landing',
};
function towerFlip(params) {
  const tank = new Tank(params);
  const state = { phase: 'wait', roll: null, braking: false, boostStart: null, brakeStart: null };
  const start = { time: TOWER.liftoffTime - 0.6, position: [0, RIDE_HEIGHT, 0], velocity: [0, 0, 0], orientation: attitude(-Math.PI / 2, 0, 0), airborne: false };
  const program = hopProgram({
    mission: TOWER, yaw: -Math.PI / 2, liftoffTime: TOWER.liftoffTime, state,
    steer: ctx => [-1.0 * ctx.position[0] - 1.5 * ctx.velocity[0], -1.0 * ctx.position[2] - 1.5 * ctx.velocity[2]],
  });
  const run = flight({ params, tank, start, end: 1319, program });
  const mass = params.dryMass + tank.fullGas;
  const summary = hopSummary(run, state, {});
  let worstMeasured = 0;
  for (const [t, height] of TOWER_MEASURED) {
    const frame = run.frames.reduce((best, f) => (Math.abs(f.t - t) < Math.abs(best.t - t) ? f : best), run.frames[0]);
    worstMeasured = Math.max(worstMeasured, Math.abs(frame.height - height));
  }
  return {
    frames: run.frames, tank,
    summary: { ...summary, worstMeasured, plannedBoostG: TOWER.boost / GRAVITY + 1, heaviestForBoost: 4 * params.nozzleThrust * 1000 / (TOWER.boost + GRAVITY), takeoffMass: mass },
  };
}

function launch(params) {
  const target = 60 * MPH;
  const start = -0.4, end = 1.9, launchStep = Math.round(-start / STEP);
  const fullCapacity = 4 * params.nozzleThrust * 1000;

  // One run of the launch: motors through the tyres plus a steady rear thrust, burning real gas from the tank.
  // The same integrator solves for the thrust and draws the replay, so the replay hits the solved time.
  const run = (rearThrust, frames = null) => {
    const tank = new Tank(params);
    const mass0 = params.dryMass + tank.gas;
    const fanSuction = Math.min(2 * mass0 * GRAVITY, 4700 * GRAVITY);
    const motorForce = speed => Math.min(32700, 1.0e6 / Math.max(speed, 1), params.tyreGrip * 0.5 * (mass0 * GRAVITY + fanSuction));
    let x = 0, v = 0, cutTime = null, distanceAtSixty = null, saturated = false;
    const steps = Math.round((end - start) / STEP);
    for (let step = 0; step < steps; step++) {
      const t = start + step * STEP;
      const mass = params.dryMass + tank.gas, weight = mass * GRAVITY;
      const go = step >= launchStep && cutTime === null;
      const capacity = fullCapacity * tank.capacityShare;
      const rear = go ? Math.min(rearThrust, capacity) : 0;
      if (go && rearThrust > capacity) saturated = true;
      // after 60 mph the pad runs out: full tyre braking, ramped in over 0.1 s
      const brakeRamp = cutTime === null ? 0 : Math.min(1, (t - cutTime) / 0.1);
      const tyre = go ? motorForce(v) : cutTime !== null && v > 0 ? -Math.min(brakeRamp * params.tyreGrip * (weight + fanSuction), mass * v / STEP) : 0;
      const flow = tank.burn(rear, STEP);
      const acceleration = (tyre + rear) / mass;
      const before = v;
      v = Math.max(0, v + acceleration * STEP);
      x += (before + v) / 2 * STEP;
      if (go && v >= target) {
        cutTime = t + (target - before) / acceleration; // when the speed actually crossed 60 mph
        distanceAtSixty = x;
      }
      if (frames && (step + 1) % RECORD_EVERY === 0) {
        const now = t + STEP, suction = now >= -0.2 ? fanSuction : 0;
        record(frames, {
          t: now, x, y: RIDE_HEIGHT, z: 0, height: 0, vx: v, vy: 0, speed: v, orientation: attitude(0, 0, 0), roll: 0, pitch: 0,
          mass, gas: tank.gas, psi: tank.psi, nozzlePsi: tank.nozzlePsi, temperature: tank.temperature,
          exhaustSpeed: tank.exhaustSpeed, flow, corner: 0, rear, thrust: rear, capacity, saturated: go && rearThrust > capacity,
          torqueShort: false, torque: 0, tyreForce: tyre, suction, acceleration,
          g: Math.hypot(acceleration, GRAVITY) / GRAVITY, horizontalG: acceleration / GRAVITY, weight, airborne: false, landed: false, crashed: false,
          phase: now < 0 ? 'Fans on, sucked down to the pad' : cutTime === null ? 'Launch: motors + 4 rear thrusters' : v > 0 ? '60 mph. Thrust off, braking (the pad is short)' : 'Stopped',
          forces: {
            weight: [0, -weight, 0], suction: [0, -suction, 0], road: [0, weight + suction, 0],
            grip: [tyre, 0, 0], thrust: [rear, 0, 0], velocity: [v, 0, 0],
          },
          nozzles: { corner: [0, 0, 0, 0], rear: [rear / 4, rear / 4, rear / 4, rear / 4], lateral: [0, 0] },
        });
      }
    }
    return { tank, cutTime, distanceAtSixty, saturated, motorForce };
  };

  // Solve for the rear thrust that gives Tesla's 0.81 s
  let low = 0, high = fullCapacity * 1.5;
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2;
    const time = run(middle).cutTime;
    if (time === null || time > 0.81) low = middle; else high = middle;
  }
  const neededThrust = high;
  const frames = [];
  const result = run(neededThrust, frames);
  const peakG = frames.reduce((best, frame) => Math.max(best, frame.horizontalG), 0);
  const peakBrakeG = frames.reduce((best, frame) => Math.max(best, -frame.horizontalG), 0);
  return {
    frames, tank: result.tank,
    summary: {
      neededThrust, fullCapacity, fullThrustTime: run(fullCapacity).cutTime, motorOnlyTime: run(0).cutTime,
      distanceAtSixty: result.distanceAtSixty, saturated: result.saturated, peakG, peakBrakeG, actualTime: result.cutTime,
      motorForce: result.motorForce(0), timeOrigin: 0,
      gasUsed: result.tank.fullGas - result.tank.gas, fullGas: result.tank.fullGas, usableGas: result.tank.fullGas - result.tank.strandedGas,
      peakThrust: neededThrust, peakShare: neededThrust / fullCapacity,
    },
  };
}

export const STUNTS = { wall: wallRide, drop: wallDrop, kickflip, launch, tower: towerFlip };

export function simulate(id, params) { return STUNTS[id](params); }

// ---------- verdicts ----------

const LABELS = { good: 'Plausible', tight: 'Barely plausible', fail: 'Implausible' };
const wrapAngle = angle => ((angle % TURN) + TURN) % TURN;
const percent = share => `${Math.round(share * 100)}%`;

// good = the car does it with margin to spare; tight = it does it with almost nothing to spare;
// fail = in this simulation the car doesn't make it. reason: the one fact that decides it.
export function verdict(id, result, params) {
  const s = result.summary;
  if (id === 'wall') {
    const slipping = s.slipTime > 0.2;
    const status = s.outcome.kind !== 'held' ? 'fail' : slipping || s.suctionCapped || s.worstMargin < 1.3 ? 'tight' : 'good';
    const reason = status === 'fail' ? s.outcome.text.charAt(0).toLowerCase() + s.outcome.text.slice(1)
      : slipping ? `tyres slip at ${Math.round(s.slipAngle * 180 / Math.PI)}° and it falls ${Math.round(s.worstLag * 180 / Math.PI)}° behind`
        : s.worstMargin < 1 ? `tyres slip briefly at ${Math.round(wrapAngle(s.worstMarginAt.pitch) * 180 / Math.PI)}°`
          : s.suctionCapped ? `fans max out at ${Math.round(s.suctionLimit / GRAVITY).toLocaleString('en-US')} kg of suction`
            : `${s.worstMargin.toFixed(1)}× the suction it needs`;
    return { status, label: LABELS[status], reason };
  }
  if (id === 'launch') {
    const status = s.actualTime === null || s.actualTime > 0.86 ? 'fail'
      : s.neededThrust > 0.85 * s.fullCapacity || s.actualTime > 0.82 ? 'tight' : 'good';
    const reason = status === 'fail' ? `best is ${s.actualTime === null ? 'over 1.9' : s.actualTime.toFixed(2)} s`
      : `uses ${percent(Math.min(1, s.neededThrust / s.fullCapacity))} of rear thrust`;
    return { status, label: LABELS[status], reason };
  }
  const gasShare = s.gasUsed / s.usableGas;
  let status = 'good';
  if (s.outcome.kind !== 'landed') status = 'fail';
  else if (gasShare > 0.85 || s.saturatedTime > 0.1) status = 'tight';
  let reason = gasShare > 0.99 ? 'uses all of the usable air' : `uses ${percent(gasShare)} of the usable air`;
  if (status === 'fail') {
    const text = s.outcome.text.charAt(0).toLowerCase() + s.outcome.text.slice(1);
    reason = s.outOfAir && s.outcome.kind !== 'hit' ? `runs out of air and ${text}` : text;
  } else if (gasShare <= 0.85 && s.saturatedTime > 0.1) reason = `needs all of its thrust (${s.peakSharePhase.toLowerCase()})`;
  return { status, label: LABELS[status], reason, gasShare };
}

// Exhaust speed from a full tank through the regulator (or straight from the tank without one)
export function fullTankExhaust(params) {
  return new Tank(params).exhaustSpeed;
}
