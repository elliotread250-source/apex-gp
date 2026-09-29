// Peer-to-peer multiplayer over WebRTC (PeerJS). No game server: PeerJS's free public broker only
// introduces the browsers, then data flows directly between players. Star topology: the host relays.
const LIB = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const PREFIX = 'apexgp-v1-';
const OPTS = { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } };
export const MAX_PLAYERS = 8;

export const NET = { role: null, code: null, myId: null, peer: null, conns: new Map(), host: null, roster: [], ready: new Set(), states: {}, on: {} };
const emit = (ev, ...a) => { try { NET.on[ev]?.(...a); } catch (e) { console.error(e); } };

let libP = null;
function lib() {
  if (window.Peer) return Promise.resolve();
  return libP ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = LIB; s.onload = res;
    s.onerror = () => { libP = null; rej(new Error('Could not load the multiplayer library (check your connection).')); };
    document.head.appendChild(s);
  });
}
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const makeCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
export const cleanCode = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

function openPeer(id) {
  return new Promise((res, rej) => {
    const p = id ? new window.Peer(id, OPTS) : new window.Peer(OPTS);
    const t = setTimeout(() => { rej(new Error('Timed out contacting the multiplayer service.')); try { p.destroy(); } catch {} }, 12000);
    p.on('open', () => { clearTimeout(t); res(p); });
    p.on('error', e => { clearTimeout(t); rej(e); });
  });
}
function upsert(entry) {
  const i = NET.roster.findIndex(p => p.id === entry.id);
  if (i >= 0) NET.roster[i] = { ...NET.roster[i], ...entry }; else NET.roster.push(entry);
}

// ---------------- host ----------------
export async function createRoom(me) {
  await lib();
  for (let tries = 0; tries < 5; tries++) {
    const code = makeCode();
    let peer;
    try { peer = await openPeer(PREFIX + code); } catch (e) { if (e.type === 'unavailable-id') continue; throw e; }
    Object.assign(NET, { peer, role: 'host', code, myId: peer.id, roster: [{ id: peer.id, host: true, ...me }], conns: new Map(), ready: new Set(), states: {} });
    peer.on('connection', hostAccept);
    peer.on('disconnected', () => { try { peer.reconnect(); } catch {} });
    peer.on('error', e => emit('error', e));
    emit('lobby');
    return code;
  }
  throw new Error('Could not create a room, please try again.');
}
function hostAccept(conn) {
  conn.on('open', () => NET.conns.set(conn.peer, conn));
  conn.on('data', d => {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'hello') {
      if (NET.roster.length >= MAX_PLAYERS && !NET.roster.some(p => p.id === conn.peer)) { conn.send({ t: 'full' }); setTimeout(() => conn.close(), 400); return; }
      upsert({ id: conn.peer, name: String(d.name || 'Driver').slice(0, 14), team: d.team | 0 });
      broadcastLobby(); emit('lobby');
    } else if (d.t === 'st') { NET.states[conn.peer] = d.s; emit('state', conn.peer, d.s); }
    else if (d.t === 'ready') { NET.ready.add(conn.peer); emit('ready', conn.peer); }
  });
  const gone = () => {
    if (!NET.conns.has(conn.peer) && !NET.roster.some(p => p.id === conn.peer)) return;
    NET.conns.delete(conn.peer); delete NET.states[conn.peer];
    NET.roster = NET.roster.filter(p => p.id !== conn.peer);
    broadcast({ t: 'left', id: conn.peer }); broadcastLobby();
    emit('left', { id: conn.peer }); emit('lobby');
  };
  conn.on('close', gone); conn.on('error', gone);
}
export function broadcast(msg) { for (const c of NET.conns.values()) if (c.open) { try { c.send(msg); } catch {} } }
export function broadcastLobby() { broadcast({ t: 'lobby', roster: NET.roster, settings: NET.settings }); }

// ---------------- client ----------------
export async function joinRoom(code, me) {
  code = cleanCode(code);
  if (code.length !== 5) throw new Error('Room codes are 5 characters.');
  await lib();
  const peer = await openPeer();
  Object.assign(NET, { peer, role: 'client', code, myId: peer.id, roster: [], states: {} });
  const conn = peer.connect(PREFIX + code, { reliable: true });
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("Couldn't connect to that room. Check the code — or one of your networks may block direct connections.")), 15000);
      conn.on('open', () => { clearTimeout(t); res(); });
      conn.on('error', e => { clearTimeout(t); rej(e); });
      peer.on('error', e => { clearTimeout(t); rej(e.type === 'peer-unavailable' ? new Error(`No room found with code ${code}.`) : e); });
    });
  } catch (e) { leave(true); throw e; }
  NET.host = conn;
  conn.send({ t: 'hello', ...me });
  conn.on('data', d => { if (d && d.t) { if (d.t === 'lobby') { NET.roster = d.roster || []; NET.settings = d.settings; } emit(d.t, d); } });
  conn.on('close', () => { if (NET.role === 'client') { emit('hostLeft'); leave(); } });
  peer.on('error', e => emit('error', e));
  emit('lobby');
  return code;
}
export function sendToHost(msg) { if (NET.host?.open) { try { NET.host.send(msg); } catch {} } }

// ---------------- shared ----------------
export function updateMe(me) {
  if (NET.role === 'host') { upsert({ id: NET.myId, ...me }); broadcastLobby(); emit('lobby'); }
  else if (NET.role === 'client') sendToHost({ t: 'hello', ...me });
}
export function leave(quiet) {
  try { NET.peer?.destroy(); } catch {}
  Object.assign(NET, { role: null, code: null, myId: null, peer: null, host: null, conns: new Map(), roster: [], ready: new Set(), states: {}, settings: null });
  if (!quiet) emit('lobby');
}
