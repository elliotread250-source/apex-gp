import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { $, clamp, lerp, wrapAng, fmt, store } from './util.js';
import { TEAMS, TRACKS, COMPOUNDS, carSpec } from './data.js';
import { buildTextures, setAniso } from './textures.js';
import { makeCar, disposeCar } from './carModel.js';
import { buildWorld, sampleAt, gridPose, nearestIdx, surfaceAt, disposeScene } from './track.js';
import { SURF, createCarPhys, stepCar, steerLimit, speedProfile, createAI, aiAccel, maxLatAccel, topSpeed } from './physics.js';
import { createPost, createFX, createMirror } from './fx.js';
import { audio } from './audio.js';
import { IS_TOUCH, IS_PHONE, touch, initTouch, setTouchActive, goFullscreenLandscape } from './touch.js';
import { ASSETS, loadManifest, ensureModel, hasModel, carFromAsset } from './assets.js';

// ============================================================ RENDERER
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
renderer.domElement.id = 'gl';
// adaptive resolution: starts modest, scales up/down to hold the display's frame rate
const QUALITY = {
  high:   { post: true,  mirror: true,  shadows: 2048, player: 'full', ai: 'lod', garage: 'full', trees: 1400, terrainSeg: 220, prStart: 1,    prMax: 1.5 },
  medium: { post: false, mirror: false, shadows: 1024, player: 'lod',  ai: 'lod', garage: 'lod',  trees: 700,  terrainSeg: 140, prStart: 0.9,  prMax: 1.0 },
  low:    { post: false, mirror: false, shadows: 0,    player: 'lo',   ai: 'lo',  garage: 'lo',   trees: 250,  terrainSeg: 70,  prStart: 0.65, prMax: 0.8 },
};
// pick a sensible default for this machine (school laptops / Chromebooks -> low)
// Chrome without GPU acceleration renders on the CPU ("Basic Render Driver" / SwiftShader) -> 2-3 fps
const GPU_NAME = (() => { try { const gl = renderer.getContext(); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : ''; } catch { return ''; } })();
const SOFTWARE_GL = /Basic Render|SwiftShader|llvmpipe|Software|WARP/i.test(GPU_NAME);
function detectQuality() {
  const gpu = GPU_NAME;
  const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 8;
  if (IS_PHONE) return 'low';
  if (SOFTWARE_GL || /Mali|PowerVR|Adreno|Intel.*HD Graphics|Intel\(R\) HD|UHD Graphics 6|Celeron|Pentium/i.test(gpu) || cores <= 2 || mem <= 2) return 'low';
  if (/Intel|Iris|Radeon\(TM\) Graphics|Radeon Graphics|Vega|Apple M1/i.test(gpu) || cores <= 4 || mem <= 4) return 'medium';
  return 'high';
}
const RES = { pr: 1, min: 0.45, max: 1, acc: 0, frames: 0, good: 0 };
const Q = () => QUALITY[S.gfx] || QUALITY.medium;
function applyQuality() { const q = Q(); RES.max = Math.min(devicePixelRatio, q.prMax) * (SOFTWARE_GL ? 0.5 : 1); RES.min = SOFTWARE_GL ? 0.25 : 0.45; RES.pr = Math.min(RES.max, q.prStart * (SOFTWARE_GL ? 0.55 : 1)); renderer.setPixelRatio(RES.pr); renderer.shadowMap.enabled = q.shadows > 0; }
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // updated once per frame, not again for the mirror pass
document.body.prepend(renderer.domElement);
setAniso(renderer.capabilities.getMaxAnisotropy());
const T = buildTextures();

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.05, 9000);
let post = null;
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  if (post) post.setSize(innerWidth, innerHeight);
});
const mirror = createMirror();

// ============================================================ INPUT
const keys = new Set(), pressed = new Set();
addEventListener('keydown', e => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (!keys.has(e.code)) pressed.add(e.code);
  keys.add(e.code);
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const padPrev = {};
function readInput() {
  const k = c => keys.has(c);
  let thr = (k('KeyW') || k('ArrowUp')) ? 1 : 0;
  let brk = (k('KeyS') || k('ArrowDown')) ? 1 : 0;
  let steer = ((k('KeyA') || k('ArrowLeft')) ? 1 : 0) - ((k('KeyD') || k('ArrowRight')) ? 1 : 0);
  let analog = false, drs = k('ShiftLeft') || k('ShiftRight'), ers = k('KeyE');
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const ax = gp.axes[0] || 0;
    if (Math.abs(ax) > 0.06) { steer = -Math.sign(ax) * ((Math.abs(ax) - 0.06) / 0.94) ** 1.3; analog = true; }
    const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
    if (rt > 0.02) { thr = Math.max(thr, rt); analog = true; } if (lt > 0.02) { brk = Math.max(brk, lt); analog = true; }
    if (gp.buttons[0]?.pressed) drs = true; if (gp.buttons[1]?.pressed) ers = true;
    const edge = (i, code) => { const p = !!gp.buttons[i]?.pressed; if (p && !padPrev[i]) pressed.add(code); padPrev[i] = p; };
    edge(3, 'KeyC'); edge(12, 'Space'); edge(9, 'Escape'); edge(5, 'KeyX'); edge(4, 'KeyZ'); edge(2, 'KeyR');
    break;
  }
  let analogSteer = analog;
  if (touch.active) {
    if (touch.thr) thr = 1; if (touch.brk) brk = 1;
    if (touch.steer !== null) { steer = touch.steer; analogSteer = true; }
    drs = drs || touch.drs; ers = ers || touch.ers;
  }
  return { thr, brk, steer, analog, analogSteer, drs, ers };
}

// ============================================================ STATE
const S = { mode: 'race', team: 0, track: 0, laps: 3, skill: 0.95, opp: 9, grid: 'back', tyre: 'medium', assists: 'full', gfx: 'high', camMode: 0, manual: false, fov: 62, state: 'menu', time: 0 };
Object.assign(S, store.get('apex.settings2') || {});
if (S.input !== 'kbm' && S.input !== 'mobile') S.input = IS_TOUCH ? 'mobile' : 'kbm';
if (!store.get('apex.gfxChosen') || !QUALITY[S.gfx] || SOFTWARE_GL) S.gfx = detectQuality();
if (SOFTWARE_GL) document.getElementById('gpuWarn').classList.remove('hidden');
applyQuality();
S.state = 'menu';
let world = null, player = null, ais = [], fx = null, raceT0 = 0, countdown = null, finishInfo = null;

function saveSettings() {
  const { mode, team, track, laps, skill, opp, grid, tyre, assists, gfx, camMode, manual, fov, hidePillar, input } = S;
  store.set('apex.settings2', { mode, team, track, laps, skill, opp, grid, tyre, assists, gfx, camMode, manual, fov, hidePillar, input });
}

// ============================================================ SESSION
function startSession() {
  saveSettings();
  audio.init();
  if (world) { disposeScene(world.scene); }
  if (post) { post.dispose(); post = null; }
  const def = TRACKS[S.track];
  const refSpec = carSpec(TEAMS[1]);
  const trTmp = null;
  applyQuality();
  world = buildWorld(def, T, renderer, { Q: Q(), profile: null });
  const tr = world.tr;
  // brake boards need a speed profile: rebuild just the board pass cheaply by recomputing world with profile
  world.profile = speedProfile(tr, refSpec, 1);
  disposeScene(world.scene);
  world = Object.assign(buildWorld(def, T, renderer, { Q: Q(), profile: world.profile }), { profile: world.profile });
  renderer.toneMappingExposure = def.exposure;
  fx = createFX(world.scene, T);
  if (Q().post) post = createPost(renderer, world.scene, camera);

  const trk = world.tr;
  const nAI = S.mode === 'race' ? S.opp : 0;
  const rivals = TEAMS.map((t, i) => i).filter(i => i !== S.team).sort(() => Math.random() - 0.5).slice(0, nAI);
  const pSlot = S.mode === 'tt' ? 0 : S.grid === 'pole' ? 0 : S.grid === 'mid' ? Math.floor(nAI / 2) : nAI;
  player = newPlayer(trk, TEAMS[S.team], gridPose(trk, pSlot));
  ais = [];
  let slot = 0;
  for (const ti of rivals) { if (slot === pSlot) slot++; ais.push(newAI(trk, TEAMS[ti], gridPose(trk, slot))); slot++; }
  finishInfo = null; pressed.clear(); camInit = false; S.time = 0;
  $('#menu').classList.add('hidden'); $('#results').classList.add('hidden'); $('#pause').classList.add('hidden');
  $('#hud').classList.remove('hidden');
  setTouchActive(S.input === 'mobile');
  $('#tower').classList.toggle('hidden', S.mode !== 'race');
  buildLeds(); prepMinimap();
  const cmp = COMPOUNDS[S.tyre];
  $('#cmp').textContent = cmp.key; $('#cmp').style.borderColor = cmp.color;
  $('#assistTxt').textContent = S.assists === 'full' ? 'TC · ABS' : S.assists === 'some' ? 'TC' : 'NO ASSISTS';
  if (S.mode === 'race') {
    S.state = 'countdown'; countdown = { t: 0, lit: 0, out: 1.2 + 5 + 0.3 + Math.random() * 1.2 };
    $('#lights').classList.remove('hidden'); renderLights(0); flash('', '');
  } else {
    S.state = 'race'; raceT0 = 0; countdown = null; $('#lights').classList.add('hidden');
    flash('TIME TRIAL', 'Cross the line to start your lap', 2.5);
  }
}

