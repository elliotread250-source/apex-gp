import { clamp, store } from './util.js';
import { ASSETS, sampleEngine } from './assets.js';

function engineVoice(ctx, out, vol = 1) {
  // V6 turbo: firing order harmonics through a waveshaper and two formant filters
  const shaper = ctx.createWaveShaper(), curve = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) { const x = i / 1024 - 1; curve[i] = Math.tanh(x * 2.6) * 0.9; }
  shaper.curve = curve;
  const pre = ctx.createGain(); pre.gain.value = 0.6; pre.connect(shaper);
  const oscs = [['sawtooth', 1, 0.55], ['square', 0.5, 0.35], ['sawtooth', 1.5, 0.22], ['sawtooth', 2, 0.18], ['triangle', 3, 0.1], ['sine', 0.25, 0.3]].map(([type, mul, v]) => {
    const o = ctx.createOscillator(); o.type = type; const g = ctx.createGain(); g.gain.value = v;
    o.connect(g); g.connect(pre); o.start(); return { o, mul };
  });
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
  const f1 = ctx.createBiquadFilter(); f1.type = 'peaking'; f1.frequency.value = 1400; f1.Q.value = 2; f1.gain.value = 7;
  const f2 = ctx.createBiquadFilter(); f2.type = 'peaking'; f2.frequency.value = 3200; f2.Q.value = 3; f2.gain.value = 4;
  const gain = ctx.createGain(); gain.gain.value = 0;
  shaper.connect(lp); lp.connect(f1); f1.connect(f2); f2.connect(gain); gain.connect(out);
  return {
    gain, lp, vol,
    set(rpm, thr, t, cut = 1, doppler = 1) {
      const f = rpm / 60 * 3 * 0.5 * doppler;   // half firing frequency as the fundamental
      for (const { o, mul } of oscs) o.frequency.setTargetAtTime(f * mul, t, 0.015);
      lp.frequency.setTargetAtTime(900 + thr * 4200 + rpm * 0.15, t, 0.04);
    }
  };
}

export const audio = {
  ctx: null, muted: store.get('apex.muted') || false,
  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const ctx = this.ctx = new C();
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.5;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.eng = engineVoice(ctx, this.master);
    if (ASSETS.engine) sampleEngine(ctx, this.master, ASSETS.engine).then(e => { this.sampleEng = e; }).catch(e => console.warn('engine samples failed', e));
    // turbo whistle
    this.turbo = ctx.createOscillator(); this.turbo.type = 'sine'; this.turboG = ctx.createGain(); this.turboG.gain.value = 0;
    this.turbo.connect(this.turboG); this.turboG.connect(this.master); this.turbo.start();
    // noise sources
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const mk = (type, f, q) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; s.connect(fl); fl.connect(g); g.connect(this.master); s.start(); return { g, fl }; };
    this.wind = mk('bandpass', 600, 0.4);
    this.squeal = mk('bandpass', 2300, 9);
    this.rumble = mk('lowpass', 110, 1);
    this.gravel = mk('bandpass', 400, 1.2);
    this.intake = mk('bandpass', 900, 1.5);
    // two positional voices for nearby rivals (with doppler)
    this.aiVoices = [0, 1].map(() => {
      const pan = ctx.createPanner(); pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 6; pan.rolloffFactor = 1.4; pan.maxDistance = 400;
      pan.connect(this.master);
      const v = engineVoice(ctx, pan, 0.6); return { pan, v };
    });
  },
  setMuted(m) { this.muted = m; store.set('apex.muted', m); if (this.master) this.master.gain.value = m ? 0 : 0.5; },
  silence() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    if (this.sampleEng) this.sampleEng.set(8000, 0, t, 0);
    [this.eng.gain, this.turboG, this.wind.g, this.squeal.g, this.rumble.g, this.gravel.g, this.intake.g, ...this.aiVoices.map(a => a.v.gain)].forEach(g => g.gain.setTargetAtTime(0, t, 0.05));
  },
  update(s) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.eng.set(s.rpm, s.thr, t);
    const engVol = (0.13 + s.thr * 0.2) * (s.cut ? 0.2 : 1);
    if (this.sampleEng) { this.sampleEng.set(s.rpm, s.thr, t, engVol * 2.2); this.eng.gain.gain.setTargetAtTime(0, t, 0.05); }
    else this.eng.gain.gain.setTargetAtTime(engVol, t, 0.02);
    this.turbo.frequency.setTargetAtTime(2800 + s.rpm * 0.45, t, 0.1);
    this.turboG.gain.setTargetAtTime(s.thr * clamp((s.rpm - 7000) / 5000, 0, 1) * 0.018, t, 0.15);
    this.intake.g.gain.setTargetAtTime(s.thr * 0.06, t, 0.05); this.intake.fl.frequency.setTargetAtTime(500 + s.rpm * 0.12, t, 0.05);
    this.wind.g.gain.setTargetAtTime(Math.min(0.45, (s.speed / 330) ** 1.5 * 0.5), t, 0.1);
    this.squeal.g.gain.setTargetAtTime(clamp(s.slip, 0, 1) * 0.22, t, 0.04);
    this.rumble.g.gain.setTargetAtTime(s.kerb ? 0.9 : 0, t, 0.03);
    this.gravel.g.gain.setTargetAtTime(s.gravel ? Math.min(0.7, s.speed / 150) : 0, t, 0.05);
    // listener
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.setTargetAtTime(s.lx, t, 0.02); L.positionY.setTargetAtTime(1, t, 0.02); L.positionZ.setTargetAtTime(s.lz, t, 0.02);
      L.forwardX.setTargetAtTime(Math.sin(s.lh), t, 0.02); L.forwardY.value = 0; L.forwardZ.setTargetAtTime(Math.cos(s.lh), t, 0.02);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    }
    // rival voices
    this.aiVoices.forEach((av, i) => {
      const a = s.ai[i];
      if (!a) { av.v.gain.gain.setTargetAtTime(0, t, 0.1); return; }
      if (av.pan.positionX) { av.pan.positionX.setTargetAtTime(a.x, t, 0.02); av.pan.positionY.setTargetAtTime(0.8, t, 0.02); av.pan.positionZ.setTargetAtTime(a.z, t, 0.02); }
      av.v.set(a.rpm, 1, t, 1, a.doppler);
      av.v.gain.gain.setTargetAtTime(0.35, t, 0.1);
    });
  },
  crackle(power) { // lift-off pops
    if (!this.ctx) return;
    const ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.playbackRate.value = 0.6 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700 + Math.random() * 900; f.Q.value = 1.5;
    const g = ctx.createGain(), t = ctx.currentTime; g.gain.setValueAtTime(0.25 * power, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(f); f.connect(g); g.connect(this.master); src.start(t, Math.random()); src.stop(t + 0.07);
  },
  shift() {
    if (!this.ctx) return;
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = 'square'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.05);
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.07);
  },
  thud(power) {
    if (!this.ctx || power < 0.05) return;
    const ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 450;
    const g = ctx.createGain(), t = ctx.currentTime; g.gain.setValueAtTime(Math.min(1.4, power), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    src.connect(f); f.connect(g); g.connect(this.master); src.start(); src.stop(t + 0.45);
  },
  beep(freq = 660, dur = 0.18) {
    if (!this.ctx) return;
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime; o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.13, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(); o.stop(t + dur + 0.02);
  }
};
