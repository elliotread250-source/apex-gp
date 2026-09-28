import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { clamp, lerp, rng } from './util.js';
import { boardTex } from './textures.js';

// ============================================================ TRACK DATA
export function buildTrack(def) {
  const pts = def.points.map(p => new THREE.Vector3(p[0], 0, p[1]));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  curve.arcLengthDivisions = 10000;
  const L = curve.getLength(), N = Math.round(L / 2), ds = L / N;
  const P = [], T = [], NL = [];
  for (let i = 0; i < N; i++) {
    const u = i / N; P.push(curve.getPointAt(u));
    const t = curve.getTangentAt(u); t.y = 0; t.normalize();
    T.push(t); NL.push(new THREE.Vector3(t.z, 0, -t.x));
  }
  const kRaw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = T[(i - 2 + N) % N], b = T[(i + 2) % N];
    kRaw[i] = Math.asin(clamp(a.z * b.x - a.x * b.z, -1, 1)) / (4 * ds);
  }
  const smooth = (arr, r) => { const o = new Float32Array(N); for (let i = 0; i < N; i++) { let s = 0; for (let j = -r; j <= r; j++) s += arr[(i + j + N) % N]; o[i] = s / (2 * r + 1); } return o; };
  const k = smooth(kRaw, 4), kS = smooth(kRaw, 10), kL = smooth(kRaw, 25);
  const halfW = def.width / 2;
  let line = new Float32Array(N);
  for (let i = 0; i < N; i++) line[i] = Math.sign(kL[i]) * Math.min(1, Math.abs(kL[i]) / 0.012) * (halfW - 2.0);
  line = smooth(smooth(line, 30), 30);
  // DRS zones on long straights
  const drs = new Uint8Array(N), straight = i => Math.abs(kS[i]) < 0.0018;
  let start = 0; while (straight(start) && start < N) start++;
  for (let n = 0, run = []; n <= N; n++) {
    const i = (start + n) % N;
    if (n < N && straight(i)) run.push(i);
    else { if (run.length * ds > 320) { const a = Math.round(90 / ds), b = Math.round(70 / ds); for (let j = a; j < run.length - b; j++) drs[run[j]] = 1; } run = []; }
  }
  const street = def.style === 'street';
  const tr = { def, curve, L, N, ds, P, T, NL, k, kS, line, drs, halfW, street,
    kerbW: street ? 1.0 : 1.5, wallD: halfW + def.runoff + (street ? 0 : 1.5) };
  tr.kerb = new Uint8Array(N); for (let i = 0; i < N; i++) tr.kerb[i] = Math.abs(kS[i]) > 0.006 ? 1 : 0;
  // corners -> run-off areas on the outside (1 = painted asphalt, 2 = gravel)
  tr.runL = new Uint8Array(N); tr.runR = new Uint8Array(N); tr.corners = [];
  const isC = i => Math.abs(kS[i]) > 0.0045;
  let c0 = 0; while (isC(c0) && c0 < N) c0++;
  for (let n = 0, cur = null; n <= N; n++) {
    const i = (c0 + n) % N;
    if (n < N && isC(i)) { if (!cur) cur = { i0: i, len: 0, kmax: 0, sgn: 0 }; cur.len++; cur.kmax = Math.max(cur.kmax, Math.abs(kS[i])); cur.sgn += kS[i]; }
    else if (cur) { cur.i1 = (cur.i0 + cur.len) % N; cur.sgn = Math.sign(cur.sgn); tr.corners.push(cur); cur = null; }
  }
  if (!street) tr.corners.forEach((c, ci) => {
    const type = c.kmax > 0.011 ? 2 : (ci % 3 === 0 ? 2 : 1);
    const arr = c.sgn > 0 ? tr.runR : tr.runL;   // outside of a left-hander is the right side
    for (let j = -12; j < c.len + 55; j++) arr[(c.i0 + j + N) % N] = type;
  });
  // spatial hash for distance queries
  const cell = 40, grid = new Map();
  for (let i = 0; i < N; i += 2) { const key = Math.floor(P[i].x / cell) + ',' + Math.floor(P[i].z / cell); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(i); }
  tr.distTo = (x, z) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell); let best = 1e9;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      const l = grid.get((cx + a) + ',' + (cz + b)); if (!l) continue;
      for (const i of l) { const dx = P[i].x - x, dz = P[i].z - z, d = dx * dx + dz * dz; if (d < best) best = d; }
    }
    return Math.sqrt(best);
  };
  tr.bounds = new THREE.Box3().setFromPoints(P);
  return tr;
}

