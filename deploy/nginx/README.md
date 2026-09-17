# HTTPS ingress

This configuration makes Nginx the LAN-facing HTTP/TLS ingress. It uses `10.174.96.95`, with operator HTTPS on port `39001`, Vision/WSS/Android signaling HTTPS on port `39002`, MinIO signed playback on port `39003`, and the MinIO Console on port `39004` when recording is enabled. It intentionally does not bind port 80, so the project-local Nginx can run as the current user without `sudo`. Change `server_name` and certificate SANs together if the public address changes. Nginx must be installed separately on the host; this repository intentionally does not vendor a web-server binary.

Internal listeners:

- Node: `127.0.0.1:3000`
- Vision: `127.0.0.1:39011`, started with `--no-tls`
- Routing/tracking: `127.0.0.1:8000`
- Go relay: `127.0.0.1:39012`
- MinIO API and Console: `127.0.0.1:9000` and `127.0.0.1:9001` (recording profile)

Place the trusted certificate and private key at `secrets/tls/server.crt` and `secrets/tls/server.key`. When Nginx is started with this directory as its prefix, validate and start with:

```powershell
nginx -p "$PWD/deploy/nginx/" -t -c nginx.conf
nginx -p "$PWD/deploy/nginx/" -c nginx.conf
```

The certificate must contain `IP:10.174.96.95` in its Subject Alternative Name and its issuing CA must be trusted by operator browsers and Android. Do not use `curl -k` as an acceptance test.

The external routes are:

- `https://10.174.96.95:39001/operator/` — dashboard
- `https://10.174.96.95:39001/osm/{z}/{x}/{y}.png` — same-origin OSM tile proxy
- `https://10.174.96.95:39002/` — existing Live View page
- `wss://10.174.96.95:39002/ws/playback` — playback WebSocket
- `https://10.174.96.95:39002/offer/android` — Android SDP signaling
- `https://10.174.96.95:39004/` — MinIO Console (recording profile)

After verification, allow only the required ingress ports: `39001`, `39002`, and, when recording is enabled, `39003` and `39004`, plus required TURN/WebRTC ports. Keep raw MinIO ports `9000` and `9001` loopback-only. Enable HSTS only after certificate renewal and rollback have been tested.
