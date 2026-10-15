"""wsnet — the one WebSocket transport for every Open Arcade game server (stdlib only).

Canonical copy: shared/wsnet.py. Each game folder gets an identical copy (tools/sync-shared.sh) because
every game deploys as its own Railway service rooted at its folder; tools/test_wsnet.py fails if a copy
drifts. Do not edit the copies.

What it gives a game server:
  * accept(handler)  — validates and answers the RFC 6455 handshake. The reply is always "HTTP/1.1 101"
                       with no "Connection: close" (an HTTP/1.0 reply is rejected by browsers, which
                       silently broke online play in three games).
  * Conn             — one socket: send(obj) / send_raw(bytes) / recv() (reassembles fragmented
                       messages, answers pings, honours close frames, caps message size), a token-bucket
                       rate limiter (allow), close(), and free attributes for the game (room, name, …).
  * frame(data)      — pre-encode a message once to send to many sockets.
  * serve(conn, on_message, on_close) — the read loop: JSON objects with a string "t" go to on_message,
                       anything else is ignored; on_close always runs.
"""

import base64
import hashlib
import json
import socket
import struct
import threading
import time
import itertools

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_ids = itertools.count(1)


def frame(data, opcode=0x1):
    """One unmasked server frame (FIN set) carrying `data` (bytes)."""
    head = bytearray([0x80 | opcode])
    n = len(data)
    if n < 126:
        head.append(n)
    elif n < 65536:
        head.append(126)
        head += struct.pack(">H", n)
    else:
        head.append(127)
        head += struct.pack(">Q", n)
    return bytes(head) + data


def encode(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()


class Conn:
    """One WebSocket. Writes are locked because several threads may send to the same socket."""

    def __init__(self, rfile, wfile, max_msg=4096, rate=10.0, burst=30.0):
        self.rfile = rfile
        self.wfile = wfile
        self.wlock = threading.Lock()
        self.max_msg = max_msg
        self.rate = rate
        self.burst = burst
        self.tokens = burst
        self.last = time.monotonic()
        self.closed = False
        self.id = next(_ids)
        self.room = None
        self.name = "Player"
        self.opened = time.monotonic()

    # ---- writing (everything goes through _write, so a subclass can redefine send_raw safely)
    def _write(self, data):
        if self.closed:
            return False
        try:
            with self.wlock:
                self.wfile.write(data)
                self.wfile.flush()
            return True
        except (OSError, ValueError):
            self.closed = True
            return False

    def send_raw(self, data):
        """Send an already-framed message (see frame())."""
        return self._write(data)

    def send(self, obj):
        return self._write(frame(encode(obj)))

    def close(self, code=1000):
        if not self.closed:
            self._write(frame(struct.pack(">H", code), 0x8))
        self.closed = True

    # ---- reading
    def _read(self, n):
        data = self.rfile.read(n)
        if data is None or len(data) < n:
            raise EOFError
        return data

    def recv(self):
        """Next complete text message as str, or None when the socket is finished."""
        parts, total = [], 0
        try:
            while True:
                b0, b1 = self._read(2)
                fin, op = b0 & 0x80, b0 & 0x0F
                if not b1 & 0x80:              # clients must mask (RFC 6455 5.1)
                    return None
                n = b1 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", self._read(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", self._read(8))[0]
                if op >= 0x8 and n > 125:          # control frames are small
                    return None
                if op < 0x8 and total + n > self.max_msg:
                    self.close(1009)               # message too big
                    return None
                mask = self._read(4)
                payload = bytearray(self._read(n)) if n else bytearray()
                for i in range(n):
                    payload[i] ^= mask[i & 3]
                if op == 0x8:                       # close: answer and stop
                    self.close(1000)
                    return None
                if op == 0x9:                       # ping -> pong
                    self._write(frame(bytes(payload), 0xA))
                    continue
                if op == 0xA:                       # pong
                    continue
                if op in (0x1, 0x2, 0x0):
                    if op != 0x0 and parts:         # a new message before the last one finished
                        return None
                    parts.append(bytes(payload))
                    total += n
                    if fin:
                        return b"".join(parts).decode("utf-8", "replace")
                    continue
                return None                         # unknown opcode
        except (OSError, EOFError, ValueError, struct.error):
            return None

    # ---- flow control
    def allow(self, cost=1.0):
        """Token bucket for everything a client sends (rate per second, burst)."""
        now = time.monotonic()
        self.tokens = min(self.burst, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if self.tokens < cost:
            return False
        self.tokens -= cost
        return True


def is_upgrade(handler, path="/ws"):
    return handler.path.split("?")[0] == path and "websocket" in handler.headers.get("Upgrade", "").lower()


def accept(handler, idle_timeout=90):
    """Answer the handshake on a BaseHTTPRequestHandler. Returns True if the socket is now a WebSocket."""
    key = handler.headers.get("Sec-WebSocket-Key", "").strip()
    version = handler.headers.get("Sec-WebSocket-Version", "").strip()
    try:
        valid = len(base64.b64decode(key, validate=True)) == 16
    except (ValueError, TypeError):
        valid = False
    if not valid or version != "13":
        handler.send_response(400)
        handler.send_header("Sec-WebSocket-Version", "13")
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return False
    accept_key = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    handler.protocol_version = "HTTP/1.1"          # never an HTTP/1.0 101
    handler.close_connection = True                 # the HTTP side is done after this socket
    handler.send_response_only(101, "Switching Protocols")
    handler.send_header("Upgrade", "websocket")
    handler.send_header("Connection", "Upgrade")
    handler.send_header("Sec-WebSocket-Accept", accept_key)
    handler._headers_buffer.append(b"\r\n")         # end the headers without the class's extra ones
    handler.wfile.write(b"".join(handler._headers_buffer))
    handler._headers_buffer = []
    handler.wfile.flush()
    try:
        handler.connection.settimeout(idle_timeout)
        handler.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except OSError:
        pass
    return True


def serve(conn, on_message, on_close):
    """Read loop: dispatch JSON objects with a string "t"; always run on_close at the end."""
    try:
        while True:
            raw = conn.recv()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if isinstance(msg, dict) and isinstance(msg.get("t"), str):
                on_message(conn, msg)
    finally:
        conn.closed = True
        on_close(conn)
