"""APEX GP: the static game plus a small multiplayer relay at /ws.

Multiplayer used to go browser-to-browser over WebRTC through PeerJS's public broker with STUN only,
so players behind strict NATs or mobile networks often couldn't connect at all. Now every player
keeps one WebSocket to this server and the server passes messages along. The race logic is unchanged
and still runs in the host's browser (it owns the AI cars and the start); the relay only:
  * gives rooms 5-character codes and up to 8 players, and stamps who sent what (no spoofed ids);
  * lets the host talk to everyone and players talk to the host, nothing else;
  * caps message size and rate, tells the host when a player drops and players when the host does;
  * closes rooms when the host leaves.

  client -> server   host {}                         -> hosted {code, id}
                     join {code}                     -> joined {code, id, host}  | error {msg}
                     up {d}            (player)      -> host gets  from {id, d}
                     down {d, to?}     (host)        -> players get msg {d}
                     ping {id}                       -> pong {id}
  server -> client   gone {id} (to the host) · hostgone (to players)

Stdlib only; the WebSocket transport is wsnet.py (a copy of the Open Arcade shared module).
Run: python server.py  (PORT, default 8080)
"""
import os
import random
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import wsnet

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_PLAYERS = 8
MAX_ROOMS = 200
MAX_CONNS = 900
IDLE_TIMEOUT = 60
CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
# pages allowed to open the relay: this service, the GitHub Pages copy, local development
ALLOWED_ORIGINS = {"https://elliotread250-source.github.io"}

rooms = {}
lock = threading.Lock()
conn_count = 0


class Conn(wsnet.Conn):
    def __init__(self, rfile, wfile):
        # the host sends ~20 snapshots a second of up to 17 cars; players ~20 states a second
        super().__init__(rfile, wfile, max_msg=48 * 1024, rate=60.0, burst=120.0)
        self.pid = "p" + os.urandom(4).hex()
        self.role = None


class Room:
    def __init__(self, code, host):
        self.code = code
        self.host = host
        self.players = {}           # pid -> Conn
        self.created = time.monotonic()


def origin_ok(handler):
    origin = handler.headers.get("Origin")
    if not origin:
        return True                 # not a browser (tests, tools)
    o = urlsplit(origin)
    host = (handler.headers.get("Host") or "").lower()
    if o.netloc.lower() == host:
        return True
    if o.hostname in ("localhost", "127.0.0.1", "[::1]", "::1"):
        return True
    return f"{o.scheme}://{o.netloc}".lower() in ALLOWED_ORIGINS


def new_code():
    for _ in range(100):
        code = "".join(random.choice(CODE_CHARS) for _ in range(5))
        if code not in rooms:
            return code
    raise RuntimeError("no free codes")


def on_message(conn, msg):
    t = msg.get("t")
    if not conn.allow(0.5 if t in ("up", "down") else 1):
        return
    if t == "ping":
        conn.send({"t": "pong", "id": msg.get("id")})
        return
    reply, targets, out = None, (), None
    with lock:                      # decide under the lock, send after it (a slow socket must not stall others)
        room = conn.room
        if t == "host" and room is None:
            if len(rooms) >= MAX_ROOMS:
                reply = {"t": "error", "msg": "busy"}
            else:
                room = Room(new_code(), conn)
                rooms[room.code] = room
                conn.room, conn.role = room, "host"
                reply = {"t": "hosted", "code": room.code, "id": conn.pid}
        elif t == "join" and room is None:
            code = "".join(ch for ch in str(msg.get("code") or "").upper() if ch in CODE_CHARS)[:5]
            room = rooms.get(code)
            if room is None:
                reply = {"t": "error", "msg": "no room"}
            elif len(room.players) + 1 >= MAX_PLAYERS:
                reply = {"t": "error", "msg": "full"}
            else:
                room.players[conn.pid] = conn
                conn.room, conn.role = room, "player"
                reply = {"t": "joined", "code": room.code, "id": conn.pid, "host": room.host.pid}
        elif t == "up" and room is not None and conn.role == "player":
            targets, out = (room.host,), {"t": "from", "id": conn.pid, "d": msg.get("d")}
        elif t == "down" and room is not None and conn.role == "host":
            to = msg.get("to")
            targets = tuple(c for c in ([room.players.get(str(to))] if to else room.players.values()) if c)
            out = {"t": "msg", "d": msg.get("d")}
    if reply:
        conn.send(reply)
    if targets:
        data = wsnet.frame(wsnet.encode(out))
        for c in targets:
            c.send_raw(data)


def on_close(conn):
    notify = []
    with lock:
        room = conn.room
        conn.room = None
        if room is None:
            return
        if conn.role == "host":
            rooms.pop(room.code, None)
            for p in list(room.players.values()):
                p.room = None
                notify.append((p, {"t": "hostgone"}, True))
        else:
            room.players.pop(conn.pid, None)
            notify.append((room.host, {"t": "gone", "id": conn.pid}, False))
    for c, m, close in notify:
        c.send(m)
        if close:
            c.close()


def serve_socket(handler):
    global conn_count
    if not origin_ok(handler):
        handler.send_error(403)
        return
    if not wsnet.accept(handler, IDLE_TIMEOUT):
        return
    conn = Conn(handler.rfile, handler.wfile)
    with lock:
        conn_count += 1
        full = conn_count > MAX_CONNS
    try:
        if full:
            conn.send({"t": "error", "msg": "busy"})
            return
        conn.send({"t": "hello"})
        wsnet.serve(conn, on_message, on_close)
    finally:
        with lock:
            conn_count -= 1


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript",
                      ".glb": "model/gltf-binary", ".webp": "image/webp", ".json": "application/json", ".wasm": "application/wasm"}

    def end_headers(self):
        path = self.path.split("?")[0]
        # the car models are big and never change under the same name; everything else is re-checked
        self.send_header("Cache-Control", "public, max-age=86400" if path.startswith("/assets/") else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if wsnet.is_upgrade(self):
            return serve_socket(self)
        if path == "/healthz":
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.endswith(".py") or path.startswith("/.git") or path in ("/ws", "/Dockerfile", "/railway.json") or path.startswith("/tools/"):
            self.send_error(404)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        if self.path.split("?")[0] not in ("/healthz", "/ws"):
            super().log_message(fmt, *args)


def main():
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), partial(Handler, directory=ROOT))
    server.daemon_threads = True
    print(f"apex-gp on :{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
