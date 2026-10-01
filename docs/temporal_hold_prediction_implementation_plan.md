# Temporal Hold / Prediction Layer Implementation Plan

## Project

Current source archive: `p4_integrated_backend_20261003_optimize_virtual.zip`

Primary target: `services/vision/index.html`

Supporting files likely to change:

- `services/vision/index.html`
- `services/vision/app/core/settings.py` only if server-provided defaults/configuration are added later
- `services/vision/tests/` if browser logic is extracted into a testable module
- project documentation / `.env.example` only if new runtime settings are promoted to server configuration

---

## 1. Goal

Reduce visible object-detection flicker in the live preview when YOLO/ByteTrack temporarily produces no observation for an already-established object.

The change must distinguish between:

1. **Low-confidence detection** — handled by YOLO + ByteTrack confidence hysteresis.
2. **No detection for a short interval** — handled by this temporal layer.
3. **Object truly gone** — track must be removed after a bounded timeout.

The intended rendering behavior is:

```text
real observation
      |
      v
OBSERVED
      |
      | short detector gap
      v
PREDICTING
      |
      | prediction window elapsed
      v
HOLDING / FADING
      |
      | hold timeout elapsed
      v
EXPIRED
```

Instead of:

```text
visible -> missing -> visible -> missing -> visible
```

we want:

```text
real -> predicted -> predicted -> real
```

for short gaps.

---

## 2. Current System Behavior

### 2.1 Server-side anti-flicker

The current server already supports confidence hysteresis through ByteTrack:

- `YOLO_APPEAR_CONFIDENCE` -> `new_track_thresh`
- `YOLO_KEEP_CONFIDENCE` -> `track_low_thresh`
- `track_buffer` keeps lost track identity reusable

Relevant files:

- `services/vision/app/services/yolo.py`
- `services/vision/app/trackers/bytetrack.yaml`
- `services/vision/app/core/settings.py`

This helps when YOLO still emits a weak detection.

It does **not** provide a renderable bounding box when YOLO emits no observation for the current inference result.

### 2.2 Browser-side stabilization already present

`services/vision/index.html` currently contains:

- bounding-box EMA smoothing with `TRACK_SMOOTHING = 0.45`
- server `track_id` reuse
- local geometric matching for objects without server IDs
- global camera-motion estimation
- previous-track translation using `globalMotion`
- frame-count-based ghost retention with `ghostFrames`
- ghost opacity decay using `GHOST_OPACITY`

Current deletion logic is effectively:

```javascript
track.misses++;
track.confidence *= 0.75;
if (track.misses > ghostFrames) tracks.delete(id);
```

The weakness is that `ghostFrames` is tied to presentation/inference events rather than elapsed time.

At different playback/inference rates the same `ghostFrames` setting represents a different real duration.

---

## 3. Scope

### In scope

- Replace frame-count ghost lifetime with time-based retention.
- Add short-term bounding-box prediction.
- Reuse the existing global camera-motion estimate.
- Smooth object velocity to avoid prediction spikes.
- Blend predicted tracks back into real detections when reacquired.
- Give segmentation masks a shorter, more conservative hold policy.
- Add observable debug data so tuning can be measured.
- Preserve existing ByteTrack behavior and track IDs.

### Out of scope for the first implementation

- Replacing ByteTrack.
- Modifying Ultralytics internals.
- Exporting ByteTrack's internal Kalman filter state to the browser.
- Optical-flow-based per-object tracking.
- Full mask deformation/warping.
- Long-duration occlusion prediction.
- Predicting object motion for more than a few hundred milliseconds.

---

## 4. Recommended Initial Parameters

Start with these values:

```javascript
const TRACK_PREDICT_MS = 150;
const TRACK_HOLD_MS = 220;
const MASK_PREDICT_MS = 100;
const VELOCITY_SMOOTHING = 0.30;
const MAX_NORMALIZED_SPEED = 2.0;
const PREDICTED_MIN_ALPHA = 0.50;
```

Interpretation:

- `0-150 ms`: predict bounding-box position.
- `150-220 ms`: stop extrapolating; hold the latest predicted box and fade it.
- `>220 ms`: remove the rendered track.
- segmentation mask is retained/predicted for at most about `100 ms`.

