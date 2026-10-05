# Local presentation mode

From the repository root, with Node.js 20 or later installed:

```sh
node tools/presentation/server.mjs
```

Open <http://127.0.0.1:3080/operator/>. Stop with Ctrl+C. To use another port:

```sh
DEMO_PORT=3081 node tools/presentation/server.mjs
```

This launcher serves the existing operator UI with a separate local mock API.
It needs no npm install, Docker, database, GPU, API keys, or internet connection.
Leaflet 1.9.4 and its license are included in `vendor/`. MapLibre and other CDN
scripts are omitted. A local SVG schematic replaces the online basemap.
Production application files and Vision dependencies are unchanged.

## Suggested presentation walkthrough

1. Show the map and the fleet summary: eight sample vehicles in four states.
2. Open **차량 목록** and select **화물차 1호**. The video panel opens automatically.
   It draws a simulated road scene with two cars and one pedestrian. Try the
   detection overlay, distance colors, pause, and fullscreen controls.
3. Open **AI 도우미** and ask `차량 현황을 알려줘` or `안전 점검 항목을 알려줘`.
   The existing chat UI streams a prewritten response without a model or API.
4. Open **설정** to inspect UI controls. Data source changes affect only the
   mock setting; they never connect to BIMS.
5. **가상 경로·배차** shows a sample scenario and three vehicles for inspecting
   its layout. Routing, dispatch, edits, recordings, and trip creation require
   the real backend and return an explicit unsupported-operation message here.

All vehicle observations, detections, distances, and assistant responses are
presentation examples, not real telemetry or model output. The banner and
video labels disclose this. The drawing is a schematic, not a road map.
The server binds only to `127.0.0.1` and applies a Content Security Policy that
allows local resources only. Mock data is held in memory and resets on restart.
The mock session token is valid only for this isolated presentation host.

## Optional browser verification

`smoke.py` requires Playwright and an installed Chromium; neither is needed to
run the demo. With the demo running, execute:

```sh
python3 tools/presentation/smoke.py
```

Set `CHROMIUM_PATH` if Chromium is elsewhere. The check opens the dashboard,
selects the video vehicle, submits an assistant question, and fails on browser
errors, failed HTTP responses, or external requests. Screenshots go to
`/private/tmp/p4-presentation-*.png`.
