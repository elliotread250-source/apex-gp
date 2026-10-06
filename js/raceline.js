// Gran Turismo-style dynamic driving line.
// 1) optimiseLine(): minimum-curvature racing line (elastic band relaxed inside the track edges),
//    giving the classic outside -> apex -> outside path.
// 2) buildRaceLine(): 3D chevrons along that line plus apex markers. Each frame the chevrons ahead of
//    the car are coloured from YOUR current speed: blue = power, yellow = lift, red = brake from here.
//    The red zone starts exactly where you need to brake at your current speed and fades as you slow.
import * as THREE from 'three';
import { maxLatAccel, RHO } from './physics.js';

export function optimiseLine(tr, margin = 0.95) {
  const { N, P, NL, halfW } = tr, lim = halfW - margin;
  const lat = new Float32Array(N), x = new Float32Array(N), z = new Float32Array(N);
  const pos = () => { for (let i = 0; i < N; i++) { x[i] = P[i].x + NL[i].x * lat[i]; z[i] = P[i].z + NL[i].z * lat[i]; } };
  // coarse-to-fine relaxation: pull every point towards the midpoint of its neighbours (straightens the
  // path = lowers curvature), then clamp to the usable track width
  for (const [k, iters, gain] of [[40, 160, 0.6], [20, 220, 0.6], [9, 260, 0.5], [4, 160, 0.4]]) {
    for (let it = 0; it < iters; it++) {
      pos();
      for (let i = 0; i < N; i++) {
        const a = (i - k + N) % N, b = (i + k) % N;
        const mx = (x[a] + x[b]) / 2, mz = (z[a] + z[b]) / 2;
        const d = (mx - x[i]) * NL[i].x + (mz - z[i]) * NL[i].z;
        lat[i] = Math.max(-lim, Math.min(lim, lat[i] + d * gain));
      }
    }
  }
  pos();
  // signed curvature of the optimised path (for speed targets)
  const kLine = new Float32Array(N), r = 3;
  for (let i = 0; i < N; i++) {
    const a = (i - r + N) % N, b = (i + r) % N;
    const ax = x[i] - x[a], az = z[i] - z[a], bx = x[b] - x[i], bz = z[b] - z[i];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    const cross = (az * bx - ax * bz) / (la * lb), ang = Math.asin(Math.max(-1, Math.min(1, cross)));
    kLine[i] = ang / ((la + lb) / 2);
  }
  const sm = new Float32Array(N);
  for (let i = 0; i < N; i++) { let s = 0; for (let j = -4; j <= 4; j++) s += kLine[(i + j + N) % N]; sm[i] = s / 9; }
  return { lat, kLine: sm };
}

