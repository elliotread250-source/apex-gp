// Optional real assets. If present they replace the procedural car / synthesised engine.
//   assets/manifest.json  { "car": true, "engine": true }  switches them on
//   assets/car.glb   + optional assets/car.json  { "rotateY": 0, "paint": ["MaterialName"], "length": 5.63 }
//   assets/engine.json  [{ "file": "engine/4000.ogg", "rpm": 4000, "load": "on" }, ...]
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export const ASSETS = { car: null, carCfg: {}, engine: null };

let manifest = null;
async function exists(key) { if (!manifest) { try { manifest = await (await fetch('assets/manifest.json')).json(); } catch { manifest = {}; } } return !!manifest[key]; }

export async function loadAssets(ctxGetter) {
  const jobs = [];
  if (await exists('car')) jobs.push((async () => {
    try { ASSETS.carCfg = await (await fetch('assets/car.json')).json(); } catch { ASSETS.carCfg = {}; }
    const loader = new GLTFLoader();
    const draco = new DRACOLoader(); draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/'); loader.setDRACOLoader(draco);
    const gltf = await loader.loadAsync('assets/car.glb');
    ASSETS.car = prepareCar(gltf.scene, ASSETS.carCfg);
  })().catch(e => console.warn('car.glb failed to load, using procedural car', e)));
  if (await exists('engine')) jobs.push((async () => {
    ASSETS.engine = await (await fetch('assets/engine.json')).json();
  })().catch(e => console.warn('engine.json failed', e)));
  await Promise.all(jobs);
  return ASSETS;
}

// Normalise an arbitrary F1 model: forward +z, ground at y=0, 5.63 m long, wheels on their own pivots.
function prepareCar(root, cfg) {
  const wrap = new THREE.Group(); wrap.add(root);
  root.rotation.y = THREE.MathUtils.degToRad(cfg.rotateY || 0);
  wrap.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(wrap);
  const size = box.getSize(new THREE.Vector3());
  if (size.x > size.z && cfg.rotateY == null) { root.rotation.y += Math.PI / 2; wrap.updateMatrixWorld(true); box = new THREE.Box3().setFromObject(wrap); box.getSize(size); }
  const k = (cfg.length || 5.63) / size.z;
  root.scale.multiplyScalar(k); wrap.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(wrap);
  const c = box.getCenter(new THREE.Vector3());
  root.position.x -= c.x; root.position.z -= c.z; root.position.y -= box.min.y;
  wrap.updateMatrixWorld(true);
  wrap.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
  return wrap;
}

// Build a car instance from the loaded model, matching the procedural car's interface.
export function carFromAsset(team) {
  const g = ASSETS.car.clone(true);
  const paintNames = ASSETS.carCfg.paint || [];
  g.traverse(o => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    if (paintNames.includes(o.material.name)) o.material.color.set(team.c1);
  });
  g.updateMatrixWorld(true);
  // find wheel meshes by name and put them on pivots at each corner
  const wheelRe = /wheel|tyre|tire|rim|rueda|reifen/i, corners = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
  const pivots = corners.map(() => null), found = [];
  g.traverse(o => { if (o.isMesh && wheelRe.test(o.name + ' ' + (o.parent?.name || ''))) found.push(o); });
  const spins = [], steer = [];
  if (found.length) {
    const centers = found.map(o => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()));
    corners.forEach(([sx, sz], ci) => {
      const mine = found.filter((o, i) => Math.sign(centers[i].x) === sx && Math.sign(centers[i].z) === sz);
      if (!mine.length) return;
      const bb = new THREE.Box3(); mine.forEach(o => bb.expandByObject(o));
      const holder = new THREE.Group(); holder.position.copy(bb.getCenter(new THREE.Vector3())); g.add(holder);
      const spin = new THREE.Group(); holder.add(spin); holder.updateMatrixWorld(true);
      mine.forEach(o => spin.attach(o));
      spins.push(spin); if (sz > 0) steer.push(holder);
    });
  }
  const dummyMat = new THREE.MeshStandardMaterial({ color: '#200', emissive: '#ff1010', emissiveIntensity: 0.4 });
  const rain = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.02), dummyMat); rain.position.set(0, 0.33, -2.6); g.add(rain);
  const helmet = new THREE.Object3D(), visor = new THREE.Object3D(), pillar = new THREE.Object3D(), drsFlap = new THREE.Object3D();
  return { group: g, steer, spins, helmet, visor, drsFlap, rain, mirrors: [], pillar, frontWing: [], fromAsset: true };
}

// Sample-based engine: loops recorded at several rpm, crossfaded and pitch-shifted to the live rpm.
export async function sampleEngine(ctx, out, list) {
  const voices = await Promise.all(list.map(async s => {
    const buf = await ctx.decodeAudioData(await (await fetch('assets/' + s.file)).arrayBuffer());
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); g.gain.value = 0; src.connect(g); g.connect(out); src.start(0, Math.random() * buf.duration);
    return { src, g, rpm: s.rpm, load: s.load || 'on' };
  }));
  return {
    set(rpm, thr, t, vol) {
      const want = thr > 0.3 ? 'on' : 'off';
      const pool = voices.some(v => v.load === want) ? voices.filter(v => v.load === want) : voices;
      voices.forEach(v => {
        const inPool = pool.includes(v);
        const d = Math.abs(Math.log2(rpm / v.rpm));
        const w = inPool ? Math.max(0, 1 - d / 0.5) : 0;
        v.src.playbackRate.setTargetAtTime(rpm / v.rpm, t, 0.02);
        v.g.gain.setTargetAtTime(w * vol, t, 0.03);
      });
    }
  };
}
