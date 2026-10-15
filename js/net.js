// Multiplayer over the APEX GP relay (server.py, /ws). Every player keeps one WebSocket to the server,
// which passes messages between the host and the others: no peer-to-peer connections, so strict NATs,
// mobile networks and firewalls that allow normal web traffic all work. The race itself is still run
// by the host's browser (star topology: the host relays everyone's state), exactly as before.
//
// The page on GitHub Pages has no server of its own, so it uses the relay on Railway; anywhere else
// the relay is this page's own host. `?relay=wss://…` overrides it (testing).
export const MAX_PLAYERS = 8;
const RAILWAY = 'wss://apex-gp-production.up.railway.app/ws';
function relayUrl() {
  const q = new URLSearchParams(location.search).get('relay');
  if (q && /^wss?:\/\//.test(q)) return q;
  if (location.protocol === 'file:' || /\.github\.io$/.test(location.hostname)) return RAILWAY;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export const NET = { role: null, code: null, myId: null, peer: null, conns: new Map(), host: null, roster: [], ready: new Set(), states: {}, on: {} };
const emit = (ev, ...a) => { try { NET.on[ev]?.(...a); } catch (e) { console.error(e); } };
export const cleanCode = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

const ERRORS = { 'no room': 'No room found with that code.', full: 'That room is full.', busy: 'The multiplayer server is busy — try again shortly.' };
let ws = null, pingT = 0;

// open a socket, send `first`, and resolve with the server's answer (hosted / joined)
function connect(first, want) {
  return new Promise((res, rej) => {
    let sock;
    try { sock = new WebSocket(relayUrl()); } catch { rej(new Error('Could not reach the multiplayer server.')); return; }
    let settled = false;
    const fail = msg => { if (!settled) { settled = true; clearTimeout(t); try { sock.close(); } catch {} rej(new Error(msg)); } };
    const t = setTimeout(() => fail('Timed out contacting the multiplayer server.'), 12000);
    sock.onopen = () => sock.send(JSON.stringify(first));
    sock.onerror = () => fail('Could not reach the multiplayer server. Check your internet connection.');
    sock.onclose = () => { if (!settled) fail('Could not reach the multiplayer server. Check your internet connection.'); else if (ws === sock) dropped(); };
    sock.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!settled) {
        if (m.t === want) { settled = true; clearTimeout(t); ws = sock; startPing(); res(m); }
        else if (m.t === 'error') { if (m.msg === 'full') emit('full'); fail(ERRORS[m.msg] || 'Connection problem.'); }
        return;
      }
      if (ws === sock) onMessage(m);
    };
  });
}
function startPing() {
  clearInterval(pingT);
  pingT = setInterval(() => raw({ t: 'ping', id: Date.now() }), 20000);
}
function raw(o) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch {} } }

function dropped() {
  const role = NET.role;
  if (!role) return;
  if (role === 'client') emit('hostLeft');
  else emit('error', new Error('Lost the connection to the multiplayer server.'));
  leave();
}

function upsert(entry) {
  const i = NET.roster.findIndex(p => p.id === entry.id);
  if (i >= 0) NET.roster[i] = { ...NET.roster[i], ...entry }; else NET.roster.push(entry);
}

function onMessage(m) {
  if (NET.role === 'host') {
    if (m.t === 'from') fromPlayer(m.id, m.d);
    else if (m.t === 'gone') playerGone(m.id);
  } else if (NET.role === 'client') {
    if (m.t === 'msg') {
      const d = m.d;
      if (!d || typeof d !== 'object' || !d.t) return;
      if (d.t === 'lobby') { NET.roster = d.roster || []; NET.settings = d.settings; }
      emit(d.t, d);
    } else if (m.t === 'hostgone') { emit('hostLeft'); leave(); }
  }
}

// ---------------- host ----------------
export async function createRoom(me) {
  leave(true);
  const r = await connect({ t: 'host' }, 'hosted');
  Object.assign(NET, { peer: true, role: 'host', code: r.code, myId: r.id, roster: [{ id: r.id, host: true, ...me }], conns: new Map(), ready: new Set(), states: {} });
  emit('lobby');
  return r.code;
}
function fromPlayer(id, d) {
  if (!d || typeof d !== 'object') return;
  if (d.t === 'hello') {
    NET.conns.set(id, true);
    upsert({ id, name: String(d.name || 'Driver').slice(0, 14), team: d.team | 0 });
    broadcastLobby(); emit('lobby');
  } else if (d.t === 'st') { NET.states[id] = d.s; emit('state', id, d.s); }
  else if (d.t === 'ready') { NET.ready.add(id); emit('ready', id); }
}
function playerGone(id) {
  if (!NET.conns.has(id) && !NET.roster.some(p => p.id === id)) return;
  NET.conns.delete(id); delete NET.states[id];
  NET.roster = NET.roster.filter(p => p.id !== id);
  broadcast({ t: 'left', id }); broadcastLobby();
  emit('left', { id }); emit('lobby');
}
export function broadcast(msg) { if (NET.role === 'host') raw({ t: 'down', d: msg }); }
export function broadcastLobby() { broadcast({ t: 'lobby', roster: NET.roster, settings: NET.settings }); }

// ---------------- client ----------------
export async function joinRoom(code, me) {
  code = cleanCode(code);
  if (code.length !== 5) throw new Error('Room codes are 5 characters.');
  leave(true);
  const r = await connect({ t: 'join', code }, 'joined');
  Object.assign(NET, { peer: true, role: 'client', code: r.code, myId: r.id, host: r.host, roster: [], states: {} });
  raw({ t: 'up', d: { t: 'hello', ...me } });
  emit('lobby');
  return r.code;
}
export function sendToHost(msg) { if (NET.role === 'client') raw({ t: 'up', d: msg }); }

// ---------------- shared ----------------
export function updateMe(me) {
  if (NET.role === 'host') { upsert({ id: NET.myId, ...me }); broadcastLobby(); emit('lobby'); }
  else if (NET.role === 'client') sendToHost({ t: 'hello', ...me });
}
export function leave(quiet) {
  clearInterval(pingT);
  const sock = ws; ws = null;
  if (sock) { try { sock.close(); } catch {} }
  Object.assign(NET, { role: null, code: null, myId: null, peer: null, host: null, conns: new Map(), roster: [], ready: new Set(), states: {}, settings: null });
  if (!quiet) emit('lobby');
}
