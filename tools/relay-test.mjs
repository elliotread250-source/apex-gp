// node tools/relay-test.mjs [http://localhost:9420] — the multiplayer relay with raw WebSocket clients.
const base = (process.argv[2] || 'http://localhost:9420').replace(/\/$/, '');
const url = base.replace(/^http/, 'ws') + '/ws';
let pass = 0; const fails = [];
const ok = (c, m) => { if (c) pass++; else fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(headers) {
  const ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
  const c = { ws, inbox: [], closed: false };
  ws.onmessage = e => c.inbox.push(JSON.parse(e.data));
  ws.onclose = () => { c.closed = true; };
  c.open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  c.send = o => ws.send(JSON.stringify(o));
  c.wait = async (t, pred = () => true, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const i = c.inbox.findIndex(m => m.t === t && pred(m)); if (i >= 0) return c.inbox.splice(i, 1)[0]; await sleep(10); }
    throw new Error('no ' + t);
  };
  c.none = async (t, ms = 300) => { await sleep(ms); return !c.inbox.some(m => m.t === t); };
  return c;
}
try {
  const h = client(); await h.open;
  h.send({ t: 'host' });
  const hosted = await h.wait('hosted');
  ok(/^[A-Z2-9]{5}$/.test(hosted.code) && /^p[0-9a-f]{8}$/.test(hosted.id), 'host gets a 5-character code and an id');
  const a = client(), b = client(); await Promise.all([a.open, b.open]);
  a.send({ t: 'join', code: hosted.code.toLowerCase() });
  b.send({ t: 'join', code: hosted.code });
  const ja = await a.wait('joined'), jb = await b.wait('joined');
  ok(ja.host === hosted.id && ja.id !== jb.id, 'players join (case-insensitive) with their own ids');
  a.send({ t: 'up', d: { t: 'hello', name: 'A', id: 'FAKE' } });
  const f = await h.wait('from');
  ok(f.id === ja.id && f.d.name === 'A', 'player messages reach the host stamped with the real sender');
  ok(await b.none('from') && await b.none('msg'), "players don't hear each other directly");
  h.send({ t: 'down', d: { t: 'snap', p: { x: 1 } } });
  const [ma, mb] = await Promise.all([a.wait('msg'), b.wait('msg')]);
  ok(ma.d.t === 'snap' && mb.d.p.x === 1, 'host broadcasts reach every player');
  h.send({ t: 'down', to: jb.id, d: { t: 'only-b' } });
  ok((await b.wait('msg')).d.t === 'only-b' && await a.none('msg'), 'host can message one player');
  a.send({ t: 'down', d: { t: 'evil' } });
  ok(await b.none('msg'), 'a player cannot broadcast');
  const x = client(); await x.open;
  x.send({ t: 'join', code: 'ZZZZZ' });
  ok((await x.wait('error')).msg === 'no room', 'unknown code refused');
  // fill the room: host + 7 players
  const more = []; for (let i = 0; i < 5; i++) { const c = client(); await c.open; c.send({ t: 'join', code: hosted.code }); await c.wait('joined'); more.push(c); }
  x.send({ t: 'join', code: hosted.code });
  ok((await x.wait('error')).msg === 'full', 'the ninth person is refused (8 per room)');
  more[0].ws.close();
  const g = await h.wait('gone');
  ok(g.id && g.id !== ja.id, 'host hears when a player drops');
  h.ws.close();
  await a.wait('hostgone'); await sleep(200);
  ok(a.closed && b.closed, 'players are told and disconnected when the host leaves');
  const y = client(); await y.open; y.send({ t: 'join', code: hosted.code });
  ok((await y.wait('error')).msg === 'no room', 'the room is gone with its host');
  // ping, oversize, wrong origin
  y.send({ t: 'ping', id: 7 }); ok((await y.wait('pong')).id === 7, 'ping answered');
  y.send({ t: 'host' }); const h2 = await y.wait('hosted');
  y.ws.send(JSON.stringify({ t: 'down', d: 'x'.repeat(60 * 1024) })); await sleep(300);
  ok(y.closed, 'oversized messages close the socket');
  void h2;
  let refused = false;
  try { const bad = client({ Origin: 'https://evil.example' }); await bad.open; } catch { refused = true; }
  ok(refused, 'pages from other sites cannot open the relay');
  const gh = client({ Origin: 'https://elliotread250-source.github.io' }); await gh.open; gh.send({ t: 'host' });
  ok(!!(await gh.wait('hosted')), 'the GitHub Pages copy may use the relay');
  gh.ws.close(); for (const c of [x, ...more]) c.ws.close();
} catch (e) { fails.push(String(e.message || e)); }
for (const f of fails) console.log('FAIL', f);
console.log(`${pass} passed, ${fails.length} failed (${base})`);
process.exit(fails.length ? 1 : 0);
