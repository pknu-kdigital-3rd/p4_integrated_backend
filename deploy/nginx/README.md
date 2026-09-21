# HTTPS ingress

Docker Compose runs Nginx as the only HTTP/TLS gateway. It publishes operator
HTTPS on `39001`, Vision/WebRTC signaling on `39002`, and MinIO signed replay
traffic on `39003`. MinIO Console is not
published.

Internal upstreams use Compose DNS:

- Node: `p4-node:3000`
- Vision: `p4-vision:39011`
- Go relay: `p4-relay:39012`
- MinIO S3 API: `p4-minio:9000`

The Nginx container mounts:

- `deploy/nginx/nginx.conf` at `/etc/nginx/nginx.conf`;
- `./data/tls` at `/etc/nginx/tls`;
- `./data/nginx_logs` at `/var/log/nginx`.

The Nginx entrypoint creates a self-signed certificate with
`TLS_PUBLIC_ADDRESS` in its Subject Alternative Name when either TLS file is
missing. Once `data/tls/server.crt` and `data/tls/server.key` exist, container
recreation reuses them, even if `TLS_PUBLIC_ADDRESS` changes. Set the address
before the first startup so the generated certificate matches the clients that
will connect. For a trusted deployment, replace both files in the host `tls`
directory with certificates from the site's CA. For development, copy
`data/tls/server.crt` to each client and import it into that client's trust
store; the certificate is not served by an HTTP route. Never copy or distribute
`data/tls/server.key`. Do not use `curl -k` as an acceptance test.

## Public routes

- `https://<PUBLIC_ADDRESS>:39001/operator/` — operator dashboard
- `https://<PUBLIC_ADDRESS>:39001/osm/{z}/{x}/{y}.png` — same-origin OSM tiles
- `https://<PUBLIC_ADDRESS>:39002/` — Vision live view
- `wss://<PUBLIC_ADDRESS>:39002/ws/playback` — playback WebSocket
- `https://<PUBLIC_ADDRESS>:39002/offer/android` — Android SDP signaling
- `https://<PUBLIC_ADDRESS>:39003/<bucket>/<object>` — signed MinIO replay object

The `39003` listener is published by both the production and development
Compose files because recording is always enabled.