export function sampleAt(tr, s) {
  s = ((s % tr.L) + tr.L) % tr.L;
  const f = s / tr.ds, i = Math.floor(f) % tr.N, j = (i + 1) % tr.N, u = f - Math.floor(f);
  const A = tr.P[i], B = tr.P[j], ta = tr.T[i], tb = tr.T[j];
  const tx = lerp(ta.x, tb.x, u), tz = lerp(ta.z, tb.z, u), tl = Math.hypot(tx, tz);
  return { x: lerp(A.x, B.x, u), z: lerp(A.z, B.z, u), tx: tx / tl, tz: tz / tl, nx: tz / tl, nz: -tx / tl, i };
}
export function gridPose(tr, k) {
  const s = tr.L - (12 + k * 8), lat = (k % 2 === 0) ? 2.6 : -2.6, p = sampleAt(tr, s);
  return { s, lat, x: p.x + p.nx * lat, z: p.z + p.nz * lat, h: Math.atan2(p.tx, p.tz) };
}
export function nearestIdx(tr, x, z, hint) {
  let best = 1e18, bi = 0;
  if (hint < 0) { for (let i = 0; i < tr.N; i++) { const d = (tr.P[i].x - x) ** 2 + (tr.P[i].z - z) ** 2; if (d < best) { best = d; bi = i; } } return bi; }
  for (let o = -40; o <= 40; o++) { const i = (hint + o + tr.N) % tr.N; const d = (tr.P[i].x - x) ** 2 + (tr.P[i].z - z) ** 2; if (d < best) { best = d; bi = i; } }
  return bi;
}
// Surface under a point given its sample index and lateral offset
export function surfaceAt(tr, i, lat) {
  const a = Math.abs(lat);
  if (a <= tr.halfW) return 'road';
  if (tr.kerb[i] && a <= tr.halfW + tr.kerbW) return 'kerb';
  if (tr.street) return 'road';
  const run = lat > 0 ? tr.runL[i] : tr.runR[i];
  if (run === 1) return 'runoff';
  if (run === 2 && a > tr.halfW + tr.kerbW + 0.5) return 'gravel';
  return 'grass';
}

// Build a strip following the track between lateral offsets (numbers or functions of sample index)
function ribbon(tr, offA, offB, yA, yB, opts = {}) {
  const { vScale = 10, filter = null, alongU = false, flip = false, h = null } = opts;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= tr.N; i++) {
    const j = i % tr.N, p = tr.P[j], n = tr.NL[j], d = i * tr.ds / vScale;
    const oa = typeof offA === 'function' ? offA(j) : offA, ob = typeof offB === 'function' ? offB(j) : offB;
    const ax = p.x + n.x * oa, az = p.z + n.z * oa, bx = p.x + n.x * ob, bz = p.z + n.z * ob;
    pos.push(ax, yA + (h ? h(ax, az) : 0), az, bx, yB + (h ? h(bx, bz) : 0), bz);
    if (alongU) uv.push(flip ? -d : d, 0, flip ? -d : d, 1); else uv.push(0, d, 1, d);
    if (i < tr.N && (!filter || filter(j))) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals();
  return geo;
}

// smooth 2D value noise
function makeNoise(seed) {
  const r = rng(seed), S = 256, perm = new Float32Array(S * S); for (let i = 0; i < perm.length; i++) perm[i] = r();
  const at = (x, y) => perm[((y & 255) * S) + (x & 255)];
  const sm = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), xf), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), xf), yf);
  };
}

