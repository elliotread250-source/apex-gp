// Pit crew and pit-stop choreography. The crew waits in the player's box; during a stop the car is jacked
// up, wheel guns fire, wheels come off and go on, the jacks drop and the lollipop turns green.
import * as THREE from 'three';

const lerp = (a, b, t) => a + (b - a) * t;
const phase = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));
const smooth = x => x * x * (3 - 2 * x);

function person(team, pose = 'stand') {
  const g = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({ color: team.c1, roughness: 0.85 });
  const trim = new THREE.MeshStandardMaterial({ color: team.c2, roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: '#141418', roughness: 0.9 });
  const visor = new THREE.MeshStandardMaterial({ color: '#0d1016', roughness: 0.1, metalness: 0.9 });
  const add = (geo, m, x, y, z, rx = 0, ry = 0, rz = 0, p = g) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); o.castShadow = true; p.add(o); return o; };
  const kneel = pose === 'kneel', h = kneel ? 0.62 : 1;
  // legs
  if (kneel) {
    add(new THREE.CapsuleGeometry(0.075, 0.38, 4, 8), dark, -0.11, 0.12, -0.15, Math.PI / 2);  // shin on the ground
    add(new THREE.CapsuleGeometry(0.08, 0.34, 4, 8), dark, -0.11, 0.3, 0.02, 0.3);
    add(new THREE.CapsuleGeometry(0.08, 0.42, 4, 8), dark, 0.11, 0.26, 0.12, -0.2);             // other leg forward
  } else for (const s of [-1, 1]) { add(new THREE.CapsuleGeometry(0.068, 0.72, 4, 8), dark, s * 0.1, 0.46, 0); add(new THREE.BoxGeometry(0.12, 0.07, 0.24), dark, s * 0.1, 0.04, 0.05); }
  // torso, stripe, helmet
  const ty = kneel ? 0.78 : 1.18;
  add(new THREE.CapsuleGeometry(0.155, 0.46, 4, 12), suit, 0, ty, 0).scale.set(1.15, 1, 0.8);
  add(new THREE.BoxGeometry(0.37, 0.06, 0.26), trim, 0, ty + 0.08, 0);
  add(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 8), dark, 0, ty + 0.35, 0);
  add(new THREE.SphereGeometry(0.128, 16, 12), trim, 0, ty + 0.49, 0).scale.set(1, 1.08, 1.1);
  add(new THREE.SphereGeometry(0.13, 16, 6, Math.PI / 2 - 0.9, 1.8, 1.25, 0.45), visor, 0, ty + 0.49, 0);
  // arms reaching forward (toward the car)
  const arms = [];
  for (const s of [-1, 1]) {
    const a = new THREE.Group(); a.position.set(s * 0.21, ty + 0.22, 0); g.add(a);
    add(new THREE.CapsuleGeometry(0.045, 0.24, 4, 8), suit, 0, -0.14, 0.02, 0.3, 0, 0, a);
    add(new THREE.CapsuleGeometry(0.04, 0.24, 4, 8), suit, 0, -0.22, 0.22, 1.35, 0, 0, a);
    add(new THREE.SphereGeometry(0.045, 8, 6), dark, 0, -0.24, 0.38, 0, 0, 0, a);
    arms.push(a);
  }
  g.userData = { arms, h };
  return g;
}
function wheelGun() {
  const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: '#1a1a1d', metalness: 0.6, roughness: 0.4 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 0.32), m); g.add(body);
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.2, 10), new THREE.MeshStandardMaterial({ color: '#c8c8c8', metalness: 1, roughness: 0.3 }));
  nose.rotation.x = Math.PI / 2; nose.position.z = 0.24; g.add(nose);
  const hose = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.2, 6), new THREE.MeshStandardMaterial({ color: '#d02020' }));
  hose.position.set(0, -0.5, -0.2); hose.rotation.x = 0.4; g.add(hose);
  g.userData.nose = nose; return g;
}
function tyreProp(color) {
  const g = new THREE.Group();
  const t = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.1, 10, 24), new THREE.MeshStandardMaterial({ color: '#141416', roughness: 0.9 }));
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.012, 6, 24), new THREE.MeshBasicMaterial({ color }));
  band.position.z = 0.1; g.add(t, band); g.rotation.y = Math.PI / 2; return g;
}

