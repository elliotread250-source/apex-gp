import * as THREE from 'three';
import { canvasTex } from './textures.js';

// Dimensions follow a modern ground-effect F1 car: 5.63 m long, 2.0 m wide, 3.6 m wheelbase, 18" wheels.
// Forward is +z, left is +x, ground is y=0. Front axle z=+1.8, rear axle z=-1.8.

// ---------- geometry helpers ----------
function se(t, w, h, n) {
  const c = Math.cos(t), s = Math.sin(t);
  return [w / 2 * Math.sign(c) * Math.pow(Math.abs(c), 2 / n), h / 2 * Math.sign(s) * Math.pow(Math.abs(s), 2 / n)];
}
// Loft superellipse sections along z (ascending). Section: {z, w, h, y, x=0, n=3, flat=0 (flattens the bottom)}
export function loft(sections, segs = 40, caps = true) {
  const pos = [], uv = [], idx = [];
  const z0 = sections[0].z, z1 = sections[sections.length - 1].z, ring = segs + 1;
  sections.forEach(S => {
    for (let j = 0; j <= segs; j++) {
      const t = j / segs * Math.PI * 2; let [px, py] = se(t, S.w, S.h, S.n ?? 3);
      if (S.flat && py < 0) py *= 1 - S.flat;
      pos.push((S.x || 0) + px, S.y + py, S.z); uv.push(j / segs, (S.z - z0) / (z1 - z0));
    }
  });
  for (let i = 0; i < sections.length - 1; i++) for (let j = 0; j < segs; j++) {
    const a = i * ring + j, b = a + ring, c = a + 1, d = b + 1; idx.push(a, c, b, b, c, d);
  }
  if (caps) for (const [si, front] of [[0, false], [sections.length - 1, true]]) {
    const S = sections[si], base = pos.length / 3;
    pos.push(S.x || 0, S.y, S.z); uv.push(0.25, front ? 1 : 0);
    for (let j = 0; j <= segs; j++) { const k = (si * ring + j) * 3; pos.push(pos[k], pos[k + 1], pos[k + 2]); uv.push(j / segs, front ? 1 : 0); }
    for (let j = 0; j < segs; j++) front ? idx.push(base, base + 1 + j, base + 2 + j) : idx.push(base, base + 2 + j, base + 1 + j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// Inverted airfoil across the car (x). Leading edge at z=+chord/2. `curl` lifts the outer ends (front-wing flaps), `spoon` lifts the centre.
function wingGeo(span, chord, { thick = 0.11, camber = 0.06, curl = 0, spoon = 0, sweep = 0 } = {}) {
  const sh = new THREE.Shape(), N = 18, up = [], lo = [];
  for (let i = 0; i <= N; i++) {
    const x = 0.5 - Math.cos(i / N * Math.PI) * 0.5;
    const yt = 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const yc = -camber * 4 * x * (1 - x);
    up.push([x * chord, (yc + yt) * chord]); lo.push([x * chord, (yc - yt) * chord]);
  }
  sh.moveTo(...up[0]); up.slice(1).forEach(p => sh.lineTo(...p)); lo.reverse().forEach(p => sh.lineTo(...p));
  const g = new THREE.ExtrudeGeometry(sh, { depth: span, bevelEnabled: false, curveSegments: 4, steps: 24 });
  g.rotateY(Math.PI / 2); g.translate(-span / 2, 0, chord / 2);
  if (curl || spoon || sweep) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = Math.abs(p.getX(i)) / (span / 2);
      p.setY(i, p.getY(i) + curl * Math.pow(u, 3) + spoon * (1 - u * u));
      p.setZ(i, p.getZ(i) - sweep * Math.pow(u, 2));
    }
    g.computeVertexNormals();
  }
  return g;
}
// Flat plate: outline in (z, y), thickness along x
function plateGeo(pts, thick) {
  const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(p => sh.lineTo(p[0], p[1]));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false });
  g.rotateY(-Math.PI / 2); g.translate(thick / 2, 0, 0);
  return g;
}
function rodGeo(a, b, r, flat = 1) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r, r, len, 8); g.scale(1, 1, flat); // flat<1 => aerofoil-ish wishbone
  const m = new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()), new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m); return g;
}
function tyreGeo(w, r = 0.36) {
  const h = w / 2;
  const p = [[0.225, -h + 0.025], [0.26, -h + 0.004], [0.3, -h], [r - 0.03, -h + 0.004], [r - 0.01, -h + 0.03], [r - 0.002, -h + 0.07], [r, -h + 0.11], [r, h - 0.11], [r - 0.002, h - 0.07], [r - 0.01, h - 0.03], [r - 0.03, h - 0.004], [0.3, h], [0.26, h - 0.004], [0.225, h - 0.025]];
  const g = new THREE.LatheGeometry(p.map(q => new THREE.Vector2(q[0], q[1])), 48);
  g.rotateZ(Math.PI / 2);
  return g;
}
function merge(geos) { // tiny BufferGeometry merge (non-indexed) to cut draw calls
  const out = [], uvs = [];
  for (const g0 of geos) { const g = g0.index ? g0.toNonIndexed() : g0; out.push(...g.attributes.position.array); uvs.push(...(g.attributes.uv ? g.attributes.uv.array : new Float32Array(g.attributes.position.count * 2))); }
  const m = new THREE.BufferGeometry(); m.setAttribute('position', new THREE.Float32BufferAttribute(out, 3)); m.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); m.computeVertexNormals(); return m;
}