function newPlayer(tr, team, gp) {
  const spec = carSpec(team), cmp = COMPOUNDS[S.tyre];
  const car = hasModel(Q().player) ? carFromAsset(team, Q().player) : makeCar(team, T, { cockpit: true, compound: cmp.color, mirrorTex: Q().mirror ? mirror.rt.texture : null });
  world.scene.add(car.group);
  const c = createCarPhys(spec, cmp);
  c.x = gp.x; c.z = gp.z; c.h = gp.h;
  return {
    c, car, team, spec, code: 'YOU', idx: nearestIdx(tr, gp.x, gp.z, -1), s: gp.s, lat: gp.lat, prevS: gp.s, total: gp.s - tr.L,
    maxLap: -1, lapStart: 0, lapTimes: [], best: null, last: null, finished: false, finishTime: null,
    steer: 0, thr: 0, brk: 0, wrongWay: 0, shake: 0, spinAngle: 0, surf: ['road', 'road', 'road', 'road'],
    sector: 0, secStart: 0, secTimes: [null, null, null], bestSec: store.get('apex.sec.' + tr.def.id) || [null, null, null], secCols: ['', '', ''],
    trace: new Float32Array(Math.ceil(tr.L / 10) + 2), bestTrace: null, get v() { return this.c.vx; }, get x() { return this.c.x; }, get z() { return this.c.z; }, get h() { return this.c.h; }
  };
}
function newAI(tr, team, gp) {
  const spec = carSpec(team);
  const car = hasModel(Q().ai) ? carFromAsset(team, Q().ai) : makeCar(team, T, { compound: COMPOUNDS[['soft', 'medium', 'hard'][Math.floor(Math.random() * 3)]].color });
  world.scene.add(car.group);
  const sk = S.skill * (0.975 + Math.random() * 0.035);
  const a = createAI(spec, sk);
  Object.assign(a, { car, team, code: team.code, s: gp.s, total: gp.s - tr.L, lat: gp.lat, h: gp.h, x: gp.x, z: gp.z, lineK: 0.75 + Math.random() * 0.3, profile: speedProfile(tr, spec, sk), rpm: 5000, spinAngle: 0 });
  return a;
}

// ============================================================ PLAYER
const WHEELS = [[1, 0.8], [1, -0.8], [0, 0.8], [0, -0.8]]; // [front?, left offset]
function updatePlayer(dt, inp, locked) {
  const tr = world.tr, p = player, c = p.c, spec = p.spec;
  p.idx = nearestIdx(tr, c.x, c.z, p.idx);
  const P0 = tr.P[p.idx], T0 = tr.T[p.idx], N0 = tr.NL[p.idx];
  const rx = c.x - P0.x, rz = c.z - P0.z;
  p.lat = rx * N0.x + rz * N0.z;
  p.s = ((p.idx * tr.ds + rx * T0.x + rz * T0.z) % tr.L + tr.L) % tr.L;
  const hT = Math.atan2(T0.x, T0.z), rel = wrapAng(c.h - hT), sr = Math.sin(rel), cr = Math.cos(rel);
  // per-wheel surfaces
  const muW = [], b = spec.L - spec.a; let drag = 0, bump = 0;
  WHEELS.forEach(([f, y], i) => {
    const fx = f ? spec.a : -b, lat = p.lat + fx * sr + y * cr;
    const sf = surfaceAt(tr, p.idx, lat); p.surf[i] = sf;
    muW.push(SURF[sf].mu); drag += SURF[sf].drag / 4; bump = Math.max(bump, SURF[sf].bump);
  });
  c.bump = bump;
  if (p.finished) inp = { thr: 0.15, brk: c.vx > 25 ? 0.3 : 0, steer: clamp(-p.lat * 0.05 - rel * 1.5, -1, 1), drs: false, ers: false, analog: true, analogSteer: true };

  // pedal & steering smoothing (keyboard is digital)
  if (inp.analog) { p.thr = inp.thr; p.brk = inp.brk; }
  else { p.thr += clamp(inp.thr - p.thr, -dt * 10, dt * 6); p.brk += clamp(inp.brk - p.brk, -dt * 10, dt * 9); }
  const target = inp.steer, v = Math.abs(c.vx);
  // keyboard: progressive ramp that slows with speed, so taps are small corrections and holds are full turns
  if (inp.analogSteer) p.steerRaw = lerp(p.steerRaw || 0, target, Math.min(1, dt * 12));
  else {
    const sr = p.steerRaw || 0, speedK = 1 / (1 + v / 25);
    const rate = target === 0 ? 2.6 + 3 * speedK : (Math.sign(target) !== Math.sign(sr) && Math.abs(sr) > 0.05 ? 5 : 0.55 + 2.8 * speedK);
    p.steerRaw = sr + clamp(target - sr, -rate * dt, rate * dt);
  }
  // curved response: finer control around centre
  const sa = Math.abs(p.steerRaw);
  p.steer = Math.sign(p.steerRaw) * (inp.analogSteer ? sa : 0.35 * sa + 0.65 * sa * sa);

  // DRS / reverse
  const drsAvail = !!tr.drs[p.idx] && (S.mode === 'tt' || (raceT0 && Math.floor(p.total / tr.L) >= 1));
  if (!drsAvail || p.brk > 0.1) c.drsOpen = false; else if (inp.drs) c.drsOpen = true;
  p.drsAvail = drsAvail;
  if (v < 0.4 && inp.brk > 0.5 && inp.thr === 0 && !locked) c.reverse = true;
  if (inp.thr > 0.05 || (c.reverse && inp.brk === 0 && v < 0.3)) c.reverse = false;
  if (c.reverse && c.vx > 0.5) c.reverse = false;

  if (locked) { // on the grid: rev the engine
    c.rpm = lerp(c.rpm, 4000 + p.thr * 7500 + (p.thr > 0.5 ? Math.sin(S.time * 30) * 250 : 0), Math.min(1, dt * 8));
    return;
  }
  const full = S.assists === 'full';
  stepCar(c, { thr: p.thr, brk: p.brk, steer: p.steer, ers: inp.ers }, dt, {
    muW, drag, auto: !S.manual, abs: full, tc: S.assists !== 'off',
    steerMax: steerLimit(spec, v, full) * (inp.analogSteer ? 1.1 : 1)
  });
  if (c.shifted) { audio.shift(); c.shifted = 0; }

  // walls
  const nlat = (c.x - P0.x) * N0.x + (c.z - P0.z) * N0.z;
  const ext = Math.abs(sr) * 2.4 + Math.abs(cr) * 0.95;
  const wallLim = tr.wallD - ext;
  if (Math.abs(nlat) > wallLim) {
    const sg = Math.sign(nlat), pen = Math.abs(nlat) - wallLim;
    const nx = -N0.x * sg, nz = -N0.z * sg; // points back into the track
    c.x += nx * pen; c.z += nz * pen;
    const sh = Math.sin(c.h), ch = Math.cos(c.h);
    let Vx = sh * c.vx + ch * c.vy, Vz = ch * c.vx - sh * c.vy;
    const vn = Vx * nx + Vz * nz;
    if (vn < 0) {
      Vx -= 1.2 * vn * nx; Vz -= 1.2 * vn * nz;
      const tx = Vx - (Vx * nx + Vz * nz) * nx, tz = Vz - (Vx * nx + Vz * nz) * nz, tl = Math.hypot(tx, tz);
      const loss = Math.min(1, 0.45 * -vn / Math.max(tl, 1));
      Vx -= tx * loss; Vz -= tz * loss;
      c.vx = Vx * sh + Vz * ch; c.vy = Vx * ch - Vz * sh;
      const fwd = Math.abs(rel) < Math.PI / 2, align = fwd ? -rel : wrapAng(Math.PI - rel);
      c.r = c.r * 0.3 + align * Math.min(3, -vn * 0.25);
      const hit = -vn;
      audio.thud(hit / 14); p.shake = Math.max(p.shake, hit / 25);
      if (hit > 9) { c.damage = Math.min(1, c.damage + (hit - 9) / 28); if (c.damage > 0.35 && !p.wingGone) { p.wingGone = true; p.car.frontWing.forEach(m => m.visible = false); flash('', 'FRONT WING DAMAGE', 2.5, 'warn'); } }
      for (let i = 0; i < Math.min(30, hit * 2); i++) fx.sparks.emit(c.x - nx * 1, 0.4, c.z - nz * 1, Vx * 0.5 + (Math.random() - .5) * 6, Math.random() * 4, Vz * 0.5 + (Math.random() - .5) * 6, 0.4, 0.12, 0, 1, 1, 0.8, 0.4);
    }
  }
  if (Math.abs(nlat) > tr.wallD + 8) resetPlayer();
  p.wrongWay = (Math.abs(rel) > 2.0 && c.vx > 4) ? p.wrongWay + dt : 0;
  p.stuck = (Math.abs(c.vx) < 1.5 && p.thr > 0.5) ? (p.stuck || 0) + dt : 0;
}

