// Run: node --test "services/vision/tests/js/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tracks = require('../../live-view-tracks.js');

const config = tracks.normalizeConfig();
const BOX = [0.40, 0.40, 0.50, 0.60];

function newTrack(box = BOX, nowMs = 0) {
  return tracks.startTrack({ box: box.slice() }, box, nowMs);
}

// Drive a track through a sequence of [timeMs, box|null] steps the way the
// page does: null means no observation in that frame.
function run(track, steps) {
  const states = [];
  for (const [nowMs, box] of steps) {
    if (box) {
      tracks.recordObservation(track, box, nowMs, config);
      track.box = box.slice();
    } else {
      tracks.advanceMissingTrack(track, nowMs, config);
    }
    states.push(track.state);
  }
  return states;
}

test('normalizeConfig keeps predict <= hold and mask <= hold', () => {
  const custom = tracks.normalizeConfig({ predictMs: 300, holdMs: 100, maskPredictMs: 900 });
  assert.equal(custom.predictMs, 300);
  assert.equal(custom.holdMs, 300);
  assert.equal(custom.maskPredictMs, 300);
  assert.equal(tracks.normalizeConfig({ holdMs: 'not a number' }).holdMs, 220);
});

test('continuous observation stays observed', () => {
  const track = newTrack();
  assert.deepEqual(run(track, [[33, BOX], [66, BOX], [100, BOX]]), ['observed', 'observed', 'observed']);
});

test('a short miss predicts and then returns to observed', () => {
  const track = newTrack();
  assert.deepEqual(run(track, [[33, BOX], [66, null], [100, BOX]]), ['observed', 'predicting', 'observed']);
});

test('a medium gap holds and fades but never reaches zero alpha', () => {
  const track = newTrack();
  assert.equal(tracks.advanceMissingTrack(track, 100, config), 'predicting');
  assert.equal(tracks.trackAlpha(track, 100, config), 1);
  assert.equal(tracks.advanceMissingTrack(track, 200, config), 'holding');
  const alpha = tracks.trackAlpha(track, 200, config);
  assert.ok(alpha < 1 && alpha > config.predictedMinAlpha, `alpha ${alpha}`);
  assert.equal(tracks.advanceMissingTrack(track, 220, config), 'holding');
  assert.equal(tracks.trackAlpha(track, 220, config), config.predictedMinAlpha);
  assert.equal(tracks.distanceVisible(track), false);
});

test('a long gap expires the track', () => {
  const track = newTrack();
  assert.equal(tracks.advanceMissingTrack(track, 221, config), 'expired');
});

test('retention is measured in media time, not in frames', () => {
  // The same 300 ms gap expires whether it spans 2 frames or 30.
  const sparse = newTrack();
  assert.equal(run(sparse, [[150, null], [300, null]]).at(-1), 'expired');
  const dense = newTrack();
  const steps = Array.from({ length: 30 }, (_, index) => [(index + 1) * 10, null]);
  assert.equal(run(dense, steps).at(-1), 'expired');
});

test('a reacquisition is reported', () => {
  const track = newTrack();
  tracks.advanceMissingTrack(track, 100, config);
  assert.equal(tracks.recordObservation(track, BOX, 133, config), true);
  assert.equal(tracks.recordObservation(track, BOX, 166, config), false);
});

test('camera shift moves the box and its observation reference together', () => {
  const track = newTrack();
  tracks.shiftTrack(track, 0.1, -0.05);
  assert.deepEqual(track.box.map((v) => +v.toFixed(6)), [0.5, 0.35, 0.6, 0.55]);
  assert.deepEqual(track.lastObservedBox.map((v) => +v.toFixed(6)), [0.5, 0.35, 0.6, 0.55]);
});

function center(box) {
  return tracks.boxCenter(box).map((v) => +v.toFixed(4));
}

// Observe a box moving right by 0.01 per 33 ms frame (~0.3 widths/s).
function movingTrack(frames = 10) {
  const track = newTrack([0.40, 0.40, 0.50, 0.60], 0);
  for (let i = 1; i <= frames; i += 1) {
    const box = [0.40 + 0.01 * i, 0.40, 0.50 + 0.01 * i, 0.60];
    tracks.recordObservation(track, box, i * 33, config);
    track.box = box.slice();
  }
  return track;
}

test('velocity is learned from real observations and smoothed', () => {
  const track = movingTrack();
  // EMA approaches the true 0.303/s from below.
  assert.ok(track.vx > 0.2 && track.vx < 0.31, `vx ${track.vx}`);
  assert.equal(+track.vy.toFixed(6), 0);
});

test('several short misses move the centre by velocity, size held', () => {
  const track = movingTrack();
  const before = track.box.slice();
  const t0 = track.lastObservedAtMs;
  tracks.advanceMissingTrack(track, t0 + 33, config);
  tracks.advanceMissingTrack(track, t0 + 66, config);
  tracks.advanceMissingTrack(track, t0 + 99, config);
  const moved = track.box[0] - before[0];
  assert.ok(Math.abs(moved - track.vx * 0.099) < 1e-9, `moved ${moved}`);
  assert.equal(+(track.box[2] - track.box[0]).toFixed(9), +(before[2] - before[0]).toFixed(9));
  assert.equal(+(track.box[3] - track.box[1]).toFixed(9), +(before[3] - before[1]).toFixed(9));
});

