// Real car model (prepared by dev/prep.mjs from a CC-BY Sketchfab model; see CREDITS.md).
// assets/manifest.json: { "car": "sf23", "eye": [0, 0.84, -0.45] } switches it on; missing -> procedural car.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export const ASSETS = { models: {}, cfg: {}, liveries: new Map() };
const FILES = { full: '', lod: '_lod', lo: '_lo' }, pending = {};
let loader = null;

export async function loadManifest() {
  try { ASSETS.cfg = await (await fetch('assets/manifest.json')).json(); } catch { ASSETS.cfg = {}; }
  return ASSETS.cfg;
}
export const hasModel = d => !!ASSETS.models[d];
// Download a detail level of the car on demand (school networks: low only fetches ~1.4 MB)
export function ensureModel(detail, onProgress) {
  if (!ASSETS.cfg.car) return Promise.resolve(null);
  if (ASSETS.models[detail]) return Promise.resolve(ASSETS.models[detail]);
  if (pending[detail]) return pending[detail];
  if (!loader) { loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder); }
  return pending[detail] = loader.loadAsync(`assets/${ASSETS.cfg.car}${FILES[detail]}.glb`, e => onProgress && e.total && onProgress(e.loaded / e.total))
    .then(g => (ASSETS.models[detail] = prepareCar(g.scene, ASSETS.cfg)))
    .catch(e => { console.warn('Car model failed to load, using procedural car', e); return null; });
}

// forward +z, ground at y=0, real length (5.63 m)
function prepareCar(root, cfg) {
  const wrap = new THREE.Group(); wrap.add(root);
  root.rotation.y = THREE.MathUtils.degToRad(cfg.rotateY || 0);
  wrap.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(wrap);
  const size = box.getSize(new THREE.Vector3());
  root.scale.multiplyScalar((cfg.length || 5.63) / size.z); wrap.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(wrap);
  const c = box.getCenter(new THREE.Vector3());
  root.position.x -= c.x; root.position.z -= c.z; root.position.y -= box.min.y;
  wrap.updateMatrixWorld(true);
  wrap.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
  splitPillar(wrap, cfg.pillar || { x: 0.05, z0: 0.5, z1: 0.78, y0: 0.69, y1: 0.9 });
  return wrap;
}

// Cut the halo's centre strut out of the body into its own mesh so the cockpit view can hide it.
function splitPillar(wrap, box) {
  const bodies = []; wrap.traverse(o => { if (o.isMesh && /body/i.test(o.name + ' ' + (o.parent?.name || ''))) bodies.push(o); });
  const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const mesh of bodies) {
    const geo = mesh.geometry, idx = geo.index; if (!idx) continue;
    const pos = geo.attributes.position, keep = [], cut = [];
    for (let t = 0; t < idx.count; t += 3) {
      const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
      v.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld); a.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld); b.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      v.add(a).add(b).multiplyScalar(1 / 3);
      (Math.abs(v.x) < box.x && v.z > box.z0 && v.z < box.z1 && v.y > box.y0 && v.y < box.y1 ? cut : keep).push(i0, i1, i2);
    }
    if (!cut.length) continue;
    const g1 = geo.clone(); g1.setIndex(keep); mesh.geometry = g1;
    const g2 = geo.clone(); g2.setIndex(cut);
    const pm = new THREE.Mesh(g2, mesh.material); pm.name = 'pillar'; pm.castShadow = true;
    pm.position.copy(mesh.position); pm.quaternion.copy(mesh.quaternion); pm.scale.copy(mesh.scale);
    mesh.parent.add(pm);
  }
}