function resetPlayer() {
  const tr = world.tr, p = player, c = p.c, q = sampleAt(tr, p.s - 5);
  Object.assign(c, { x: q.x, z: q.z, h: Math.atan2(q.tx, q.tz), vx: 0, vy: 0, r: 0, gear: 1, reverse: false });
  p.steer = 0; p.steerRaw = 0; p.idx = nearestIdx(tr, c.x, c.z, -1);
  flash('', 'Car reset', 1.2);
}

// ============================================================ AI
function updateAIs(dt, locked) {
  const tr = world.tr, L = tr.L, all = [player, ...ais];
  for (const a of ais) {
    if (locked) { a.rpm = 5000 + Math.random() * 3000; continue; }
    if (a.react > 0) { a.react -= dt; continue; }
    const i = Math.floor(((a.s % L) + L) % L / tr.ds) % tr.N;
    let vT = a.profile[i];
    if (a.finished) vT = Math.min(vT, 45);
    let avoidT = 0, cap = Infinity;
    for (const o of all) {
      if (o === a) continue;
      const os = o === player ? player.s : o.s, ov = o === player ? player.c.vx : o.v;
      let gap = ((os - a.s) % L + L * 1.5) % L - L / 2;
      if (gap > 0 && gap < 28 && Math.abs(o.lat - a.lat) < 2.6) {
        const side = o.lat > 0 ? -1 : 1;
        const room = side > 0 ? (tr.halfW - 1.3) - o.lat : o.lat - (-tr.halfW + 1.3);
        if (room > 2.8 && a.v > ov - 6) avoidT = o.lat + side * 3.2 - a.line;
        if (gap < 14) cap = Math.min(cap, Math.max(0, ov) + (gap - 7) * 1.2); // close up to ~7 m, then match speed
      }
    }
    if (cap < Infinity) vT = Math.min(vT, cap);
    a.avoid = lerp(a.avoid, avoidT, Math.min(1, dt * 1.6));
    if (a.v < vT) a.v = Math.min(vT, a.v + Math.max(0.5, aiAccel(a)) * dt);
    else a.v = Math.max(vT, a.v - (maxLatAccel(a.spec, a.v, a.skill) * 0.95 + 0.5 * 1.225 * a.spec.cda * a.v * a.v / a.spec.mass) * dt);
    a.s += a.v * dt; a.total += a.v * dt;
    const idx = Math.floor(((a.s % L) + L) % L / tr.ds) % tr.N;
    a.line = tr.line[idx] * a.lineK;
    const latT = clamp(a.line + a.avoid, -tr.halfW + 1.2, tr.halfW - 1.2);
    a.lat = lerp(a.lat, latT, Math.min(1, dt * (a.total < 50 ? 0.4 : 1.2)));
    // rpm for sound: pick a gear like the player's box would
    const r = a.spec.ratios; let g = 1; const wr = a.v / a.spec.rw * 30 / Math.PI; while (g < 8 && wr * r[g] > 11900) g++;
    a.rpm = Math.max(5000, wr * r[g]);
  }
  for (const a of ais) {
    const q = sampleAt(tr, a.s), nx = q.x + q.nx * a.lat, nz = q.z + q.nz * a.lat, dx = nx - a.x, dz = nz - a.z;
    a.h = (dx * dx + dz * dz > 0.0004) ? a.h + wrapAng(Math.atan2(dx, dz) - a.h) * 0.35 : Math.atan2(q.tx, q.tz);
    a.x = nx; a.z = nz;
    if (!a.finished && S.mode === 'race' && a.total >= S.laps * L) { a.finished = true; a.finishTime = S.time - raceT0; }
  }
}

function collide() {
  const p = player, c = p.c, tr = world.tr;
  for (const a of ais) {
    const dx0 = a.x - c.x, dz0 = a.z - c.z; if (dx0 * dx0 + dz0 * dz0 > 49) continue;
    let best = null;
    for (const o1 of [1.5, -1.5]) for (const o2 of [1.5, -1.5]) {
      const ax = c.x + Math.sin(c.h) * o1, az = c.z + Math.cos(c.h) * o1, bx = a.x + Math.sin(a.h) * o2, bz = a.z + Math.cos(a.h) * o2;
      const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz);
      if (d < 1.9 && (!best || 1.9 - d > best.pen)) best = { pen: 1.9 - d, nx: dx / (d || 1), nz: dz / (d || 1) };
    }
    if (!best) continue;
    const { pen, nx, nz } = best;
    c.x -= nx * pen * 0.6; c.z -= nz * pen * 0.6;
    const q = sampleAt(tr, a.s);
    a.lat += (nx * q.nx + nz * q.nz) * pen * 0.4; a.s += (nx * q.tx + nz * q.tz) * pen * 0.4;
    const sh = Math.sin(c.h), ch = Math.cos(c.h);
    let Vx = sh * c.vx + ch * c.vy, Vz = ch * c.vx - sh * c.vy;
    const avx = Math.sin(a.h) * a.v, avz = Math.cos(a.h) * a.v;
    const rel = (Vx - avx) * nx + (Vz - avz) * nz;
    if (rel > 0) {
      const j = rel * 0.55;
      Vx -= nx * j; Vz -= nz * j;
      c.vx = Vx * sh + Vz * ch; c.vy = Vx * ch - Vz * sh;
      c.r += (nx * ch - nz * sh) * j * 0.08;
      a.v = Math.max(0, a.v + j * (Math.sin(a.h) * nx + Math.cos(a.h) * nz));
      audio.thud(rel / 20); p.shake = Math.max(p.shake, rel / 30);
      if (rel > 8) c.damage = Math.min(1, c.damage + rel / 80);
    }
  }
}

