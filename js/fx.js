import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------- post-processing: bloom + speed blur/vignette/CA ----------------
const SpeedShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0 }, vig: { value: 0.35 }, ca: { value: 0 }, center: { value: new THREE.Vector2(0.5, 0.45) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float amount; uniform float vig; uniform float ca; uniform vec2 center; varying vec2 vUv;
    void main(){
      vec2 dir = vUv - center; float d = length(dir);
      vec4 col = vec4(0.);
      float w = smoothstep(0.18, 0.75, d) * amount;
      for (int i = 0; i < 8; i++) { float t = float(i) / 7.0; col += texture2D(tDiffuse, vUv - dir * w * t * 0.06); }
      col /= 8.0;
      if (ca > 0.0) { col.r = mix(col.r, texture2D(tDiffuse, vUv + dir * ca * 0.004).r, 0.8); col.b = mix(col.b, texture2D(tDiffuse, vUv - dir * ca * 0.004).b, 0.8); }
      col.rgb *= 1.0 - vig * smoothstep(0.35, 0.95, d * 1.25);
      gl_FragColor = col;
    }`
};

export function createPost(renderer, scene, camera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  const rp = new RenderPass(scene, camera); composer.addPass(rp);
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.28, 0.5, 0.92); composer.addPass(bloom);
  const speed = new ShaderPass(SpeedShader); composer.addPass(speed);
  composer.addPass(new OutputPass());
  return {
    composer, rp, speed,
    setScene(s, c) { rp.scene = s; rp.camera = c; },
    setSize(w, h) { composer.setSize(w, h); },
    render() { composer.render(); },
    dispose() { composer.dispose(); rt.dispose(); }
  };
}

// ---------------- particles: tyre smoke + sparks ----------------
const PVERT = `
  attribute float size; attribute float alpha; attribute vec3 tint; varying float vA; varying vec3 vT;
  void main(){ vA = alpha; vT = tint; vec4 mv = modelViewMatrix * vec4(position,1.); gl_PointSize = size * (600.0 / -mv.z); gl_Position = projectionMatrix * mv; }`;
const PFRAG = `uniform sampler2D map; varying float vA; varying vec3 vT; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vT, 1.) * t * vec4(1.,1.,1.,vA); if (gl_FragColor.a < 0.01) discard; }`;

class ParticlePool {
  constructor(scene, max, tex, additive) {
    this.max = max; this.n = 0; this.i = 0;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.life = new Float32Array(max); this.ttl = new Float32Array(max);
    this.size = new Float32Array(max); this.s0 = new Float32Array(max); this.grow = new Float32Array(max); this.alpha = new Float32Array(max); this.a0 = new Float32Array(max); this.tint = new Float32Array(max * 3);
    this.grav = additive ? -9.8 : 0.6;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({ uniforms: { map: { value: tex } }, vertexShader: PVERT, fragmentShader: PFRAG, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.points = new THREE.Points(g, m); this.points.frustumCulled = false; scene.add(this.points);
  }
  emit(x, y, z, vx, vy, vz, ttl, size, grow, alpha, r = 1, gg = 1, b = 1) {
    const i = this.i; this.i = (this.i + 1) % this.max;
    this.p.set([x, y, z], i * 3); this.v.set([vx, vy, vz], i * 3); this.life[i] = 0; this.ttl[i] = ttl;
    this.s0[i] = size; this.grow[i] = grow; this.a0[i] = alpha; this.tint.set([r, gg, b], i * 3);
  }
  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.ttl[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] += dt; const t = this.life[i] / this.ttl[i];
      if (t >= 1) { this.ttl[i] = 0; this.alpha[i] = 0; continue; }
      const k = i * 3, drag = Math.exp(-dt * 1.8);
      this.v[k] *= drag; this.v[k + 2] *= drag; this.v[k + 1] += this.grav * dt;
      this.p[k] += this.v[k] * dt; this.p[k + 1] += this.v[k + 1] * dt; this.p[k + 2] += this.v[k + 2] * dt;
      if (this.p[k + 1] < 0.02 && this.grav < 0) { this.p[k + 1] = 0.02; this.v[k + 1] *= -0.3; }
      this.size[i] = this.s0[i] + this.grow[i] * this.life[i];
      this.alpha[i] = this.a0[i] * (1 - t) * Math.min(1, t * 8);
    }
    const a = this.points.geometry.attributes; a.position.needsUpdate = a.size.needsUpdate = a.alpha.needsUpdate = a.tint.needsUpdate = true;
  }
}

// ---------------- skid marks (ring buffer of quads on the road) ----------------
class Skids {
  constructor(scene, tex, max = 4000) {
    this.max = max; this.i = 0;
    const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: tex, color: '#000', transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }), max);
    this.mesh.frustumCulled = false; this.mesh.count = 0; scene.add(this.mesh);
    this.m4 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.last = new Map();
  }
  mark(id, x, z, width, strength) {
    const prev = this.last.get(id);
    if (prev && strength > 0) {
      const dx = x - prev[0], dz = z - prev[1], len = Math.hypot(dx, dz);
      if (len < 0.25) return;
      if (len < 3) {
        this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dx, dz));
        this.m4.compose(new THREE.Vector3((x + prev[0]) / 2, 0.028, (z + prev[1]) / 2), this.q, new THREE.Vector3(width, 1, len + 0.05));
        this.mesh.setMatrixAt(this.i, this.m4); this.i = (this.i + 1) % this.max;
        this.mesh.count = Math.min(this.max, Math.max(this.mesh.count, this.i));
        this.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (strength > 0) this.last.set(id, [x, z]); else this.last.delete(id);
  }
}

export function createFX(scene, T) {
  const smoke = new ParticlePool(scene, 700, T.smoke, false);
  const sparks = new ParticlePool(scene, 500, T.spark, true);
  const dirt = new ParticlePool(scene, 300, T.smoke, false);
  const skids = new Skids(scene, T.skid);
  return {
    smoke, sparks, dirt, skids,
    update(dt) { smoke.update(dt); sparks.update(dt); dirt.update(dt); }
  };
}

// ---------------- rear-view mirrors ----------------
export function createMirror() {
  const rt = new THREE.WebGLRenderTarget(384, 120, { samples: 0 });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const cam = new THREE.PerspectiveCamera(38, 384 / 120, 0.3, 800);
  return { rt, cam };
}