// Crew group positioned in car space (forward +z). Returns { group, update(t, dur, car, released) }
export function createCrew(team, compoundColor) {
  const group = new THREE.Group();
  const wheels = [[0.8, 1.8], [-0.8, 1.8], [0.8, -1.8], [-0.8, -1.8]];
  const crews = wheels.map(([x, z]) => {
    const s = Math.sign(x);
    const gunner = person(team, 'kneel'); gunner.position.set(s * 1.25, 0, z); gunner.rotation.y = -s * Math.PI / 2; group.add(gunner);
    const gun = wheelGun(); gun.position.set(s * 1.0, 0.36, z); gun.rotation.y = -s * Math.PI / 2; group.add(gun);
    const off = person(team); off.position.set(s * 1.45, 0, z + 0.75 * Math.sign(z)); off.rotation.y = -s * Math.PI / 2 + Math.sign(z) * 0.4; group.add(off);
    const on = person(team); on.position.set(s * 1.5, 0, z - 0.75 * Math.sign(z)); on.rotation.y = -s * Math.PI / 2 - Math.sign(z) * 0.4; group.add(on);
    const fresh = tyreProp(compoundColor); fresh.position.set(s * 1.45, 0.62, z - 0.75 * Math.sign(z) + 0.2 * Math.sign(z)); group.add(fresh);
    return { s, z, gunner, gun, off, on, fresh, freshBase: fresh.position.clone() };
  });
  const jackF = person(team), jackR = person(team);
  jackF.position.set(0, 0, 3.9); jackF.rotation.y = Math.PI; jackR.position.set(0, 0, -3.5); group.add(jackF, jackR);
  const jackM = new THREE.MeshStandardMaterial({ color: '#d9d9d9', metalness: 0.7, roughness: 0.35 });
  const jackBarF = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.1), jackM); jackBarF.position.set(0, 0.35, 3.35); jackBarF.rotation.x = -0.45; group.add(jackBarF);
  const jackBarR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.0), jackM); jackBarR.position.set(0, 0.35, -3.0); jackBarR.rotation.x = 0.45; group.add(jackBarR);
  // lollipop / release man at the front left, board over the nose
  const lolli = person(team); lolli.position.set(1.7, 0, 3.2); lolli.rotation.y = -2.3; group.add(lolli);
  const board = new THREE.Mesh(new THREE.CircleGeometry(0.28, 20), new THREE.MeshBasicMaterial({ color: '#e01010', side: THREE.DoubleSide }));
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.4, 6), jackM);
  pole.position.set(1.15, 1.35, 3.2); pole.rotation.z = 1.1; board.position.set(0.55, 1.62, 3.2); board.rotation.y = Math.PI / 2; group.add(pole, board);
  // side stabilisers
  for (const s of [-1, 1]) { const st = person(team); st.position.set(s * 1.3, 0, 0.1); st.rotation.y = -s * Math.PI / 2; group.add(st); }
  group.traverse(o => { if (o.isMesh) o.castShadow = true; });

  return {
    group,
    // t: seconds into the stop; dur: total stationary time. Returns car lift (m) and per-wheel outward offsets.
    update(t, dur, released) {
      const u = t / dur;
      const lift = smooth(phase(u, 0.02, 0.12)) * (1 - smooth(phase(u, 0.86, 0.95)));
      jackBarF.rotation.x = -0.45 + lift * 0.35; jackBarR.rotation.x = 0.45 - lift * 0.35;
      const off = [];
      crews.forEach(c => {
        const gunning = (u > 0.12 && u < 0.3) || (u > 0.68 && u < 0.84);
        c.gun.userData.nose.rotation.z += gunning ? 1.7 : 0;
        c.gun.position.y = 0.36 + (gunning ? Math.sin(t * 90) * 0.004 : 0);
        c.gunner.userData.arms.forEach(a => a.rotation.x = gunning ? -0.25 : 0);
        // wheel off, then fresh wheel carried in and fitted
        const outP = smooth(phase(u, 0.3, 0.46)), inP = smooth(phase(u, 0.5, 0.66));
        off.push(outP * (1 - inP) * 0.55);
        c.off.position.x = c.s * (1.45 + outP * 0.35);
        c.fresh.visible = inP < 0.98;
        c.fresh.position.x = lerp(c.freshBase.x, c.s * 0.8, inP); c.fresh.position.z = lerp(c.freshBase.z, c.z, inP); c.fresh.position.y = lerp(c.freshBase.y, 0.36, inP);
      });
      board.material.color.set(released || u > 0.97 ? '#18c048' : '#e01010');
      pole.rotation.z = released ? 0.2 : 1.1; board.position.y = released ? 2.2 : 1.62; board.position.x = released ? 1.3 : 0.55;
      return { lift: lift * 0.07, off };
    },
    reset() { crews.forEach(c => { c.fresh.visible = true; c.fresh.position.copy(c.freshBase); c.off.position.x = c.s * 1.45; }); board.material.color.set('#e01010'); pole.rotation.z = 1.1; board.position.set(0.55, 1.62, 3.2); }
  };
}