// ============================================================ WORLD
export function buildWorld(def, T, renderer, { quality = 'high', profile = null } = {}) {
  const tr = buildTrack(def);
  const R = rng(def.id.length * 977 + 13);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(def.fog, 700, 5200);
  const std = o => new THREE.MeshStandardMaterial(o);
  const c = tr.bounds.getCenter(new THREE.Vector3());
  const size = Math.max(tr.bounds.max.x - tr.bounds.min.x, tr.bounds.max.z - tr.bounds.min.z);

  // ---- sky + environment lighting
  const sky = new Sky(); sky.scale.setScalar(20000);
  const su = sky.material.uniforms;
  su.turbidity.value = def.sky.turbidity; su.rayleigh.value = def.sky.rayleigh; su.mieCoefficient.value = 0.005; su.mieDirectionalG.value = 0.8;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - def.sky.elev), THREE.MathUtils.degToRad(def.sky.azim));
  su.sunPosition.value.copy(sunDir);
  const envScene = new THREE.Scene(); const sky2 = new Sky(); sky2.scale.setScalar(1000); sky2.material.uniforms = THREE.UniformsUtils.clone(su); envScene.add(sky2);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(envScene, 0).texture; pmrem.dispose();
  scene.environment = env; scene.add(sky);

  scene.add(new THREE.HemisphereLight('#dbe8ff', tr.street ? '#6d6356' : '#4a5f33', def.hemi * 0.6));
  const sun = new THREE.DirectionalLight('#fff3e2', def.sunI);
  sun.castShadow = true; sun.shadow.mapSize.set(quality === 'high' ? 4096 : 1024, quality === 'high' ? 4096 : 1024);
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 600 });
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // ---- terrain: flat near the track, rolling further away
  const noise = makeNoise(def.id.length * 31);
  const heightAt = tr.street ? () => 0 : (x, z) => {
    const d = tr.distTo(x, z), f = clamp((d - tr.wallD - 40) / 260, 0, 1);
    const n = noise(x / 180, z / 180) * 0.7 + noise(x / 60 + 50, z / 60) * 0.3;
    return f * f * (3 - 2 * f) * n * 26;
  };
  tr.heightAt = heightAt;
  const gSize = size + 3000, gSeg = quality === 'high' ? 220 : 120;
  const gGeo = new THREE.PlaneGeometry(gSize, gSize, gSeg, gSeg); gGeo.rotateX(-Math.PI / 2);
  const gp = gGeo.attributes.position, gcol = [];
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i) + c.x, z = gp.getZ(i) + c.z;
    gp.setY(i, heightAt(x, z) - 0.03);
    const v = 0.82 + noise(x / 40, z / 40) * 0.3;
    gcol.push(v, v * (0.97 + noise(x / 90 + 7, z / 90) * 0.06), v * 0.92);
  }
  gGeo.setAttribute('color', new THREE.Float32BufferAttribute(gcol, 3)); gGeo.computeVertexNormals();
  const grassTex = tr.street ? T.city.clone() : T.grass.clone(); grassTex.needsUpdate = true; grassTex.repeat.set(gSize / 18, gSize / 18);
  const ground = new THREE.Mesh(gGeo, std({ map: grassTex, vertexColors: true, roughness: 0.95 }));
  ground.position.set(c.x, 0, c.z); ground.receiveShadow = true; scene.add(ground);

  // ---- road
  const road = new THREE.Mesh(ribbon(tr, tr.halfW, -tr.halfW, 0.02, 0.02, { vScale: 13 }),
    std({ map: T.asphalt, normalMap: T.asphaltN, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.82, side: THREE.DoubleSide }));
  road.receiveShadow = true; scene.add(road);
  // rubbered-in racing line
  const rub = new THREE.Mesh(ribbon(tr, j => tr.line[j] + 1.1, j => tr.line[j] - 1.1, 0.024, 0.024, { vScale: 13 }),
    new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.2, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  scene.add(rub);
  // kerbs, raised on the outside edge
  const kerbM = std({ map: T.kerb, normalMap: T.kerbN, roughness: 0.6, side: THREE.DoubleSide });
  for (const s of [1, -1]) {
    const m = new THREE.Mesh(ribbon(tr, s * (tr.halfW - 0.1), s * (tr.halfW + tr.kerbW), 0.035, 0.09, { vScale: 3, filter: j => tr.kerb[j] }), kerbM);
    m.receiveShadow = true; scene.add(m);
  }
  if (tr.street) {
    const walk = std({ color: '#a7a39a', roughness: 0.9, side: THREE.DoubleSide });
    for (const s of [1, -1]) scene.add(new THREE.Mesh(ribbon(tr, s * tr.wallD, s * tr.halfW, 0.04, 0.04, { vScale: 4 }), walk));
  } else {
    // painted asphalt run-off and gravel traps on corner exits
    const runM = std({ map: T.runoff, roughness: 0.85, side: THREE.DoubleSide }), gravM = std({ map: T.gravel, normalMap: T.gravelN, roughness: 1, side: THREE.DoubleSide });
    const inner = tr.halfW + 0.2, outer = tr.wallD - 0.3;
    for (const [s, arr] of [[1, tr.runL], [-1, tr.runR]]) {
      const a = new THREE.Mesh(ribbon(tr, s * inner, s * outer, 0.025, 0.025, { vScale: 6, filter: j => arr[j] === 1 }), runM); a.receiveShadow = true; scene.add(a);
      const g = new THREE.Mesh(ribbon(tr, s * (tr.halfW + tr.kerbW + 0.5), s * outer, 0.03, 0.05, { vScale: 5, filter: j => arr[j] === 2 }), gravM); g.receiveShadow = true; scene.add(g);
      // asphalt strip between kerb and gravel
      scene.add(new THREE.Mesh(ribbon(tr, s * inner, s * (tr.halfW + tr.kerbW + 0.5), 0.022, 0.022, { vScale: 6, filter: j => arr[j] === 2 }), runM));
    }
  }
  // ---- barriers: sponsor boards on a tyre/Tecpro wall, armco rail, catch fence
  const adM = std({ map: T.ads, roughness: 0.6, side: THREE.DoubleSide });
  const railM = std({ color: '#c9ccd0', metalness: 0.8, roughness: 0.35 });
  const fenceM = new THREE.MeshStandardMaterial({ map: T.fence, alphaTest: 0.4, transparent: false, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5 });
  fenceM.map = T.fence.clone(); fenceM.map.needsUpdate = true; fenceM.map.repeat.set(1, 4);
  for (const s of [1, -1]) {
    const w = new THREE.Mesh(ribbon(tr, s * tr.wallD, s * tr.wallD, 0, 1.1, { vScale: 48, alongU: true, flip: s > 0 }), adM);
    w.castShadow = true; w.receiveShadow = true; scene.add(w);
    scene.add(new THREE.Mesh(ribbon(tr, s * (tr.wallD + 0.12), s * (tr.wallD + 0.12), 1.1, 1.45, { vScale: 10 }), railM));
    if (!tr.street) scene.add(new THREE.Mesh(ribbon(tr, s * (tr.wallD + 0.35), s * (tr.wallD + 0.35), 1.45, 4.6, { vScale: 1.5, alongU: true }), fenceM));
  }
  if (!tr.street) {
    const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 4.8, 6), n = Math.floor(tr.L / 6) * 2;
    const posts = new THREE.InstancedMesh(postGeo, std({ color: '#6d7278', metalness: 0.7, roughness: 0.4 }), n);
    const m4 = new THREE.Matrix4(); let k = 0;
    for (let s = 0; s < tr.L - 3; s += 6) for (const side of [1, -1]) {
      const p = sampleAt(tr, s), off = side * (tr.wallD + 0.4);
      m4.makeTranslation(p.x + p.nx * off, 2.4, p.z + p.nz * off); posts.setMatrixAt(k++, m4);
    }
    posts.count = k; scene.add(posts);
  }

  // ---- start line, grid, gantry
  {
    const p = tr.P[0], t = tr.T[0];
    const lineM = new THREE.Mesh(new THREE.PlaneGeometry(tr.halfW * 2, 2.2), std({ map: T.checker, roughness: 0.7 }));
    lineM.rotation.set(-Math.PI / 2, 0, Math.atan2(t.x, t.z)); lineM.position.set(p.x, 0.03, p.z); scene.add(lineM);
    const slotM = new THREE.MeshBasicMaterial({ color: '#e8e8e8' });
    for (let k = 0; k < 10; k++) {
      const gp = gridPose(tr, k);
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.25), slotM);
      bar.rotation.set(-Math.PI / 2, 0, gp.h); bar.position.set(gp.x + Math.sin(gp.h) * 3.2, 0.03, gp.z + Math.cos(gp.h) * 3.2); scene.add(bar);
    }
  }
  const lightsMats = [];
  {
    const p = tr.P[Math.round(8 / tr.ds)], t = tr.T[0], n = tr.NL[0], h = Math.atan2(t.x, t.z);
    const gm = std({ color: '#1b1b20', metalness: 0.5, roughness: 0.5 });
    const span = tr.wallD * 2 + 2;
    for (const s of [1, -1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 8, 0.6), gm); post.position.set(p.x + n.x * s * (tr.wallD + 1), 4, p.z + n.z * s * (tr.wallD + 1)); post.castShadow = true; scene.add(post); }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 1.2, 0.8), gm); beam.position.set(p.x, 7.6, p.z); beam.rotation.y = h; beam.castShadow = true; scene.add(beam);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(span * .5, 1.1), std({ map: T.ads, side: THREE.DoubleSide })); sign.position.set(p.x, 8.9, p.z); sign.rotation.y = h; scene.add(sign);
    for (let i = 0; i < 5; i++) {
      const pod = new THREE.Group(), off = (i - 2) * 1.2;
      pod.position.set(p.x + n.x * off, 6.2, p.z + n.z * off); pod.rotation.y = h + Math.PI; scene.add(pod);
      pod.add(new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.5), gm));
      const mat = new THREE.MeshBasicMaterial({ color: '#2a0000', toneMapped: false }); lightsMats.push(mat);
      for (const y of [0.45, -0.45]) { const l = new THREE.Mesh(new THREE.CircleGeometry(0.3, 16), mat); l.position.set(0, y, 0.26); pod.add(l); }
    }
  }

  // ---- brake marker boards before heavy braking zones
  if (profile) {
    const tex = { 300: boardTex(300), 200: boardTex(200), 100: boardTex(100) };
    const boardGeo = new THREE.PlaneGeometry(1.2, 1.2), postGeo = new THREE.BoxGeometry(0.08, 1.4, 0.08), postM = std({ color: '#888' });
    const N = tr.N;
    for (const cn of tr.corners) {
      let minV = 1e9, mi = cn.i0; for (let j = 0; j < cn.len; j++) { const i = (cn.i0 + j) % N; if (profile[i] < minV) { minV = profile[i]; mi = i; } }
      // find where braking starts: walk back while profile is falling
      let b = mi, steps = 0; while (steps < 400 && profile[(b - 1 + N) % N] > profile[b] + 0.05) { b = (b - 1 + N) % N; steps++; }
      const drop = profile[b] - minV; if (drop < 18) continue;
      const side = cn.sgn > 0 ? -1 : 1;    // boards on the outside of the corner
      for (const d of [100, 200, 300]) {
        const s = b * tr.ds - d + 100, p = sampleAt(tr, s), off = side * (tr.halfW + tr.kerbW + 2.2), h = Math.atan2(p.tx, p.tz);
        const bx = p.x + p.nx * off, bz = p.z + p.nz * off;
        const board = new THREE.Mesh(boardGeo, std({ map: tex[d], roughness: 0.5 })); board.position.set(bx, 1.5, bz); board.rotation.y = h + Math.PI; board.castShadow = true; scene.add(board);
        const post = new THREE.Mesh(postGeo, postM); post.position.set(bx, 0.7, bz); scene.add(post);
      }
    }
  }

  if (tr.street) buildCity(scene, tr, T, R); else buildPark(scene, tr, T, R, heightAt, quality);

  // distant hills / mountains
  // distant rolling hills: a ring of terrain rising beyond the circuit
  {
    const RR = size / 2 + 1500, segA = 160, segR = 12, pos = [], idx = [];
    for (let j = 0; j <= segR; j++) for (let i = 0; i <= segA; i++) {
      const a = i / segA * Math.PI * 2, rr = RR + j / segR * 3500, f = j / segR;
      const hgt = (noise(Math.cos(a) * 6 + 100, Math.sin(a) * 6 + 100) * 0.7 + noise(Math.cos(a) * 20 + 3, Math.sin(a) * 20) * 0.3) * (tr.street ? 520 : 380) * Math.sin(f * Math.PI * 0.9) ** 1.4;
      pos.push(c.x + Math.cos(a) * rr, hgt - 5, c.z + Math.sin(a) * rr);
    }
    for (let j = 0; j < segR; j++) for (let i = 0; i < segA; i++) { const A = j * (segA + 1) + i, B = A + segA + 1; idx.push(A, B, A + 1, A + 1, B, B + 1); }
    const hg = new THREE.BufferGeometry(); hg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); hg.setIndex(idx); hg.computeVertexNormals();
    scene.add(new THREE.Mesh(hg, std({ color: tr.street ? '#7c8a78' : '#4f6b3f', roughness: 1, side: THREE.DoubleSide })));
  }
  if (def.id === 'riviera') {
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(9000, 3000), std({ color: '#1b5a86', roughness: 0.08, metalness: 0.2 }));
    sea.rotation.x = -Math.PI / 2; sea.position.set(c.x, 0.01, tr.bounds.min.z - 1600); scene.add(sea);
  }
  // sky reflections are strong: keep scenery mostly diffuse
  scene.traverse(o => { if (o.material && o.material.isMeshStandardMaterial) o.material.envMapIntensity = 0.3; });
  return { scene, tr, sun, sunDir, sky, lightsMats, env };
}

