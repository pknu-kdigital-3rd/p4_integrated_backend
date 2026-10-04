# Stream stop/start recovery

The browser playback WebSocket and Android WebRTC publisher are separate
connections. A healthy playback WebSocket can be waiting for a fresh H.264 IDR;
reopening that socket does not repair Android's media transport.

Recovery now keeps an open browser WebSocket during the initial-frame watchdog.
A stalled decoder or previously playing stream requests a resync over the
existing socket. Failed transports still reconnect, and explicit foreground
return still rejoins live. Loading stays visible until a frame actually paints.

Python keeps the relay feed open after source END, flushes the finished decoder,
then waits on the same transport for the next RESET/START. Previously END caused
a disconnect and the receiver's 500 ms reconnect delay.

The relay calls `Feed.Begin` when installing a publisher, before reading its RTP
packets. This creates a fresh epoch and clears the previous publisher's sequence
and codec state. Its first packet is therefore checked against the new stream,
rather than being discarded as a late packet from the previous track. END marks
the source inactive; the keyframe watchdog retries only for an active source
without an accepted IDR. Its retry count and wait duration restart on epoch
changes. Publisher arrival logs the negotiated video codec and format parameters.

Android also ignores late local-SDP success and HTTP answer callbacks belonging
to an already replaced peer. A delayed answer must never be applied to the new
peer connection.

The relay now registers pending offers as well as connected publishers. Before
gathering ICE candidates for a replacement, it closes the previous server peer
and its native transports. Android sends an explicit close request on stop or
retry using the existing `/offer/android` URL and an opaque `connectionId`
returned in the answer. A late close request cannot close a newer connection.
Canceled offer requests also stop waiting for ICE gathering. No additional
route or port is required; TURN relay ports remain **39006–39007**.

Android's delayed codec stats callback runs on the RTC executor and checks that
its peer is still current before calling native WebRTC methods. SDP acceptance
is labeled separately from an established WebRTC connection in the UI.

Validation covers browser waiting/failed transport/decoder recovery, same-feed
END followed by another START, relay source lifecycle and first restarted IDR,
existing relay signaling/broadcaster tests, and Android Kotlin compilation.
Actual Android-to-relay network stop/start recovery still needs deployment
verification. These fixes do not establish the cause of every missing IDR;
continued active-source waits require checking publisher connection and codec
logs. The previously supplied watchdog logs alone did not prove a live publisher.

## Dev deployment

The relay binary is baked into its image by `docker/relay.Dockerfile`; its mounts
contain only relay sockets and recording spool data. It needs rebuilding.
Vision mounts its app directory and runs Uvicorn with reload; its image and
individually mounted entrypoint are unchanged. Recreate to start both services
from the updated checkout, then reload the browser page for the new JavaScript:

```bash
docker compose -f docker-compose.dev.yml build p4-relay
docker compose -f docker-compose.dev.yml up -d --no-deps --force-recreate p4-relay p4-vision
```

Verify effective files/binary before testing:

```bash
docker compose -f docker-compose.dev.yml exec -T p4-vision python -c "from pathlib import Path; assert 'END ends the source' in Path('app/services/yolo.py').read_text(); assert 'Waiting for live video from Android' in Path('index.html').read_text(); print('stream recovery code present')"
docker compose -f docker-compose.dev.yml exec -T p4-relay sh -c "grep -a -o publisher_start /media-relay"
docker compose -f docker-compose.dev.yml logs -f --tail 100 p4-relay p4-vision
```

After an Android restart, expect `YOLO feed reset: ... reason=publisher_start`
and `Android publisher video codec=...`. Watchdog messages should cease while
the publisher is stopped, and accepted keyframes should stop active retries.
The Android callback guards require rebuilding and installing the updated app;
backend/browser recovery changes also work with the existing app.

For the peer-release changes alone, rebuild and recreate `p4-relay` and install
the updated Android APK. Vision and coturn need no changes. Verify the deployed
relay binary includes `Android previous peer retired before new ICE gathering`,
then check logs for `Android peer explicitly released` on stop and Android's
`Relay peer release HTTP 200`. After resume, expect ICE connected, telemetry
channel OPEN, publisher arrival and accepted keyframes without repeated retries.

The native local TURN regression test occupies both relay ports, closes the
previous server peer, and verifies the replacement immediately gathers a relay
candidate using the freed port. This tests Pion allocation cleanup with a local
Pion TURN server; it does not verify the deployed coturn server or phone network.
