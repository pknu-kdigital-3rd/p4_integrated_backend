# HTTPS ingress

Docker Compose runs Nginx as the only HTTP/TLS gateway. It publishes operator
HTTPS on `39001`, Vision/WebRTC signaling on `39002`, and MinIO signed replay
traffic on `39003` when the recording override is enabled. MinIO Console is not
published.

Internal upstreams use Compose DNS:

- Node: `node:3000`
- Vision: `vision:39011`
- Go relay: `relay:39012`
- MinIO S3 API: `minio:9000`

The Nginx container mounts:

- `deploy/nginx/nginx.conf` at `/etc/nginx/nginx.conf`;
- `./data/tls` at `/etc/nginx/tls`;
- `./data/nginx_logs` at `/var/log/nginx`.

The Nginx entrypoint creates a self-signed certificate with
`TLS_PUBLIC_ADDRESS` in its Subject Alternative Name on first startup. Set
that Compose variable before creating the stack. For a trusted deployment,
replace the certificate and key in the host `tls` directory with certificates
from the site's CA. Do not use `curl -k` as an acceptance test.

## Public routes

- `https://<PUBLIC_ADDRESS>:39001/operator/` — operator dashboard
- `https://<PUBLIC_ADDRESS>:39001/osm/{z}/{x}/{y}.png` — same-origin OSM tiles
- `https://<PUBLIC_ADDRESS>:39002/` — Vision live view
- `wss://<PUBLIC_ADDRESS>:39002/ws/playback` — playback WebSocket
- `https://<PUBLIC_ADDRESS>:39002/offer/android` — Android SDP signaling
- `https://<PUBLIC_ADDRESS>:39003/<bucket>/<object>` — signed MinIO replay object

The `39003` listener is configured in the base Nginx container so it can be
validated internally, but the host mapping is added only by
`docker-compose.recording.yml` when recording is enabled.
