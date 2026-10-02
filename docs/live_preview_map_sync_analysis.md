# Map position lag behind live preview

## Summary and scope

The reported symptom is a vehicle marker trailing **recorded footage streamed through Live Preview in normal monitoring mode**. The delay feels greater than 250 ms; 250 ms or less would be acceptable. Whether it happens during a replay trip, without a trip, or both is not yet established.

Code inspection and a controlled execution of the actual marker functions reproduced one concrete bug: a fleet animation can continue writing an older position after a live-frame update has taken ownership. This can affect the marker for the remainder of a three-second animation. It is not proof that the observed footage has exactly three seconds of lag, or that this explains the active-trip case.

This document records the analysis and recommended fixes. It does not implement those fixes. The actual delay has not been measured against a running vehicle stream.

## Current synchronization path

1. Android supplies video and QR events containing the source recording timestamp. The relay associates QR events with video access units.
2. Vision resolves each frame's recording time from the QR anchor and RTP presentation timestamp. Between QR anchors it estimates source time, including playback-rate changes.
3. When sending a frame, Vision matches GPS/IMU history by recording session and resolved source time. The encoded video and matched telemetry travel together.
4. The browser decodes and draws the video frame, performs overlay work, and sends its telemetry to the parent dashboard with the frame's epoch and sequence.
5. The dashboard chooses a direct GPS position or a replay-route position and updates the marker. Map camera following is a separate operation.

| Stage | Code reference | Relevant behavior |
| --- | --- | --- |
| QR association | [yolofeed.go](../services/media-relay/internal/yolofeed/yolofeed.go), `PublishQREvent` and access-unit assembly | Exact RTP timestamp matching; otherwise an arrival-time estimate with a 250 ms acceptance window. |
| Source clock | [source_timeline.py](../services/vision/app/services/source_timeline.py), `SourceTimelineResolver` | QR anchors and RTP-based extrapolation, limited to 1.5 seconds without an anchor. |
| Frame GPS | [playback.py](../services/vision/app/api/playback.py), `_frame_telemetry`; [telemetry.py](../services/vision/app/services/telemetry.py), `match_gps` | Matching uses source time, not server arrival time. GPS interpolation allows gaps up to 2.5 seconds; extrapolation/holding lasts up to 1.5 seconds. |
| Video and parent message | [Vision page](../services/vision/index.html), `paint`, `postPresentedTelemetry` | Publishes telemetry for the drawn frame, after overlay and telemetry-panel work. |
| Position selection | [dashboard](../operator-web/app.js), live telemetry message handler and `updateRemainingTripRoute` | Selects frame GPS, timed replay-route placement, or fallback positions. |
| Marker and camera | [live-map.js](../operator-web/live-map.js), `update`, `follow` | Direct marker movement; camera pans at 250 ms intervals with 250 ms animation duration. |

### Two different kinds of delay

- **Playback latency:** footage is behind the original source because of transport, inference, decoding, or buffering. If its marker uses the same frame's correctly matched telemetry, both can still agree.
- **Relative synchronization error:** the marker represents a different instant or position than the displayed footage. Animation conflicts, inaccurate source-time association, GPS timing, or fallback updates can cause this.

The recent jump-to-live and backlog work addresses playback latency. It does not by itself correct a marker animation conflict or an incorrect video/GPS timestamp relationship.

## Findings and evidence

### 1. Confirmed: a fleet animation can overwrite a live-frame position

`glideMarker` in the dashboard schedules repeated `requestAnimationFrame` callbacks over `FLEET_POLL_MS`, currently 3000 ms. Its callbacks keep writing the interpolated position until the animation finishes.

Fleet polling avoids starting a new animation while `isLiveOverride` is fresh. However, an animation already started before the first valid live GPS update, or during a stale interval, remains scheduled. `createLiveMapFollower.update` immediately calls `setLatLng` but does not cancel `marker.glideFrame`. The earlier callback can then write an older interpolated position over the fresh one.

**Controlled reproduction:** execute the actual `glideMarker` and `createLiveMapFollower` functions with a fake animation clock and marker:

1. Start a fleet glide from synthetic position `[0, 0]` to `[30, 0]` over 3000 ms.
2. At 500 ms, apply a live-frame update to `[10, 0]`.
3. Execute the previously scheduled fleet callback at 500 ms.

Observed output:

```json
{
  "framePosition": [10, 0],
  "afterOldFleetAnimation": [5, 0],
  "oldAnimationStillRunning": true
}
```

These coordinates are synthetic values, not geographic measurements. The reproduction proves competing writers and a stale overwrite; it does not measure the real recording's time offset.

