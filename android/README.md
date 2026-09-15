# WebRTC camera client

This app publishes the Android camera to the Go relay at
`POST /offer/android` through the HTTPS ingress using a WebRTC video track and an
HTTPS SDP offer/answer exchange. The Go relay forwards the encoded H.264 access
units to the Python inference server over its local reliable feed.

## Run the servers

Start the Go relay internally on `127.0.0.1:39012` and the Python inference/playback server on
`127.0.0.1:39011`, then start the HTTPS ingress. Either server may start first; both sides retry their local
connection until the other process is available.

## Run the Android app

Open the `android` directory in Android Studio and run the `app` configuration.
The debug APK can also be built with:

```powershell
.\gradlew.bat :app:assembleDebug
```

The default URL is `https://10.174.96.95:39002`. Override it with the Gradle property
`relay.url=https://its.example.internal:39002` when using DNS. Install the deployment
CA certificate on the development device before connecting. Debug builds trust
user-installed CAs; release builds trust system CAs only. Cleartext HTTP is disabled.

Use the **QR scanning** switch in the app to disable ML Kit QR analysis while
measuring video throughput. When disabled, camera frames are released
immediately after WebRTC publishing instead of waiting for QR processing.
The camera panel also reports `capture=... fps`, which measures frames delivered
by CameraX before WebRTC encoding or Vision inference.

The phone and server must be reachable on the same network. This prototype
uses host ICE candidates and does not configure a STUN/TURN server.
