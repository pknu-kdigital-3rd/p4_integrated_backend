# ngrok setup for the Docker deployment

Run ngrok on the Docker host where the project's published ports are reachable:

- `39001`: operator dashboard.
- `39002`: Vision inference and live preview.

The current Docker Nginx configuration uses HTTPS on both ports. ngrok can
connect to those endpoints using their existing self-signed certificates.
Visitors receive ngrok's publicly trusted HTTPS certificate.

## 1. Save the ngrok auth token

With the ngrok CLI installed, replace `YOUR_AUTH_TOKEN` with your token:

```bash
ngrok config add-authtoken YOUR_AUTH_TOKEN
ngrok config check
```

The token is saved in ngrok's configuration. See the
[ngrok CLI documentation](https://ngrok.com/docs/gateway/agent/cli).

## 2. Test the dashboard tunnel

```bash
ngrok http https://localhost:39001 --upstream-tls-verify=false
```

Keep the terminal open. ngrok displays a public HTTPS URL. Append `/operator/`
to that URL to open the dashboard.

`--upstream-tls-verify=false` allows the agent to connect to the local
self-signed HTTPS endpoint. Browser-facing HTTPS still uses ngrok's trusted
certificate.

This tunnel exposes the dashboard. The embedded preview also requires its
own reachable URL with the current Docker routing.

## 3. Start dashboard and preview tunnels

The current Docker configuration requires two different public URLs. Use
domains available in your ngrok account; the names below are placeholders.

In the first terminal:

```bash
ngrok http https://localhost:39001 \
  --url https://YOUR-OPERATOR-DOMAIN \
  --upstream-tls-verify=false
```

In the second terminal:

```bash
ngrok http https://localhost:39002 \
  --url https://YOUR-VISION-DOMAIN \
  --upstream-tls-verify=false
```

Keep both processes running. Video playback uses WebSocket through the Vision
tunnel; server dataset playback does not require TURN ports.

## 4. Configure the project's public URLs

Add these assignments to `env.local`, replacing both domain placeholders:

```bash
export PUBLIC_OPERATOR_URL=https://YOUR-OPERATOR-DOMAIN
export VISION_PUBLIC_BASE_URL=https://YOUR-VISION-DOMAIN
export LIVE_VIEW_URL=https://YOUR-VISION-DOMAIN/
export LIVE_VIEW_PARENT_ORIGINS=https://YOUR-OPERATOR-DOMAIN
```

If you also need direct LAN access, allow both dashboard origins:

```bash
export LIVE_VIEW_PARENT_ORIGINS=https://YOUR-OPERATOR-DOMAIN,https://10.174.96.119:39001
```

The preview URL must be reachable by the outside browser. The parent origin
must match the dashboard's public origin so synchronized telemetry can reach
the dashboard and map.

## 5. Apply the environment settings

From the project root:

```bash
source env.local
docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate p4-node p4-vision
```

These are environment-only changes, so no image rebuild is needed. Recreate
the containers to apply them; a container restart does not update its
environment.

Verify the effective configuration inside the running containers:

```bash
docker exec p4-node printenv PUBLIC_OPERATOR_URL VISION_PUBLIC_BASE_URL LIVE_VIEW_URL
docker exec p4-vision printenv LIVE_VIEW_PARENT_ORIGINS
```

Expected values should contain your actual ngrok domains. These checks confirm
the container environment; open the pages to verify browser playback too.

## 6. Open the pages

```text
Dashboard: https://YOUR-OPERATOR-DOMAIN/operator/
Preview:   https://YOUR-VISION-DOMAIN/
```

Saved MinIO recording playback uses port `39003` and needs a separate reachable
recording endpoint if you want that feature. It is unnecessary for the local
server video/GPS/IMU dataset view.

## Free-plan limitation

The ngrok free plan currently provides one development domain. It cannot
provide the two independent public domains used by this procedure. Starting
two tunnels on the same public URL does not separate dashboard and preview
traffic.

To serve both Docker pages with one domain, add path routing to the Docker
ingress and configure the preview and its WebSocket accordingly. The native
launcher's single-domain gateway is separate from the Docker Nginx setup;
`NATIVE_TLS=false` does not change Docker Nginx.

See [ngrok free-plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits)
for current domain, transfer and browser-interstitial restrictions.
