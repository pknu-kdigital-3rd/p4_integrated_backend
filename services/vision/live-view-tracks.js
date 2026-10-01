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
//   age <= predictMs  -> 'predicting' (drawn like an observed box)
//   age <= holdMs     -> 'holding'    (dashed, fading, no distance)
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

  // Initialise temporal state on a newly created track.
  function startTrack(track, box, nowMs) {
    track.lastObservedBox = box.slice();
    track.lastObservedAtMs = nowMs;
    track.lastUpdatedAtMs = nowMs;
    track.state = 'observed';
    return track;
  }

  // Apply the frame's camera translation to everything positioned in image
  // coordinates. Called once per displayed frame, before matching.
  function shiftTrack(track, dx, dy) {
    track.box = translateBox(track.box, dx, dy);
    if (track.lastObservedBox) track.lastObservedBox = translateBox(track.lastObservedBox, dx, dy);
  }

  // Record a real detector observation. Returns true when the track was
  // being predicted or held (a reacquisition).
  function recordObservation(track, observedBox, nowMs) {
    const reacquired = track.state === 'predicting' || track.state === 'holding';
    track.lastObservedBox = observedBox.slice();
    track.lastObservedAtMs = nowMs;
    track.lastUpdatedAtMs = nowMs;
    track.state = 'observed';
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

  return {
    DEFAULTS,
    normalizeConfig,
    clampBox,
    translateBox,
    startTrack,
    shiftTrack,
    recordObservation,
    observationAgeMs,
    advanceMissingTrack,
    trackAlpha,
    distanceVisible,
  };
});