const VS = `attribute vec3 col; attribute float alpha; varying vec3 vC; varying float vA;
  void main(){ vC = col; vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FS = `varying vec3 vC; varying float vA; void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(vC * 1.25, vA); }`;

export function buildRaceLine(tr, scene) {
  const SPACING = 4.2, n = Math.floor(tr.L / SPACING), W = 0.95, LEN = 1.15;
  const pos = new Float32Array(n * 4 * 3), col = new Float32Array(n * 4 * 3), alpha = new Float32Array(n * 4), idx = [];
  const sAt = new Float32Array(n), iAt = new Uint32Array(n);
  for (let c = 0; c < n; c++) {
    const s = c * SPACING, f = s / tr.ds, i = Math.floor(f) % tr.N, j = (i + 1) % tr.N, u = f - Math.floor(f);
    const px = THREE.MathUtils.lerp(tr.P[i].x, tr.P[j].x, u), pz = THREE.MathUtils.lerp(tr.P[i].z, tr.P[j].z, u);
    const la = THREE.MathUtils.lerp(tr.line[i], tr.line[j], u), N0 = tr.NL[i];
    // direction of the line itself (includes the lateral drift through corners)
    const i2 = (i + 2) % tr.N, la2 = tr.line[i2];
    let tx = tr.P[i2].x + tr.NL[i2].x * la2 - (tr.P[i].x + N0.x * tr.line[i]), tz = tr.P[i2].z + tr.NL[i2].z * la2 - (tr.P[i].z + N0.z * tr.line[i]);
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    const nx = tz, nz = -tx, cx = px + N0.x * la, cz = pz + N0.z * la, y = 0.04;
    // chevron "^": left-back, tip, right-back, inner notch
    const v = [[cx + nx * W / 2 - tx * LEN / 2, cz + nz * W / 2 - tz * LEN / 2], [cx + tx * LEN / 2, cz + tz * LEN / 2],
               [cx - nx * W / 2 - tx * LEN / 2, cz - nz * W / 2 - tz * LEN / 2], [cx - tx * LEN * 0.05, cz - tz * LEN * 0.05]];
    v.forEach((q, k) => pos.set([q[0], y, q[1]], (c * 4 + k) * 3));
    const b = c * 4; idx.push(b, b + 3, b + 1, b + 3, b + 2, b + 1);
    sAt[c] = s; iAt[c] = i;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('col', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 });
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 2; scene.add(mesh);

  // apex markers: small glowing posts on the inside of each corner (where the line touches the edge)
  const apexes = [];
  const apexGroup = new THREE.Group(); scene.add(apexGroup);
  const postGeo = new THREE.ConeGeometry(0.22, 0.75, 4); postGeo.translate(0, 0.38, 0);
  const postMat = new THREE.MeshBasicMaterial({ color: '#ffb21e' });
  for (const cn of tr.corners) {
    let best = -1, bi = cn.i0;
    for (let j = 0; j < cn.len; j++) { const i = (cn.i0 + j) % tr.N, a = Math.abs(tr.line[i]); if (Math.sign(tr.line[i]) === cn.sgn && a > best) { best = a; bi = i; } }
    if (best < tr.halfW * 0.5) continue;
    const side = Math.sign(tr.line[bi]), off = side * (tr.halfW + 0.45);
    const m = new THREE.Mesh(postGeo, postMat); m.position.set(tr.P[bi].x + tr.NL[bi].x * off, 0, tr.P[bi].z + tr.NL[bi].z * off); apexGroup.add(m);
    apexes.push({ i: bi, mesh: m });
  }

  const BLUE = new THREE.Color('#2b8cff'), YEL = new THREE.Color('#ffc21e'), RED = new THREE.Color('#ff2a1a'), tmp = new THREE.Color();
  let minima = null;
  return {
    mesh, apexGroup,
    // profile: target speed per track sample for the player's car; spec: car spec; mode: 'full' | 'brake' | 'off'
    update(player, profile, spec, mode) {
      const on = mode !== 'off'; mesh.visible = on; apexGroup.visible = mode === 'full';
      if (!on) return;
      if (!minima) { // corner speed minima along the profile
        minima = [];
        for (let i = 0; i < tr.N; i++) { const a = profile[(i - 12 + tr.N) % tr.N], b = profile[(i + 12) % tr.N], v = profile[i];
          if (v <= a && v <= b && Math.max(a, b) - v > 6 && (!minima.length || i - minima[minima.length - 1].i > 30)) minima.push({ i, v }); }
      }
      const L = tr.L, v = Math.max(0, player.c.vx), ps = player.s, VIEW = 340;
      // distance ahead (m) to each upcoming corner minimum, and the braking distance it needs from our speed
      const zones = [];
      for (const m of minima) {
        let d = ((m.i * tr.ds - ps) % L + L) % L; if (d > VIEW + 300) continue;
        const vt = m.v * 0.97, cap = maxLatAccel(spec, (v + vt) / 2) * 0.88 + 0.5 * RHO * spec.cda * v * v / spec.mass;
        const need = v > vt ? (v * v - vt * vt) / (2 * cap) : 0;
        zones.push({ d, need, vt });
      }
      zones.sort((p, q) => p.d - q.d);
      const cA = mesh.geometry.attributes.col, aA = mesh.geometry.attributes.alpha;
      for (let c = 0; c < n; c++) {
        let d = ((sAt[c] - ps) % L + L) % L;
        let a = 0;
        if (d < VIEW && d > 2.5) a = Math.min(1, (d - 2.5) / 6) * (1 - Math.pow(d / VIEW, 2)) * 0.92;
        let kind = 0; // 0 blue, 1 yellow, 2 red
        if (a > 0) for (const z of zones) {
          if (d > z.d) continue;                                   // past this corner's apex
          const start = z.d - z.need;                              // where braking must begin
          if (z.need > 0 && d >= start - 1) { kind = 2; break; }
          if (z.need > 0 && d >= start - 28) kind = Math.max(kind, 1);
          break;                                                   // only the next corner matters
        }
        if (mode === 'brake' && kind === 0) a = 0;
        // red brightens near the brake point, yellow is a softer warning
        if (kind === 2) tmp.copy(RED); else if (kind === 1) tmp.copy(YEL); else tmp.copy(BLUE);
        for (let k = 0; k < 4; k++) { cA.setXYZ(c * 4 + k, tmp.r, tmp.g, tmp.b); aA.setX(c * 4 + k, a); }
      }
      cA.needsUpdate = aA.needsUpdate = true;
    }
  };
}
