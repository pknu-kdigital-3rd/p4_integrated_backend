# Temporal Hold / Prediction Layer — Revised Plan

Revision of `docs/temporal_hold_prediction_implementation_plan.md` after
checking it against the live-view code. The goal, the state model
(observed → predicting → holding → expired), the initial constants and the
"boxes outlive masks, stale distances are not presented as fresh" rules are
unchanged. This document records what changed and why, and is the plan that
was implemented.

## 1. Corrections to the original plan

### 1.1 Skipped-inference frames are not observations

With `YOLO_FRAME_DROP_POLICY=latest`, frames the model did not process are
still published, built by `_skipped_frame_result()` in
`services/vision/app/services/yolo.py`. Their `items` are a **copy of the
previous inference result** (same boxes, same `track_id`s) and the result
carries `inference_skipped: true`.

The original plan would treat those copies as fresh observations: every copy
resets the track age, so prediction would never start in exactly the mode the
plan expects to benefit most, and every copy is a zero-displacement velocity
sample that drags the learned velocity toward zero. This is also why boxes
currently freeze and then jump when inference falls behind.

**Rule:** a result with `inference_skipped === true` is "no new observation"
for every existing track. Its items only seed tracks when none exist yet (for
example right after a reset), so a reset during a skipped run does not leave
the overlay empty until the next real inference.

### 1.2 Clock: media timestamps, not `performance.now()`

The overlay is redrawn only in `paint()`, once per presented frame. `paint()`
is paced by the source timestamps (`pair.timestamp_us`), except that while
more than `MAX_LIVE_LAG_S` is buffered the backlog is painted as fast as it
decodes. With a wall clock, such a burst presents ~100 ms of video within a
few milliseconds, so displacement / tiny `dt` produces velocity spikes and the
hold timeout expires against the wrong amount of video.

**Rule:** the temporal layer's clock is `pair.timestamp_us / 1000` (media
milliseconds). Retention then means the same amount of *video* at any browser
FPS or catch-up speed, which is what acceptance criterion "changing browser FPS
does not materially change the retention duration" requires. If the clock
moves backwards (new epoch, jump to live, reconnect), all tracks are cleared.

### 1.3 Residual velocity: shift the reference box with the camera

Existing tracks are translated by `globalMotion` before matching. The box that
velocity is measured against (`lastObservedBox`) gets the same per-frame
translation, so the velocity sample is the object's motion *relative to the
image after camera compensation*. Camera pans are therefore never learned as
object velocity, and prediction adds only that residual motion — camera motion
is applied exactly once, in the existing pre-matching step. The original
phase 3 ("integrate with global motion") reduces to this rule and is merged
into the prediction commit.

### 1.4 No visual change while predicting

In `latest` mode a track is typically "predicting" on most displayed frames
(inference at 10 fps under 30 fps video). Fading or dashing during the
prediction window would make every box pulse between real and skipped frames.

**Rule:** inside the prediction window a track is drawn exactly like an
observed one (solid, full alpha, labels; the distance label keeps the existing
held-distance behaviour). Only the **holding** phase is visibly different:
dashed, thinner, alpha fading from 1.0 to `PREDICTED_MIN_ALPHA`, distance
label hidden.

### 1.5 Masks move with their box

Masks are drawn from the stored item. Today a ghosted mask stays where it was
observed while its box keeps moving. A retained mask is translated by the
displacement of its box since the mask was observed (camera shift plus
prediction). Masks are kept for `MASK_PREDICT_MS` after the last real
observation, then only the box remains.

### 1.6 Minimum alpha

`PREDICTED_MIN_ALPHA` is 0.35 instead of 0.5: the last held frame is fainter,
so expiry is a smaller step. The alpha never reaches zero before expiry.

### 1.7 Testable module

The temporal logic is pure (no DOM) and lives in
`services/vision/live-view-tracks.js`, served by the vision app at
`/live-view-tracks.js` (Nginx already forwards every path on the Live View
port), loaded by `index.html` with a classic `<script src>`, and unit-tested
with `node --test services/vision/tests/js/`. The module exposes a global
(`window.LiveViewTracks`) and CommonJS exports for the tests.

### 1.8 One expiry system

The `ghost frames` control is replaced immediately by millisecond controls
(predict, hold, mask), persisted in `localStorage`
(`playback-track-predict-ms`, `playback-track-hold-ms`,
`playback-mask-predict-ms`). `misses` no longer controls deletion.

## 2. Constants

| Constant | Value | Meaning |
|---|---|---|
| `TRACK_PREDICT_MS` | 150 | extrapolate the box centre this long after the last real observation |
| `TRACK_HOLD_MS` | 220 | then hold and fade; delete after this age |
| `MASK_PREDICT_MS` | 100 | keep a translated mask this long, then box only |
| `VELOCITY_SMOOTHING` | 0.30 | EMA weight of a new velocity sample |
| `MAX_NORMALIZED_SPEED` | 2.0 | clamp, image widths/heights per second |
| `MAX_VELOCITY_SAMPLE_GAP_MS` | 500 | larger gaps are reacquisition: velocity resets to 0 |
| `PREDICTED_MIN_ALPHA` | 0.35 | alpha at the end of the hold phase |

`TRACK_SMOOTHING = 0.45` (box EMA, also the reacquisition blend) is unchanged.
Width and height are never extrapolated.

## 3. Per-frame order

```text
paint(frame, pair)
  estimateGlobalMotion()                     (existing)
  nowMs = pair.timestamp_us / 1000
  compensatedDetections(inference, nowMs)
    clock went backwards -> clear tracks
    shift every track box, lastObservedBox and mask offset by globalMotion (once)
    if inference_skipped and tracks exist -> no observations this frame
    match server IDs, then local IoU matching            (existing)
    matched   -> observeTrack(): velocity sample, EMA box, state=observed
    unmatched -> advanceMissingTrack(): predict within window, then hold;
                 expired after TRACK_HOLD_MS -> delete
    return confirmed && shown tracks
  draw: alpha / dash / labels / mask from the track's state
```

Raw compensation mode keeps its current per-frame behaviour (no tracks).

## 4. Diagnostics

The stats line shows `tracks obs/pred/hold`, cumulative `expired` and
`reacquired`, the maximum current prediction age, and the active
`predict/hold/mask` values. A **track debug** checkbox (persisted) draws
`ID OBS`, `ID PRED 67ms` or `ID HOLD 184ms` next to each box; it is off by
default.

## 5. Commits

1. Module + tests: media clock, skipped frames as gaps, time-based hold and
   fade, stale distance hidden while holding, millisecond controls replacing
   ghost frames.
2. Bounded linear centre prediction with residual velocity (EMA, clamp, gap
   check) and predict-then-hold.
3. Short-lived translated masks, state counters and the debug overlay.

## 6. Tests (`node --test`)

Sequences from the original plan, driven with explicit media timestamps:
continuous observation; one short miss; several short misses (centre moves by
velocity, reacquisition blends); medium gap (holding, no extrapolation, alpha
between min and 1); long gap (expired); detector jump (velocity clamped);
camera pan (shifted reference box gives zero residual velocity); skipped
frames (no age reset, no velocity decay); backwards clock (reset); mask
translation and expiry.

## 7. Unchanged from the original plan

Out-of-scope list, server-tracker prediction as a later option, the
real-footage test matrix (section 22) and acceptance criteria (section 23).