// ---------- shared geometry (built once) ----------
let GEO = null;
function geometry() {
  if (GEO) return GEO;
  const G = {};
  // chassis + long narrow nose (tip at z≈2.95, just behind the wing leading edge)
  G.body = loft([
    { z: -2.42, w: .16, h: .16, y: .38, n: 2.4 }, { z: -2.15, w: .26, h: .26, y: .41, n: 2.5 }, { z: -1.75, w: .4, h: .4, y: .47, n: 2.7 },
    { z: -1.3, w: .56, h: .52, y: .52, n: 3 }, { z: -0.85, w: .7, h: .6, y: .52, n: 3.4 }, { z: -0.45, w: .78, h: .56, y: .47, n: 3.9, flat: .2 },
    { z: 0.25, w: .76, h: .52, y: .46, n: 4, flat: .2 }, { z: 0.8, w: .62, h: .46, y: .44, n: 3.6, flat: .2 }, { z: 1.3, w: .46, h: .38, y: .4, n: 3.2 },
    { z: 1.85, w: .34, h: .3, y: .34, n: 2.8 }, { z: 2.35, w: .27, h: .22, y: .28, n: 2.6 }, { z: 2.75, w: .22, h: .15, y: .22, n: 2.5 }, { z: 2.97, w: .16, h: .09, y: .19, n: 2.3 }], 48);
  G.airbox = loft([
    { z: -2.0, w: .05, h: .08, y: .5, n: 2.4 }, { z: -1.6, w: .14, h: .18, y: .66, n: 2.6 }, { z: -1.2, w: .24, h: .3, y: .84, n: 2.6 },
    { z: -0.86, w: .3, h: .36, y: .95, n: 2.4 }, { z: -0.66, w: .27, h: .32, y: .99, n: 2.2 }], 28);
  // sidepods: high letterbox inlet, downwash ramp, deep undercut
  const pod = s => loft([
    { z: -1.45, x: s * .34, w: .14, h: .14, y: .27, n: 2.4 }, { z: -1.0, x: s * .44, w: .3, h: .26, y: .34, n: 3 },
    { z: -0.45, x: s * .55, w: .46, h: .34, y: .42, n: 3.8, flat: .45 }, { z: 0.15, x: s * .6, w: .5, h: .34, y: .5, n: 4.5, flat: .55 },
    { z: 0.5, x: s * .6, w: .48, h: .3, y: .54, n: 5, flat: .5 }, { z: 0.6, x: s * .6, w: .44, h: .26, y: .545, n: 5, flat: .5 }], 32);
  G.podL = pod(1); G.podR = pod(-1);
  // floor with edge
  const half = [[0.3, 1.35], [0.55, 1.1], [0.78, 0.75], [0.84, 0.4], [0.84, -1.1], [0.7, -1.55], [0.55, -2.05]];
  const fs = new THREE.Shape(); fs.moveTo(half[0][0], -half[0][1]);
  half.forEach(p => fs.lineTo(p[0], -p[1])); [...half].reverse().forEach(p => fs.lineTo(-p[0], -p[1]));
  G.floor = new THREE.ExtrudeGeometry(fs, { depth: 0.035, bevelEnabled: false }); G.floor.rotateX(-Math.PI / 2); G.floor.translate(0, 0.04, 0);
  G.floorEdge = merge([-1, 1].map(s => { const g = new THREE.BoxGeometry(0.012, 0.07, 1.4); g.translate(s * 0.84, 0.1, -0.35); return g; }));
  G.floorFences = merge([0.18, 0.3, 0.42, 0.52].flatMap(x => [-1, 1].map(s => { const g = plateGeo([[0.25, 0.04], [-0.45, 0.04], [-0.45, 0.2], [0.05, 0.3], [0.25, 0.22]], 0.012); g.translate(s * x, 0, 1.2); return g; })));
  // diffuser with strakes
  G.diffuser = merge([(() => { const g = new THREE.BoxGeometry(1.08, 0.03, 0.62); g.rotateX(0.3); g.translate(0, 0.14, -2.35); return g; })(),
    ...[-0.52, -0.3, -0.1, 0.1, 0.3, 0.52].map(x => { const g = plateGeo([[0.3, 0.05], [-0.32, 0.22], [-0.32, 0.34], [0.3, 0.1]], 0.012); g.translate(x, 0, -2.35); return g; })]);
  // front wing: main plane + 3 flaps that curl up to the endplates
  G.fw = [
    wingGeo(1.96, 0.42, { thick: .09, camber: .05, curl: 0.02, sweep: 0.05 }),
    wingGeo(1.9, 0.2, { thick: .1, camber: .07, curl: 0.12, sweep: 0.08 }),
    wingGeo(1.84, 0.17, { thick: .1, camber: .08, curl: 0.2, sweep: 0.1 }),
    wingGeo(1.76, 0.14, { thick: .1, camber: .09, curl: 0.27, sweep: 0.12 })];
  G.fwEnd = plateGeo([[0.12, 0.03], [-0.55, 0.03], [-0.62, 0.18], [-0.45, 0.33], [-0.1, 0.34], [0.1, 0.2]], 0.018);
  G.fwFoot = plateGeo([[0.1, 0], [-0.55, 0], [-0.55, 0.02], [0.1, 0.02]], 0.1);
  // rear wing
  G.rwMain = wingGeo(1.0, 0.36, { thick: .13, camber: .08, spoon: 0.03 });
  G.rwFlap = wingGeo(1.0, 0.22, { thick: .1, camber: .09, spoon: 0.02 });
  G.beam1 = wingGeo(0.86, 0.2, { thick: .12, camber: .06, curl: 0.03 });
  G.beam2 = wingGeo(0.86, 0.15, { thick: .1, camber: .07, curl: 0.04 });
  G.rwEnd = plateGeo([[0.14, 0.55], [-0.36, 0.5], [-0.52, 0.62], [-0.56, 0.9], [-0.5, 1.08], [-0.05, 1.1], [0.16, 0.98], [0.1, 0.7]], 0.02);
  G.swan = merge([-0.09, 0.09].map(x => { const g = plateGeo([[-0.05, 0.3], [-0.2, 0.3], [-0.3, 0.72], [-0.42, 0.86], [-0.32, 0.9], [-0.18, 0.74]], 0.018); g.translate(x, 0, -2.1); return g; }));
  G.fin = plateGeo([[0, 0], [-0.9, -0.24], [-1.05, -0.04], [-0.1, 0.1]], 0.012);
  G.tyreF = tyreGeo(0.37); G.tyreR = tyreGeo(0.44);
  G.rim = new THREE.CylinderGeometry(0.23, 0.23, 0.3, 32); G.rim.rotateZ(Math.PI / 2);
  G.cover = new THREE.CircleGeometry(0.228, 40); G.coverRing = new THREE.RingGeometry(0.195, 0.228, 40); G.nut = new THREE.CylinderGeometry(0.035, 0.035, 0.04, 6); G.nut.rotateZ(Math.PI / 2);
  G.duct = new THREE.CylinderGeometry(0.2, 0.2, 0.14, 20); G.duct.rotateZ(Math.PI / 2);
  G.helmet = new THREE.SphereGeometry(0.15, 28, 20); G.visor = new THREE.SphereGeometry(0.152, 28, 8, Math.PI / 2 - 0.95, 1.9, 1.2, 0.38);
  G.disc = new THREE.CircleGeometry(0.5, 32); G.mirror = new THREE.SphereGeometry(0.5, 18, 12);
  G.pod = new THREE.CapsuleGeometry(0.03, 0.08, 4, 10); G.pod.rotateX(Math.PI / 2);
  GEO = G; return G;
}