// ============================================================ RACE LOGIC / TIMING
function updateProgress() {
  const tr = world.tr, p = player;
  let d = p.s - p.prevS; if (d < -tr.L / 2) d += tr.L; if (d > tr.L / 2) d -= tr.L;
  p.total += d; p.prevS = p.s;
  const lapT = S.time - p.lapStart;
  const timing = !(S.mode === 'tt' && p.maxLap < 0);
  if (timing && p.total >= 0) {
    const bin = Math.floor(p.s / 10); if (bin < p.trace.length) p.trace[bin] = lapT;
    // sectors
    const sec = Math.min(2, Math.floor(p.s / (tr.L / 3)));
    if (sec > p.sector && p.maxLap >= 0 && sec === p.sector + 1) { closeSector(p.sector, S.time - p.secStart); p.sector = sec; p.secStart = S.time; }
  }
  const lapIdx = Math.floor(p.total / tr.L);
  if (lapIdx > p.maxLap) {
    const prev = p.maxLap; p.maxLap = lapIdx;
    if (prev === -1 && lapIdx === 0) {
      if (S.mode === 'tt') { p.lapStart = S.time; flash('', 'Lap started', 1.2); }
      p.sector = 0; p.secStart = S.mode === 'tt' ? S.time : p.lapStart; p.secCols = ['', '', ''];
    } else if (lapIdx >= 1) {
      closeSector(2, S.time - p.secStart);
      const lt = S.time - p.lapStart; p.lapStart = S.time; p.sector = 0; p.secStart = S.time;
      p.last = lt; p.lapTimes.push(lt);
      const pb = p.best == null || lt < p.best;
      if (pb) { p.best = lt; p.bestTrace = p.trace.slice(); }
      p.trace = new Float32Array(p.trace.length);
      const rec = store.get('apex.best.' + tr.def.id);
      if (rec == null || lt < rec) { store.set('apex.best.' + tr.def.id, lt); store.set('apex.trace.' + tr.def.id, Array.from(p.bestTrace || [])); }
      if (S.mode === 'race' && lapIdx >= S.laps) { finishRace(); return; }
      const extra = S.mode === 'race' && lapIdx === S.laps - 1 ? 'FINAL LAP' : '';
      flash(extra || (pb ? 'PERSONAL BEST' : 'LAP ' + lapIdx), fmt(lt) + (rec != null && lt < rec ? '  ·  TRACK RECORD' : ''), 2.5, pb ? 'pb' : '');
      audio.beep(pb ? 990 : 780, 0.12);
      setTimeout(() => { if (player === p) p.secCols = ['', '', '']; }, 3000);
    }
  }
}
function closeSector(i, t) {
  const p = player, tr = world.tr;
  const pb = p.bestSec[i] == null || t < p.bestSec[i];
  p.secCols[i] = pb ? 'var(--purple)' : (p.secTimes[i] != null && t < p.secTimes[i] ? 'var(--green)' : 'var(--yellow)');
  p.secTimes[i] = t;
  if (pb) { p.bestSec[i] = t; store.set('apex.sec.' + tr.def.id, p.bestSec); }
}
function finishRace() {
  const p = player; p.finished = true; p.finishTime = S.time - raceT0;
  const pos = standings().indexOf(p) + 1;
  flash(pos === 1 ? 'WINNER!' : 'P' + pos, 'Chequered flag', 4);
  audio.beep(1040, 0.3);
  finishInfo = { at: S.time };
}
function standings() {
  return [player, ...ais].sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1; if (b.finished) return 1;
    return b.total - a.total;
  });
}
function showResults() {
  S.state = 'results';
  setTouchActive(false);
  const tr = world.tr, now = S.time - raceT0;
  const rows = [player, ...ais].map(c => {
    const v = c === player ? player.c.vx : c.v;
    return { c, t: c.finished ? c.finishTime : now + (S.laps * tr.L - c.total) / Math.max(v || 0, 45) };
  }).sort((a, b) => a.t - b.t);
  const lead = rows[0].t, pPos = rows.findIndex(r => r.c === player) + 1;
  $('#resTitle').textContent = pPos === 1 ? '🏆 VICTORY' : 'FINISHED P' + pPos;
  $('#resBody').innerHTML = `<table class="res">${rows.map((r, i) => `<tr class="${r.c === player ? 'me' : ''}"><td class="pos">${i + 1}</td>
    <td><span style="display:inline-block;width:4px;height:14px;background:${r.c.team.c1};margin-right:8px;vertical-align:-2px"></span>${r.c === player ? 'YOU' : r.c.code} <span style="color:var(--dim);font-size:12px">${r.c.team.name}</span></td>
    <td class="gap">${i === 0 ? fmt(r.t) : '+' + (r.t - lead).toFixed(3)}</td></tr>`).join('')}</table>
    <div style="margin-top:12px;color:var(--dim);font-size:13px">Your best lap: <b style="color:var(--purple)">${fmt(player.best)}</b></div>`;
  $('#results').classList.remove('hidden');
}