**Scope:** the direct live-marker path is vulnerable, including no-trip streaming and planned-route cases that use that path. The active replay-route path calls `drawReplayRouteAt`, which cancels `marker.glideFrame` before setting the position. Fresh frame-driven replay-route updates also cancel `routeAnimationFrame` and bypass the 500 ms route glide. A persistent lag in that path requires further investigation.

### 2. Confirmed: replay time correction differs by position path

The dashboard's `DEFAULT_REPLAY_GPS_LEAD_MS` is 300 ms, with a browser-saved override under `operatorReplayGpsLeadMs`. `withReplayGpsLead` adjusts the recording timestamp used for timed route placement and free-replay estimates.

Direct frame GPS positions use Vision's matched latitude/longitude without this adjustment. Consequently, changing from route-based placement to direct GPS can change the effective calibration.

The comment supporting the default cites approximately 250–300 ms of GPS lag for a particular 2026-08-27 recording. That is existing code commentary, not a measurement verified in this analysis or a universal calibration for every recording. The saved browser value must also be captured during diagnosis.

### 3. Confirmed: map camera smoothing is separate from marker timing

The marker is set directly in `update`, while `follow` throttles camera pans to 250 ms and animates each pan over 250 ms. This can make following appear delayed, but it does not introduce a fixed 250 ms delay into the marker's geographic coordinates. The scheduling interval and animation overlap also mean 250 ms is not a strict bound on perceived camera delay.

The reported larger marker lag should not be attributed solely to this behavior. Compare the marker against map landmarks with following disabled to separate the two effects.

### 4. Risks requiring a playback trace

| Candidate | Why it can matter | Evidence needed |
| --- | --- | --- |
| GPS holding or extrapolation | Missing speed/bearing can hold an older fix; extrapolation based on a previous heading can be inaccurate through a turn. Interpolation across sparse fixes also has spatial error. | Frame source time, GPS match kind/age, sample spacing, accuracy, and turns in the recording. The 1.5-second limit is not a fixed added delay. |
| Telemetry delivery lag | The relay's Vision sink sends queued HTTP batches serially with a two-second request timeout. A bounded queue can still contain old data. | Queue residence time, queue depth, failures/drops, and newest GPS source time available when matching. The timeout alone does not prove a two-second lag. |
| QR association error | Arrival-time fallback estimates association when RTP timestamps differ. Video and data-channel delivery delays may differ. | Exact/fallback pairing counts, chosen frame/event pairing delta, QR decode latency, and source-time discontinuities. The 250 ms window bounds the heuristic, not true source-time accuracy. |
| QR extrapolation | Source time is predicted between anchors and may be wrong around pause, seek, or speed changes. | Timeline status/generation, anchor gaps, and QR source time versus resolved frame time. |
| Fleet fallback | After three seconds without a valid live position, the marker can return to fleet updates, which may use another recording instant. | Position-owner transitions and accepted/rejected live messages around the mismatch. |
| Route timing or geometry | Timestamp anchors and road matching can place the vehicle inaccurately even if the browser applies the update immediately. | Raw GPS versus route-derived coordinates at the same source time, road-snap mode, and route timing anchors. |
| Browser scheduling | Overlay work precedes the parent message; parent event handling and rendering happen afterward. Replay marker draws are deferred during zoom animation. | Draw/message/update timings, long tasks, and whether zooming or following is active. |

## Recommended fix sequence

### First: enforce one position owner

- Cancel an existing fleet glide before applying any frame-driven marker position. Invalidate its ownership token so a stale callback cannot resume writing after takeover.
- Make every animation callback verify that its vehicle, session, and position owner are still current. Apply the same rule to delayed route redraws and fallback transitions.
- Keep live-frame ownership while usable frame-time positions are arriving. Explicitly label a stale/fleet fallback rather than presenting it as synchronized live positioning.
- Reset ownership and frame ordering on a session change or jump-to-live epoch. Accept newer epochs even when their sequence restarts at zero; reject superseded frame messages.
- Preserve the existing immediate frame-driven placement on replay routes. Keep telemetry tied to frames actually drawn, including when stale video rendering is skipped.

### Second: measure residual error by path

Capture a bounded diagnostic trace for both an active replay trip and no-trip streaming. Record:

- Vehicle/session, epoch/sequence, resolved recording timestamp, source-timeline status, and GPS match kind/age.
- Position owner: direct frame GPS, timed replay route, free-replay estimate, or fleet fallback.
- Saved replay lead, timestamp actually used for placement, raw GPS coordinate, selected target coordinate, and applied marker coordinate.
- Video draw submission time, telemetry message receive time, marker update time, and next browser rendering opportunity; also record camera/zoom state.
- Relay pairing and telemetry-delivery measurements when browser-side evidence cannot explain the offset.

