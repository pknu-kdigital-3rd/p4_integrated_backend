# HTTPS ingress

This configuration makes Nginx the only LAN-facing HTTP/TLS process. It uses `10.174.96.95`, with operator HTTPS on port `39001` and Vision/WSS/Android signaling HTTPS on port `39002`. Port 80 redirects to the operator URL. Change `server_name` and certificate SANs together if the public address changes. Nginx must be installed separately on the host; this repository intentionally does not vendor a web-server binary.

Internal listeners:

- Node: `127.0.0.1:3000`
- Vision: `127.0.0.1:39011`, started with `--no-tls`
- Routing/tracking: `127.0.0.1:8000`
- Go relay: `127.0.0.1:39012`

Place the trusted certificate and private key at `secrets/tls/server.crt` and `secrets/tls/server.key`. When Nginx is started with this directory as its prefix, validate and start with:

```powershell
nginx -p "$PWD/deploy/nginx/" -t -c nginx.conf
nginx -p "$PWD/deploy/nginx/" -c nginx.conf
```

The certificate must contain `IP:10.174.96.95` in its Subject Alternative Name and its issuing CA must be trusted by operator browsers and Android. Do not use `curl -k` as an acceptance test.

The external routes are:

- `https://10.174.96.95:39001/operator/` — dashboard
- `https://10.174.96.95:39002/` — existing Live View page
- `wss://10.174.96.95:39002/ws/playback` — playback WebSocket
- `https://10.174.96.95:39002/offer/android` — Android SDP signaling

After verification, restrict firewall access to ports 80, 39001, and 39002 plus required TURN/WebRTC ports. Raw application ports should not be reachable from the LAN. Enable HSTS only after certificate renewal and rollback have been tested.