These are starting values, not permanent constants.

---

## 5. Track State Model

Extend each frontend track from the current structure to include explicit timing and motion state.

Recommended track shape:

```javascript
{
  id,
  server,
  className,

  // Current displayed/smoothed box.
  box: [x1, y1, x2, y2],

  // Last real observed box after normalization, before prediction.
  lastObservedBox: [x1, y1, x2, y2],

  // Last detector payload; needed for class, mask, distance, etc.
  item,

  confidence,
  hits,
  confirmed,
  shown,

  // Timing.
  lastObservedAtMs,
  lastUpdatedAtMs,
  predictionAgeMs,

  // Motion in normalized image coordinates per second.
  vx,
  vy,

  // Optional later extension.
  vw,
  vh,

  // Rendering state.
  state: 'observed' | 'predicting' | 'holding',

  // Mask state.
  lastObservedMask,
  maskObservedAtMs,
}
```

`misses` may remain temporarily for diagnostics, but it must no longer control deletion.

---

## 6. Time Source

Use a monotonic browser clock:

```javascript
performance.now()
```

Do not use `Date.now()` for short-term motion calculations because wall-clock changes are irrelevant and undesirable here.

For every call that updates or renders track state, capture the time once:

```javascript
const nowMs = performance.now();
```

Pass that value into helper functions so all tracks for the same rendered frame use the same timestamp.

---

## 7. Bounding-Box Representation for Prediction

Predict box center rather than four corners independently.

Convert:

```text
[x1, y1, x2, y2]
```

into:

```text
cx = (x1 + x2) / 2
cy = (y1 + y2) / 2
w  = x2 - x1
h  = y2 - y1
```

For phase 1:

- predict `cx`
- predict `cy`
- hold `w`
- hold `h`

Do **not** initially extrapolate width/height. This avoids unstable box breathing caused by noisy detections.

After prediction:

```text
x1 = cx - w/2
x2 = cx + w/2
y1 = cy - h/2
y2 = cy + h/2
```

Clamp the result to normalized `[0, 1]` image coordinates.

---

## 8. Velocity Estimation

### 8.1 Raw residual velocity

When a real observation is received for an existing track:

```javascript
const dtSec = (nowMs - track.lastObservedAtMs) / 1000;
```

Compute previous and new centers.

```javascript
rawVx = (newCx - oldCx) / dtSec;
rawVy = (newCy - oldCy) / dtSec;
```

### 8.2 Smooth velocity

YOLO boxes jitter, so never use raw velocity directly.

Use an EMA:

```javascript
track.vx = track.vx * (1 - VELOCITY_SMOOTHING)
         + rawVx * VELOCITY_SMOOTHING;

track.vy = track.vy * (1 - VELOCITY_SMOOTHING)
         + rawVy * VELOCITY_SMOOTHING;
```

Recommended initial:

```javascript
VELOCITY_SMOOTHING = 0.30;
```

### 8.3 Clamp unreasonable velocity

A bad detection or ID mismatch must not shoot a predicted box across the screen.

Clamp normalized image speed:

```javascript
track.vx = clamp(track.vx, -MAX_NORMALIZED_SPEED, MAX_NORMALIZED_SPEED);
track.vy = clamp(track.vy, -MAX_NORMALIZED_SPEED, MAX_NORMALIZED_SPEED);
```

A starting limit around `2.0 normalized image widths/heights per second` is deliberately generous and should be tuned from logs.

### 8.4 Ignore invalid `dt`

Do not update velocity when:

```text
dt <= 0
```

or when the gap is already too old to represent continuous motion.

For example, skip velocity learning if:

```text
dt > 0.5 s
```

because the next observation should be treated as reacquisition rather than a clean velocity sample.

---

## 9. Camera Motion Integration

The current frontend already calculates:

```javascript
globalMotion = { dx, dy, confidence }
```

and shifts existing boxes before association.

Retain this mechanism.

### Important rule

Avoid applying camera motion twice.

The implementation must define one consistent coordinate update order.

Recommended order per displayed frame:

```text
1. Estimate global motion from previous displayed frame -> current displayed frame.
2. Translate existing track boxes by global motion once.
3. Match current YOLO observations.
4. For unmatched tracks, apply only residual object-velocity prediction.
5. Render.
```