// ============================================================ HUD
let msgTimer = 0;
function flash(main, sub = '', dur = 2, cls = '') {
  $('#msg').textContent = main; $('#sub').textContent = sub;
  $('#msg').className = cls === 'warn' ? 'warn' : ''; $('#msg').style.color = cls === 'pb' ? 'var(--purple)' : '';
  if (cls === 'warn' && !main) $('#sub').style.color = '#ffb000'; else $('#sub').style.color = '';
  $('#msg').style.opacity = $('#sub').style.opacity = 1; msgTimer = dur;
}
function buildLeds() { $('#leds').innerHTML = '<i></i>'.repeat(15); }
function renderLights(n) {
  $('#lights').innerHTML = Array.from({ length: 5 }, (_, i) => `<div class="col"><i class="${i < n ? 'on' : ''}"></i><i class="${i < n ? 'on' : ''}"></i></div>`).join('');
  if (world) world.lightsMats.forEach((m, i) => m.color.set(i < n ? '#ff2a10' : '#2a0000'));
}
let mm = null;
function prepMinimap() {
  const tr = world.tr, b = tr.bounds, W = 440, pad = 34;
  const sc = Math.min((W - pad * 2) / (b.max.x - b.min.x), (W - pad * 2) / (b.max.z - b.min.z));
  const ox = W / 2 - (b.min.x + b.max.x) / 2 * sc, oz = W / 2 - (b.min.z + b.max.z) / 2 * sc;
  const X = x => ox + x * sc, Z = z => oz + z * sc;
  const bg = document.createElement('canvas'); bg.width = bg.height = W;
  const g = bg.getContext('2d'); g.lineJoin = g.lineCap = 'round';
  const path = () => { g.beginPath(); tr.P.forEach((p, i) => i ? g.lineTo(X(p.x), Z(p.z)) : g.moveTo(X(p.x), Z(p.z))); g.closePath(); };
  path(); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 16; g.stroke();
  path(); g.strokeStyle = '#e9e9ee'; g.lineWidth = 8; g.stroke();
  g.strokeStyle = '#1ee36b';
  for (let i = 0; i < tr.N; i++) if (tr.drs[i] && tr.drs[(i + 1) % tr.N]) { const a = tr.P[i], c = tr.P[(i + 1) % tr.N]; g.beginPath(); g.moveTo(X(a.x), Z(a.z)); g.lineTo(X(c.x), Z(c.z)); g.stroke(); }
  const s0 = tr.P[0]; g.fillStyle = '#e10600'; g.fillRect(X(s0.x) - 7, Z(s0.z) - 7, 14, 14);
  mm = { bg, X, Z, ctx: $('#minimap').getContext('2d') };
}
function drawMinimap() {
  const { bg, X, Z, ctx } = mm;
  ctx.clearRect(0, 0, 440, 440); ctx.drawImage(bg, 0, 0);
  for (const a of ais) { ctx.fillStyle = a.team.c1; ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(X(a.x), Z(a.z), 9, 0, 7); ctx.fill(); ctx.stroke(); }
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#e10600'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(X(player.c.x), Z(player.c.z), 12, 0, 7); ctx.fill(); ctx.stroke();
}
const tempCol = t => t < 70 ? '#2f7dff' : t < 88 ? '#27c3c9' : t < 112 ? '#1ee36b' : t < 125 ? '#ffb000' : '#ff3030';
let hudT = 0, hudN = 0;
function updateHUD(dt) {
  const p = player, c = p.c, tr = world.tr;
  if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) $('#msg').style.opacity = $('#sub').style.opacity = 0; }
  if (p.stuck > 2.5 && msgTimer <= 0) flash('', 'Stuck? Press R to reset', 2, 'warn');
  if (p.wrongWay > 1) { $('#msg').textContent = 'WRONG WAY'; $('#msg').className = 'warn'; $('#msg').style.opacity = 1; $('#sub').textContent = 'Press R to reset'; $('#sub').style.opacity = 1; msgTimer = 0.3; }
  hudT += dt; if (hudT < 1 / 30) return; hudT = 0; hudN++;
  const kmh = Math.round(Math.abs(c.vx) * 3.6);
  $('#speed').textContent = kmh;
  const gear = c.reverse ? 'R' : (S.state === 'countdown' ? 'N' : c.gear);
  $('#gear').textContent = gear;
  const leds = $('#leds').children, frac = clamp((c.rpm - 9000) / 3000, 0, 1), lit = Math.round(frac * 15);
  const flashOn = c.rpm > 11800 && Math.floor(S.time * 12) % 2;
  for (let i = 0; i < 15; i++) leds[i].style.background = i < lit ? (flashOn ? '#2f8cff' : i < 5 ? '#1ee36b' : i < 10 ? '#ff2a1a' : '#b44dff') : '#222';
  $('#drsPill').className = 'pill' + (c.drsOpen ? ' act' : p.drsAvail ? ' avail' : '');
  $('#ersPill').className = 'pill' + (c.ersOn ? ' act' : c.harvest ? ' avail' : '');
  $('#ersBar b').style.width = (c.ers * 100) + '%';
  $('#gbTxt').textContent = S.manual ? 'MANUAL' : 'AUTO';
  const cur = S.state === 'countdown' ? 0 : (S.mode === 'tt' && p.maxLap < 0 ? null : S.time - p.lapStart);
  $('#tCur').textContent = cur == null ? 'OUT LAP' : fmt(cur);
  $('#tLast').textContent = fmt(p.last);
  $('#tBest').textContent = fmt(p.best ?? (S.mode === 'tt' ? store.get('apex.best.' + tr.def.id) : null));
  // live delta to best lap
  const ref = p.bestTrace || (S.mode === 'tt' ? world.refTrace : null);
  const dEl = $('#delta');
  if (ref && cur != null && p.total >= 0) {
    const f = p.s / 10, i = Math.floor(f), r0 = ref[i], r1 = ref[i + 1] || r0;
    if (r0 > 0) { const dlt = cur - lerp(r0, r1, f - i); dEl.textContent = (dlt >= 0 ? '+' : '−') + Math.abs(dlt).toFixed(2); dEl.className = dlt < 0 ? 'neg' : 'pos'; } else dEl.textContent = '';
  } else dEl.textContent = '';
  const secs = $('#sectors').children;
  for (let i = 0; i < 3; i++) secs[i].style.background = p.secCols[i] || (i === p.sector && cur != null ? '#555' : '#2a2a35');
  // tyres
  const tg = $('.tgrid').children;
  for (let i = 0; i < 4; i++) tg[i].style.background = tempCol(c.tyreT[i]);
  $('#tyreTxt').textContent = `${Math.round((c.tyreT[0] + c.tyreT[1] + c.tyreT[2] + c.tyreT[3]) / 4)}°C · WEAR ${Math.round(c.wear * 100)}%` + (c.damage > 0.05 ? ` · DMG ${Math.round(c.damage * 100)}%` : '');
  if (S.mode === 'race') {
    const st = standings(), pos = st.indexOf(p) + 1;
    $('#posTxt').textContent = pos + '/' + st.length;
    $('#lapTxt').textContent = clamp(Math.floor(p.total / tr.L) + 1, 1, S.laps) + '/' + S.laps;
    const lead = st[0];
    if ((hudN % 6) === 0) $('#tower').innerHTML = st.map((o, i) => {
      const ov = o === p ? p.c.vx : o.v;
      let gap = i === 0 ? 'LEADER' : o.finished ? 'FIN' : '+' + ((lead.total - o.total) / Math.max(40, ov || 0)).toFixed(1);
      if (!o.finished && lead.total - o.total > tr.L) gap = '+' + Math.floor((lead.total - o.total) / tr.L) + ' LAP';
      return `<div class="r ${o === p ? 'me' : ''}"><span class="p">${i + 1}</span><span class="c" style="background:${o.team.c1}"></span><span>${o === p ? 'YOU' : o.code}</span><span class="g">${gap}</span></div>`;
    }).join('');
  } else { $('#posTxt').textContent = 'TT'; $('#lapTxt').textContent = Math.max(0, p.maxLap + 1); }
  if (hudN % 2 === 0) drawMinimap();
  // steering wheel display + LEDs
  const car = p.car;
  if (car.dispCanvas && S.camMode === 0) {
    const g = car.dispCanvas.getContext('2d');
    g.fillStyle = '#04060a'; g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#fff'; g.font = '900 78px Titillium Web, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(gear, 128, 60);
    g.font = '700 30px Titillium Web, Arial'; g.textAlign = 'left'; g.fillText(kmh, 12, 32);
    g.fillStyle = c.drsOpen ? '#1ee36b' : p.drsAvail ? '#0f5a2a' : '#333'; g.fillRect(190, 12, 54, 26); g.fillStyle = '#000'; g.font = '900 20px Titillium Web, Arial'; g.fillText('DRS', 197, 26);
    if (dEl.textContent) { g.fillStyle = dEl.className === 'neg' ? '#1ee36b' : '#ff4040'; g.font = '700 24px Titillium Web, Arial'; g.textAlign = 'right'; g.fillText(dEl.textContent, 246, 64); g.textAlign = 'left'; }
    g.fillStyle = '#ffd21e'; g.fillRect(12, 104, 232 * c.ers, 12);
    g.fillStyle = '#aaa'; g.font = '600 20px Titillium Web, Arial'; g.fillText(cur == null ? '' : fmt(cur), 12, 80);
    for (let i = 0; i < 4; i++) { g.fillStyle = tempCol(c.tyreT[i]); g.fillRect(200 + (i % 2) * 22, 72 + (i >> 1) * 14, 18, 10); }
    car.dispTex.needsUpdate = true;
    car.ledMats.forEach((m, i) => m.color.set(i < Math.round(frac * 10) ? (flashOn ? '#2f8cff' : i < 4 ? '#1ee36b' : i < 7 ? '#ff2a1a' : '#b44dff') : '#111'));
  }
}

// ============================================================ VISUALS / FX
function syncPlayerCar(dt) {
  const p = player, c = p.c, car = p.car, g = car.group;
  const bumpY = c.bump * (Math.sin(S.time * 57) * 0.006 + Math.sin(S.time * 31) * 0.004) * Math.min(1, Math.abs(c.vx) / 20);
  g.position.set(c.x, bumpY, c.z);
  // tiny pitch/roll from load transfer (F1 cars are stiff)
  g.rotation.set(clamp(-c.axS * 0.0006, -0.012, 0.012), c.h, clamp(c.ayS * 0.0004, -0.015, 0.015), 'YXZ');
  p.spinAngle += (c.lockF > 0.3 ? 0 : c.vx * dt / 0.36) + c.spinR * dt * 20;
  car.spins.forEach((sp, i) => sp.rotation.x = i < 2 && c.lockF > 0.3 ? sp.rotation.x : p.spinAngle);
  const st = p.steer * steerLimit(p.spec, Math.abs(c.vx), S.assists === 'full');
  for (const f of car.steer) f.rotation.y = st;
  car.drsFlap.rotation.x = c.drsOpen ? -0.75 : 0;
  if (car.wheel) car.wheel.rotation.z = -p.steer * 1.6;
  car.rain.material.emissiveIntensity = c.harvest ? (Math.floor(S.time * 8) % 2 ? 4 : 0.3) : 0.4;
}
function syncAI(a, dt) {
  const g = a.car.group, tr = world.tr;
  g.position.set(a.x, 0, a.z); g.rotation.set(0, a.h, 0);
  a.spinAngle += a.v * dt / 0.36;
  for (const sp of a.car.spins) sp.rotation.x = a.spinAngle;
  const st = wrapAng(a.h - (a._ph ?? a.h)) / Math.max(dt, 1e-3) * 3.6 / Math.max(a.v, 5); a._st = lerp(a._st || 0, clamp(st, -0.3, 0.3), 0.2); a._ph = a.h;
  for (const f of a.car.steer) f.rotation.y = a._st;
  const i = Math.floor(((a.s % tr.L) + tr.L) % tr.L / tr.ds) % tr.N;
  a.car.drsFlap.rotation.x = tr.drs[i] && S.state === 'race' && a.total > tr.L ? -0.75 : 0;
}
let fxAcc = 0;
function emitFX(dt) {
  const p = player, c = p.c, spec = p.spec;
  fxAcc += dt; if (fxAcc < 1 / 60) return; fxAcc = 0;
  const sh = Math.sin(c.h), ch = Math.cos(c.h), b = spec.L - spec.a, v = Math.hypot(c.vx, c.vy);
  WHEELS.forEach(([f, y], i) => {
    const fx_ = f ? spec.a : -b, wx = c.x + sh * fx_ + ch * y, wz = c.z + ch * fx_ - sh * y;
    const surf = p.surf[i];
    const strength = f ? Math.max(c.lockF, c.slideF * 3) : Math.max(c.spinR, c.slideR * 3);
    const onTarmac = surf === 'road' || surf === 'kerb' || surf === 'runoff';
    fx.skids.mark('p' + i, wx, wz, f ? 0.3 : 0.38, onTarmac && strength > 0.12 && v > 3 ? 1 : 0);
    if (onTarmac && strength > 0.15 && v > 3 && Math.random() < strength * 1.5)
      fx.smoke.emit(wx, 0.25, wz, (Math.random() - .5) * 1.5 + sh * c.vx * 0.15, 0.5 + Math.random() * 0.6, (Math.random() - .5) * 1.5 + ch * c.vx * 0.15, 1.8 + Math.random(), 0.9, 2.6, 0.32, 0.92, 0.92, 0.95);
    if ((surf === 'grass' || surf === 'gravel') && v > 8 && Math.random() < 0.7)
      fx.dirt.emit(wx, 0.3, wz, (Math.random() - .5) * 2, 0.8 + Math.random(), (Math.random() - .5) * 2, 1.2, 0.7, 2.2, 0.45, surf === 'gravel' ? 0.78 : 0.45, surf === 'gravel' ? 0.68 : 0.4, surf === 'gravel' ? 0.52 : 0.25);
  });
  // plank sparks when the car bottoms out at high speed (more on kerbs & bumps)
  const sparkRate = clamp((v - 58) / 25, 0, 1) * (0.25 + c.bump * 0.9);
  if (Math.random() < sparkRate) {
    const n = 3 + Math.random() * 8 | 0, bx = c.x - sh * 1.2, bz = c.z - ch * 1.2;
    for (let i = 0; i < n; i++) fx.sparks.emit(bx + (Math.random() - .5) * 0.5, 0.05, bz + (Math.random() - .5) * 0.5, sh * c.vx * 0.55 + (Math.random() - .5) * 5, Math.random() * 2.5, ch * c.vx * 0.55 + (Math.random() - .5) * 5, 0.22 + Math.random() * 0.2, 0.09, 0, 1, 1, 0.75, 0.35);
  }
}

