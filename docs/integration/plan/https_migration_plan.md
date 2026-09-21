# HTTPS Migration Rationale and Implementation Plan

## Status

- Document type: architecture decision and implementation plan
- Scope: browser-facing pages and externally reachable service endpoints
- Current LAN address used during development: `10.174.96.119`
- Primary affected ports: Node/dashboard `39005`, Vision `39001`, media relay `39002`, routing/tracking `8000`

## Executive summary

The platform must move its browser-facing pages from HTTP to HTTPS because the operator dashboard embeds the Vision Live View inside an iframe, and Live View decodes H.264 through the browser WebCodecs API. WebCodecs is restricted to secure contexts. An HTTPS iframe inside an HTTP dashboard is not a secure context because every ancestor in the frame hierarchy must also be secure.

This explains the current behavior:

- Opening `https://10.174.96.119:39001/` directly works after the browser trusts the certificate.
- Opening the same page inside the modal iframe of `http://10.174.96.119:39005/operator/` fails with `WebCodecs requires HTTPS (secure context)`.
- Changing only `LIVE_VIEW_URL` from HTTP to HTTPS cannot fix the iframe case. The containing dashboard must also be HTTPS.

The recommended target is HTTPS for every browser-facing endpoint, terminated at a reverse proxy. Application processes may continue to use HTTP on loopback or an isolated private network where there is an explicit trust boundary. This avoids adding separate TLS implementations to Node, FastAPI, Uvicorn, and Go while providing one consistent certificate and redirect policy.

## Why HTTPS is required

### 1. WebCodecs requires a secure context

The Vision page uses `VideoDecoder` and `EncodedVideoChunk` to decode H.264. These WebCodecs interfaces are available only in secure contexts in supporting browsers.

HTTPS is therefore a functional requirement for remote browser playback, not only a security improvement. Loopback development URLs such as `http://localhost` and `http://127.0.0.1` may be treated as trustworthy by browsers, but a LAN address such as `http://10.174.96.119` is not equivalent to loopback.

References:

