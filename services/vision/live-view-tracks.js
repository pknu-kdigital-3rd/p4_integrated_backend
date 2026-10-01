// Temporal hold / prediction for Live View overlay tracks.
//
// Pure functions over the page's track objects, kept out of index.html so
// they can be unit-tested with `node --test "services/vision/tests/js/*.test.js"`.
// See docs/temporal_hold_prediction_revised_plan.md.
//
// Time is media time in milliseconds (pair.timestamp_us / 1000), not the
// browser clock: paint() drains a backlog without pacing, so wall-clock gaps
// would not match the amount of video between two frames.
//
// Track lifecycle after the last real observation:
//   age <= predictMs  -> 'predicting' (centre moves with the learned residual
//                        velocity; drawn like an observed box)
//   age <= holdMs     -> 'holding'    (dashed, fading, no distance)
// A retained mask follows its box for maskPredictMs, then only the box is
// drawn.
//   age >  holdMs     -> 'expired'    (caller deletes the track)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiveViewTracks = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    predictMs: 150,
    holdMs: 220,
    maskPredictMs: 100,
    velocitySmoothing: 0.30,
    maxNormalizedSpeed: 2.0,
    maxVelocitySampleGapMs: 500,
    predictedMinAlpha: 0.35,
  });

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  // Merge overrides into the defaults and keep the phases ordered:
  // 0 <= predict <= hold, mask <= hold.
  function normalizeConfig(overrides) {
    const config = { ...DEFAULTS };
    for (const [key, value] of Object.entries(overrides || {})) {
      if (key in DEFAULTS) config[key] = finiteOr(value, DEFAULTS[key]);
    }
    config.predictMs = Math.max(0, config.predictMs);
    config.holdMs = Math.max(config.predictMs, config.holdMs);
    config.maskPredictMs = clamp(config.maskPredictMs, 0, config.holdMs);
    return config;
  }

  function clampBox(box) {
    return box.map((value) => clamp(value, 0, 1));
  }

  function translateBox(box, dx, dy) {
    return clampBox([box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy]);
  }

  function boxCenter(box) {
    return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  }

  // Initialise temporal state on a newly created track.
  function startTrack(track, box, nowMs) {
    track.lastObservedBox = box.slice();
    track.lastObservedAtMs = nowMs;
    track.lastUpdatedAtMs = nowMs;
    track.state = 'observed';
    // Residual centre velocity in normalised image units per second, i.e.
    // object motion after camera compensation.
    track.vx = 0;
    track.vy = 0;
    // Displacement of the box since its mask was observed (camera shift plus
    // prediction); a retained mask is drawn moved by this much.
    track.maskShift = [0, 0];
    return track;
  }

  // Apply the frame's camera translation to everything positioned in image
  // coordinates. Called once per displayed frame, before matching.
  function addMaskShift(track, dx, dy) {
    const shift = Array.isArray(track.maskShift) ? track.maskShift : [0, 0];
    track.maskShift = [shift[0] + dx, shift[1] + dy];
  }

  function shiftTrack(track, dx, dy) {
    track.box = translateBox(track.box, dx, dy);
    if (track.lastObservedBox) track.lastObservedBox = translateBox(track.lastObservedBox, dx, dy);
    addMaskShift(track, dx, dy);
  }

  // Learn velocity from two real observations. lastObservedBox has been
  // shifted with the camera every frame, so the difference is the object's
  // own motion; camera pans are never learned as velocity.
  function updateVelocity(track, observedBox, nowMs, config) {
    const dtMs = nowMs - finiteOr(track.lastObservedAtMs, nowMs);
    if (!track.lastObservedBox || dtMs <= 0) return;
    if (dtMs > config.maxVelocitySampleGapMs) {
      // Reacquisition after a long gap, not a continuous motion sample.
      track.vx = 0;
      track.vy = 0;
      return;
    }
    const [oldX, oldY] = boxCenter(track.lastObservedBox);
    const [newX, newY] = boxCenter(observedBox);
    const rawVx = (newX - oldX) / (dtMs / 1000);
    const rawVy = (newY - oldY) / (dtMs / 1000);
    const weight = config.velocitySmoothing;
    const limit = config.maxNormalizedSpeed;
    track.vx = clamp(finiteOr(track.vx, 0) * (1 - weight) + rawVx * weight, -limit, limit);
    track.vy = clamp(finiteOr(track.vy, 0) * (1 - weight) + rawVy * weight, -limit, limit);
  }

  // Record a real detector observation. Returns true when the track was
  // being predicted or held (a reacquisition). The page then blends the
  // displayed box toward the observation with its usual EMA, so a predicted
  // box does not snap.
  function recordObservation(track, observedBox, nowMs, config) {
    const reacquired = track.state === 'predicting' || track.state === 'holding';
    updateVelocity(track, observedBox, nowMs, config || DEFAULTS);
    track.lastObservedBox = observedBox.slice();
    track.lastObservedAtMs = nowMs;
    track.lastUpdatedAtMs = nowMs;
    track.state = 'observed';
    track.maskShift = [0, 0];
    return reacquired;
  }

  function observationAgeMs(track, nowMs) {
    return Math.max(0, nowMs - finiteOr(track.lastObservedAtMs, nowMs));
  }

  // Advance a track that has no observation in this frame. Returns its new
  // state; 'expired' means the caller must delete it.
  function advanceMissingTrack(track, nowMs, config) {
    const age = observationAgeMs(track, nowMs);
    if (age > config.holdMs) {
      track.state = 'expired';
      return track.state;
    }
    // Extrapolate the centre (width and height held) only for the part of
    // the elapsed interval that lies inside the prediction window, stepping
    // from the last update so an already predicted box is not moved twice.
    const windowEnd = finiteOr(track.lastObservedAtMs, nowMs) + config.predictMs;
    const from = Math.max(finiteOr(track.lastUpdatedAtMs, nowMs), finiteOr(track.lastObservedAtMs, nowMs));
    const to = Math.min(nowMs, windowEnd);
    if (to > from) {
      const stepSec = (to - from) / 1000;
      const dx = finiteOr(track.vx, 0) * stepSec;
      const dy = finiteOr(track.vy, 0) * stepSec;
      track.box = translateBox(track.box, dx, dy);
      addMaskShift(track, dx, dy);
    }
    track.state = age <= config.predictMs ? 'predicting' : 'holding';
    track.lastUpdatedAtMs = nowMs;
    return track.state;
  }

  // Full alpha while observed or predicting (so latest-mode boxes do not
  // pulse between real and skipped frames); fade only while holding, never
  // to zero before expiry.
  function trackAlpha(track, nowMs, config) {
    if (track.state !== 'holding') return 1;
    const span = Math.max(1, config.holdMs - config.predictMs);
    const progress = clamp((observationAgeMs(track, nowMs) - config.predictMs) / span, 0, 1);
    return 1 - (1 - config.predictedMinAlpha) * progress;
  }

  // Distance comes from an earlier depth map; once holding it would read as
  // a current measurement of a box that is no longer being observed.
  function distanceVisible(track) {
    return track.state !== 'holding';
  }

  // The mask to draw for a track: the observed polygon while observed, the
  // same polygon moved with its box for maskPredictMs after the last real
  // observation, then none (box only). A polygon is not extrapolated
  // further because its shape changes with the object.
  function maskForTrack(track, mask, nowMs, config) {
    if (!Array.isArray(mask) || mask.length < 3) return null;
    if (track.state === 'observed') return mask;
    if (observationAgeMs(track, nowMs) > config.maskPredictMs) return null;
    const [dx, dy] = Array.isArray(track.maskShift) ? track.maskShift : [0, 0];
    if (!dx && !dy) return mask;
    return mask.map((point) => [point[0] + dx, point[1] + dy]);
  }

  // Per-state counts and the oldest current prediction, for the stats line.
  function summarize(trackList, nowMs) {
    const summary = { observed: 0, predicting: 0, holding: 0, maxPredictionAgeMs: 0 };
    for (const track of trackList) {
      if (!(track.state in summary)) continue;
      summary[track.state] += 1;
      if (track.state !== 'observed') {
        summary.maxPredictionAgeMs = Math.max(summary.maxPredictionAgeMs, observationAgeMs(track, nowMs));
      }
    }
    return summary;
  }

  // Optional per-track debug text, e.g. "s17 PRED 67ms".
  function debugLabel(track, nowMs) {
    const age = Math.round(observationAgeMs(track, nowMs));
    if (track.state === 'predicting') return `${track.id} PRED ${age}ms`;
    if (track.state === 'holding') return `${track.id} HOLD ${age}ms`;
    return `${track.id} OBS`;
  }

  return {
    DEFAULTS,
    normalizeConfig,
    clampBox,
    translateBox,
    boxCenter,
    startTrack,
    shiftTrack,
    updateVelocity,
    recordObservation,
    observationAgeMs,
    advanceMissingTrack,
    trackAlpha,
    distanceVisible,
    maskForTrack,
    summarize,
    debugLabel,
  };
});