// ============================================================ CAMERA
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0), xAxis = new THREE.Vector3(1, 0, 0), zAxis = new THREE.Vector3(0, 0, 1);
let camRoll = 0, camInit = false;
const chase = { yaw: 0, dist: 5.6 };
const head = { gLong: 0, gLat: 0, look: 0 };
function updateCamera(dt) {
  const p = player, c = p.c, g = p.car.group, v = Math.abs(c.vx), t = S.time;
  g.updateMatrixWorld(true);
  const lookBack = keys.has('KeyB'), cockpit = S.camMode === 0 && !lookBack;
  p.car.helmet.visible = p.car.visor.visible = !cockpit;
  p.car.pillar.visible = !(cockpit && S.hidePillar);
  p.shake = Math.max(0, p.shake - dt * 2.5);
  const vib = p.shake * 0.05 + c.bump * 0.006 * Math.min(1, v / 20) + Math.min(v / 95, 1) * 0.0008 + (S.state === 'countdown' ? 0.0006 : 0);
  const jx = (Math.sin(t * 41) + Math.sin(t * 67.3) * 0.6) * vib, jy = (Math.sin(t * 53.7) + Math.sin(t * 89.1) * 0.5) * vib;
  head.gLong = lerp(head.gLong, clamp(c.axS / 9.81, -6, 3), Math.min(1, dt * 4));
  head.gLat = lerp(head.gLat, clamp(c.ayS / 9.81, -6, 6), Math.min(1, dt * 3));
  const gLong = head.gLong, gLat = head.gLat;
  camRoll = lerp(camRoll, clamp(gLat * 0.008, -0.04, 0.04), Math.min(1, dt * 3));
  const slip = Math.atan2(c.vy, Math.max(Math.abs(c.vx), 2));
  let fov = S.fov + Math.min(v / 95, 1.1) * 5 + (c.ersOn ? 1.5 : 0);
  if (lookBack) {
    camera.position.copy(tmpV.set(0, 1.15, -2.9).applyMatrix4(g.matrixWorld));
    camera.quaternion.setFromAxisAngle(yAxis, c.h); camera.near = 0.05; fov = 62;
  } else if (S.camMode === 0) {
    const eye = (p.car.fromAsset && ASSETS.cfg.eye) || [0, 0.9, -0.46];
    const hx = eye[0] - gLat * 0.01 + jx, hy = eye[1] + jy - Math.max(0, -gLong) * 0.004, hz = eye[2] + clamp(-gLong * 0.008, -0.02, 0.04);
    camera.position.copy(tmpV.set(hx, hy, hz).applyMatrix4(g.matrixWorld));
    head.look = lerp(head.look, clamp(c.r * 0.06 + slip * 0.35, -0.2, 0.2), Math.min(1, dt * 2.5));
    camera.quaternion.setFromAxisAngle(yAxis, c.h + Math.PI + head.look);
    tmpQ.setFromAxisAngle(xAxis, -0.02 - Math.max(0, -gLong) * 0.004); camera.quaternion.multiply(tmpQ);
    tmpQ.setFromAxisAngle(zAxis, camRoll); camera.quaternion.multiply(tmpQ);
    camera.near = 0.05;
  } else if (S.camMode === 1) {
    camera.position.copy(tmpV.set(jx * 0.5, 1.24 + jy * 0.5, -0.62).applyMatrix4(g.matrixWorld));
    camera.quaternion.setFromAxisAngle(yAxis, c.h + Math.PI);
    tmpQ.setFromAxisAngle(xAxis, -0.06); camera.quaternion.multiply(tmpQ);
    camera.near = 0.05;
  } else {
    const travel = c.h + slip;
    if (!camInit) { chase.yaw = c.h; chase.dist = 5.6; camInit = true; }
    chase.yaw += wrapAng(lerp(c.h, travel, 0.5) - chase.yaw) * Math.min(1, dt * 4.5);
    chase.dist = lerp(chase.dist, 5.4 + v * 0.018 - clamp(c.axS, -40, 15) * 0.015, Math.min(1, dt * 4));
    camPos.set(c.x - Math.sin(chase.yaw) * chase.dist, 1.55 + v * 0.002, c.z - Math.cos(chase.yaw) * chase.dist);
    camera.position.copy(camPos); camera.position.x += jx * 2; camera.position.y += jy * 2;
    camLook.set(c.x + Math.sin(c.h) * 4, 0.75, c.z + Math.cos(c.h) * 4);
    camera.lookAt(camLook);
    tmpQ.setFromAxisAngle(zAxis, camRoll * 0.5); camera.quaternion.multiply(tmpQ);
    camera.near = 0.1; fov += 4;
  }
  camera.fov = lerp(camera.fov, fov, Math.min(1, dt * 4)); camera.updateProjectionMatrix();
  $('#vig').style.opacity = post ? 0 : clamp((v - 40) / 60, 0, 0.8) + (p.shake > 0.1 ? 0.3 : 0);
  if (post) {
    post.speed.uniforms.amount.value = clamp((v - 45) / 50, 0, 1) * (cockpit ? 0.8 : 0.6);
    post.speed.uniforms.ca.value = clamp(p.shake * 3, 0, 1.5);
    post.speed.uniforms.vig.value = 0.3 + clamp((v - 40) / 60, 0, 0.25);
  }
  world.sun.position.set(c.x + world.sunDir.x * 300, world.sunDir.y * 300, c.z + world.sunDir.z * 300);
  world.sun.target.position.set(c.x, 0, c.z);
  world.sky.position.set(camera.position.x, 0, camera.position.z);
}
let mirrorFrame = 0;
function renderMirror() {
  if (!Q().mirror || !player.car.mirrors.length || !(S.camMode === 0 || S.camMode === 1)) return;
  if (++mirrorFrame % 3) return;
  const g = player.car.group, mc = mirror.cam;
  mc.position.copy(tmpV.set(0, 1.25, -0.3).applyMatrix4(g.matrixWorld));
  mc.quaternion.setFromAxisAngle(yAxis, player.c.h); tmpQ.setFromAxisAngle(xAxis, -0.04); mc.quaternion.multiply(tmpQ);
  const hv = player.car.helmet.visible; player.car.mirrors.forEach(m => m.visible = false);
  renderer.setRenderTarget(mirror.rt); renderer.render(world.scene, mc); renderer.setRenderTarget(null);
  player.car.mirrors.forEach(m => m.visible = true); player.car.helmet.visible = hv;
}

