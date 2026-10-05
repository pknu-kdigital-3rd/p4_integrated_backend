# Private TURN administration

This is a real server administration interface, independent of demo mode.
It lists coturn allocations, their UDP relay addresses, client addresses,
protocols, age/expiry, and traffic counters. The relay's actual WebRTC/ICE state
and selected ICE candidates appear separately. Coturn does not expose ICE state
for individual allocations; an allocation must not be classified as stale solely
from the relay's current state.

Release a selected allocation with **연결 해제** and confirm the session/address.
The backend issues coturn's `cs <session-id>`, then verifies that session is gone.
It does not restart coturn or release other allocations. A live client may allocate
again, so stop or terminate the unwanted Android publisher before releasing it.

Automatic refresh is off initially. Its checkbox enables two-second refreshes
only while the page is visible. There is no background allocation cleanup.

## Enable on Linux

The normal Compose files retain `--no-cli` and have no administration service.
Add the override and the `turn-admin` profile to enable administration. In the
deployment's environment file, set a separate password of at least 24 characters:

```dotenv
TURN_ADMIN_ENABLED=true
TURN_ADMIN_PASSWORD=<a separate long random administration password>
```

Use the same environment file and base Compose file as your existing deployment.
The commands below assume production and a root `.env` file. For development,
substitute `docker-compose.dev.yml`; use `--env-file` when your environment file
has a different path.

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.turn-admin.yml --profile turn-admin build p4-relay p4-turn-admin
docker compose -f docker-compose.prod.yml -f docker-compose.turn-admin.yml --profile turn-admin up -d --no-deps --force-recreate p4-relay p4-coturn p4-turn-admin
```

The relay binary and admin application are baked into their images and must be
rebuilt when their code changes. Coturn uses the existing image with a changed
command and must be recreated. None of these changes use an individual file
bind mount. Enabling this feature recreates coturn and interrupts existing TURN
connections once.

The allocation pool remains UDP **39006–39007**. Coturn's CLI listens only on
server loopback **127.0.0.1:5766**. The admin HTTP service uses host networking
and listens only on **127.0.0.1:39013**. The relay status port is published only
to **127.0.0.1:39012**. There is no Nginx/public route or additional external
firewall opening. This override targets Linux host networking.

Connect from your computer through an SSH tunnel:

```powershell
ssh -N -L 39013:127.0.0.1:39013 rtx6000
```

Open `http://127.0.0.1:39013/`. Sign in as `admin` with `TURN_ADMIN_PASSWORD`.
For another host, substitute its SSH alias. Keep the page behind the SSH tunnel;
do not publish or reverse-proxy it publicly.

## Verify the deployed configuration

```bash
docker exec p4-coturn sh -c 'tr "\000" "\n" < /proc/1/cmdline | grep -E "^--(cli-ip|cli-port|min-port|max-port|no-cli)(=|$)"' 
docker exec p4-relay sh -c 'grep -a -o iceConnectionState /media-relay'
docker exec p4-turn-admin python -c 'import os; from pathlib import Path; assert os.environ["TURN_ADMIN_ENABLED"] == "true"; assert "self.command(\"cs \" + session_id)" in Path("server.py").read_text(); print("admin enabled; targeted release present")'
sudo ss -lntp | grep -E '127.0.0.1:(5766|39012|39013)'
curl --fail --user admin http://127.0.0.1:39013/api/status
```

`curl --user admin` prompts for the password. Check that the effective command has `--cli-ip=127.0.0.1`, has no `--no-cli`, and retains
the two-port allocation range. The API must show the live server's allocations
and relay state; errors are displayed rather than replaced with sample data.

## Disable

Set `TURN_ADMIN_ENABLED=false` and recreate `p4-turn-admin` to make its page,
assets, and control API return 404. To remove the service, CLI, and status port
entirely, stop/remove the admin container, then recreate from the base file alone:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.turn-admin.yml --profile turn-admin stop p4-turn-admin
docker compose -f docker-compose.prod.yml -f docker-compose.turn-admin.yml --profile turn-admin rm -f p4-turn-admin
docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate p4-relay p4-coturn
```

Do not run `down` on the entire stack to disable this feature.

## Checks

```bash
python -m unittest discover -s services/turn-admin -v
node services/turn-admin/test_app.cjs
```

Real coturn integration check (isolated test container; no production allocations):

```bash
docker run --rm -d --name p4-turn-admin-test -p 127.0.0.1:41304:3478/udp -p 127.0.0.1:5766:5766/tcp coturn/coturn:4.6.3 -n --log-file=stdout --lt-cred-mech --cli-ip=0.0.0.0 --cli-password=private-test-password-at-least-24 --no-tls --no-dtls --realm=abrupt-test --user=abrupt-test:test-password --min-port=41306 --max-port=41307 --max-allocate-lifetime=120 --listening-ip=0.0.0.0
python services/turn-admin/integration_check.py
docker stop p4-turn-admin-test
```

The test abandons two UDP allocations without deallocation, cancels one through
the actual CLI, verifies the other remains, and immediately reuses the freed UDP
port. Production CLI binding remains loopback; only this disposable container
binds its CLI internally to `0.0.0.0` behind a loopback-only Docker port mapping.
See [coturn's CLI documentation](https://github.com/coturn/coturn/blob/4.6.3/README.turnserver).