Because the current code already performs step 2 before matching, the new prediction layer should treat `vx/vy` as **residual object motion after global compensation** as much as practical.

Do not add `globalMotion` a second time inside the same frame's missing-track predictor.

### Fallback

If:

```javascript
globalMotion.confidence <= 0
```

continue with velocity-only prediction.

---

## 10. Updated Track Lifecycle

### 10.1 New real observation

For a new track:

```text
state = observed
vx = 0
vy = 0
lastObservedAtMs = now
lastUpdatedAtMs = now
predictionAgeMs = 0
```

Keep the current confirmation logic:

- server-identified tracks can be immediately confirmed
- local tracks still follow local confirmation rules
- `shown` behavior remains compatible with current minimum-confidence handling

### 10.2 Existing real observation

When the same track is observed again:

1. calculate real-observation `dt`
2. update smoothed residual velocity
3. run existing EMA box smoothing
4. replace/update `item`
5. update confidence smoothing
6. set `lastObservedAtMs = now`
7. set `predictionAgeMs = 0`
8. set `state = 'observed'`
9. refresh `lastObservedMask` when a real mask is available

The existing `TRACK_SMOOTHING = 0.45` can remain for the first implementation.

### 10.3 No observation: prediction phase

Calculate:

```javascript
const ageMs = nowMs - track.lastObservedAtMs;
```

If:

```text
ageMs <= TRACK_PREDICT_MS
```

then:

```text
state = predicting
```

Move only the box center using residual velocity for the elapsed display interval.

Prefer incremental prediction using `lastUpdatedAtMs` rather than repeatedly applying total age to an already predicted box.

Example:

```javascript
const stepSec = (nowMs - track.lastUpdatedAtMs) / 1000;
moveBoxCenter(track.box, track.vx * stepSec, track.vy * stepSec);
track.lastUpdatedAtMs = nowMs;
```

This avoids double integration.

### 10.4 No observation: hold phase

If:

```text
TRACK_PREDICT_MS < ageMs <= TRACK_HOLD_MS
```

then:

```text
state = holding
```

Do not continue extrapolating object velocity.

Hold the latest predicted box in place except for the normal per-frame global camera translation that is already part of compensation.

This limits runaway prediction.

### 10.5 Expiry

If:

```text
ageMs > TRACK_HOLD_MS
```

remove the track from the frontend rendering set.

This replaces:

```javascript
if (track.misses > ghostFrames) tracks.delete(id);
```

---

## 11. Reacquisition Behavior

A predicted box and a newly returned YOLO box will rarely be identical.

Do not snap directly from the predicted location to the detector location.

Reuse the existing EMA update:

```javascript
track.box = track.box.map(
  (value, index) =>
    value * (1 - TRACK_SMOOTHING) +
    observation.box[index] * TRACK_SMOOTHING
);
```

This naturally blends prediction back into observation.

### Optional stronger reacquisition

If the prediction age was large, temporarily increase detector weight.

Example concept:

```text
fresh reacquisition: normal smoothing
old reacquisition:   stronger pull toward observed box
```

Do not add this until the basic implementation is tested.

---

## 12. Rendering / Fade Policy

Replace `ghost = track.misses > 0` with state-based rendering.

Suggested behavior:

### Observed

- alpha: `1.0`
- solid box
- normal line width
- labels visible
- mask visible

### Predicting

- alpha falls gradually from `1.0` toward approximately `0.65`
- optionally dashed/thinner box
- suppress or de-emphasize label updates that could falsely imply fresh distance data

### Holding

- alpha approximately `0.5-0.65`
- dashed/thinner box
- no continued object-motion extrapolation
- distance label should either be hidden or explicitly treated as held/stale

### Expired

- not rendered

Recommended helper:

```javascript
function trackAlpha(track, nowMs) {
  if (track.state === 'observed') return 1;

  const age = nowMs - track.lastObservedAtMs;
  const progress = Math.min(1, age / TRACK_HOLD_MS);
  return 1 - (1 - PREDICTED_MIN_ALPHA) * progress;
}
```

Do not fade all the way to zero before deletion; that can recreate a visible blink.

---

## 13. Segmentation Mask Strategy

