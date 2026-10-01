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