Use recording nanoseconds only for source-time comparisons. Use a common browser time basis such as `performance.timeOrigin + performance.now()` for iframe/parent timing, with precision limits recorded. Do not subtract a source recording timestamp from browser or server wall time. Canvas draw submission and the next animation callback are timing proxies, not proof of physical screen presentation; validate visible alignment with a simultaneous screen capture.

Existing `window.__liveFrameDebug`, `window.__replayDebug`, and telemetry match fields provide starting points, but they do not currently measure the complete display delay. Any proposed diagnostic fields are future additive changes; no API or database changes are needed to create this document.

### Third: correct measured source and calibration problems

- If a repeatable recording-specific offset remains after ownership is fixed, establish it using multiple recognizable turns or landmarks. Apply the same display-time correction once across route and direct-GPS paths.
- Direct GPS calibration requires looking up/interpolating telemetry at the corrected source time; adding a time value to an already matched coordinate cannot correct it. Preserve original timestamps and stored observations.
- Do not increase the global 300 ms lead to hide unmeasured delivery or animation delays. Different recordings may require different calibration, and spatial GPS error is not always a timing error.
- If traces identify telemetry queue age or unreliable QR association, fix that stage and measure again. Do not delay footage by an arbitrary amount or extend stale-data windows to conceal the problem.
- Consider camera-follow changes only if camera motion still bothers the operator after marker synchronization meets the target.

### Implementation status (first step)

Implemented in the operator web client:

- `glideMarker` moved to [live-map.js](../operator-web/live-map.js) with a per-marker ownership token. `cancelGlide` cancels the queued callback and invalidates the token, so a glide callback that was already dispatched cannot write again.
- `createLiveMapFollower.update` (every frame-driven position, including free-replay estimates) and `drawReplayRouteAt` call `cancelGlide` before setting the marker.
- The fleet poll's follow step only moves the camera (`follow`), so it no longer competes with its own glide.
- `acceptLiveTelemetry` rejects superseded frames by `epoch`/`seq`: a newer epoch is accepted even when its sequence restarts at zero; an older epoch is rejected unless frames stopped for `LIVE_OVERRIDE_STALE_MS`. Frame ordering resets when the fleet poll moves the view to a new recording session.
- Regression tests: `node/tests/live-marker-ownership.test.ts` (scenario 1 below, epoch/sequence/session cases). The overwrite test fails with the fix removed.

Not done: the diagnostic trace, measurement of the remaining delay, and any calibration change (second and third steps).

## Verification and acceptance

### Regression scenarios for a subsequent implementation

1. Start a fleet glide, deliver a frame position midway, then run remaining scheduled callbacks: none may overwrite the frame position.
2. Exercise active replay trips, no-trip streaming, and direct GPS placement. Verify which path owns the marker and that a configured replay correction is applied exactly once where supported.
3. Test stale/missing GPS, recovery, and fleet fallback. On recovery, cancel old animations before placing the new frame position.
4. Test jump-to-live, epoch sequence reset, session changes, and late messages. No previous owner or frame may move the current marker.
5. Test pause, seek, GPS gaps, turns, and playback-rate changes; record uncertainty rather than inventing a synchronized position when source time is unavailable.
6. Test zooming and camera following separately from marker coordinates. Deferred draws must use the latest valid position.

### Repeatable before/after capture

1. Use the same recording, segment, playback speed, map zoom, road-snap mode, and saved GPS lead. Capture those settings and the source revision.
2. Run once with an active replay trip and once without a trip. For each, compare following enabled with a stationary map centered on a known turn.
3. Include steady travel, several turns or landmarks, and a background/resume event. Record the footage and map together with the diagnostic trace.
4. Compare paired frame/marker updates by session, epoch, and sequence. Report median, 95th percentile, maximum delay, and fallback intervals separately.
5. Compare landmark alignment independently of browser update timing. Note GPS accuracy, sample gaps, and road-match uncertainty; convert spatial error to time only when motion and landmark correspondence justify it.

**Acceptance target:** during steady foreground playback with usable frame-time telemetry, target a 95th-percentile frame-to-marker application delay of at most 250 ms. Report maxima rather than hiding outliers. Obsolete animations must never overwrite the current frame position. A low application delay alone does not establish visual synchronization: any repeatable landmark lag greater than 250 ms must be investigated separately, with measurement and GPS uncertainty stated. Stale/fallback intervals must be identified rather than counted as synchronized playback.

### Verification performed for this analysis

- Inspected both frontend position paths, Vision source-time/GPS matching, and relay QR association and telemetry forwarding.
- Reproduced the fleet animation overwrite with the actual frontend functions and controlled animation scheduling.
- Did not measure a running vehicle stream, verify the recording's calibration, or implement a synchronization fix. Those remain the next steps described above.
