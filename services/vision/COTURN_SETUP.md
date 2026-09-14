# Coturn setup for the WebRTC relay

This project uses:

| Purpose | Protocol and ports |
| --- | --- |
| HTTPS ingress for dashboard, Vision/WSS, and Android signaling | TCP `443` |
| Internal Go relay signaling | loopback TCP `39012` |
| Internal FastAPI playback | loopback TCP `39011` |
| Coturn listener | UDP/TCP `3478` |
| Coturn TLS listener (optional) | TCP `5349` |
| Coturn relay allocations | UDP `40000-40255` |

The relay range is controlled by coturn. When TURN is selected, media is
relayed through coturn instead of requiring the Android device to reach an
unpredictable `aiortc` host port.

## 1. Coturn configuration

Edit `/etc/turnserver.conf`:

```ini
listening-port=3478
tls-listening-port=5349

# Private address of this Linux host.
listening-ip=<PRIVATE_SERVER_IP>
relay-ip=<PRIVATE_SERVER_IP>

# Required when the Linux host is behind a NAT router.
# Use only `external-ip=<PUBLIC_IP>` when the host has the public address directly.
external-ip=<PUBLIC_IP>/<PRIVATE_SERVER_IP>

realm=turn.example.com
server-name=turn.example.com
fingerprint
lt-cred-mech
user=user:pass

min-port=40000
max-port=40255

no-multicast-peers
no-loopback-peers
stale-nonce=600
```

Replace every placeholder. Use a strong password and do not commit it to the
repository. Coturn requires long-term credentials for WebRTC; `external-ip`
maps the public NAT address to the private server address, and the relay port
range limits allocated UDP ports.

Restart and inspect coturn:

```bash
sudo systemctl restart coturn
sudo systemctl enable coturn
sudo systemctl status coturn
sudo journalctl -u coturn -f
```

If the service uses a different configuration path, check it with:

```bash
systemctl cat coturn
```

## 2. Linux firewall

```bash
sudo ufw allow 443/tcp
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 40000:40255/udp
sudo ufw reload
sudo ufw status verbose
```

If possible, restrict the rules to the expected client networks instead of
allowing them from all addresses.

The NAT router and any cloud security group must forward/allow the same ports:

- TCP `443` to the HTTPS ingress
- UDP/TCP `3478` to coturn
- TCP `5349` to coturn when TLS is used
- UDP `40000-40255` to coturn

## 3. FastAPI TURN environment

The Python server reads these environment variables:

```bash
export TURN_URL='turn:10.174.96.95:3478?transport=udp'
export TURN_USERNAME='user'
export TURN_PASSWORD='pass'
```

These are also the application defaults. Override them with environment
variables when deploying outside this development network.

Start the Python playback server as a loopback HTTP upstream on port `39011`:

```bash
cd /path/to/poc-server-webrtc/server
uv sync
export HOST=127.0.0.1
export PORT=39011
uv run python run.py --no-tls
```

Start the Go relay separately on loopback port `39012`:

```bash
cd /path/to/poc-server-webrtc/relay-go
RELAY_LISTEN_ADDR=127.0.0.1:39012 go run .
```

The Python feed connection retries until the relay socket exists, and the
Android publisher retries until the relay HTTP endpoint is available; these
processes do not require a fixed startup order.

## 4. Android build configuration

The Android module reads Gradle properties. Do not put the real password in a
committed file; put these in the developer's user Gradle properties or pass
them on the Gradle command line:

```text
turn.url=turn:10.174.96.95:3478?transport=udp
turn.username=user
turn.password=pass
relay.url=https://10.174.96.95
```

Build the APK:

```powershell
cd E:\project4\poc-server-webrtc\android
.\gradlew.bat :app:assembleDebug
```

The app uses the HTTPS ingress URL, defaulting to `https://10.174.96.95`.
The ingress forwards `/offer/android` to the loopback Go relay.

## 5. Verify TURN is being used

Check that coturn is listening:

```bash
sudo ss -lntup | grep -E '3478|5349|40000|40001'
```

The SDP exchanged by the clients should contain candidates with `typ relay`.
Browser diagnostics are available at `chrome://webrtc-internals`; coturn
should also show an allocation and relay traffic in its journal.

If the page loads but video remains black, first check that Android and the browser can reach
`https://<PUBLIC_HOST>` with a trusted certificate; then confirm the ingress, NAT forwarding, and cloud
firewall rules for the coturn listener and relay range.