// ---------- livery & decal textures ----------
const SMALL = ['ORBIT', 'VOLTA', 'KAIROS', 'NEON FUEL', 'SPEEDNET', 'APEX'];
const isLight = hex => { const c = new THREE.Color(hex); return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.6; };
function liveryTex(team, kind) {
  return canvasTex(1024, 1024, (g, W, H) => {
    const U = u => u * W, V = v => (1 - v) * H, txt = isLight(team.c1) ? '#111' : '#fff';
    g.fillStyle = team.c1; g.fillRect(0, 0, W, H);
    // carbon lower half (sides below the midline and underside)
    const cg = g.createLinearGradient(0, 0, 8, 8); cg.addColorStop(0, '#111114'); cg.addColorStop(1, '#1d1d22');
    g.fillStyle = cg; g.fillRect(U(0.56), 0, U(0.38), H);
    const text = (str, u, v, size, rot, col = txt, maxW = 400, weight = 900, italic = 'italic ') => {
      g.save(); g.translate(U(u), V(v)); g.rotate(rot); g.fillStyle = col; g.font = `${italic}${weight} ${size}px Titillium Web, Arial, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(str, 0, 0, maxW); g.restore();
    };
    if (kind === 'body') {
      // accent stripes down the nose flanks and around the cockpit
      g.fillStyle = team.c2; g.fillRect(U(0.105), V(1), U(0.012), V(0.5) - V(1)); g.fillRect(U(0.383), V(1), U(0.012), V(0.5) - V(1));
      g.fillStyle = team.c3; g.fillRect(U(0.12), V(0.62), U(0.26), U(0.01));
      // nose: number + stack of sponsor decals reading from the front
      text(String(team.num), 0.25, 0.9, 110, Math.PI, '#fff');
      g.save(); g.translate(U(0.25), V(0.9)); g.rotate(Math.PI); g.strokeStyle = '#000'; g.lineWidth = 4; g.font = 'italic 900 110px Titillium Web, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.strokeText(String(team.num), 0, 0); g.restore();
      [team.sponsor, ...SMALL.slice(0, 4)].forEach((s, i) => text(s, 0.25, 0.82 - i * 0.045, i ? 30 : 42, Math.PI, i ? txt : team.c2 === '#ffffff' ? '#fff' : txt, 170));
      // engine cover: big sponsor on both flanks + smaller ones
      text(team.sponsor, 0.08, 0.3, 70, Math.PI / 2, txt, 330); text(team.sponsor, 0.42, 0.3, 70, -Math.PI / 2, txt, 330);
      text('APEX', 0.1, 0.62, 28, Math.PI / 2); text('APEX', 0.4, 0.62, 28, -Math.PI / 2);
      // top of engine cover: number
      text(String(team.num), 0.25, 0.22, 60, 0, team.c2);
    } else {
      g.fillStyle = team.c2; g.fillRect(U(0.16), 0, U(0.02), H); g.fillRect(U(0.32), 0, U(0.02), H);
      text(team.sponsor, 0.07, 0.45, 110, Math.PI / 2, txt, 700); text(team.sponsor, 0.43, 0.45, 110, -Math.PI / 2, txt, 700);
      text(SMALL[1], 0.25, 0.75, 40, Math.PI, txt, 300);
    }
  }, { repeat: false });
}
// transparent decal (text on a plane)
function decalTex(str, color = '#fff', w = 512, h = 128, font = 'italic 900 92px') {
  return canvasTex(w, h, (g, W, H) => { g.clearRect(0, 0, W, H); g.fillStyle = color; g.font = `${font} Titillium Web, Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(str, W / 2, H / 2 + 4, W - 16); }, { repeat: false });
}
// tyre: sidewall lettering + compound band, subtle tread sheen
const tyreCache = {};
export function tyreTex(color) {
  if (tyreCache[color]) return tyreCache[color];
  return tyreCache[color] = canvasTex(1024, 256, (g, W, H) => {
    g.fillStyle = '#19191b'; g.fillRect(0, 0, W, H);
    const band = (y0, y1) => {
      g.fillStyle = '#1e1e21'; g.fillRect(0, y0, W, y1 - y0);
      g.fillStyle = color; g.fillRect(0, y0 + (y1 - y0) * 0.66, W, 3);
      g.font = '900 26px Titillium Web, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? color : '#f2f2f2'; g.fillText(i % 2 ? 'P ZERO·APEX' : 'ORBIT', (i + 0.5) * W / 4, y0 + (y1 - y0) * 0.35); }
    };
    // lathe v runs 0 (one side) -> 1 (other side); canvas top = v 1
    band(H * 0.72, H * 0.97); band(H * 0.03, H * 0.28);
    const tg = g.createLinearGradient(0, H * 0.4, 0, H * 0.6); tg.addColorStop(0, '#161618'); tg.addColorStop(0.5, '#222226'); tg.addColorStop(1, '#161618');
    g.fillStyle = tg; g.fillRect(0, H * 0.36, W, H * 0.28);
  }, { repeat: false });
}
function helmetTex(team) {
  return canvasTex(512, 256, (g, W, H) => {
    g.fillStyle = team.c2; g.fillRect(0, 0, W, H);
    g.fillStyle = team.c1; g.fillRect(0, H * 0.55, W, H * 0.45);
    g.fillStyle = team.c3; g.fillRect(0, H * 0.5, W, H * 0.05);
    g.fillStyle = '#fff'; g.font = 'italic 900 40px Titillium Web, Arial'; g.textAlign = 'center'; g.fillText(team.num, W * 0.25, H * 0.8); g.fillText(team.num, W * 0.75, H * 0.8);
  }, { repeat: false });
}

// ---------- materials ----------
const paintMat = (color, map) => new THREE.MeshPhysicalMaterial({ color: map ? '#ffffff' : color, map, roughness: 0.38, metalness: 0.05, clearcoat: 0.7, clearcoatRoughness: 0.12, envMapIntensity: 0.55 });

export function makeCar(team, T, { cockpit = false, compound = '#ffd21e', mirrorTex = null } = {}) {
  const G = geometry();
  const g = new THREE.Group();
  const livery = paintMat(null, liveryTex(team, 'body')), podLiv = paintMat(null, liveryTex(team, 'pod'));
  const paint = paintMat(team.c1), paint2 = paintMat(team.c2);
  const carbon = new THREE.MeshPhysicalMaterial({ color: '#b8b8b8', map: T.carbon, roughness: 0.4, metalness: 0.2, clearcoat: 0.45, clearcoatRoughness: 0.2, envMapIntensity: 0.22 });
  const matte = new THREE.MeshStandardMaterial({ color: '#0b0b0d', roughness: 0.7, metalness: 0.2 });
  const black = new THREE.MeshStandardMaterial({ color: '#050506', roughness: 0.95 });
  const tyreM = new THREE.MeshStandardMaterial({ map: tyreTex(compound), roughness: 0.82, metalness: 0, envMapIntensity: 0.3 });
  const metal = new THREE.MeshStandardMaterial({ color: '#9aa0a6', roughness: 0.28, metalness: 1, envMapIntensity: 0.7 });
  const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, parent = g) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const decal = (str, w, h, x, y, z, rx, ry, col, font) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: decalTex(str, col, 512, 128, font), transparent: true, roughness: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0, 'YXZ'); g.add(m); return m;
  };
  const light = isLight(team.c1) ? '#111' : '#fff';

  // ---- main structures
  add(G.body, livery);
  add(G.airbox, paint);
  add(G.disc, black, 0, 0.995, -0.655).scale.set(0.12, 0.13, 1);        // roll-hoop intake
  for (const s of [-1, 1]) add(G.disc, black, s * 0.09, 0.85, -0.66).scale.set(0.05, 0.1, 1); // side intakes
  add(G.fin, paint, 0, 0.92, -1.28);
  add(G.podL, podLiv); add(G.podR, podLiv);
  for (const s of [-1, 1]) {
    add(G.disc, black, s * 0.6, 0.55, 0.605).scale.set(0.2, 0.1, 1);    // letterbox inlet
    add(new THREE.BoxGeometry(0.44, 0.015, 0.05), paint, s * 0.6, 0.6, 0.6);   // inlet top lip
    // cooling louvres on the pod top
    for (let i = 0; i < 6; i++) add(new THREE.BoxGeometry(0.2, 0.012, 0.018), matte, s * 0.52, 0.5 - i * 0.012, -0.55 - i * 0.07, 0.35, 0, 0);
    // halo fairing & mirror
    add(new THREE.BoxGeometry(0.16, 0.02, 0.2), paint, s * 0.66, 0.6, 0.35).rotation.z = -s * 0.2;
  }
  add(G.floor, carbon); add(G.floorEdge, carbon); add(G.floorFences, carbon); add(G.diffuser, carbon);
  // cockpit
  add(G.disc, black, 0, 0.735, -0.3, -Math.PI / 2).scale.set(0.46, 0.95, 1);
  for (const s of [-1, 1]) add(new THREE.CapsuleGeometry(0.035, 0.7, 4, 8), carbon, s * 0.26, 0.74, -0.32, Math.PI / 2);
  add(new THREE.BoxGeometry(0.46, 0.1, 0.14), carbon, 0, 0.8, -0.74);
  // front wing (main plane carbon, flaps livery) + endplates, footplates, strakes, nose pillars
  add(G.fw[0], carbon, 0, 0.075, 2.7, 0.04);
  add(G.fw[1], paint, 0, 0.125, 2.43, 0.3);
  add(G.fw[2], carbon, 0, 0.175, 2.31, 0.5);
  add(G.fw[3], paint2, 0, 0.23, 2.21, 0.72);
  for (const s of [-1, 1]) {
    add(G.fwEnd, paint, s * 0.99, 0.02, 2.9); add(G.fwFoot, carbon, s * 0.93, 0.03, 2.9);
    for (const x of [0.25, 0.45]) add(new THREE.BoxGeometry(0.008, 0.08, 0.36), carbon, s * x, 0.05, 2.62);
    add(new THREE.BoxGeometry(0.02, 0.1, 0.25), carbon, s * 0.07, 0.12, 2.78);
  }
  decal(team.sponsor, 0.5, 0.12, 0.45, 0.13, 2.65, -Math.PI / 2 + 0.04, 0, light);
  decal(team.sponsor, 0.5, 0.12, -0.45, 0.13, 2.65, -Math.PI / 2 + 0.04, 0, light);
  // rear wing, swan neck, twin beam wings, endplate LEDs, rain light
  add(G.rwMain, carbon, 0, 0.84, -2.4, 0.18);
  const drsFlap = new THREE.Group(); drsFlap.position.set(0, 1.0, -2.3); g.add(drsFlap);
  add(G.rwFlap, paint, 0, 0, -0.14, 0.62, 0, 0, drsFlap);
  add(new THREE.BoxGeometry(0.04, 0.12, 0.04), carbon, 0, -0.02, -0.12, 0, 0, 0, drsFlap); // DRS actuator
  add(G.swan, carbon);
  for (const s of [-1, 1]) {
    add(G.rwEnd, carbon, s * 0.51, 0, -2.18);
    for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.022, 0.012, 0.18), black, s * 0.51, 0.95 - i * 0.05, -2.2, 0.3);
    add(new THREE.BoxGeometry(0.022, 0.18, 0.02), new THREE.MeshBasicMaterial({ color: '#ff2020', toneMapped: false }), s * 0.51, 0.8, -2.74);
    decal(team.sponsor, 0.4, 0.1, s * 0.525, 0.8, -2.45, 0, s * Math.PI / 2, '#fff');
  }
  decal(team.sponsor, 0.55, 0.13, 0, 0.9, -2.38, -Math.PI / 2 + 0.18, 0, '#fff');
  add(G.beam1, carbon, 0, 0.4, -2.35, 0.12); add(G.beam2, carbon, 0, 0.47, -2.5, 0.35);
  const rain = add(new THREE.BoxGeometry(0.12, 0.06, 0.02), new THREE.MeshStandardMaterial({ color: '#200', emissive: '#ff1010', emissiveIntensity: 0.4 }), 0, 0.33, -2.44);
  // halo
  const halo = new THREE.CatmullRomCurve3([[-0.31, 0.74, -0.78], [-0.33, 0.93, -0.55], [-0.27, 1.01, -0.15], [0, 1.03, 0.1], [0.27, 1.01, -0.15], [0.33, 0.93, -0.55], [0.31, 0.74, -0.78]].map(p => new THREE.Vector3(...p)));
  add(new THREE.TubeGeometry(halo, 64, 0.028, 12), carbon);
  const pillar = add(new THREE.CylinderGeometry(0.024, 0.036, 0.36, 12), carbon, 0, 0.87, 0.23, -0.9);
  // camera pods, pitot tube, antennas
  for (const s of [-1, 1]) add(G.pod, paint, s * 0.16, 0.33, 2.1);
  add(new THREE.CylinderGeometry(0.006, 0.006, 0.35, 6), metal, 0, 0.26, 3.05, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.004, 0.004, 0.18, 5), black, 0.12, 0.62, 1.2, 0.3);
  add(new THREE.CylinderGeometry(0.004, 0.004, 0.14, 5), black, 0, 0.92, -1.6, -0.4);
  add(new THREE.BoxGeometry(0.1, 0.06, 0.16), black, 0, 1.18, -0.82); // T-cam
  // mirrors on stalks
  const mirrors = [];
  for (const s of [-1, 1]) {
    add(rodGeo([s * 0.34, 0.66, 0.45], [s * 0.5, 0.76, 0.43], 0.012), carbon);
    add(G.mirror, paint, s * 0.53, 0.78, 0.45).scale.set(0.21, 0.085, 0.1);
    add(new THREE.BoxGeometry(0.02, 0.05, 0.08), carbon, s * 0.64, 0.78, 0.44);
    if (mirrorTex) {
      const mg = new THREE.PlaneGeometry(0.17, 0.06), uv = mg.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, s > 0 ? 1 - uv.getX(i) * 0.5 : 0.5 - uv.getX(i) * 0.5);
      const glass = add(mg, new THREE.MeshBasicMaterial({ map: mirrorTex }), s * 0.53, 0.78, 0.395, 0, Math.PI, 0); glass.castShadow = false; mirrors.push(glass);
    }
  }
  // wheels + suspension
  const steer = [], spins = [];
  const coverM = new THREE.MeshPhysicalMaterial({ color: '#ffffff', map: T.carbon, roughness: 0.3, metalness: 0.3, clearcoat: 0.8, envMapIntensity: 0.35 });
  const ringM = new THREE.MeshStandardMaterial({ color: team.c1, roughness: 0.4, metalness: 0.3 });
  const susp = [];
  for (const [x, z, front] of [[0.8, 1.8, 1], [-0.8, 1.8, 1], [0.8, -1.8, 0], [-0.8, -1.8, 0]]) {
    const s = Math.sign(x), w = front ? 0.37 : 0.44;
    const holder = new THREE.Group(); holder.position.set(x, 0.36, z); g.add(holder);
    const spin = new THREE.Group(); holder.add(spin);
    add(front ? G.tyreF : G.tyreR, tyreM, 0, 0, 0, 0, 0, 0, spin);
    add(G.rim, metal, 0, 0, 0, 0, 0, 0, spin).scale.set(w / 0.3 * 0.98, 1, 1);
    add(G.nut, black, s * (w / 2 + 0.015), 0, 0, 0, 0, 0, spin);
    // wheel covers (static on the real car) + brake duct drum
    add(G.cover, coverM, s * (w / 2 - 0.015), 0, 0, 0, s * Math.PI / 2, 0, holder);
    add(G.coverRing, ringM, s * (w / 2 - 0.013), 0, 0, 0, s * Math.PI / 2, 0, holder);
    add(G.duct, carbon, -s * (w / 2 + 0.05), 0, 0, 0, 0, 0, holder);
    if (!front) for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.01, 0.34 - i * 0.06, 0.36), carbon, x - s * (w / 2 + 0.14 + i * 0.03), 0.42 + i * 0.03, z);
    if (front) steer.push(holder);
    spins.push(spin);
    const hub = [x - s * (w / 2 + 0.1), 0.36, z];
    const pts = front ? [[s * 0.33, 0.56, z + 0.4], [s * 0.33, 0.54, z - 0.35], [s * 0.3, 0.3, z + 0.32], [s * 0.3, 0.28, z - 0.4]] : [[s * 0.3, 0.5, z + 0.45], [s * 0.26, 0.5, z - 0.2], [s * 0.3, 0.26, z + 0.45], [s * 0.28, 0.24, z - 0.2]];
    pts.forEach((p, i) => susp.push(rodGeo(p, [hub[0], i < 2 ? 0.52 : 0.22, hub[2] + (i % 2 ? -0.02 : 0.02)], 0.018, 0.35)));
    susp.push(rodGeo([s * 0.32, front ? 0.3 : 0.55, z - 0.15], [hub[0], front ? 0.5 : 0.24, z], 0.013));
    susp.push(rodGeo([s * 0.3, 0.42, z + 0.05], [hub[0], 0.4, z + (front ? 0.14 : -0.1)], 0.01)); // track rod / toe link
  }
  add(merge(susp), carbon);
  // driver
  const helmet = add(G.helmet, new THREE.MeshPhysicalMaterial({ map: helmetTex(team), roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 }), 0, 0.86, -0.44, 0, Math.PI, 0);
  const visor = add(G.visor, new THREE.MeshStandardMaterial({ color: '#15171c', roughness: 0.05, metalness: 0.95 }), 0, 0.86, -0.44);

  const out = { group: g, steer, spins, helmet, visor, drsFlap, rain, mirrors, pillar, frontWing: [] };
  g.children.forEach(ch => { if (ch.isMesh && (G.fw.includes(ch.geometry) || ch.geometry === G.fwEnd || ch.geometry === G.fwFoot)) out.frontWing.push(ch); });

  if (cockpit) {
    const wheel = new THREE.Group(); wheel.position.set(0, 0.7, 0.1); wheel.rotation.x = -0.3; wheel.scale.setScalar(0.85); g.add(wheel);
    const wb = new THREE.Shape();
    wb.moveTo(-0.13, -0.06); wb.quadraticCurveTo(-0.16, 0.0, -0.13, 0.07); wb.lineTo(0.13, 0.07); wb.quadraticCurveTo(0.16, 0, 0.13, -0.06); wb.quadraticCurveTo(0, -0.085, -0.13, -0.06);
    const wg = new THREE.ExtrudeGeometry(wb, { depth: 0.035, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2 }); wg.translate(0, 0, -0.0175);
    add(wg, carbon, 0, 0, 0, 0, 0, 0, wheel);
    for (const s of [-1, 1]) {
      add(new THREE.CapsuleGeometry(0.028, 0.1, 4, 10), new THREE.MeshStandardMaterial({ color: '#202022', roughness: 0.95 }), s * 0.15, 0, 0, 0, 0, s * 0.22, wheel);
      add(new THREE.BoxGeometry(0.05, 0.012, 0.01), metal, s * 0.1, -0.04, 0.03, 0, 0, 0, wheel); // shift paddles
    }
    ['#e10600', '#ffd21e', '#2f8cff', '#1ee36b', '#ffffff', '#ff8000'].forEach((c, i) => add(new THREE.CylinderGeometry(0.008, 0.008, 0.01, 10), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.2 }), (i % 2 ? 1 : -1) * (0.095 + (i >> 1) * 0.012), -0.03 + (i >> 1) * 0.022, -0.028, Math.PI / 2, 0, 0, wheel));
    for (const s of [-1, 1]) add(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 12), metal, s * 0.075, -0.055, -0.026, Math.PI / 2, 0, 0, wheel); // rotary dials
    const dc = document.createElement('canvas'); dc.width = 256; dc.height = 128;
    const dtex = new THREE.CanvasTexture(dc); dtex.colorSpace = THREE.SRGBColorSpace;
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.07), new THREE.MeshBasicMaterial({ map: dtex, toneMapped: false }));
    disp.position.set(0, 0.005, -0.028); disp.rotation.y = Math.PI; wheel.add(disp);
    const ledMats = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.MeshBasicMaterial({ color: '#111', toneMapped: false }); ledMats.push(m);
      const led = new THREE.Mesh(new THREE.CircleGeometry(0.0055, 10), m); led.position.set(0.063 - i * 0.014, 0.056, -0.028); led.rotation.y = Math.PI; wheel.add(led);
    }
    // gloves on the wheel
    const glove = new THREE.MeshStandardMaterial({ color: '#1a1a1c', roughness: 0.9 });
    for (const s of [-1, 1]) add(new THREE.SphereGeometry(0.03, 12, 10), glove, s * 0.15, 0.0, -0.035, 0, 0, 0, wheel).scale.set(0.9, 1.4, 0.8);
    Object.assign(out, { wheel, dispCanvas: dc, dispTex: dtex, ledMats });
  }
  return out;
}

export function disposeCar(car) {
  car.group.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m.map && !m.map.isRenderTargetTexture && !Object.values(tyreCache).includes(m.map) && m.map.image && m.map.image.width !== 64) m.map.dispose(); m.dispose(); }); });
}