Bounding boxes and masks must not use identical prediction rules.

A bounding box can be approximated with center translation for a short gap.

A segmentation polygon changes shape and perspective, so long extrapolation is unsafe.

### Phase 1 mask behavior

For a real observation:

- save the latest real mask
- save its observation timestamp

For a short miss:

```text
age <= MASK_PREDICT_MS
```

- reuse the last mask
- allow the same global camera translation used for the box
- do not apply residual object-velocity polygon deformation initially
- fade the mask

After:

```text
age > MASK_PREDICT_MS
```

- stop drawing the stale mask
- continue drawing predicted/held bounding box until `TRACK_HOLD_MS`

This gives:

```text
0-100 ms   box + short-lived mask
100-220 ms box only
>220 ms    nothing
```

This is safer than leaving a visibly incorrect polygon on a moving object.

### Important implementation detail

The current `track.item = observation.item` stores the current mask directly.

Add a separate mask state so predicted tracks do not accidentally treat stale mask data as a fresh observation.

Recommended:

```javascript
track.lastObservedMask = observation.item.mask ?? null;
track.maskObservedAtMs = nowMs;
```

---

## 14. Distance / Metadata Handling During Prediction

Distance and other inference-derived fields are not fresh during predicted frames.

Do not invent new values.

Recommended first-phase behavior:

- retain last known class name
- retain track ID
- retain last known confidence only for internal display state
- suppress the distance label while `state !== 'observed'`

Alternative later behavior:

```text
"12 m (held)"
```

but hiding stale distance initially is cleaner.

---

## 15. Replace `ghostFrames` UI

The current UI exposes:

```text
ghost frames
```

Replace or deprecate it with millisecond controls.

Recommended controls:

```text
Prediction: 150 ms
Hold timeout: 220 ms
Mask hold: 100 ms
```

For the first implementation, these can remain constants to reduce UI changes.

Once validated, expose them as advanced debug controls and persist them in `localStorage`.

Suggested keys:

```text
playback-track-predict-ms
playback-track-hold-ms
playback-mask-predict-ms
```

### Compatibility

If keeping `ghostFrames` temporarily:

- stop using it for deletion
- label it deprecated in code
- remove it after the new layer is verified

Do not run both independent expiry systems at the same time.

---

## 16. Function Refactor

`compensatedDetections()` currently performs several responsibilities.

Refactor enough to make temporal behavior explicit without over-engineering.

Suggested helpers:

```javascript
boxToCenterSize(box)
centerSizeToBox(cx, cy, w, h)
clampBox(box)
updateTrackVelocity(track, observedBox, nowMs)
updateObservedTrack(track, observation, nowMs)
predictMissingTrack(track, nowMs)
trackRenderAlpha(track, nowMs)
maskForTrack(track, nowMs)
expireOldTracks(nowMs)
```

Keep association inside `compensatedDetections()` initially.

Target control flow:

```javascript
function compensatedDetections(inference, width, height, nowMs) {
  const observations = ...;

  applyGlobalMotionToExistingTracks();
  matchServerTracks();
  matchLocalTracks();

  for (const unmatchedTrack of ...) {
    predictMissingTrack(unmatchedTrack, nowMs);
  }

  expireOldTracks(nowMs);

  return renderableTracks(nowMs);
}
```

Then:

```javascript
function drawOverlay(inference, width, height) {
  const nowMs = performance.now();
  ... compensatedDetections(inference, width, height, nowMs) ...
}
```

---

## 17. Interaction With `YOLO_FRAME_DROP_POLICY`

Current configuration supports:

```text
latest
queue
```

The temporal layer should work under both.

### `latest`

This mode benefits most from temporal prediction because inference updates can be intentionally skipped when inference cannot keep up.

### `queue`

Prediction gaps should be less common because inference preserves order, but true detector misses/occlusion can still occur.

Do not make the temporal layer depend on a specific drop policy.

---

## 18. Configuration Recommendation

The temporal layer is complementary to ByteTrack confidence hysteresis.

Use a reasonable server threshold baseline while testing:

```env
YOLO_APPEAR_CONFIDENCE=0.40
YOLO_KEEP_CONFIDENCE=0.05
```

or start from the tracker defaults if false positives increase.

