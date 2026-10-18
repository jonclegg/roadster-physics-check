// Runs every Roadster stunt outside the browser and prints the results as Markdown: the key numbers at the
// default hardware, then each dial swept across its range with the verdict for every stunt.
//
//   node scripts/roadster_check.mjs
//
// No dependencies. It loads the same physics.js and tank tables the page uses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const page = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'roadster');
globalThis.window = {};
new Function(fs.readFileSync(path.join(page, 'tank-tables.js'), 'utf8'))();
const physics = await import(pathToFileURL(path.join(page, 'physics.js')).href);
physics.setTankTables(window.TANK_TABLES);

const { DEFAULT_PARAMS, GRAVITY, FEET, Tank, simulate, verdict, fullTankExhaust } = physics;
const STUNT_NAMES = { wall: 'Wall ride', drop: 'Wall launch and drop', kickflip: 'Kickflip over the fleet', launch: '0–60 mph in 0.81 s', tower: 'Tower flip finale' };
const STATUS = { good: 'Plausible', tight: 'Barely plausible', fail: 'Implausible' };
const SWEEPS = {
  dryMass: [1300, 1500, 1700, 1900, 2100, 2300, 2600],
  fillPsi: [4000, 5000, 6000, 7000, 8000, 10000],
  nozzleThrust: [5, 10, 15, 20, 25, 30],
  nozzleEfficiency: [0.7, 0.8, 0.9, 1],
  regulatorPsi: [0, 500, 1000, 2000, 3000],
  blowdown: ['adiabatic', 'isothermal'],
  skirtGap: [1, 3, 8, 16, 20, 25, 30],
  tyreGrip: [0.5, 0.7, 1.0, 1.26, 1.6],
};
const round = (value, digits = 0) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const tank = new Tank(DEFAULT_PARAMS);
console.log('## The default hardware\n');
console.log('| Quantity | Value |\n|---|---|');
console.log(`| Car without air | ${round(DEFAULT_PARAMS.dryMass)} kg |`);
console.log(`| Nitrogen at ${round(DEFAULT_PARAMS.fillPsi)} psi in 600 L | ${round(tank.fullGas, 1)} kg |`);
console.log(`| Take-off mass | ${round(DEFAULT_PARAMS.dryMass + tank.fullGas)} kg |`);
console.log(`| Gas too cold to use (adiabatic blowdown) | ${round(tank.strandedGas, 1)} kg |`);
console.log(`| Exhaust speed, full tank through the regulator | ${round(fullTankExhaust(DEFAULT_PARAMS))} m/s |`);
const wall = simulate('wall', DEFAULT_PARAMS).summary;
console.log(`| Most suction the fans can hold (${DEFAULT_PARAMS.skirtGap} mm gap) | ${round(wall.suctionLimit / GRAVITY)} kg |`);

console.log('\n## Each stunt at the default hardware\n');
console.log('| Stunt | Verdict | Deciding fact | Details |\n|---|---|---|---|');
for (const id of Object.keys(STUNT_NAMES)) {
  const result = simulate(id, DEFAULT_PARAMS), summary = result.summary, v = verdict(id, result, DEFAULT_PARAMS);
  const details = id === 'wall'
    ? `peak suction ${round(summary.peakSuction / GRAVITY)} kg, peak fan power ${round(summary.peakFan / 1000)} kW`
    : id === 'launch'
      ? `needs ${round(summary.neededThrust / 1000, 1)} kN of rear thrust; motors alone ${summary.motorOnlyTime === null ? 'over 1.9' : round(summary.motorOnlyTime, 2)} s`
      : `apex ${round(summary.apex / FEET)} ft, touchdown ${summary.touchdownSpeed === null ? '–' : round(summary.touchdownSpeed, 1)} m/s, air used ${round(summary.gasUsed)} of ${round(summary.usableGas)} kg usable`;
  console.log(`| ${STUNT_NAMES[id]} | ${STATUS[v.status]} | ${v.reason} | ${details} |`);
}

console.log('\n## The simulation against the video, at the default hardware\n');
console.log('Video numbers are the broadcast gauges (altitude shifted 0.25 s earlier for the gauge lag) or, for the tower, heights measured in pixels.\n');
console.log('| Stunt | Quantity | Video | Simulation |\n|---|---|---|---|');
const peak = (rows, column) => Math.max(...rows.map(row => row[column]));
const kickflip = simulate('kickflip', DEFAULT_PARAMS).summary;
console.log(`| Kickflip | Peak altitude | ${round(peak(physics.KICKFLIP_TELEMETRY, 2), 1)} ft | ${round(kickflip.apex / FEET, 1)} ft |`);
console.log(`| Kickflip | Peak G in the lift-off burn | ${round(peak(physics.KICKFLIP_TELEMETRY.filter(row => row[0] < 672.5), 1), 1)} | ${round(kickflip.boostG, 1)} |`);
console.log(`| Kickflip | Touchdown (video clock) | about 676.2 s | ${round(kickflip.touchdownTime, 2)} s |`);
const drop = simulate('drop', DEFAULT_PARAMS).summary;
console.log(`| Wall drop | Height leaving the lip | ${round(peak(physics.DROP_TELEMETRY, 2), 1)} ft | ${round(drop.lipHeight / FEET, 1)} ft |`);
console.log(`| Wall drop | Peak G in the catch | ${round(peak(physics.DROP_TELEMETRY.filter(row => row[0] > 438), 1), 1)} | ${round(drop.catchG, 1)} |`);
console.log(`| Wall drop | Touchdown (video clock) | about 441 s | ${round(drop.touchdownTime, 2)} s |`);
const tower = simulate('tower', DEFAULT_PARAMS).summary;
console.log(`| Tower flip | Peak height | over ${round(peak(physics.TOWER_MEASURED, 1), 1)} m (camera cuts away) | ${round(tower.apex, 1)} m |`);
console.log(`| Tower flip | Worst miss against the measured heights | – | ${round(tower.worstMeasured, 1)} m |`);

console.log('\n## Each dial across its range\n');
console.log('Every other dial stays at its default. ✓ plausible, ~ barely plausible, ✗ implausible.\n');
const symbol = { good: '✓', tight: '~', fail: '✗' };
for (const [key, values] of Object.entries(SWEEPS)) {
  console.log(`### ${key} (default ${DEFAULT_PARAMS[key]})\n`);
  console.log(`| ${key} | ${Object.values(STUNT_NAMES).join(' | ')} |\n|---|${Object.keys(STUNT_NAMES).map(() => '---').join('|')}|`);
  for (const value of values) {
    const params = { ...DEFAULT_PARAMS, [key]: value };
    const cells = Object.keys(STUNT_NAMES).map(id => { const v = verdict(id, simulate(id, params), params); return `${symbol[v.status]} ${v.reason}`; });
    console.log(`| ${value} | ${cells.join(' | ')} |`);
  }
  console.log('');
}
