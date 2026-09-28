// Vehicle dynamics: single-track (bicycle) model with Pacejka-style tyres, friction ellipse,
// aero downforce/drag, longitudinal load transfer, engine torque curve, 8-speed gearbox,
// tyre temperature & wear, and driver assists (TC / ABS).
import { clamp, lerp } from './util.js';

export const G = 9.81, RHO = 1.225;
const PB = 18.5, PC = 1.45;
const pac = a => Math.sin(PC * Math.atan(PB * a));
export const PEAK_SLIP = Math.tan(Math.PI / (2 * PC)) / PB;

export const SURF = {
  road:   { mu: 1.0,  drag: 0,    bump: 0 },
  kerb:   { mu: 0.92, drag: 0,    bump: 1 },
  runoff: { mu: 0.9,  drag: 0,    bump: 0.15 },
  grass:  { mu: 0.5,  drag: 0.05, bump: 0.6 },
  gravel: { mu: 0.45, drag: 0.28, bump: 1.2 },
};

export function engineTorque(spec, rpm) {
  const Tpk = spec.power / (11000 * Math.PI / 30);
  let f;
  if (rpm < 6000) f = 0.55 + 0.35 * (rpm - 4000) / 2000;
  else if (rpm < 9500) f = 0.9 + 0.1 * (rpm - 6000) / 3500;
  else if (rpm < 11500) f = 1;
  else f = 1 - 0.12 * (rpm - 11500) / 700;
  return Tpk * Math.max(0.3, f);
}
function tyreMu(spec, Fz, Fz0) { return spec.mu0 * Math.max(0.6, 1 - spec.loadSens * (Fz / Fz0 - 1)); }

// Steady-state max lateral acceleration for the whole car at speed v
export function maxLatAccel(spec, v, mu = 1) {
  const W = spec.mass * G, Fz = W + 0.5 * RHO * spec.cla * v * v;
  return tyreMu(spec, Fz, W) * mu * Fz / spec.mass * 0.93;
}
export function topSpeed(spec, drs = false) { return Math.cbrt(spec.power * 0.92 / (0.5 * RHO * spec.cda * (drs ? 0.86 : 1))); }

// Ideal speed at every track sample for a car of this spec (used by the AI and for brake boards)
export function speedProfile(tr, spec, skill = 1) {
  const N = tr.N, ds = tr.ds, v = new Float32Array(N), m = spec.mass;
  const vmax = topSpeed(spec) * (0.97 + 0.03 * skill);
  const power = spec.power * (0.9 + 0.1 * skill);
  for (let i = 0; i < N; i++) {
    const k = Math.abs(tr.kS[i]) * 0.9;
    let x = vmax;
    if (k > 1e-5) { x = 60; for (let it = 0; it < 10; it++) x = Math.min(vmax, Math.sqrt(maxLatAccel(spec, x, skill) / k)); }
    v[i] = x;
  }
  for (let n = 0; n < 2 * N; n++) {           // braking
    const i = N - 1 - (n % N), j = (i + 1) % N;
    const dec = maxLatAccel(spec, v[j], skill) * 0.92 + 0.5 * RHO * spec.cda * v[j] * v[j] / m;
    const lim = Math.sqrt(v[j] * v[j] + 2 * dec * ds);
    if (v[i] > lim) v[i] = lim;
  }
  for (let n = 0; n < 2 * N; n++) {           // traction / power
    const i = n % N, j = (i + 1) % N, vi = Math.max(v[i], 3);
    const down = 0.5 * RHO * spec.cla * vi * vi;
    const trac = spec.mu0 * skill * (m * G * spec.a / spec.L + down * (1 - spec.aeroBal)) / m * 0.95;
    const acc = Math.min(trac, power * 0.92 / (m * vi)) - 0.5 * RHO * spec.cda * vi * vi / m;
    const lim = Math.sqrt(v[i] * v[i] + 2 * Math.max(0, acc) * ds);
    if (v[j] > lim) v[j] = lim;
  }
  return v;
}

