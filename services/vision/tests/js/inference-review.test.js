'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { frameIndex, validateManifest, ResultReader } = require('../../inference-review.js');
const overlay = require('../../live-view-overlay.js');
const colors = require('../../live-view-distance-colors.js');

function fixture(count = 40) {
  const frames = [], lines = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const line = JSON.stringify({ pts_90k: i * 3000,
      result: { width: 64, height: 48, items: [{ distance_m: i }] } }) + '\n';
    const bytes = Buffer.byteLength(line);
    frames.push([i * 3000, offset, bytes]); lines.push(line); offset += bytes;
  }
  const file = new Blob(lines);
  return { file, manifest: { version: 1, complete: true, time_base: 90000, width: 64, height: 48,
    duration: count / 30, frame_count: count, frames, results: { size: file.size } } };
}

test('timestamp lookup respects irregular frame intervals and boundaries', () => {
  const frames = [[0], [3000], [9000], [12000]];
  assert.equal(frameIndex(frames, 2999), 0);
  assert.equal(frameIndex(frames, 3000), 1);
  assert.equal(frameIndex(frames, 8999), 1);
  assert.equal(frameIndex(frames, 9000), 2);
  assert.equal(frameIndex(frames, 1e6), 3);
});

test('manifest rejects incomplete, overlapping and oversized records', () => {
  const { manifest, file } = fixture();
  validateManifest(manifest, file.size);
  assert.throws(() => validateManifest({ ...manifest, complete: false }, file.size));
  assert.throws(() => validateManifest({ ...manifest, version: 2 }, file.size));
  assert.throws(() => validateManifest(manifest, file.size - 1));
  const bad = structuredClone(manifest); bad.frames[1][1] = 0;
  assert.throws(() => validateManifest(bad, file.size));
});

test('indexed local reads and lookahead remain bounded during a whole video', async () => {
  const { file, manifest } = fixture();
  const reader = new ResultReader(file, manifest);
  for (let i = 0; i < manifest.frame_count; i++) {
    assert.equal((await reader.read(i)).items[0].distance_m, i);
    reader.prefetch(i);
    assert.ok(reader.cache.size <= 16, reader.cache.size);
  }
  reader.reset(); assert.equal(reader.cache.size, 0);
  assert.equal((await reader.read(2)).items[0].distance_m, 2);
});

test('stale reads after reset cannot refill the active cache', async () => {
  const { file, manifest } = fixture();
  let release;
  const delayed = { slice: (...args) => ({ text: () => new Promise(resolve => {
    release = async () => resolve(await file.slice(...args).text());
  }) }) };
  const reader = new ResultReader(delayed, manifest);
  const pending = reader.read(0);
  reader.reset(); await release(); await pending;
  assert.equal(reader.cache.size, 0);
});

test('incorrect per-frame timestamps are rejected', async () => {
  const { manifest } = fixture();
  const reader = new ResultReader({ slice: () => ({ text: async () => JSON.stringify({ pts_90k: 1, result: {} }) }) }, manifest);
  await assert.rejects(reader.read(0), /Invalid inference/);
});

test('raw rendering supports all box coordinate formats', () => {
  for (const [bbox, bbox_format] of [
    [[0.1, 0.2, 0.8, 0.9], 'xyxy_normalized'], [[10, 20, 80, 90], 'xyxy_pixels'],
    [[0.45, 0.55, 0.7, 0.7], 'xywh_normalized'], [[45, 55, 70, 70], 'xywh_pixels'],
  ]) {
    const actual = overlay.normalizedBox({ bbox, bbox_format }, 100, 100);
    actual.forEach((value, i) => assert.ok(Math.abs(value - [0.1, 0.2, 0.8, 0.9][i]) < 1e-8));
  }
  assert.equal(overlay.normalizedBox({ bbox: [0, 0, NaN, 1] }, 100, 100), null);
});

test('boxes, masks and distance labels can be controlled independently', () => {
  const calls = [];
  const ctx = new Proxy({ canvas: { width: 100, height: 100 }, measureText: () => ({ width: 40 }) }, {
    get(target, name) { return name in target ? target[name] : (...args) => calls.push([name, ...args]); },
  });
  const item = { class: 'car', bbox: [0.1, 0.2, 0.8, 0.9], confidence: 0.9,
    distance_m: 12, mask_format: 'polygon_normalized', mask: [[0.1, 0.2], [0.8, 0.2], [0.8, 0.9]] };
  overlay.draw(ctx, [item], 100, 100, { boxes: false, masks: true, distances: false,
    distanceColors: colors, distanceSettings: colors.normalizeSettings({ ...colors.DEFAULTS, enabled: true }) });
  assert.ok(calls.some(call => call[0] === 'fill'));
  assert.ok(!calls.some(call => call[0] === 'strokeRect'));
  assert.ok(calls.some(call => call[0] === 'fillText' && call[1] === 'car 90%'));
  calls.length = 0;
  overlay.draw(ctx, [item], 100, 100, { masks: false });
  assert.ok(calls.some(call => call[0] === 'strokeRect'));
  assert.ok(!calls.some(call => call[0] === 'fill'));
  assert.ok(calls.some(call => call[0] === 'fillText' && call[1].includes('12.0 m')));
});
