import * as THREE from 'three';
import { rng } from './util.js';

let maxAniso = 8;
export const setAniso = a => { maxAniso = a; };

function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function toTex(c, { repeat = true, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
export function canvasTex(w, h, draw, opts) { const c = makeCanvas(w, h); draw(c.getContext('2d'), w, h); return toTex(c, opts); }

// Normal map from a grayscale height canvas (Sobel)
function normalFromHeight(src, strength = 2) {
  const w = src.width, h = src.height, d = src.getContext('2d').getImageData(0, 0, w, h).data;
  const out = makeCanvas(w, h), og = out.getContext('2d'), img = og.createImageData(w, h);
  const H = (x, y) => d[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
    img.data[i] = (-dx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  og.putImageData(img, 0, 0);
  return toTex(out, { srgb: false });
}
function speckle(g, w, h, n, cols, size, r) { for (let i = 0; i < n; i++) { g.fillStyle = cols[(r() * cols.length) | 0]; const s = size * (0.5 + r()); g.fillRect(r() * w, r() * h, s, s); } }

export function buildTextures() {
  const r = rng(7);
  const T = {};

  // --- asphalt: aggregate colour + height -> normal
  const aH = makeCanvas(512, 512), ah = aH.getContext('2d');
  ah.fillStyle = '#808080'; ah.fillRect(0, 0, 512, 512);
  speckle(ah, 512, 512, 60000, ['#5a5a5a', '#9a9a9a', '#b0b0b0', '#6e6e6e'], 1.6, r);
  T.asphaltN = normalFromHeight(aH, 1.4);
  T.asphalt = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#3c3c3f'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 50000, ['#2f2f33', '#48484c', '#36363a', '#56565b', '#414145'], 1.6, r);
    // patches / repairs
    for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(20,20,22,${0.08 + r() * 0.08})`; g.fillRect(r() * w, r() * h, 40 + r() * 120, 30 + r() * 200); }
    g.fillStyle = '#e6e6e6'; g.fillRect(4, 0, 12, h); g.fillRect(w - 16, 0, 12, h);
  });
  // runoff asphalt with painted stripes (modern run-off)
  T.runoff = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#2f3440'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 9000, ['#262a34', '#3a4050', '#2a2f3a'], 1.5, r);
    g.fillStyle = '#1e57b8'; g.fillRect(0, 0, w, h * 0.5);
    speckle(g, w, h * 0.5, 4000, ['#1b4fa8', '#2461c7'], 1.5, r);
  });
  T.gravel = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#b9a88a'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 16000, ['#a39274', '#cbbb9c', '#8d7e63', '#d8cbb0'], 2.2, r);
  });
  const gH = makeCanvas(256, 256), gh = gH.getContext('2d'); gh.fillStyle = '#808080'; gh.fillRect(0, 0, 256, 256);
  speckle(gh, 256, 256, 12000, ['#404040', '#c0c0c0', '#ffffff', '#202020'], 2.4, r);
  T.gravelN = normalFromHeight(gH, 3);

  T.grass = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#4c8a2c'; g.fillRect(0, 0, w / 2, h); g.fillStyle = '#437f26'; g.fillRect(w / 2, 0, w / 2, h);
    speckle(g, w, h, 14000, ['#3c7222', '#579433', '#478430', '#62a03c', '#3a6a20'], 1.6, r);
  });
  T.grassVar = canvasTex(512, 512, (g, w, h) => {   // large-scale variation, multiplied in via lightMap-like trick
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) { const x = r() * w, y = r() * h, rad = 30 + r() * 110; const gr = g.createRadialGradient(x, y, 0, x, y, rad); const c = r() < 0.5 ? '170,180,120' : '120,150,100'; gr.addColorStop(0, `rgba(${c},.45)`); gr.addColorStop(1, `rgba(${c},0)`); g.fillStyle = gr; g.fillRect(0, 0, w, h); }
  });
  T.city = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#8d8a84'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 8000, ['#7f7c77', '#9a978f', '#86837d'], 1.6, r);
    g.strokeStyle = 'rgba(60,60,60,.35)'; g.lineWidth = 2;
    for (let i = 0; i <= w; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
  });
  T.kerb = canvasTex(64, 128, (g, w, h) => {
    g.fillStyle = '#d31d1d'; g.fillRect(0, 0, w, h / 2); g.fillStyle = '#f1f1f1'; g.fillRect(0, h / 2, w, h / 2);
    for (let y = 0; y < h; y += 8) { g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(0, y, w, 2); }
  });
  T.kerbN = canvasTex(64, 128, (g, w, h) => { // ridged kerb normal
    for (let y = 0; y < h; y++) { const s = Math.sin(y / 8 * Math.PI * 2); g.fillStyle = `rgb(128,${128 + s * 90},${220})`; g.fillRect(0, y, w, 1); }
  }, { srgb: false });
  T.ads = canvasTex(2048, 128, (g, w, h) => {
    const ads = [['APEX GP', '#e10600', '#fff'], ['TURBO COLA', '#111', '#ff2d2d'], ['NEON FUEL', '#0b1b4a', '#39ff88'], ['ORBIT TYRES', '#ffd000', '#111'],
      ['SPEEDNET', '#fff', '#0a3cff'], ['GRIDLOCK', '#1d1d1d', '#ffb000'], ['VOLTA', '#00a0e0', '#fff'], ['KAIROS WATCHES', '#0c3b2a', '#e8d9a8']];
    const pw = w / ads.length;
    ads.forEach(([t, bg, fg], i) => {
      g.fillStyle = bg; g.fillRect(i * pw, 0, pw, h);
      g.fillStyle = fg; g.font = '900 italic 58px Titillium Web, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(t, i * pw + pw / 2, h / 2 + 4, pw - 20);
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(i * pw, 0, 3, h);
    });
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, h - 6, w, 6);
  });
  T.crowd = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = '#26262c'; g.fillRect(0, 0, w, h);
    const cols = ['#e10600', '#ffffff', '#ffd000', '#ff8000', '#2f8cff', '#1ee36b', '#f5c6a5', '#8b5a3c', '#222'];
    for (let y = 4; y < h; y += 8) for (let x = 2; x < w; x += 5) { if (r() < .12) continue; g.fillStyle = cols[(r() * cols.length) | 0]; g.fillRect(x + r(), y + r() * 2, 3, 4); }
  });
  T.windows = canvasTex(128, 256, (g, w, h) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    for (let y = 10; y < h; y += 32) for (let x = 10; x < w; x += 30) {
      g.fillStyle = r() < .3 ? '#6d86a8' : '#2c3a52'; g.fillRect(x, y, 16, 20);
      g.fillStyle = 'rgba(0,0,0,.15)'; g.fillRect(x - 2, y + 20, 20, 3);
    }
  });
  T.checker = canvasTex(128, 32, (g, w, h) => {
    const s = 8; for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) { g.fillStyle = ((x + y) / s) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x, y, s, s); }
  }, { repeat: false });
  T.fence = canvasTex(64, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.strokeStyle = 'rgba(200,205,210,.9)'; g.lineWidth = 2;
    for (let i = -w; i < w * 2; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke(); g.beginPath(); g.moveTo(i + h, 0); g.lineTo(i, h); g.stroke(); }
  });
  T.carbon = canvasTex(64, 64, (g, w, h) => {
    for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) {
      const a = ((x + y) / 8) % 2;
      const gr = a ? g.createLinearGradient(x, y, x + 8, y) : g.createLinearGradient(x, y, x, y + 8);
      gr.addColorStop(0, '#0d0d0f'); gr.addColorStop(0.5, '#26262b'); gr.addColorStop(1, '#0d0d0f');
      g.fillStyle = gr; g.fillRect(x, y, 8, 8);
    }
  });
  T.carbon.repeat.set(6, 6);
  T.smoke = canvasTex(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }, { repeat: false });
  T.spark = canvasTex(32, 32, (g, w, h) => {
    const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, 'rgba(255,255,230,1)'); gr.addColorStop(0.3, 'rgba(255,190,80,.9)'); gr.addColorStop(1, 'rgba(255,90,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }, { repeat: false });
  T.skid = canvasTex(32, 64, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.2, 'rgba(0,0,0,1)'); gr.addColorStop(0.8, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }, { repeat: false });
  return T;
}

// Distance board face ("300", "200", "100")
export function boardTex(n) {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#111'; g.font = '900 60px Titillium Web, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), w / 2, h / 2 + 4);
    g.strokeStyle = '#111'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
  }, { repeat: false });
}

// Team livery wrapped around a lofted body. u: around (0 = left flank, .25 = top, .5 = right flank), v: along (0 = rear, 1 = front).
export function liveryTex(team, kind = 'body') {
  return canvasTex(1024, 1024, (g, W, H) => {
    g.fillStyle = team.c1; g.fillRect(0, 0, W, H);
    const U = u => u * W, V = v => (1 - v) * H;            // canvas y=0 is the front (flipY)
    // underside in carbon/black
    g.fillStyle = '#121214'; g.fillRect(U(0.68), 0, U(0.14), H);
    if (kind === 'body') {
      // central stripe along the top and a sweeping flank band
      g.fillStyle = team.c2; g.fillRect(U(0.235), V(1), U(0.03), H);
      g.beginPath(); g.moveTo(U(0), V(0.62)); g.lineTo(U(0.12), V(0.62)); g.lineTo(U(0.06), V(0.2)); g.lineTo(U(0), V(0.2)); g.fill();
      g.beginPath(); g.moveTo(U(0.5), V(0.62)); g.lineTo(U(0.38), V(0.62)); g.lineTo(U(0.44), V(0.2)); g.lineTo(U(0.5), V(0.2)); g.fill();
      g.fillStyle = team.c3; g.fillRect(U(0.95), V(0.9), U(0.05), V(0) - V(0.9) - H * 0.05); g.fillRect(U(0), V(0.9), U(0.02), V(0) - V(0.9) - H * 0.05);
      // nose number (reads from the front)
      g.save(); g.translate(U(0.25), V(0.86)); g.rotate(Math.PI);
      g.fillStyle = '#fff'; g.font = '900 italic 90px Titillium Web, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.strokeStyle = '#000'; g.lineWidth = 6; g.strokeText(team.num, 0, 0); g.fillText(team.num, 0, 0); g.restore();
      // engine cover sponsors on both flanks
      const side = (u, rot) => { g.save(); g.translate(U(u), V(0.36)); g.rotate(rot); g.fillStyle = team.c2 === '#ffffff' || team.c2 === '#f2f2f2' ? '#ffffff' : '#ffffff'; g.font = '900 italic 64px Titillium Web, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(team.sponsor, 0, 0, 300); g.restore(); };
      side(0.07, Math.PI / 2); side(0.43, -Math.PI / 2);
    } else {
      // sidepod: accent strip along the top edge and sponsor on the outer face
      g.fillStyle = team.c2; g.fillRect(U(0.2), 0, U(0.1), H);
      const side = (u, rot) => { g.save(); g.translate(U(u), V(0.5)); g.rotate(rot); g.fillStyle = '#fff'; g.font = '900 italic 110px Titillium Web, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(team.sponsor, 0, 0, 800); g.restore(); };
      side(0.02, Math.PI / 2); side(0.48, -Math.PI / 2);
    }
  }, { repeat: false });
}