- [MDN: VideoDecoder](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder)
- [MDN: Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)
- [W3C: Secure Contexts](https://www.w3.org/TR/secure-contexts/)

### 2. The modal iframe inherits the dashboard's security boundary

The operator dashboard currently loads Live View into `#live-view-frame`. Even when the frame source is HTTPS, the frame cannot be a secure context while its parent dashboard is loaded over HTTP.

The required browser hierarchy is:

```text
HTTPS operator dashboard
└── HTTPS Vision Live View iframe
    ├── WebCodecs H.264 VideoDecoder
    └── WSS playback connection
```

The following hierarchy is invalid for WebCodecs:

```text
HTTP operator dashboard
└── HTTPS Vision Live View iframe
    └── window.isSecureContext == false
```

### 3. HTTP exposes authentication material

The operator dashboard sends login credentials and bearer JWTs to the Node API. Under HTTP, another party able to observe or modify the network path can read credentials and tokens, replay requests, inject JavaScript, or replace API responses.

HTTPS protects confidentiality and integrity between the browser and the platform. This is especially important for an operator interface that reads vehicle telemetry and may later perform administrative or control actions.

### 4. HTTPS prevents mixed-content and protocol inconsistencies

Moving the top-level dashboard to HTTPS ensures that:

- relative API calls such as `/api/v1/tracking/vehicles` automatically use HTTPS;
- the Vision iframe can use HTTPS without an insecure ancestor;
- the Vision page automatically selects `wss://` for `/ws/playback`;
- active HTTP resources are not blocked as mixed content;
- users do not have to understand which individual page must be opened manually to establish certificate trust.

### 5. WebRTC signaling and operational data also benefit

The Android publisher currently sends its SDP offer to the Go relay over HTTP. WebRTC media is separately protected by WebRTC transport security, but HTTP signaling still exposes SDP, ICE information, service responses, and endpoint behavior to alteration or observation.

HTTPS for the relay signaling endpoint is recommended for the final deployment. It is not the direct cause of the browser WebCodecs failure, so it can be migrated after the dashboard and Vision path.

## Current state

| Component | Current public behavior | Current implementation | Main issue |
| --- | --- | --- | --- |
| Node control API and dashboard | HTTP, currently port `39005` in development | Express uses `app.listen(...)` | HTTP top-level page prevents secure iframe context; credentials and JWTs travel over HTTP |
| Operator Live View modal | Cross-origin iframe | `operator-web/app.js` assigns `bootstrap.liveViewUrl` to `#live-view-frame` | Cannot use WebCodecs while the dashboard ancestor is HTTP |
| Vision service | Supports HTTPS on port `39001` | `services/vision/run.py --tls` configures Uvicorn certificates | Browser trust and consistent public URL must be managed centrally |
| Vision playback WebSocket | Chooses `ws://` or `wss://` from page protocol | `services/vision/index.html` | Must be `wss://` for the HTTPS browser page |
| Routing/tracking | HTTP on port `8000` | Uvicorn HTTP | Acceptable internally; public route-explorer access should be HTTPS |
| Go media relay | HTTP signaling on port `39002` | Go uses `ListenAndServe()` | Android signaling is cleartext; Python callback protocol must match its endpoint |
| Android publisher | Default relay URL uses HTTP | Cleartext traffic is enabled in the manifest | Must move to an HTTPS relay URL before cleartext is disabled |

## Target architecture

### Recommended boundary

Use a reverse proxy such as Nginx or Caddy as the only browser/LAN-facing TLS endpoint. Bind application services to loopback or an isolated service network.

```text
Browser / Android
        │ HTTPS / WSS
        ▼
TLS reverse proxy
├── Operator/API  ──► Node HTTP on loopback
├── Vision/WSS    ──► FastAPI HTTP on loopback
├── Routing       ──► Uvicorn HTTP on loopback
└── Relay offer   ──► Go HTTP on loopback

Node ──HTTP on trusted internal boundary──► Routing/tracking
Go   ──HTTP on loopback───────────────────► Python control endpoint
Go   ──Unix domain socket─────────────────► Python H.264 feed
```

This still qualifies as HTTPS for the complete user-facing service. TLS is terminated once at the controlled ingress boundary, while internal protocols remain simpler and are not exposed publicly.

### Certificate strategy

For the LAN deployment, use one of the following:

1. Preferred: an internal DNS name and a certificate issued by an organizational/private CA trusted by every browser and Android device.
2. Development only: a private development CA, with its root certificate explicitly installed on each client device.
3. Temporary diagnosis only: individually accepted self-signed leaf certificates.

The certificate must contain the exact hostname or IP used by clients in its Subject Alternative Name. Trusting `localhost` or `127.0.0.1` does not automatically trust `10.174.96.119`.

## Migration plan

### Phase 1: Freeze public URL and certificate decisions

- Choose the public names. Prefer stable DNS names over a raw LAN IP.
- Decide whether public endpoints will use standard port `443` with hostnames or retain separate ports.
- Issue certificates containing all required DNS names/IP addresses.
- Install the issuing CA certificate on operator browsers and Android test devices.
- Record certificate renewal, deployment, ownership, and expiry-monitoring procedures.

Deliverable: every client trusts the certificate without a browser bypass warning.

### Phase 2: Add an HTTPS ingress for Node and the dashboard

- Keep Node bound to an internal port, for example `127.0.0.1:39005`.
- Configure the reverse proxy to expose the operator dashboard and API over HTTPS.
- Redirect the public HTTP dashboard URL to HTTPS.
- Preserve forwarded protocol and client headers (`X-Forwarded-Proto`, `X-Forwarded-For`, and `Host`).
- If secure cookies are introduced, configure Express proxy trust before enabling them.
- Update OpenAPI server URLs and operational documentation.

Acceptance criteria:

- The dashboard loads from an `https://` URL.
- `window.isSecureContext` is `true` in the dashboard.
- Login and authenticated API requests use HTTPS.
- `/api/v1/tracking/vehicles` is requested through HTTPS.

### Phase 3: Put Vision and playback WebSocket behind trusted HTTPS

- Choose one TLS owner:
  - preferred: run Vision internally with `--no-tls` and terminate TLS at the reverse proxy; or
  - alternative: keep `run.py --tls` and proxy to it with upstream certificate validation configured.
- Proxy normal HTTP requests and WebSocket upgrades for `/ws/playback`.
- Set the browser-visible Vision URL to HTTPS.
- Ensure the proxy timeouts support long-lived WebSocket sessions.
- Keep the Live View iframe modal; no new tab is required.

Node configuration must expose an HTTPS browser URL:

```env
VISION_PUBLIC_BASE_URL="https://10.174.96.119:39001"
LIVE_VIEW_URL="https://10.174.96.119:39001/"
```

If a DNS name or standard port is selected, replace these temporary IP URLs with the final public URLs.

Acceptance criteria:

- Direct Vision access reports `window.isSecureContext === true`.
- The modal iframe reports `window.isSecureContext === true`.
- `VideoDecoder` and `EncodedVideoChunk` are available in the supported browser.
- The playback connection uses `wss://`.
- No mixed-content errors appear in browser developer tools.

### Phase 4: Secure public routing/tracking access

- Keep `ROUTING_TRACKING_BASE_URL=http://127.0.0.1:8000` when Node and routing run on the same host or trusted service network.
- Expose the interactive route-explorer page through the HTTPS reverse proxy only if users need direct browser access.
- Stop exposing the raw Uvicorn port to the LAN after proxy verification.
- Preserve the current Node-to-routing timeout and error behavior.

This phase distinguishes public HTTPS from internal service transport. The browser must not receive an internal loopback URL that it is expected to call directly.

### Phase 5: Secure Go relay signaling and Android configuration

- Put the Go signaling endpoint behind HTTPS, or add direct TLS support to the Go server.
- Change the Android server URL from `http://10.174.96.119:39002` to the final `https://` relay URL.
- Configure Android to trust the deployment CA.
- Remove `android:usesCleartextTraffic="true"` after every required Android endpoint is HTTPS.
- Confirm that SDP offer/answer exchange, ICE negotiation, QR data-channel behavior, and H.264 publishing still work.
- Keep the Go-to-Python H.264 feed on the Unix domain socket; TLS is neither required nor applicable to that local socket.

Acceptance criteria:

- Android publishes without cleartext exceptions.
- Relay signaling is HTTPS.
- The Python `android_live` state transitions correctly.
- No `connection refused`, certificate-validation, or backlog-overflow loop remains during normal startup.

### Phase 6: Remove public HTTP and enforce policy

- Redirect browser-facing HTTP requests to HTTPS during a short compatibility period.
- Close raw application ports at the host/cloud firewall once proxy routes are verified.
- Bind internal application listeners to loopback or the private service network.
- Enable HSTS only after certificate renewal and HTTPS routing are proven; premature HSTS can make certificate mistakes harder to recover from.
- Remove stale HTTP URLs from source defaults, examples, Android hints, README files, and deployment scripts.
- Add automated checks that reject public `http://` and `ws://` configuration values in production.

## Configuration policy

Use separate concepts for public browser URLs and internal service URLs.

Example:

```env
# Browser-visible URLs: HTTPS only
PUBLIC_OPERATOR_URL="https://its.example.internal"
VISION_PUBLIC_BASE_URL="https://vision.its.example.internal"
LIVE_VIEW_URL="https://vision.its.example.internal/"

# Internal service-to-service URLs: allowed only on loopback/private network
ROUTING_TRACKING_BASE_URL="http://127.0.0.1:8000"
PY_ANDROID_LIVE_URL="http://127.0.0.1:39001/internal/android-live"
RELAY_STATUS_URL="http://127.0.0.1:39002/internal/status"
```

Production startup validation should fail when a browser-visible URL uses `http://`, except for an explicitly enabled local-development mode using loopback.

## Implementation work items

### Reverse proxy and deployment

- Add version-controlled reverse-proxy configuration.
- Add certificate and private-key paths through deployment secrets, never source control.
- Add WebSocket upgrade headers for Vision playback.
- Add HTTP-to-HTTPS redirects.
- Add health checks for each upstream service.
- Add firewall rules exposing only approved HTTPS entry points and required WebRTC/TURN ports.

### Node and operator dashboard

- Add a public operator URL setting if redirects or absolute links need it.
- Validate `VISION_PUBLIC_BASE_URL` and `LIVE_VIEW_URL` as HTTPS in production.
- Keep the existing modal iframe behavior.
- Add a visible diagnostic message containing the configured Live View origin when iframe startup fails.
- Update the OpenAPI server URL from its current HTTP development value.
- Add a test proving bootstrap returns the intended HTTPS Live View URL.

### Vision service

- Support proxy-aware operation and document whether TLS is terminated in Vision or at the proxy.
- Add an explicit health endpoint that does not require the YOLO playback session.
- Verify WSS upgrade behavior through the proxy.
- Avoid two simultaneous TLS termination layers unless upstream TLS validation is intentionally configured.

### Routing/tracking

- Keep the internal base URL separate from any public route-explorer URL.
- Add a health endpoint suitable for reverse-proxy checks.
- Document playback and live-BIMS startup under the new ingress topology.

### Go relay and Android

- Add configurable TLS or proxy deployment instructions for the relay endpoint.
- Replace HTTP-only examples and UI hints.
- Add Android network-security configuration for the selected CA.
- Disable unrestricted cleartext traffic after migration.

## Verification checklist

### Browser

- [ ] Dashboard address begins with `https://`.
- [ ] Dashboard `window.isSecureContext` is `true`.
- [ ] Live View iframe address begins with `https://`.
- [ ] Live View iframe `window.isSecureContext` is `true`.
- [ ] `VideoDecoder` exists.
- [ ] `EncodedVideoChunk` exists.
- [ ] Playback WebSocket uses `wss://` and remains connected.
- [ ] Browser console contains no mixed-content or certificate errors.
- [ ] Live View works inside the modal without opening a new tab.

### APIs and services

- [ ] Node liveness and readiness endpoints work through HTTPS.
- [ ] Authentication works and JWTs are never sent over public HTTP.
- [ ] Tracking vehicle refresh works through the HTTPS dashboard origin.
- [ ] Node can reach routing/tracking over the intended internal URL.
- [ ] Direct public access to raw internal HTTP ports is blocked.
- [ ] Vision health and playback endpoints work through the proxy.
- [ ] WebSocket upgrade headers and timeouts are correct.

### Android and relay

- [ ] Android uses the final HTTPS relay URL.
- [ ] Android trusts the deployment CA without bypass behavior.
- [ ] Go and Python agree on the `PY_ANDROID_LIVE_URL` protocol.
- [ ] Go and Python use the same `YOLO_FEED_SOCKET` path.
- [ ] Android connection updates `android_live=true` in Python.
- [ ] Normal streaming does not trigger recurring `backlog_overflow` resets.

### Certificate operations

- [ ] Certificate SANs match every client-visible hostname/IP.
- [ ] Certificate expiry is monitored.
- [ ] Renewal is tested before production use.
- [ ] Private keys are readable only by the owning service/proxy account.
- [ ] Certificates and private keys are excluded from Git.

## Test commands

Replace certificate and URL values with the final deployment values.

```bash
# Confirm the HTTPS endpoint and certificate chain.
curl --cacert /path/to/ca.crt https://10.174.96.119:39001/

# Confirm the operator endpoint after HTTPS ingress is enabled.
curl --cacert /path/to/ca.crt https://10.174.96.119:39005/health/live

# Confirm internal routing remains reachable from the Node host.
curl http://127.0.0.1:8000/internal/telemetry/status

# Confirm relay status from the local service boundary.
curl http://127.0.0.1:39002/internal/status
```

Temporary `curl -k` checks may prove that a TLS listener is present, but they do not verify certificate trust and must not be used as the final acceptance test.

## Rollout and rollback

### Rollout order

1. Establish trusted certificates and HTTPS ingress.
2. Enable HTTPS for the dashboard while retaining internal Node HTTP.
3. Enable proxied HTTPS/WSS for Vision and verify the modal.
4. Move optional public routing access behind HTTPS.
5. Move Android relay signaling to HTTPS.
6. Close public HTTP ports and enable enforcement.

### Rollback

- Keep the previous reverse-proxy configuration available as a versioned deployment artifact.
- Roll back proxy routing and environment values together; do not leave HTTPS public URLs pointing to an HTTP-only listener.
- During pre-production rollout only, retain loopback HTTP listeners for diagnosis.
- Do not restore public HTTP as a normal operating mode after credentials or control actions are exposed to the interface.

## Definition of done

The migration is complete when the operator can load the dashboard over trusted HTTPS, select a vehicle, open Live View in the existing modal, and decode H.264 through WebCodecs with `window.isSecureContext === true`, while all browser-visible API and WebSocket traffic uses HTTPS/WSS and raw internal HTTP listeners are not reachable from the LAN.