// ============================================================ MAIN LOOP
const clock = new THREE.Clock();
let noRender = false;
function frame() { requestAnimationFrame(frame); tick(Math.min(clock.getDelta(), 0.05)); }
function tick(dt) {
  if (S.state === 'menu' || S.state === 'loading') { if (!noRender) renderGarage(dt); return; }
  const inp = readInput();
  if (pressed.has('Escape') || pressed.has('KeyP')) { if (S.state === 'paused') resume(); else if (S.state === 'race' || S.state === 'countdown') pause(); }
  if (pressed.has('KeyM')) { audio.setMuted(!audio.muted); flash('', audio.muted ? 'Sound off' : 'Sound on', 1); }
  if (S.state !== 'paused' && S.state !== 'results') {
    if (pressed.has('KeyC')) { S.camMode = (S.camMode + 1) % 3; camInit = false; saveSettings(); flash('', ['Cockpit cam', 'T-cam', 'Chase cam'][S.camMode], 1); }
    if (pressed.has('KeyR') && S.state === 'race' && !player.finished) resetPlayer();
    if (pressed.has('BracketLeft') || pressed.has('BracketRight')) { S.fov = clamp(S.fov + (pressed.has('BracketRight') ? 4 : -4), 46, 90); saveSettings(); flash('', 'Field of view ' + S.fov + '°', 1); }
    if (pressed.has('Space')) { S.hidePillar = !S.hidePillar; saveSettings(); flash('', S.hidePillar ? 'Halo pillar hidden' : 'Halo pillar shown', 1); }
    if (pressed.has('KeyG')) { S.manual = !S.manual; saveSettings(); flash('', S.manual ? 'Manual gearbox — X up, Z down' : 'Automatic gearbox', 1.5); }
    const c = player.c;
    if (S.manual && !c.reverse) {
      if (pressed.has('KeyX') && c.gear < 8) { c.gear++; c.shiftT = 0.035; audio.shift(); }
      if (pressed.has('KeyZ') && c.gear > 1) { c.gear--; audio.shift(); }
    }
  }
  pressed.clear();
  $('#rotate').classList.toggle('hidden', !(touch.active && innerHeight > innerWidth * 1.05));
  if (S.state === 'paused') { audio.silence(); draw(); return; }

  S.time += dt;
  const locked = S.state === 'countdown';
  if (locked) {
    countdown.t += dt;
    const n = clamp(Math.floor(countdown.t - 1.2) + 1, 0, 5);
    if (n !== countdown.lit && countdown.t < countdown.out) { countdown.lit = n; renderLights(n); if (n > 0) audio.beep(440, 0.15); }
    if (countdown.t >= countdown.out) {
      renderLights(0); S.state = 'race'; raceT0 = S.time; player.lapStart = S.time; player.secStart = S.time;
      flash('LIGHTS OUT', 'AND AWAY WE GO!', 1.8); audio.beep(880, 0.4);
      setTimeout(() => $('#lights').classList.add('hidden'), 900);
    }
  }
  const steps = Math.ceil(dt / (1 / 300)), h = dt / steps;
  const thrBefore = player.thr, rpmBefore = player.c.rpm;
  for (let i = 0; i < steps; i++) {
    updatePlayer(h, inp, locked);
    updateAIs(h, locked);
    if (!locked) collide();
  }
  if (!locked) updateProgress();
  if (finishInfo && S.state !== 'results' && S.time - finishInfo.at > 4) showResults();
  // lift-off crackle
  if (thrBefore > 0.6 && player.thr < 0.4 && rpmBefore > 9500) for (let i = 0; i < 3; i++) setTimeout(() => audio.crackle(0.8), i * 45 + Math.random() * 30);
  else if (player.thr < 0.1 && player.c.rpm > 9000 && Math.random() < dt * 6) audio.crackle(0.4);

  syncPlayerCar(dt);
  for (const a of ais) syncAI(a, dt);
  emitFX(dt); fx.update(dt);
  updateCamera(dt);
  updateHUD(dt);
  // audio
  const c = player.c, near = ais.map(a => ({ a, d: Math.hypot(a.x - c.x, a.z - c.z) })).sort((x, y) => x.d - y.d).slice(0, 2).filter(o => o.d < 250);
  audio.update({
    rpm: c.rpm, thr: locked ? player.thr : (player.finished ? 0.15 : player.thr), cut: c.shiftT > 0, speed: Math.abs(c.vx) * 3.6,
    slip: Math.max(c.lockF, c.spinR, c.slideF * 4, c.slideR * 4) * (player.surf.some(s => s === 'road' || s === 'kerb') ? 1 : 0),
    kerb: player.surf.includes('kerb') && Math.abs(c.vx) > 5, gravel: player.surf.some(s => s === 'gravel' || s === 'grass') && Math.abs(c.vx) > 3,
    lx: camera.position.x, lz: camera.position.z, lh: c.h,
    ai: near.map(({ a, d }) => {
      // doppler from closing speed
      const ux = (c.x - a.x) / (d || 1), uz = (c.z - a.z) / (d || 1);
      const vs = Math.sin(a.h) * a.v * ux + Math.cos(a.h) * a.v * uz, vl = -(Math.sin(c.h) * c.vx * ux + Math.cos(c.h) * c.vx * uz);
      return { x: a.x, z: a.z, rpm: a.rpm, doppler: clamp((343 + vl) / (343 - vs), 0.7, 1.4) };
    })
  });
  renderer.shadowMap.needsUpdate = true;
  renderMirror();
  draw();
  adaptRes(dt);
}
function draw() { if (noRender) return; if (post) post.render(); else renderer.render(world.scene, camera); }
function adaptRes(dt) {
  RES.acc += dt; RES.frames++;
  if (RES.acc < 0.75) return;
  const fps = RES.frames / RES.acc; RES.acc = 0; RES.frames = 0;
  RES.peak = Math.max((RES.peak || 60) * 0.998, Math.min(fps, 240)); // ≈ display refresh rate
  const target = RES.peak - 4;
  let pr = RES.pr;
  if (fps < target) { pr = Math.max(RES.min, pr - (fps < target * 0.75 ? 0.15 : 0.06)); RES.good = 0; }
  else if (++RES.good >= 4) { pr = Math.min(RES.max, pr + 0.05); RES.good = 0; }
  if (Math.abs(pr - RES.pr) > 0.01) { RES.pr = pr; renderer.setPixelRatio(pr); if (post) post.setSize(innerWidth, innerHeight); }
}

// ============================================================ GARAGE (MENU BACKGROUND)
const garage = { scene: new THREE.Scene(), cam: new THREE.PerspectiveCamera(32, 1, 0.1, 200), car: null, ang: 0.6, dist: null, y: 2.6, spin: true };
const photo = location.hash === '#photo';
if (photo) document.body.classList.add('photo');
{
  const gs = garage.scene; gs.background = new THREE.Color('#0b0b10');
  const pm = new THREE.PMREMGenerator(renderer); gs.environment = pm.fromScene(new RoomEnvironment(renderer), 0.04).texture; pm.dispose();
  gs.fog = new THREE.Fog('#0b0b10', 14, 40);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ color: '#101014', roughness: .55, metalness: .25, envMapIntensity: 0.25 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; gs.add(floor);
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.7, 3.8, 96), new THREE.MeshBasicMaterial({ color: '#e10600' })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01; gs.add(ring);
  const spot = new THREE.SpotLight('#ffffff', 400, 40, 0.5, 0.6); spot.position.set(3, 12, 4); spot.castShadow = true; spot.shadow.mapSize.set(2048, 2048); gs.add(spot);
  const rim = new THREE.DirectionalLight('#6fa8ff', 1.5); rim.position.set(-6, 4, -6); gs.add(rim);
  gs.add(new THREE.HemisphereLight('#ffffff', '#222', 0.4));
}
function setGarageCar(i) {
  if (garage.car) { garage.scene.remove(garage.car.group); disposeCar(garage.car); }
  const gd = hasModel(Q().garage) ? Q().garage : ['lo', 'lod', 'full'].find(hasModel);
  garage.car = gd ? carFromAsset(TEAMS[i], gd) : makeCar(TEAMS[i], T, { compound: COMPOUNDS[S.tyre].color }); garage.scene.add(garage.car.group);
}
function renderGarage(dt) {
  if (garage.spin) garage.ang += dt * 0.22;
  const w = innerWidth, narrow = w < 760 || photo, cam = garage.cam;
  cam.aspect = w / innerHeight; cam.setViewOffset(w, innerHeight, narrow ? 0 : -w * 0.17, 0, w, innerHeight); cam.updateProjectionMatrix();
  const cd = garage.dist || 11 * Math.max(1, (narrow ? 1.1 : 1.7) / cam.aspect);
  cam.position.set(Math.sin(garage.ang) * cd, garage.y, Math.cos(garage.ang) * cd); cam.lookAt(0, 0.4, 0);
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.needsUpdate = true;
  adaptRes(dt);
  renderer.render(garage.scene, cam);
}

