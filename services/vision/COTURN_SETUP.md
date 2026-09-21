# Coturn setup for the WebRTC relay

This project uses:

| Purpose | Protocol and ports |
| --- | --- |
| HTTPS ingress for the operator dashboard | TCP `39001` |
| HTTPS ingress for Vision/WSS and Android signaling | TCP `39002` |
| Internal Go relay signaling | private Compose TCP `39012` |
| Internal FastAPI playback | private Compose TCP `39011` |
| Coturn listener | UDP/TCP `39004` |
| Coturn TLS listener (optional) | TCP `39005` |
| Coturn relay allocations | UDP `39006-39007` |

The relay range is controlled by coturn. When TURN is selected, media is
relayed through coturn instead of requiring the Android device to reach an
unpredictable `aiortc` host port.

## Disable coturn on a directly reachable network

Coturn is optional when the Android device and the relay host can reach each
other directly. Stop the Compose service and remove its firewall/NAT rules
only after confirming that the direct ICE candidate works:

```bash
./scripts/run-linux-stack.sh stop coturn
```

Set an explicitly empty `TURN_URL` for both the Go relay and Vision. The empty
value is different from an unset value and disables TURN while retaining host
ICE candidates:

```bash
export TURN_URL=""
export TURN_USERNAME=""
export TURN_PASSWORD=""
```

Restart the relay and Vision after changing the environment. Rebuild the
Android app without a TURN server as well:

```powershell
.\gradlew.bat :app:assembleDebug -Pturn.url=
```

If the phone or operator later connects from a different network, a symmetric
NAT or a firewall may prevent direct ICE. In that case keep coturn enabled and
restore the TURN URL and credentials.

## 1. Coturn configuration

Coturn is part of the Compose stack and runs with Linux host networking. Set
its address and credentials as Compose variables when starting the stack:

```bash
TURN_LISTENING_IP=0.0.0.0 \
TURN_RELAY_IP=10.174.96.119 \
TURN_EXTERNAL_IP=10.174.96.119 \
TURN_REALM=p4.local \
TURN_USERNAME=user \
TURN_PASSWORD=replace-with-a-strong-secret \
docker compose up -d coturn
```

The Compose service always binds UDP/TCP `39004`, optional TLS TCP `39005`,
and the relay allocation range UDP `39006-39007`. The `external-ip` value is
the address that remote ICE clients use; when the host is behind NAT, set it
to the public address and configure the corresponding NAT mapping.

Start and inspect the container:

```bash
./scripts/run-linux-stack.sh start coturn
docker logs -f p4-coturn
```

## 2. Linux firewall

```bash
sudo ufw allow 39001/tcp
sudo ufw allow 39002/tcp
sudo ufw allow 39004/udp
sudo ufw allow 39004/tcp
sudo ufw allow 39005/tcp
sudo ufw allow 39006:39007/udp
sudo ufw reload
sudo ufw status verbose
```

If possible, restrict the rules to the expected client networks instead of
allowing them from all addresses.

The NAT router and any cloud security group must forward/allow the same ports:

- TCP `39001` to the operator HTTPS ingress
- TCP `39002` to the Vision/signaling HTTPS ingress
- UDP/TCP `39004` to coturn
- TCP `39005` to coturn when TLS is used
- UDP `39006-39007` to coturn

## 3. FastAPI and relay TURN environment

The Python server reads these environment variables:

```bash
export TURN_URL='turn:10.174.96.119:39004?transport=udp'
export TURN_USERNAME='user'
export TURN_PASSWORD='pass'
```

These are also the application defaults. Override them with environment
variables when deploying outside this development network.

The Compose services receive their internal TURN and relay URLs from Compose
defaults or shell overrides; Node, Vision, and the Go relay communicate over
the private `p4-internal` network. Start them together with:

```bash
./scripts/run-linux-stack.sh start
```

For development bind mounts and reload commands, set `P4_COMPOSE_DEV=true`
before starting the stack.

## 4. Android build configuration

The Android module reads Gradle properties. Do not put the real password in a
committed file; put these in the developer's user Gradle properties or pass
them on the Gradle command line:

```text
turn.url=turn:10.174.96.119:39004?transport=udp
turn.username=user
turn.password=pass
relay.url=https://10.174.96.119:39002
```

Build the APK:

```powershell
cd E:\project4\p4_integrated_backend\android
.\gradlew.bat :app:assembleDebug
```

The app uses the HTTPS ingress URL, defaulting to `https://10.174.96.119:39002`.
The ingress forwards `/offer/android` to the private Go relay container.

## 5. Verify TURN is being used

Check that coturn is listening:

```bash
sudo ss -lntup | grep -E '39004|39005|39006|39007'
```

The SDP exchanged by the clients should contain candidates with `typ relay`.
Browser diagnostics are available at `chrome://webrtc-internals`; coturn
should also show an allocation and relay traffic in its journal.

If the page loads but video remains black, first check that Android and the
browser can reach `https://<PUBLIC_HOST>:39002` with a trusted certificate;
then inspect the Nginx and Coturn container logs and confirm the NAT forwarding
and cloud firewall rules for the listener and relay range.