// Max steering angle so a keyboard/pad full-lock sits near the tyres' peak slip
export function steerLimit(spec, v, assist) {
  const vv = Math.max(v, 1), k = maxLatAccel(spec, vv) / (vv * vv);
  return Math.min(0.38, spec.L * k + PEAK_SLIP * (assist ? 0.75 : 1.3));
}

export function createCarPhys(spec, compound) {
  return {
    spec, compound, x: 0, z: 0, h: 0, vx: 0, vy: 0, r: 0,
    gear: 1, rpm: spec.idle, shiftT: 0, shiftCool: 0, axS: 0, ayS: 0,
    fyf: 0, fyr: 0, useF: 0, useR: 0, lockF: 0, spinR: 0, slideF: 0, slideR: 0,
    tyreT: [82, 82, 82, 82], wear: 0, damage: 0, ers: 1, ersOn: false, drsOpen: false,
    delta: 0, bump: 0, harvest: false, reverse: false,
  };
}

// One physics step. ctl: {thr, brk, steer(-1..1, left +), ers, manualGear}
// env: {muW:[FL,FR,RL,RR], drag, auto, abs, tc, steerMax}
export function stepCar(c, ctl, dt, env) {
  const s = c.spec, m = s.mass, L = s.L, a = s.a, b = L - a, W = m * G;
  let { vx, vy, r } = c;
  const avx = Math.abs(vx), sgn = vx >= 0 ? 1 : -1;
  // ---- aero
  const q = 0.5 * RHO * vx * vx;
  const cla = s.cla * (c.drsOpen ? 0.9 : 1), cda = s.cda * (c.drsOpen ? 0.86 : 1) * (1 + c.damage * 0.06);
  const downF = q * cla * s.aeroBal * (1 - c.damage * 0.55), downR = q * cla * (1 - s.aeroBal);
  const Fdrag = q * cda * sgn;
  // ---- loads (with longitudinal transfer)
  const dT = m * c.axS * s.hcg / L;
  const Fzf = Math.max(0.15 * W, W * b / L + downF - dT), Fzr = Math.max(0.15 * W, W * a / L + downR + dT);
  // ---- tyre condition: compound, temperature window, wear
  const tF = (c.tyreT[0] + c.tyreT[1]) / 2, tR = (c.tyreT[2] + c.tyreT[3]) / 2, opt = c.compound.optimal;
  const tg = t => clamp(1 - 0.00008 * (t - opt) ** 2, 0.9, 1);
  const cond = c.compound.mu * (1 - c.wear * 0.15);
  const muF = (env.muW[0] + env.muW[1]) / 2, muR = (env.muW[2] + env.muW[3]) / 2;
  const capF = tyreMu(s, Fzf, W * b / L) * muF * cond * tg(tF) * Fzf * 0.96;
  const capR = tyreMu(s, Fzr, W * a / L) * muR * cond * tg(tR) * Fzr * 0.96 * 1.1; // wider rears

  // ---- powertrain
  const ratio = s.ratios[c.gear];
  const wheelRpm = avx / s.rw * 30 / Math.PI;
  let rpm = Math.max(s.idle, wheelRpm * ratio);
  const launching = c.gear === 1 && ctl.thr > 0.05 && wheelRpm * ratio < 9000 && !c.reverse;
  if (launching) rpm = Math.max(rpm, lerp(s.idle, 9500, ctl.thr));
  const limiter = rpm >= s.redline;
  let Tq = engineTorque(s, rpm) * ctl.thr;
  if (limiter) Tq *= 0.1;
  if (c.shiftT > 0) Tq *= 0.35;
  let Fdrive = c.reverse ? -3200 * ctl.brk : Tq * ratio / s.rw * 0.92;
  c.ersOn = false;
  if (ctl.ers && c.ers > 0 && ctl.thr > 0.5 && !c.reverse) { Fdrive += s.ersPower * ctl.thr / Math.max(avx, 10); c.ers = Math.max(0, c.ers - dt * 0.1); c.ersOn = true; }
  // engine braking + MGU-K harvest on lift / braking
  c.harvest = false;
  if (!c.reverse && ctl.thr < 0.1 && avx > 2) {
    Fdrive -= (18 + 28 * rpm / 12000) * ratio / s.rw;
    if (avx > 15) { Fdrive -= Math.min(1400, 60e3 / avx); c.ers = Math.min(1, c.ers + dt * 0.03); c.harvest = true; }
  }
  // ---- brakes
  const brk = c.reverse ? 0 : ctl.brk;
  const Fb = brk * s.brakeMax * (avx < 1 ? avx : 1);
  let FxF = -Fb * s.bias * sgn, FxR = Fdrive - Fb * (1 - s.bias) * sgn;
  // ---- steering + slip angles (first, so the assists know how much grip cornering is using)
  const delta = ctl.steer * env.steerMax;
  const vxa = Math.max(avx, 1.5);
  const aF = Math.atan2(vy + a * r, vxa) - delta * sgn, aR = Math.atan2(vy - b * r, vxa);
  const cd = Math.cos(delta), sd = Math.sin(delta);
  const vLatF = (vy + a * r) * cd - vx * sd, vLatR = vy - b * r;
  const fy0F = capF * pac(aF), fy0R = capR * pac(aR);          // pure cornering force
  const availF = Math.sqrt(Math.max(0, capF * capF - fy0F * fy0F)), availR = Math.sqrt(Math.max(0, capR * capR - fy0R * fy0R));
  // brake-by-wire: engine braking / harvest never locks the rears on its own
  if (Fdrive < 0 && FxR < 0) { const eb = Math.min(-Fdrive, availR * 0.8); FxR = FxR - Fdrive - eb; }
  if (env.abs) { if (Math.abs(FxF) > availF * 0.97) FxF = Math.sign(FxF) * availF * 0.97; if (FxR < 0 && -FxR > availR * 0.97) FxR = -availR * 0.97; }
  let tcCut = 0;
  const tcLim = Math.max(availR * 0.95, capR * 0.12);
  if (env.tc && FxR > tcLim) { tcCut = 1 - tcLim / FxR; FxR = tcLim; }
  c.tcCut = tcCut;
  // combined slip: friction ellipse, saturation -> sliding
  const axle = (Fxd, cap, fy0, vLat, mA) => {
    let Fx = Fxd, Fy = -fy0, slide = 0;
    if (Math.abs(Fxd) > cap) { slide = Math.min(1, Math.abs(Fxd) / cap - 1 + 0.2); Fx = Math.sign(Fxd) * cap * 0.85; Fy = -fy0 * 0.35; }
    else { const hh = Math.hypot(Fx, Fy); if (hh > cap) { const k = cap / hh; Fx *= k; Fy *= k; } }
    const lim = mA * Math.abs(vLat) / dt; if (Math.abs(Fy) > lim) Fy = Math.sign(Fy) * lim;
    return [Fx, Fy, slide];
  };
  const [fxF, fyF, slF] = axle(FxF, capF, fy0F, vLatF, m * b / L * 0.9);
  const [fxR, fyR, slR] = axle(FxR, capR, fy0R, vLatR, m * a / L * 0.9);
  c.fyf = fyF; c.fyr = fyR; c.lockF = FxF < 0 && slF > 0 ? slF : 0; c.spinR = FxR > 0 && slR > 0 ? slR : (FxR < 0 && slR > 0 ? slR : 0);
  c.useF = Math.hypot(fxF, fyF) / Math.max(capF, 1); c.useR = Math.hypot(fxR, fyR) / Math.max(capR, 1);
  c.slideF = Math.max(0, Math.abs(aF) - PEAK_SLIP * 1.3); c.slideR = Math.max(0, Math.abs(aR) - PEAK_SLIP * 1.3);

  // ---- surface drag & rolling resistance
  const Froll = (Fzf + Fzr) * 0.012 * sgn + env.drag * W * sgn * Math.min(1, avx / 3) + env.drag * 90 * vx;
  // ---- sum forces in body frame
  const FX = fxF * cd - fyF * sd + fxR - Fdrag - Froll;
  const FY = fxF * sd + fyF * cd + fyR;
  const MZ = a * (fxF * sd + fyF * cd) - b * fyR;
  let nvx = vx + (FX / m + vy * r) * dt;
  let nvy = vy + (FY / m - vx * r) * dt;
  let nr = clamp(r + MZ / s.Iz * dt, -5, 5);
  { const sp = Math.max(Math.hypot(vx, vy), 3); if (Math.abs(nvy) > sp) nvy = Math.sign(nvy) * sp; }
  // stop cleanly instead of oscillating around zero
  if (!c.reverse && Fdrive <= 0 && vx > 0 && nvx < 0) nvx = 0;
  if (c.reverse && nvx > 0 && Fdrive < 0.1) nvx = 0;
  if (c.reverse) nvx = Math.max(nvx, -6);
  // low speed: blend to kinematic model (tyre model is singular at standstill)
  const kb = clamp((Math.abs(nvx) - 2) / 4, 0, 1);
  if (kb < 1) {
    const rk = nvx * Math.tan(delta) / L;
    nr = lerp(rk, nr, kb); nvy = lerp(rk * b, nvy, kb);
  }
  c.vx = nvx; c.vy = nvy; c.r = nr;
  c.axS = lerp(c.axS, (nvx - vx) / dt, Math.min(1, dt * 12));
  c.ayS = lerp(c.ayS, FY / m, Math.min(1, dt * 12));
  c.h += nr * dt;
  const sh = Math.sin(c.h), ch = Math.cos(c.h);
  c.x += (sh * nvx + ch * nvy) * dt; c.z += (ch * nvx - sh * nvy) * dt;

  // ---- gearbox
  c.shiftT = Math.max(0, c.shiftT - dt); c.shiftCool = Math.max(0, c.shiftCool - dt);
  const wr = Math.abs(nvx) / s.rw * 30 / Math.PI;
  if (env.auto && !c.reverse && c.shiftCool === 0) {
    if (wr * s.ratios[c.gear] > s.redline - 250 && c.gear < 8) { c.gear++; c.shiftT = 0.035; c.shiftCool = 0.2; c.shifted = 1; }
    else if (c.gear > 1) {
      const down = wr * s.ratios[c.gear - 1];
      if (down < 11200 && (wr * s.ratios[c.gear] < 7600 || (brk > 0.3 && down < 10800))) { c.gear--; c.shiftCool = 0.18; c.shifted = -1; }
    }
  }
  c.rpm = lerp(c.rpm, limiter ? s.redline - 150 + Math.random() * 300 : rpm, Math.min(1, dt * 30));
  // ---- tyres: temperature & wear
  const v = Math.hypot(nvx, nvy), vf = Math.min(v, 70) / 70;
  const heatF = 5 * c.useF * vf + 1.4 * v / 80 + c.lockF * 20, heatR = 5 * c.useR * vf + 1.4 * v / 80 + c.spinR * 20;
  const latShift = clamp(c.ayS / 40, -0.4, 0.4); // outside tyres work harder
  for (let i = 0; i < 4; i++) {
    const heat = (i < 2 ? heatF : heatR) * (1 + (i % 2 === 0 ? -latShift : latShift));
    c.tyreT[i] += (heat - (0.035 + v * 0.0004) * (c.tyreT[i] - 40)) * dt;
  }
  c.wear = Math.min(1, c.wear + dt * 0.00035 * (c.useF + c.useR) * 0.5 * c.compound.wear * (v / 60) + dt * (c.lockF + c.spinR) * 0.002);
  c.capF = capF; c.capR = capR; c.Fzf = Fzf; c.Fzr = Fzr;
}

// Kinematic AI car following a precomputed speed profile along the track
export function createAI(spec, skill) {
  return { spec, skill, s: 0, total: 0, lat: 0, v: 0, h: 0, x: 0, z: 0, line: 0, avoid: 0, react: 0.12 + Math.random() * 0.3, finished: false, finishTime: null, damage: 0 };
}
export function aiAccel(ai) {
  const s = ai.spec, v = Math.max(ai.v, 3), down = 0.5 * RHO * s.cla * v * v;
  const trac = s.mu0 * ai.skill * (s.mass * G * s.a / s.L + down * (1 - s.aeroBal)) / s.mass * 0.95;
  return Math.min(trac, s.power * (0.9 + 0.1 * ai.skill) * 0.92 / (s.mass * v)) - 0.5 * RHO * s.cda * v * v / s.mass;
}