Do not use `YOLO_APPEAR_CONFIDENCE=0.9` as the main anti-flicker mechanism; it can delay/reject legitimate new tracks without solving frames where no detection exists.

The implementation should be evaluated independently from threshold tuning.

---

## 19. Debug / Observability Additions

Add counters to the existing playback statistics so behavior can be measured rather than judged only visually.

Recommended counters:

```text
observed_tracks
predicted_tracks
held_tracks
expired_tracks
reacquired_tracks
avg_prediction_age_ms
max_prediction_age_ms
```

Optional per-track debug label when a debug switch is enabled:

```text
ID 17 OBS
ID 17 PRED 67ms
ID 17 HOLD 184ms
```

Do not show these state labels in normal operator mode.

Add current settings to the stats line:

```text
predict=150ms hold=220ms mask=100ms
```

---

## 20. Implementation Phases

### Phase 1 — Time-based hold only

Objective: prove that short zero-detection gaps are the main cause of flicker.

Changes:

1. add `lastObservedAtMs`
2. replace `ghostFrames` deletion with `TRACK_HOLD_MS`
3. preserve the last box during the timeout
4. use state-based fading
5. stop stale distance labels during held frames

No velocity prediction yet.

Expected result:

- substantial reduction in simple appear/disappear flicker
- possible visible lag/frozen boxes on moving objects

This phase should be a small, independently testable commit.

### Phase 2 — Linear center prediction

Changes:

1. store `vx`, `vy`
2. update smoothed velocity on real observations
3. predict center for `TRACK_PREDICT_MS`
4. keep width/height fixed
5. clamp prediction
6. stop extrapolating after prediction window

Expected result:

- reduced frozen-box effect during short detector gaps

### Phase 3 — Integrate carefully with global motion

Changes:

1. verify current global translation happens exactly once per displayed frame
2. ensure residual velocity is not double-counting camera motion
3. tune prediction behavior on moving-camera footage

Expected result:

- stationary/slow world objects remain aligned better during ego-camera movement

### Phase 4 — Mask policy

Changes:

1. track real mask timestamp separately
2. keep mask only for `MASK_PREDICT_MS`
3. apply global translation only
4. fade mask during the short retention interval
5. fall back to box-only rendering after mask expiration

Expected result:

- less segmentation shimmer/flicker without long-lived stale polygons

### Phase 5 — Debug controls and tuning

Changes:

1. expose time constants in advanced live-view controls if useful
2. persist via `localStorage`
3. add state counters
4. tune against representative footage

---

## 21. Testing Plan

### 21.1 Deterministic synthetic track tests

Create a small test harness or extracted JS unit test for these sequences.

#### Continuous observation

```text
OBS OBS OBS OBS OBS
```

Expected:

- always `observed`
- no prediction
- no expiry

#### One short miss

```text
OBS OBS MISS OBS
```

Expected:

- `observed -> predicting -> observed`
- no visible disappearance
- same track ID

#### Several short misses

```text
OBS OBS MISS MISS MISS OBS
```

when total gap < `TRACK_PREDICT_MS`.

Expected:

- box moves according to velocity
- reacquisition blends rather than snaps

#### Medium gap

Gap between `TRACK_PREDICT_MS` and `TRACK_HOLD_MS`.

Expected:

- prediction stops
- state becomes `holding`
- box remains visible with reduced alpha

#### Long gap

Gap > `TRACK_HOLD_MS`.

Expected:

- track is removed
- no stale overlay remains

#### Bad detector jump

Create a sudden large box-center displacement.

Expected:

- velocity clamp prevents runaway prediction

#### Reacquisition after expiry

Expected:

- new track follows normal tracker/server ID behavior
- frontend must not resurrect an expired local track incorrectly

---

## 22. Real-Footage Test Matrix

Use at least these cases:

1. stationary object + stationary camera
2. moving car + stationary camera
3. stationary roadside object + moving camera
4. moving car + moving camera
5. partial occlusion
6. dense scene with 20+ objects
7. confidence around tracking threshold
8. intentional inference slowdown
9. `YOLO_FRAME_DROP_POLICY=latest`
10. `YOLO_FRAME_DROP_POLICY=queue`
11. boxes-only overlay
12. segmentation-only overlay
13. combined overlay