function buildPark(scene, tr, T, R, heightAt, quality) {
  const std = o => new THREE.MeshStandardMaterial(o);
  const standM = std({ color: '#555a63', roughness: 0.8 }), crowdM = std({ map: T.crowd, roughness: 0.9 }), roofM = std({ color: '#e8e8ea', roughness: 0.5, metalness: 0.3 });
  const placeStand = (s, side) => {
    const p = sampleAt(tr, s), h = Math.atan2(p.tx, p.tz), g = new THREE.Group(), off = side * (tr.wallD + 9);
    g.position.set(p.x + p.nx * off, 0, p.z + p.nz * off); g.rotation.y = h + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
    for (let r = 0; r < 7; r++) { const st = new THREE.Mesh(new THREE.BoxGeometry(24, 1, 1.6), crowdM); st.position.set(0, 0.6 + r * 1.1, -r * 1.5); st.receiveShadow = true; g.add(st); }
    const back = new THREE.Mesh(new THREE.BoxGeometry(24, 9, 0.6), standM); back.position.set(0, 4.5, -10.6); g.add(back);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(25, 0.3, 13), roofM); roof.position.set(0, 11, -5); roof.rotation.x = 0.08; roof.castShadow = true; g.add(roof);
    for (const x of [-12, 12]) { const col = new THREE.Mesh(new THREE.BoxGeometry(0.4, 11, 0.4), standM); col.position.set(x, 5.5, -10.4); g.add(col); }
    scene.add(g);
  };
  for (let s = 40; s < 360; s += 25) { placeStand(s, -1); if (s > 100) placeStand(s, 1); }
  for (let s = tr.L - 300; s < tr.L - 30; s += 25) placeStand(s, -1);
  { // pit building
    const p = sampleAt(tr, tr.L - 150), h = Math.atan2(p.tx, p.tz), off = tr.wallD + 24;
    const pit = new THREE.Mesh(new THREE.BoxGeometry(12, 9, 280), std({ color: '#dfe2e6', roughness: 0.6 }));
    pit.position.set(p.x + p.nx * off, 4.5, p.z + p.nz * off); pit.rotation.y = h; pit.castShadow = true; scene.add(pit);
    const band = new THREE.Mesh(new THREE.BoxGeometry(12.2, 1.2, 280.2), std({ color: '#e10600' }));
    band.position.copy(pit.position); band.position.y = 8; band.rotation.y = h; scene.add(band);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(12.3, 2, 270), std({ color: '#223', metalness: 0.9, roughness: 0.1 }));
    glass.position.copy(pit.position); glass.position.y = 5.5; glass.rotation.y = h; scene.add(glass);
  }
  // marshal posts
  const mpM = std({ color: '#ff7a00' });
  for (let s = 150; s < tr.L; s += 380) {
    const p = sampleAt(tr, s), side = (Math.floor(s / 380) % 2) ? 1 : -1, off = side * (tr.wallD + 3);
    const m = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.4, 2.2), mpM); m.position.set(p.x + p.nx * off, 1.2, p.z + p.nz * off); m.rotation.y = Math.atan2(p.tx, p.tz); m.castShadow = true; scene.add(m);
  }
  // trees (instanced, colour-varied)
  const COUNT = quality === 'high' ? 1400 : 600;
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 4, 6); trunkGeo.translate(0, 2, 0);
  const pineGeo = new THREE.ConeGeometry(3, 7, 8); pineGeo.translate(0, 6.5, 0);
  const pine2 = new THREE.ConeGeometry(2.2, 5, 8); pine2.translate(0, 9.5, 0);
  const leafGeo = new THREE.IcosahedronGeometry(3.6, 1); leafGeo.translate(0, 6, 0);
  const trunkM = std({ color: '#5a3d24', roughness: 1 }), leafM = std({ color: '#ffffff', flatShading: true, roughness: 0.95 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkM, COUNT), pines = new THREE.InstancedMesh(pineGeo, leafM, COUNT), pinesTop = new THREE.InstancedMesh(pine2, leafM, COUNT), leafs = new THREE.InstancedMesh(leafGeo, leafM, COUNT);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), col = new THREE.Color();
  const b = tr.bounds; let nT = 0, nP = 0, nL = 0;
  for (let tries = 0; tries < 20000 && nT < COUNT; tries++) {
    const x = lerp(b.min.x - 600, b.max.x + 600, R()), z = lerp(b.min.z - 600, b.max.z + 600, R());
    if (tr.distTo(x, z) < tr.wallD + 16) continue;
    const s = 0.7 + R() * 0.9, y = heightAt(x, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * 6);
    m4.compose(ps.set(x, y - 0.2, z), q, sc.set(s, s * (0.9 + R() * 0.3), s));
    trunks.setMatrixAt(nT++, m4);
    if (R() < 0.5) { col.setHSL(0.28 + R() * 0.06, 0.45, 0.18 + R() * 0.08); pines.setMatrixAt(nP, m4); pinesTop.setMatrixAt(nP, m4); pines.setColorAt(nP, col); pinesTop.setColorAt(nP, col); nP++; }
    else { col.setHSL(0.22 + R() * 0.08, 0.45, 0.22 + R() * 0.1); leafs.setMatrixAt(nL, m4); leafs.setColorAt(nL, col); nL++; }
  }
  trunks.count = nT; pines.count = pinesTop.count = nP; leafs.count = nL;
  [pines, pinesTop, leafs].forEach(m => { m.castShadow = true; });
  scene.add(trunks, pines, pinesTop, leafs);
}

