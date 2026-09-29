// On-screen controls for phones/tablets: drag-to-steer pad (or tilt), pedals, and action buttons.
// Shown when the "Controls" setting is Mobile. Pointer events, so it also works with a mouse for testing.
import { clamp, store } from './util.js';
const capture = (el, id) => { try { el.setPointerCapture(id); } catch {} };

export const IS_TOUCH = (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) && navigator.maxTouchPoints > 0;
export const IS_PHONE = IS_TOUCH && Math.min(screen.width, screen.height) < 900;

export const touch = { active: false, thr: false, brk: false, steer: null, drs: false, ers: false, tilt: store.get('apex.tilt') || false };

export function initTouch(pressed, flash) {
  const $ = s => document.querySelector(s);
  // pedals & hold buttons (multi-touch via pointer events)
  const hold = (el, key) => {
    const on = e => { e.preventDefault(); touch[key] = true; el.classList.add('down'); capture(el, e.pointerId); try { navigator.vibrate?.(8); } catch {} };
    const off = e => { e.preventDefault(); touch[key] = false; el.classList.remove('down'); };
    el.addEventListener('pointerdown', on); el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('lostpointercapture', off);
  };
  hold($('#thrBtn'), 'thr'); hold($('#brkBtn'), 'brk'); hold($('#drsBtn'), 'drs'); hold($('#ersBtn'), 'ers');
  // tap buttons mapped to keyboard actions
  document.querySelectorAll('#touch [data-k]').forEach(b => b.addEventListener('pointerdown', e => { e.preventDefault(); pressed.add(b.dataset.k); }));

  // steering pad: put your thumb anywhere in the zone, then drag left/right from that point
  const pad = $('#steerPad'), base = $('#steerBase'), knob = $('#steerKnob');
  let pid = null, x0 = 0;
  const RANGE = () => Math.min(110, innerWidth * 0.12);
  pad.addEventListener('pointerdown', e => {
    if (touch.tilt || pid !== null) return;
    e.preventDefault(); pid = e.pointerId; x0 = e.clientX; capture(pad, e.pointerId);
    const r = pad.getBoundingClientRect();
    base.style.left = (e.clientX - r.left) + 'px'; base.style.top = (e.clientY - r.top) + 'px'; base.classList.add('on');
    knob.style.transform = 'translate(-50%,-50%)'; touch.steer = 0;
  });
  pad.addEventListener('pointermove', e => {
    if (e.pointerId !== pid) return;
    const dx = clamp(e.clientX - x0, -RANGE(), RANGE());
    knob.style.transform = `translate(calc(-50% + ${dx}px),-50%)`;
    const v = dx / RANGE(); touch.steer = -Math.sign(v) * Math.abs(v) ** 1.25; // left = positive
  });
  const end = e => { if (e.pointerId !== pid) return; pid = null; base.classList.remove('on'); if (!touch.tilt) touch.steer = null; };
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end); pad.addEventListener('lostpointercapture', end);

  // tilt steering: hold the phone like a wheel
  let tiltZero = null;
  addEventListener('deviceorientation', e => {
    if (!touch.tilt || e.beta == null) return;
    const ang = screen.orientation?.angle ?? window.orientation ?? 0;
    const roll = ang === 90 ? e.beta : (ang === -90 || ang === 270) ? -e.beta : e.gamma;
    if (tiltZero === null) tiltZero = roll;
    touch.steer = clamp(-(roll - tiltZero) / 28, -1, 1);
  });
  const tiltBtn = $('#tiltBtn');
  const setTilt = (on, quiet) => {
    touch.tilt = on; store.set('apex.tilt', on); tiltZero = null;
    tiltBtn.classList.toggle('on', on); document.body.classList.toggle('tilt', on);
    touch.steer = on ? 0 : null;
    if (!quiet && flash) flash('', on ? 'Tilt steering on (hold level to centre)' : 'Touch steering', 1.8);
  };
  tiltBtn.addEventListener('pointerdown', async e => {
    e.preventDefault();
    if (!touch.tilt && typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return; } catch { return; }
    }
    setTilt(!touch.tilt);
  });
  if (touch.tilt) setTilt(true, true);

  // no pinch-zoom or long-press menus while driving
  document.addEventListener('gesturestart', e => e.preventDefault());
  addEventListener('contextmenu', e => { if (touch.active) e.preventDefault(); });
}

export function setTouchActive(on) {
  touch.active = on;
  document.body.classList.toggle('touchplay', on);
  document.querySelector('#touch')?.classList.toggle('hidden', !on);
  if (!on) { touch.thr = touch.brk = touch.drs = touch.ers = false; if (!touch.tilt) touch.steer = null; }
}

// Full screen + landscape where the browser allows it (Android Chrome; iOS ignores this)
export function goFullscreenLandscape() {
  const el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req || document.fullscreenElement) return;
  try { Promise.resolve(req.call(el, { navigationUI: 'hide' })).then(() => screen.orientation?.lock?.('landscape')).catch(() => {}); } catch {}
}
