// Teams (fictional liveries inspired by the modern grid)
export const TEAMS = [
  { name: 'Scuderia Rossa',    code: 'ROS', num: 16, sponsor: 'VELOCE',   c1: '#c8000a', c2: '#ffd000', c3: '#111111', speed: .93, accel: .90, grip: .88, brake: .88 },
  { name: 'Toro Blu Racing',   code: 'TBR', num: 1,  sponsor: 'HYPERION', c1: '#16214f', c2: '#e10600', c3: '#ffcc00', speed: .96, accel: .93, grip: .94, brake: .91 },
  { name: 'Papaya Motorsport', code: 'PAP', num: 4,  sponsor: 'NEON FUEL',c1: '#ff7a00', c2: '#1a8fff', c3: '#111111', speed: .92, accel: .92, grip: .96, brake: .90 },
  { name: 'Silver Arrow GP',   code: 'SAG', num: 63, sponsor: 'ASTRAL',  c1: '#b9bec3', c2: '#00d2be', c3: '#111111', speed: .95, accel: .88, grip: .89, brake: .92 },
  { name: 'Emerald Racing',    code: 'EMR', num: 14, sponsor: 'SOLARA',   c1: '#00594f', c2: '#cedc00', c3: '#ffffff', speed: .87, accel: .86, grip: .89, brake: .85 },
  { name: 'Azure Alpine',      code: 'AZA', num: 10, sponsor: 'AQUAPURE', c1: '#0a5cbf', c2: '#ff5fa2', c3: '#ffffff', speed: .86, accel: .88, grip: .84, brake: .86 },
  { name: 'Grove Racing',      code: 'GRV', num: 23, sponsor: 'GROVELINE', c1: '#0a3cff', c2: '#00b4ff', c3: '#ffffff', speed: .95, accel: .82, grip: .80, brake: .83 },
  { name: 'Liberty Stars',     code: 'LIB', num: 20, sponsor: 'STARLINE',c1: '#e9e9e9', c2: '#d0021b', c3: '#222222', speed: .86, accel: .84, grip: .82, brake: .84 },
  { name: 'Blackjack F1',      code: 'BJK', num: 27, sponsor: 'ACE HIGH', c1: '#1c1c1c', c2: '#1ee36b', c3: '#ffffff', speed: .88, accel: .85, grip: .85, brake: .85 },
  { name: 'Violet Veloce',     code: 'VIO', num: 22, sponsor: 'VIOLA PAY',     c1: '#1f2a8f', c2: '#f2f2f2', c3: '#ff2a55', speed: .88, accel: .87, grip: .86, brake: .87 },
];

// Tyre compounds: grip multiplier, wear rate, sidewall colour
export const COMPOUNDS = {
  soft:   { key: 'S', mu: 1.035, wear: 2.2, color: '#ff2a2a', optimal: 95 },
  medium: { key: 'M', mu: 1.0,   wear: 1.0, color: '#ffd21e', optimal: 100 },
  hard:   { key: 'H', mu: 0.972, wear: 0.5, color: '#f2f2f2', optimal: 105 },
};

// Physical spec derived from team stats. SI units.
export function carSpec(t) {
  return {
    mass: 800,                               // car + driver + some fuel (kg)
    L: 3.6, a: 1.98, hcg: 0.29, Iz: 1150,    // wheelbase, CG->front axle, CG height, yaw inertia
    rw: 0.36,                                // tyre radius
    power: 600e3 + 70e3 * t.accel,           // W at peak (ICE + normal ERS deploy)
    ersPower: 120e3,                         // extra W on overtake
    cda: 1.52 - 0.2 * t.speed,               // drag area
    cla: 5.4 + 2.2 * t.grip,                 // downforce area
    aeroBal: 0.44,                           // front share of downforce
    mu0: 1.52 + 0.1 * t.grip,                // peak tyre friction at static load
    loadSens: 0.075,                         // grip falloff with load
    brakeMax: 52000 + 16000 * t.brake,       // N at full pedal
    bias: 0.57,
    ratios: [0, 14.2, 11.0, 9.1, 7.75, 6.75, 5.95, 5.3, 4.72],
    idle: 4000, redline: 12200,
  };
}

// Circuits: control points (x, z metres) of a closed Catmull-Rom centreline
export const TRACKS = [
  { id: 'veloce', name: 'Autodromo Veloce', blurb: 'Temple of speed', width: 13, runoff: 16, style: 'park',
    sky: { turbidity: 4, rayleigh: 1.2, elev: 38, azim: 150 }, fog: '#b9cde3', exposure: 0.42, sunI: 4.2, hemi: 1.1,
    points: [[-350, 0], [200, 0], [600, 0], [700, 15], [780, -10], [900, 0], [1100, 60], [1200, 220], [1150, 400], [1000, 480], [700, 520], [400, 560], [200, 650], [0, 700], [-300, 700], [-420, 690], [-480, 720], [-560, 700], [-800, 650], [-1000, 550], [-1050, 350], [-980, 150], [-850, 30], [-650, 0]] },
  { id: 'riviera', name: 'Riviera Street Circuit', blurb: 'Tight streets, zero margin', width: 10.5, runoff: 1.6, style: 'street',
    sky: { turbidity: 7, rayleigh: 2.2, elev: 14, azim: 250 }, fog: '#d9b596', exposure: 0.4, sunI: 4.4, hemi: 0.9,
    points: [[40, 0], [250, 0], [300, -40], [300, -160], [380, -250], [520, -260], [560, -200], [520, -120], [560, -60], [700, -40], [760, 60], [700, 160], [500, 200], [300, 180], [200, 240], [80, 300], [-80, 280], [-160, 200], [-120, 120], [-220, 60], [-180, 0], [-80, -2]] },
  { id: 'northfield', name: 'Northfield Grand Prix', blurb: 'Fast, flowing, overcast', width: 14, runoff: 20, style: 'park',
    sky: { turbidity: 18, rayleigh: 3.5, elev: 30, azim: 60 }, fog: '#aab1b8', exposure: 0.4, sunI: 2.2, hemi: 1.5,
    points: [[0, 0], [500, 0], [800, -50], [1000, -200], [1100, -450], [950, -650], [700, -700], [500, -600], [350, -650], [150, -800], [-150, -780], [-300, -600], [-250, -400], [-450, -300], [-600, -150], [-450, -20]] },
];
