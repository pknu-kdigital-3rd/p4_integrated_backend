"""Exercise the checked-in Nginx config with Docker and mock Node/Vision.

Run: python scripts/tests/test_nginx_ingress.py
Requires Docker, nginx:1.27-alpine and cryptography (for a temporary TLS cert).
"""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT).strip()


class Mock(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.server.seen.append((self.path, dict(self.headers)))
        if self.headers.get("Upgrade", "").lower() == "websocket":
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.end_headers()
            # Echo the raw binary stream to check Nginx's upgrade tunnel.
            payload = self.rfile.read(7)
            self.wfile.write(payload)
            self.wfile.flush()
            self.close_connection = True
            return
        body = (self.server.label + ":" + self.path).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class IngressTest(unittest.TestCase):
    def test_single_domain_https_and_websocket(self):
        servers = []
        container = "p4-nginx-test-" + uuid.uuid4().hex[:10]
        runtime = ROOT / ".runtime"
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="nginx-test-", dir=runtime) as directory:
            directory = Path(directory)
            try:
                for label in ("node", "vision"):
                    server = ThreadingHTTPServer(("0.0.0.0", 0), Mock)
                    server.label, server.seen = label, []
                    threading.Thread(target=server.serve_forever, daemon=True).start()
                    servers.append(server)
                node, vision = servers
                spec = importlib.util.spec_from_file_location("native_keys", ROOT / "scripts/native-keys.py")
                keys = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(keys)
                keys.ensure_keys({"JWT_PRIVATE_KEY_PATH": str(directory / "jwt.key"),
                                  "JWT_PUBLIC_KEY_PATH": str(directory / "jwt.pub"),
                                  "NATIVE_TLS_CERT": str(directory / "server.crt"),
                                  "NATIVE_TLS_KEY": str(directory / "server.key"),
                                  "PUBLIC_OPERATOR_URL": "https://localhost"})
                config = (ROOT / "deploy/nginx/nginx.conf").read_text()
                for service, port, mock in (("node", 3000, node), ("vision", 39011, vision),
                                            ("relay", 39012, node), ("minio", 9000, node)):
                    config = config.replace(f"p4-{service}:{port}", f"host.docker.internal:{mock.server_port}")
                (directory / "nginx.conf").write_text(config)
                docker("run", "-d", "--name", container, "--add-host", "host.docker.internal:host-gateway",
                       "-p", "127.0.0.1::39001", "-v", f"{directory.as_posix()}:/etc/nginx/tls:ro",
                       "-v", f"{(directory / 'nginx.conf').as_posix()}:/etc/nginx/nginx.conf:ro",
                       "nginx:1.27-alpine")
                docker("exec", container, "nginx", "-t")
                effective = docker("exec", container, "nginx", "-T")
                self.assertIn("location ^~ /live/", effective)
                port = int(docker("port", container, "39001/tcp").rsplit(":", 1)[1])
                context = ssl.create_default_context(cafile=str(directory / "server.crt"))

                def request(path):
                    connection = http.client.HTTPSConnection("localhost", port, context=context, timeout=5)
                    try:
                        connection.request("GET", path)
                        response = connection.getresponse()
                        return response.status, dict(response.headers), response.read().decode()
                    finally:
                        connection.close()

                for path, expected in (("/operator/", "node:/operator/"),
                                       ("/live/?embedded=1&autostart=1", "vision:/?embedded=1&autostart=1"),
                                       ("/live/live-view-tracks.js", "vision:/live-view-tracks.js"),
                                       ("/live/live-view-distance-colors.js", "vision:/live-view-distance-colors.js"),
                                       ("/live/health/live", "vision:/health/live")):
                    status, _, body = request(path)
                    self.assertEqual((status, body), (200, expected))
                status, headers, _ = request("/live?embedded=1")
                self.assertEqual(status, 308)
                self.assertEqual(headers["Location"], "/live/?embedded=1")
                self.assertEqual(vision.seen[0][1]["X-Forwarded-Proto"], "https")

                for path, upstream in (("/ws/playback?epoch=2", vision), ("/api/v1/assistant/ws", node)):
                    with socket.create_connection(("localhost", port), timeout=5) as raw:
                        with context.wrap_socket(raw, server_hostname="localhost") as stream:
                            stream.sendall((f"GET {path} HTTP/1.1\r\nHost: public.example\r\n"
                                            "Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n").encode())
                            header = bytearray()
                            while not header.endswith(b"\r\n\r\n"):
                                part = stream.recv(1)
                                self.assertTrue(part, "Upgrade connection closed early")
                                header.extend(part)
                            self.assertIn(b"101 Switching Protocols", header)
                            payload = bytes([0, 255, 128, 13, 10, 0, 42])
                            stream.sendall(payload)
                            echoed = bytearray()
                            while len(echoed) < len(payload):
                                part = stream.recv(len(payload) - len(echoed))
                                self.assertTrue(part, "Binary tunnel closed early")
                                echoed.extend(part)
                            self.assertEqual(echoed, payload)
                    self.assertEqual(upstream.seen[-1][0], path)
                # Nginx writes an upgrade's access log when the tunnel closes.
                for _ in range(20):
                    logs = docker("exec", container, "cat", "/var/log/nginx/its-access.log")
                    if '"GET /ws/playback?epoch=2 HTTP/1.1" 101' in logs:
                        break
                    time.sleep(0.1)
                self.assertIn('"GET /ws/playback?epoch=2 HTTP/1.1" 101', logs)
                self.assertIn(f":{vision.server_port}", logs)
            finally:
                subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                for server in servers:
                    server.shutdown()
                    server.server_close()


if __name__ == "__main__":
    unittest.main()