function buildCity(scene, tr, T, R) {
  const cols = ['#f3e2c3', '#e9c9a1', '#f2d6d0', '#d9e3e8', '#f6efe1', '#e7b98f', '#cfd8c5', '#f0c7a8', '#ffffff'];
  const mats = cols.map(c => new THREE.MeshStandardMaterial({ color: c, map: T.windows, roughness: 0.8 }));
  const roofM = new THREE.MeshStandardMaterial({ color: '#9a5a44', roughness: 0.9 }), awnM = ['#c0392b', '#1f5f8b', '#2e8b57'].map(c => new THREE.MeshStandardMaterial({ color: c }));
  const geo = new THREE.BoxGeometry(1, 1, 1), placed = [];
  for (let s = 0; s < tr.L; s += 22) for (const side of [1, -1]) {
    if (R() < 0.12) continue;
    const p = sampleAt(tr, s), dep = 12 + R() * 14, wid = 14 + R() * 8, hgt = 10 + R() * 34, off = side * (tr.wallD + 5 + dep / 2);
    const x = p.x + p.nx * off, z = p.z + p.nz * off;
    if (tr.distTo(x, z) < tr.wallD + 4 + dep / 2) continue;
    if (placed.some(q => Math.hypot(q[0] - x, q[1] - z) < 13)) continue;
    placed.push([x, z]);
    const rot = Math.atan2(p.tx, p.tz);
    const m = new THREE.Mesh(geo, mats[(R() * mats.length) | 0]); m.scale.set(wid, hgt, dep); m.position.set(x, hgt / 2, z); m.rotation.y = rot; m.castShadow = true; m.receiveShadow = true; scene.add(m);
    const roof = new THREE.Mesh(geo, roofM); roof.scale.set(wid + 0.6, 0.8, dep + 0.6); roof.position.set(x, hgt + 0.4, z); roof.rotation.y = rot; scene.add(roof);
    const awn = new THREE.Mesh(geo, awnM[(R() * 3) | 0]); awn.scale.set(wid * 0.8, 0.15, 2); awn.position.set(x - p.nx * side * (dep / 2 + 1), 3.2, z - p.nz * side * (dep / 2 + 1)); awn.rotation.y = rot; awn.castShadow = true; scene.add(awn);
  }
  const trunkM = new THREE.MeshStandardMaterial({ color: '#7a5a3a' }), leafM = new THREE.MeshStandardMaterial({ color: '#2f7a3a', side: THREE.DoubleSide });
  for (let s = 11; s < tr.L; s += 60) for (const side of [1, -1]) {
    const p = sampleAt(tr, s), off = side * (tr.wallD + 2.2), x = p.x + p.nx * off, z = p.z + p.nz * off;
    if (tr.distTo(x, z) < tr.wallD + 1.5) continue;
    const g = new THREE.Group(); g.position.set(x, 0, z);
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 8, 6), trunkM); t.position.y = 4; g.add(t);
    for (let i = 0; i < 7; i++) { const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 4), leafM); leaf.position.set(0, 8, 0); leaf.rotation.set(1.1, i / 7 * Math.PI * 2, 0, 'YXZ'); leaf.translateY(1.9); g.add(leaf); }
    g.children.forEach(ch => ch.castShadow = true); scene.add(g);
  }
  const crowdM = new THREE.MeshStandardMaterial({ map: T.crowd });
  for (let s = 20; s < 200; s += 26) {
    const p = sampleAt(tr, s), off = -(tr.wallD + 5), g = new THREE.Group();
    g.position.set(p.x + p.nx * off, 0, p.z + p.nz * off); g.rotation.y = Math.atan2(p.tx, p.tz) - Math.PI / 2;
    for (let r = 0; r < 6; r++) { const st = new THREE.Mesh(new THREE.BoxGeometry(24, 1, 1.5), crowdM); st.position.set(0, 0.6 + r * 1.1, r * 1.4); g.add(st); }
    scene.add(g);
  }
}

export function disposeScene(scene) {
  scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); });
}