// ============================================================ MENU UI
function seg(id, key, parse = x => x, after) {
  const el = $(id);
  el.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', String(S[key]) === b.dataset.v);
    b.onclick = () => { S[key] = parse(b.dataset.v); el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); onMode(); after && after(); saveSettings(); };
  });
}
function onInput() { document.body.classList.toggle('mobileMode', S.input === 'mobile'); $('#keysTitle').textContent = S.input === 'mobile' ? 'Touch controls' : 'Keyboard controls'; }
function onMode() { $('#raceOpts').style.display = S.mode === 'race' ? '' : 'none'; $('#startBtn').innerHTML = S.mode === 'race' ? 'LIGHTS OUT &nbsp;›' : 'START TIME TRIAL &nbsp;›'; }
function renderTeams() {
  $('#teams').innerHTML = TEAMS.map((t, i) => `<button class="team ${i === S.team ? 'on' : ''}" data-i="${i}">
    <span class="sw" style="background:linear-gradient(${t.c1} 60%, ${t.c2} 60%)"></span><span>${t.name}<small>#${t.num} · ${t.code}</small></span></button>`).join('');
  $('#teams').querySelectorAll('button').forEach(b => b.onclick = () => { S.team = +b.dataset.i; saveSettings(); renderTeams(); });
  const t = TEAMS[S.team], spec = carSpec(t), col = t.c1 === '#1c1c1c' || t.c1 === '#16214f' || t.c1 === '#1f2a8f' ? t.c2 : t.c1;
  $('#carInfo').innerHTML = `<div class="nm" style="color:${col}">${t.name}</div><div class="cd">#${t.num} · ${Math.round(spec.power / 745.7)} HP · VMAX ${Math.round(topSpeed(spec) * 3.6)} KM/H</div>` +
    [['Top speed', t.speed], ['Power', t.accel], ['Downforce', t.grip], ['Braking', t.brake]].map(([n, v]) => `<div class="stat"><span>${n}</span><i><b style="width:${Math.round((v - 0.7) / 0.28 * 100)}%;background:${col}"></b></i></div>`).join('');
  setGarageCar(S.team);
}
const trackCache = {};
function renderTracks() {
  $('#tracks').innerHTML = TRACKS.map((d, i) => {
    const rec = store.get('apex.best.' + d.id);
    return `<button class="track ${i === S.track ? 'on' : ''}" data-i="${i}"><canvas width="260" height="200"></canvas><b>${d.name}</b><small>${d.blurb}</small><br><small>${rec ? '⏱ ' + fmt(rec) : ''}</small></button>`;
  }).join('');
  $('#tracks').querySelectorAll('button').forEach((b, i) => {
    b.onclick = () => { S.track = i; saveSettings(); renderTracks(); };
    const d = TRACKS[i];
    if (!trackCache[d.id]) { const c = new THREE.CatmullRomCurve3(d.points.map(p => new THREE.Vector3(p[0], 0, p[1])), true, 'centripetal'); trackCache[d.id] = { pts: c.getSpacedPoints(300), len: c.getLength() }; }
    const { pts, len } = trackCache[d.id], g = b.querySelector('canvas').getContext('2d');
    const xs = pts.map(p => p.x), zs = pts.map(p => p.z), mnx = Math.min(...xs), mxx = Math.max(...xs), mnz = Math.min(...zs), mxz = Math.max(...zs);
    const sc = Math.min(220 / (mxx - mnx), 160 / (mxz - mnz)), X = x => 130 + (x - (mnx + mxx) / 2) * sc, Z = z => 100 + (z - (mnz + mxz) / 2) * sc;
    g.lineWidth = 7; g.lineJoin = 'round'; g.strokeStyle = i === S.track ? '#ffffff' : '#8a8a96';
    g.beginPath(); pts.forEach((p, k) => k ? g.lineTo(X(p.x), Z(p.z)) : g.moveTo(X(p.x), Z(p.z))); g.closePath(); g.stroke();
    g.fillStyle = '#e10600'; g.fillRect(X(pts[0].x) - 5, Z(pts[0].z) - 5, 10, 10);
    g.fillStyle = '#9a9aa6'; g.font = '600 20px Titillium Web, Arial'; g.fillText((len / 1000).toFixed(2) + ' km', 6, 22);
  });
}
function clearCars() {
  if (player) disposeCar(player.car); ais.forEach(a => disposeCar(a.car));
  player = null; ais = [];
}
function showMenu() {
  S.state = 'menu';
  clearCars();
  if (world) { disposeScene(world.scene); world = null; }
  if (post) { post.dispose(); post = null; }
  $('#hud').classList.add('hidden'); $('#pause').classList.add('hidden'); $('#results').classList.add('hidden');
  setTouchActive(false); $('#rotate').classList.add('hidden');
  $('#menu').classList.remove('hidden');
  audio.silence();
  renderTeams(); renderTracks(); onMode();
}
function pause() { S.prevState = S.state; S.state = 'paused'; $('#pause').classList.remove('hidden'); }
function resume() { S.state = S.prevState || 'race'; $('#pause').classList.add('hidden'); clock.getDelta(); }
function go() {
  if (S.input === 'mobile') goFullscreenLandscape();
  $('#loading').classList.remove('hidden'); $('#loading').textContent = 'BUILDING CIRCUIT…';
  S.state = 'loading';
  const q = Q();
  Promise.all([ensureModel(q.player, f => { $('#loading').textContent = `LOADING CAR… ${Math.min(100, Math.round(f * 100))}%`; }), ensureModel(q.ai)]).then(() => setTimeout(() => {
    clearCars();
    try { startSession(); } catch (e) { console.error(e); $('#loading').textContent = 'Error: ' + e.message; return; }
    $('#loading').classList.add('hidden'); clock.getDelta();
  }, 30));
}
$('#startBtn').onclick = go;
$('#resumeBtn').onclick = resume;
$('#restartBtn').onclick = go;
$('#againBtn').onclick = go;
$('#quitBtn').onclick = showMenu;
$('#menuBtn').onclick = showMenu;
addEventListener('keydown', e => { if (e.code === 'Enter' && S.state === 'menu') go(); });

seg('#modeSeg', 'mode'); seg('#lapSeg', 'laps', Number); seg('#aiSeg', 'skill', Number); seg('#oppSeg', 'opp', Number); seg('#gridSeg', 'grid');
seg('#tyreSeg', 'tyre', x => x, () => setGarageCar(S.team)); seg('#assistSeg', 'assists');
seg('#inputSeg', 'input', x => x, onInput); onInput();
seg('#gfxSeg', 'gfx', x => x, () => { store.set('apex.gfxChosen', true); applyQuality(); ensureModel(Q().garage).then(() => setGarageCar(S.team)); });
$('#loading').textContent = 'LOADING…';
await loadManifest();
await ensureModel(Q().garage, f => { $('#loading').textContent = `LOADING CAR… ${Math.min(100, Math.round(f * 100))}%`; });
document.fonts?.ready.then(() => { if (S.state === 'menu') { renderTracks(); renderTeams(); } });
initTouch(pressed, flash);
showMenu();
$('#loading').classList.add('hidden');
frame();

// test/debug handle
window.__apex = {
  S, renderer, camera, garage, step: dt => tick(dt), Q: () => Q(), RES, ASSETS,
  get player() { return player; }, get ais() { return ais; }, get world() { return world; },
  sim(sec, bot) { noRender = true; for (let i = 0; i < sec * 60; i++) { bot && bot(); tick(1 / 60); } noRender = false; }
};
