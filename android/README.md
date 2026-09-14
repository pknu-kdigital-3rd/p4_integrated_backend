# WebRTC camera client

This app publishes the Android camera to the Go relay at
`POST /offer/android` (default port `39002`) using a WebRTC video track and an
HTTP SDP offer/answer exchange. The Go relay forwards the encoded H.264 access
units to the Python inference server over its local reliable feed.

## Run the servers

Start the Go relay on port `39002` and the Python inference/playback server on
port `39001`. Either server may start first; both sides retry their local
connection until the other process is available.

## Run the Android app

Open the `android` directory in Android Studio and run the `app` configuration.
The debug APK can also be built with:

```powershell
.\gradlew.bat :app:assembleDebug
```

The default URL is `http://10.0.2.2:39002`, which reaches the host computer
from the Android Emulator. For a physical phone, enter the relay's LAN
address, for example `http://192.168.0.10:39002`, and allow port 39002 through
the computer firewall if necessary.

The phone and server must be reachable on the same network. This prototype
uses host ICE candidates and does not configure a STUN/TURN server.
