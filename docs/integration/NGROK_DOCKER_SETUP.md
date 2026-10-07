# ngrok setup for the Docker deployment

The Docker ingress serves the dashboard and Vision preview through one domain:

- `/operator/`: operator dashboard and Node APIs.
- `/live/`: Vision inference page and preview scripts.
- `/ws/playback`: Vision video and synchronized telemetry WebSocket.

Run ngrok on the Docker host where HTTPS port `39001` is reachable. The existing
self-signed local certificate is supported; visitors receive ngrok's trusted
HTTPS certificate. Port `39002` remains available for direct LAN preview access.

## 1. Save the ngrok auth token

With the ngrok CLI installed, replace `YOUR_AUTH_TOKEN` with your token:

```bash
ngrok config add-authtoken YOUR_AUTH_TOKEN
ngrok config check
```

The token is saved in ngrok's configuration. See the
[ngrok CLI documentation](https://ngrok.com/docs/gateway/agent/cli).

## 2. Configure the project's public URLs

Add these assignments at the end of `env.local`. This example uses the assigned
domain `henchman-prescribe-supermom.ngrok-free.dev`; substitute your account's
domain if different, from [ngrok Domains](https://dashboard.ngrok.com/domains).

```bash
export PUBLIC_OPERATOR_URL=https://henchman-prescribe-supermom.ngrok-free.dev
export VISION_PUBLIC_BASE_URL=https://henchman-prescribe-supermom.ngrok-free.dev/live
export LIVE_VIEW_URL=https://henchman-prescribe-supermom.ngrok-free.dev/live/
export LIVE_VIEW_PARENT_ORIGINS=https://henchman-prescribe-supermom.ngrok-free.dev
```

Keep the trailing `/` on `LIVE_VIEW_URL` so the preview's relative scripts load
under `/live/`. The parent origin has no path. For optional LAN dashboard access:

```bash
export LIVE_VIEW_PARENT_ORIGINS=https://henchman-prescribe-supermom.ngrok-free.dev,https://10.174.96.119:39001
```

## 3. Apply the updated routing and environment

Use a checkout containing the single-domain change to `deploy/nginx/nginx.conf`.
From the project root:

```bash
source env.local
docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate p4-node p4-vision p4-nginx
```

No image rebuild is required for this change. Node and Vision need new containers
to receive the environment settings. Nginx's configuration is an individual file
bind mount: after Git replaces that host file, recreate Nginx so it mounts the
new file. `docker compose restart` or a process reload can retain the old inode.

Verify the effective configuration:

```bash
docker exec p4-node printenv PUBLIC_OPERATOR_URL VISION_PUBLIC_BASE_URL LIVE_VIEW_URL
docker exec p4-vision printenv LIVE_VIEW_PARENT_ORIGINS
docker exec p4-nginx nginx -t
docker exec p4-nginx nginx -T 2>&1 | grep -A 16 -E 'location (= /live|\^~ /live/|= /ws/playback)'
```

Check the local preview route without opening a playback session:

```bash
curl -k --fail https://localhost:39001/live/health/live
curl -k --fail https://localhost:39001/live/live-view-tracks.js -o /dev/null
```

The health response should be `{"status":"ok"}`. After opening the preview,
inspect actual upstream routing in the access log:

```bash
docker exec p4-nginx sh -c 'tail -n 50 /var/log/nginx/its-access.log'
```

`/live/` requests should use Vision's internal port `39011`; dashboard requests
should use Node's internal port `3000`. A closed `/ws/playback` connection should
log status `101` and upstream port `39011`.

## 4. Start one tunnel

Stop any earlier tunnel using this domain, then run:

```bash
ngrok http https://localhost:39001 \
  --url https://henchman-prescribe-supermom.ngrok-free.dev \
  --upstream-tls-verify=false
```

Keep the terminal open. `--upstream-tls-verify=false` permits the local
self-signed certificate; browser-facing HTTPS uses ngrok's trusted certificate.
WebSocket traffic uses this same tunnel. No second domain or TURN ports are
needed for the server video/GPS/IMU dataset view.

## 5. Open the pages

```text
Dashboard: https://henchman-prescribe-supermom.ngrok-free.dev/operator/
Preview:   https://henchman-prescribe-supermom.ngrok-free.dev/live/
```

The dashboard's live preview iframe uses `/live/` on the same domain. If ngrok
shows its free-plan browser interstitial, visit the public page and continue,
then reload the dashboard. Confirm playback, seeking and map telemetry in the
browser; configuration checks alone do not verify video delivery.

Saved MinIO recording playback still uses port `39003` and its configured
recording endpoint. This single-domain setup covers the server dataset preview,
not public access to saved MinIO recordings.

## Free-plan and TLS notes

The free plan provides one assigned development domain, which this setup uses.
See [ngrok free-plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits)
for transfer limits and browser-interstitial restrictions.

`NATIVE_TLS=false` applies to the native launcher only. Docker Nginx continues
to use its local TLS certificate on port `39001`.