For each case record:

```text
visible flicker count
false persistence count
obvious prediction drift count
ID continuity
approximate max stale duration
browser FPS
inference latency
```

---

## 23. Acceptance Criteria

The implementation is successful when:

- a 1-3 inference-result detector gap does not normally cause an established box to disappear immediately
- predicted tracks never remain visible beyond the configured hold timeout
- no prediction continues indefinitely
- reacquired detections blend back without large visual snapping in normal cases
- prediction does not significantly increase ID switches
- stale distance values are not presented as fresh measurements
- segmentation masks disappear earlier than boxes when their geometry becomes unreliable
- changing browser FPS does not materially change the configured real-time retention duration
- CPU usage increase in the browser is negligible relative to video decode/rendering
- the existing raw/no-compensation mode behavior remains available

---

## 24. Failure Modes to Guard Against

### Double-applying camera motion

Symptom:

- boxes move too far in the direction of camera translation

Prevention:

- global translation exactly once per displayed frame
- residual prediction after that step

### Prediction accumulation bug

Symptom:

- movement accelerates unrealistically

Prevention:

- integrate from `lastUpdatedAtMs`, not full prediction age against an already predicted box

### Velocity spike after jitter

Symptom:

- box flies across the image on the first missing frame

Prevention:

- velocity EMA
- speed clamp
- `dt` validity check

### Stale mask persistence

Symptom:

- polygon floats beside the object

Prevention:

- shorter `MASK_PREDICT_MS`
- then box-only rendering

### Stale distance display

Symptom:

- old distance appears to be a current measurement

Prevention:

- hide distance labels in predicted/held states initially

### False object persistence

Symptom:

- object that has actually left the image remains visible too long

Prevention:

- hard `TRACK_HOLD_MS`
- tune around ~200 ms first

---

## 25. Suggested Commit Breakdown

### Commit 1

`vision: replace frame-count ghost expiry with time-based track hold`

- timing state
- hold timeout
- state-based alpha
- no velocity prediction

### Commit 2

`vision: add bounded linear bbox prediction for temporary detector gaps`

- center velocity
- EMA velocity
- clamp
- predict/hold state transition

### Commit 3

`vision: stabilize predicted tracks with camera-motion compensation`

- validate global-motion ordering
- prevent double compensation
- moving-camera tuning

### Commit 4

`vision: add short-lived segmentation mask retention`

- separate mask timestamp
- conservative mask timeout
- box-only fallback

### Commit 5

`vision: add temporal stabilization diagnostics and tuning controls`

- counters
- localStorage/debug UI
- remove/deprecate `ghostFrames`

---

## 26. Recommended First Implementation

Implement only this minimal path first:

```text
real detection
      |
      v
existing EMA smoothing
      |
      v
missing?
  |       |
  no      yes
  |       |
 draw     age <= 150 ms
          |
          +--> predict box center using smoothed vx/vy
          |
          150 < age <= 220 ms
          |
          +--> hold/fade latest predicted box
          |
          age > 220 ms
          |
          +--> delete track
```

Use:

```javascript
TRACK_PREDICT_MS = 150;
TRACK_HOLD_MS = 220;
MASK_PREDICT_MS = 100;
VELOCITY_SMOOTHING = 0.30;
```

Keep:

```javascript
TRACK_SMOOTHING = 0.45;
```

until real-footage testing shows a reason to change it.

This gives the project the largest likely anti-flicker improvement with relatively low implementation risk, while leaving ByteTrack's server-side identity and confidence logic intact.

---

## 27. Future Upgrade Option: Server Tracker Prediction

If frontend prediction later proves insufficient, the next architecture step is to expose ByteTrack/Kalman predicted states from the vision server itself.

A future inference payload could contain:

```json
{
  "track_id": 17,
  "bbox": [0.32, 0.21, 0.48, 0.63],
  "tracking_state": "predicted",
  "prediction_age_ms": 67
}
```

Advantages:

- one authoritative tracker state
- server Kalman motion model reused
- browser no longer needs to independently estimate object velocity

Disadvantages:

- deeper coupling to Ultralytics/ByteTrack internals
- more server code and tests
- tracker implementation changes may become version-sensitive

Therefore this should remain a later optimization, not the first implementation.
