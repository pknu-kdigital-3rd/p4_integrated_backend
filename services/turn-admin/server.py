"""Private, optional coturn administration. No demo data or automatic releases."""
import base64
import hmac
import json
import os
import re
import socket
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SESSION = re.compile(r"^\s*\d+\) id=(\d+), user <(.*)>:\s*$", re.M)


def parse_sessions(output):
    matches = list(SESSION.finditer(output))
    sessions = []
    for index, match in enumerate(matches):
        block = output[match.end():matches[index + 1].start() if index + 1 < len(matches) else len(output)]
        def field(pattern):
            found = re.search(pattern, block)
            return found.group(1).strip() if found else None
        sessions.append({
            "id": match.group(1), "username": match.group(2),
            "client": field(r"client addr ([^\n,]+)"),
            "server": field(r"server addr ([^\n]+)"),
            "relays": re.findall(r"relay addr ([^\r\n]+)", block),
            "clientProtocol": field(r"client protocol (\w+)"),
            "relayProtocol": field(r"relay protocol (\w+)"),
            "ageSeconds": field(r"started (\d+) secs ago"),
            "expiresSeconds": field(r"expiring in (\d+) secs"),
            "usage": field(r"usage: ([^\r\n]+)"),
            "rate": field(r"rate: ([^\r\n]+)"),
        })
    # Never present truncated/unparseable output as an empty allocation pool.
    total = re.search(r"Total sessions(?:[^:\r\n]*): (\d+)", output)
    if total is None or int(total.group(1)) != len(sessions):
        raise RuntimeError("Coturn session listing was incomplete")
    return sessions


class Coturn:
    def __init__(self, host, port, password):
        self.host, self.port, self.password = host, port, password
        if "\n" in password or "\r" in password:
            raise ValueError("CLI password must be a single line")

    def command(self, command):
        if command != "ps" and not re.fullmatch(r"cs \d{1,20}", command):
            raise ValueError("Unsupported coturn command")
        with socket.create_connection((self.host, self.port), timeout=3) as sock:
            # coturn speaks telnet; consume negotiation bytes separately from text.
            text = bytearray()
            state = 0
            option_command = None
            def until(marker):
                nonlocal state, option_command
                deadline = time.monotonic() + 3
                text.clear()
                while marker not in text:
                    sock.settimeout(max(.01, deadline - time.monotonic()))
                    chunk = sock.recv(4096)
                    if not chunk:
                        raise RuntimeError("Coturn management connection closed")
                    for byte in chunk:
                        if state == 0:
                            if byte == 255: state = 1
                            else: text.append(byte)
                        elif state == 1:
                            if byte in (251, 252, 253, 254):
                                option_command, state = byte, 2
                            elif byte == 250: state = 3
                            elif byte == 255: text.append(byte); state = 0
                            else: state = 0
                        elif state == 2:
                            if option_command == 251: sock.sendall(bytes((255, 254, byte)))
                            if option_command == 253: sock.sendall(bytes((255, 252, byte)))
                            state = 0
                        elif state == 3:
                            if byte == 255: state = 4
                        elif state == 4:
                            state = 0 if byte == 240 else 3
                    if len(text) > 1_000_000 or time.monotonic() > deadline:
                        raise RuntimeError("Coturn management response exceeded limits")
                return text.decode("utf-8", errors="replace")
            until(b"Enter password:")
            sock.sendall(self.password.encode() + b"\r\n")
            until(b"> ")
            sock.sendall(command.encode() + b"\r\n")
            result = until(b"> ")
            sock.sendall(b"quit\r\n")
            return result

    def sessions(self):
        return parse_sessions(self.command("ps"))

    def release(self, session_id):
        if not re.fullmatch(r"\d{1,20}", session_id):
            raise ValueError("Invalid session ID")
        if not any(session["id"] == session_id for session in self.sessions()):
            raise LookupError("Allocation has already ended; refresh the list")
        self.command("cs " + session_id)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if not any(session["id"] == session_id for session in self.sessions()):
                return
            time.sleep(.05)
        raise RuntimeError("Release requested, but coturn has not confirmed removal; refresh before retrying")


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        if not self.server.enabled:
            self.reply(404, {"error": "Administration is disabled"})
            return False
        expected = "Basic " + base64.b64encode(("admin:" + self.server.password).encode()).decode()
        if not hmac.compare_digest(self.headers.get("Authorization", ""), expected):
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="Private TURN administration"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        return True

    def do_GET(self):
        if not self.authorized(): return
        if self.path == "/api/status":
            result = {"sessions": [], "relay": None, "errors": []}
            try: result["sessions"] = self.server.coturn.sessions()
            except (OSError, RuntimeError) as error: result["errors"].append(str(error))
            try:
                with urllib.request.urlopen(self.server.relay_url, timeout=2) as response:
                    result["relay"] = json.load(response)
            except (OSError, ValueError): result["errors"].append("Relay status is unavailable")
            self.reply(200, result)
        elif self.path in ("/", "/app.js", "/style.css"):
            filename = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css"}[self.path]
            data = (Path(__file__).parent / filename).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", {"/": "text/html; charset=utf-8", "/app.js": "text/javascript; charset=utf-8", "/style.css": "text/css; charset=utf-8"}[self.path])
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)
        else: self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if not self.authorized(): return
        # Cross-origin forms cannot send this header; no CORS access is granted.
        if self.headers.get("X-Turn-Control") != "release":
            self.reply(403, {"error": "Control header required"}); return
        if self.path != "/api/release":
            self.reply(404, {"error": "Not found"}); return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024: raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(size))
            session_id = payload.get("sessionId") if isinstance(payload, dict) else None
            if not isinstance(session_id, str): raise ValueError("Session ID required")
            self.server.coturn.release(session_id)
            self.reply(200, {"released": True, "sessionId": session_id})
        except (ValueError, TypeError) as error: self.reply(400, {"error": str(error)})
        except LookupError as error: self.reply(409, {"error": str(error)})
        except (OSError, RuntimeError) as error: self.reply(502, {"error": str(error)})


def create_server(host="127.0.0.1", port=39013):
    server = ThreadingHTTPServer((host, port), Handler)
    server.enabled = os.environ.get("TURN_ADMIN_ENABLED", "false").lower() == "true"
    server.password = os.environ.get("TURN_ADMIN_PASSWORD", "")
    if server.enabled and len(server.password) < 24:
        server.server_close()
        raise ValueError("TURN_ADMIN_PASSWORD requires at least 24 characters")
    server.coturn = Coturn("127.0.0.1", int(os.environ.get("TURN_CLI_PORT", "5766")), server.password)
    server.relay_url = "http://127.0.0.1:39012/internal/status"
    return server


if __name__ == "__main__":
    create_server().serve_forever()