test('prediction stops at the end of the window while holding', () => {
  const track = movingTrack();
  const t0 = track.lastObservedAtMs;
  tracks.advanceMissingTrack(track, t0 + 150, config);
  const atWindowEnd = track.box.slice();
  assert.equal(tracks.advanceMissingTrack(track, t0 + 200, config), 'holding');
  assert.deepEqual(track.box, atWindowEnd);
  // A frame that straddles the window end only predicts up to the end.
  const straddle = movingTrack();
  const s0 = straddle.lastObservedAtMs;
  const start = straddle.box[0];
  tracks.advanceMissingTrack(straddle, s0 + 200, config);
  assert.ok(Math.abs(straddle.box[0] - start - straddle.vx * 0.150) < 1e-9);
});

test('a detector jump cannot push velocity past the clamp', () => {
  const track = newTrack([0.0, 0.4, 0.1, 0.6], 0);
  tracks.recordObservation(track, [0.9, 0.4, 1.0, 0.6], 10, config);
  assert.ok(Math.abs(track.vx) <= config.maxNormalizedSpeed);
  for (let i = 0; i < 20; i += 1) tracks.recordObservation(track, i % 2 ? [0.0, 0.4, 0.1, 0.6] : [0.9, 0.4, 1.0, 0.6], 20 + i * 10, config);
  assert.ok(Math.abs(track.vx) <= config.maxNormalizedSpeed);
});

test('camera pan is not learned as object velocity', () => {
  // A static object while the camera pans: every frame shifts the track by
  // the global motion, and the detector reports the object at the shifted spot.
  const track = newTrack([0.40, 0.40, 0.50, 0.60], 0);
  let box = [0.40, 0.40, 0.50, 0.60];
  for (let i = 1; i <= 10; i += 1) {
    tracks.shiftTrack(track, -0.02, 0);
    box = tracks.translateBox(box, -0.02, 0);
    tracks.recordObservation(track, box, i * 33, config);
  }
  assert.ok(Math.abs(track.vx) < 1e-9, `vx ${track.vx}`);
});

test('a gap longer than the sample limit resets velocity on reacquisition', () => {
  const track = movingTrack();
  const t0 = track.lastObservedAtMs;
  tracks.recordObservation(track, [0.9, 0.4, 1.0, 0.6], t0 + 600, config);
  assert.equal(track.vx, 0);
  assert.equal(track.vy, 0);
});

const MASK = [[0.40, 0.40], [0.50, 0.40], [0.50, 0.60], [0.40, 0.60]];

test('an observed track draws its mask unchanged', () => {
  const track = newTrack();
  assert.equal(tracks.maskForTrack(track, MASK, 0, config), MASK);
  assert.equal(tracks.maskForTrack(track, [[0, 0], [1, 1]], 0, config), null);
});

test('a retained mask moves with its box, then is dropped before the box', () => {
  const track = movingTrack();
  const t0 = track.lastObservedAtMs;
  tracks.shiftTrack(track, 0.05, 0);
  tracks.advanceMissingTrack(track, t0 + 66, config);
  const mask = tracks.maskForTrack(track, MASK, t0 + 66, config);
  const expectedDx = 0.05 + track.vx * 0.066;
  assert.ok(Math.abs(mask[0][0] - (0.40 + expectedDx)) < 1e-9, `mask x ${mask[0][0]}`);
  assert.equal(+mask[0][1].toFixed(9), 0.40);
  // Past maskPredictMs the box is still predicted but the mask is gone.
  assert.equal(tracks.advanceMissingTrack(track, t0 + 120, config), 'predicting');
  assert.equal(tracks.maskForTrack(track, MASK, t0 + 120, config), null);
});

test('a new observation resets the mask displacement', () => {
  const track = movingTrack();
  tracks.shiftTrack(track, 0.05, 0.02);
  tracks.recordObservation(track, BOX, track.lastObservedAtMs + 33, config);
  assert.deepEqual(track.maskShift, [0, 0]);
});

test('summary counts states and the oldest prediction', () => {
  const observed = newTrack();
  const predicting = newTrack();
  const holding = newTrack();
  tracks.advanceMissingTrack(predicting, 100, config);
  tracks.advanceMissingTrack(holding, 200, config);
  observed.lastObservedAtMs = 200;
  const summary = tracks.summarize([observed, predicting, holding], 200);
  assert.deepEqual(summary, { observed: 1, predicting: 1, holding: 1, maxPredictionAgeMs: 200 });
});

test('debug labels name the state and age', () => {
  const track = newTrack();
  track.id = 's17';
  assert.equal(tracks.debugLabel(track, 0), 's17 OBS');
  tracks.advanceMissingTrack(track, 67, config);
  assert.equal(tracks.debugLabel(track, 67), 's17 PRED 67ms');
  tracks.advanceMissingTrack(track, 184, config);
  assert.equal(tracks.debugLabel(track, 184), 's17 HOLD 184ms');
});