// Recolour the base livery's signature red into the team colour, keeping shading, logos, carbon and tyres.
function liveryMap(src, team) {
  const key = src.uuid + team.c1;
  if (ASSETS.liveries.has(key)) return ASSETS.liveries.get(key);
  const img = src.image, w = img.width, h = img.height;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, w, h), px = d.data;
  const tc = new THREE.Color(team.c1), T = { r: tc.r, g: tc.g, b: tc.b };
  // work in sRGB bytes
  const tr = Math.round(Math.pow(T.r, 1 / 2.2) * 255), tg = Math.round(Math.pow(T.g, 1 / 2.2) * 255), tb = Math.round(Math.pow(T.b, 1 / 2.2) * 255);
  const tMax = Math.max(tr, tg, tb, 1);
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], gg = px[i + 1], b = px[i + 2];
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    if (mx < 40 || r !== mx) continue;                       // not red-dominant
    const sat = (mx - mn) / mx; if (sat < 0.5) continue;
    const hueOff = (gg - b) / (mx - mn);                      // red hue ≈ 0
    if (hueOff > 0.35 || hueOff < -0.35) continue;
    // blend strength falls off near the threshold to avoid hard edges
    const k = Math.min(1, (sat - 0.5) / 0.2);
    const shade = mx / 200;                                   // Ferrari red highlight ≈ 200
    const nr = Math.min(255, tr / tMax * 230 * shade), ng = Math.min(255, tg / tMax * 230 * shade), nb = Math.min(255, tb / tMax * 230 * shade);
    // lighter team colours (white/silver) need their own brightness, not the red's
    const bright = Math.max(tr, tg, tb) / 255;
    px[i] = r + (nr * bright - r) * k; px[i + 1] = gg + (ng * bright - gg) * k; px[i + 2] = b + (nb * bright - b) * k;
  }
  g.putImageData(d, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = src.colorSpace; tex.flipY = src.flipY; tex.wrapS = src.wrapS; tex.wrapT = src.wrapT; tex.anisotropy = 8; tex.channel = src.channel;
  ASSETS.liveries.set(key, tex);
  return tex;
}

// Car instance with the same interface as the procedural car
export function carFromAsset(team, detail = 'full') {
  const g = ASSETS.models[detail].clone(true);
  const recolour = team.code !== 'ROS';
  const matCache = new Map();
  g.traverse(o => {
    if (!o.isMesh) return;
    if (!matCache.has(o.material)) {
      const m = o.material.clone();
      if (recolour && m.map) m.map = liveryMap(m.map, team);
      m.envMapIntensity = 0.6;
      if (detail === 'lo') { m.clearcoat = 0; m.clearcoatMap = null; }
      matCache.set(o.material, m);
    }
    o.material = matCache.get(o.material);
  });
  g.updateMatrixWorld(true);
  const spins = [], steer = [];
  const wheels = []; g.traverse(o => { if (o.isMesh && /wheel_/i.test(o.name + (o.parent?.name || ''))) wheels.push(o); });
  for (const w of wheels) {
    const bb = new THREE.Box3().setFromObject(w), c = bb.getCenter(new THREE.Vector3());
    const holder = new THREE.Group(); holder.position.copy(c); g.add(holder); holder.updateMatrixWorld(true);
    const spin = new THREE.Group(); holder.add(spin); spin.updateMatrixWorld(true);
    spin.attach(w);
    spins.push(spin); if (c.z > 0) steer.push(holder);
  }
  const rain = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.02), new THREE.MeshStandardMaterial({ color: '#200', emissive: '#ff1010', emissiveIntensity: 0.4 }));
  rain.position.set(0, 0.33, -2.62); g.add(rain);
  const dummy = () => new THREE.Object3D();
  const pillars = []; g.traverse(o => { if (o.isMesh && o.name === 'pillar') pillars.push(o); });
  const pillar = { set visible(on) { pillars.forEach(m => m.visible = on); }, get visible() { return pillars[0]?.visible ?? true; } };
  return { group: g, steer, spins, helmet: dummy(), visor: dummy(), drsFlap: dummy(), rain, mirrors: [], pillar, frontWing: [], fromAsset: true };
}
