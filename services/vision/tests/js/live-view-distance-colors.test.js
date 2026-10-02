'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const colors = require('../../live-view-distance-colors.js');

test('default settings keep distance coloring disabled and define the agreed thresholds and palette', () => {
  const settings = colors.normalizeSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.nearMaxM, 15);
  assert.equal(settings.midMaxM, 40);
  assert.deepEqual(settings.colors, {
    NEAR: '#ef4444', MID: '#3b82f6', FAR: '#22c55e', UNKNOWN: '#64748b',
  });
});

test('distance boundaries map to near, other/mid, and far', () => {
  assert.equal(colors.zoneForDistance(15, 15, 40), 'NEAR');
  assert.equal(colors.zoneForDistance(15.1, 15, 40), 'MID');
  assert.equal(colors.zoneForDistance(40, 15, 40), 'MID');
  assert.equal(colors.zoneForDistance(40.1, 15, 40), 'FAR');
  assert.equal(colors.zoneForDistance(10, 10, 20), 'NEAR');
  assert.equal(colors.zoneForDistance(20, 10, 20), 'MID');
  assert.equal(colors.zoneForDistance(20.1, 10, 20), 'FAR');
});

test('missing, non-finite, zero, and negative distances map to unknown', () => {
  for (const distance of [null, undefined, '', NaN, Infinity, -Infinity, 0, -0.1]) {
    assert.equal(colors.zoneForDistance(distance, 15, 40), 'UNKNOWN');
  }
});

test('settings normalize invalid thresholds and colors while retaining valid custom values', () => {
  assert.equal(colors.isValidThresholds(0.1, 200), true);
  assert.equal(colors.isValidThresholds(15.05, 40), false);
  assert.equal(colors.isValidThresholds(40, 15), false);
  const settings = colors.normalizeSettings({
    enabled: true, nearMaxM: 24.5, midMaxM: 80,
    colors: { NEAR: '#ABCDEF', MID: 'red', FAR: '#123456', UNKNOWN: '#000000' },
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.nearMaxM, 24.5);
  assert.equal(settings.midMaxM, 80);
  assert.deepEqual(settings.colors, {
    NEAR: '#abcdef', MID: colors.DEFAULTS.colors.MID,
    FAR: '#123456', UNKNOWN: '#000000',
  });
  assert.equal(colors.normalizeSettings({ nearMaxM: 45, midMaxM: 40 }).nearMaxM, 15);
});

test('distance color lookup and readable text color use the selected palette', () => {
  const settings = colors.normalizeSettings({ enabled: true, nearMaxM: 15, midMaxM: 40 });
  assert.equal(colors.colorForDistance(5, settings), settings.colors.NEAR);
  assert.equal(colors.colorForDistance(25, settings), settings.colors.MID);
  assert.equal(colors.colorForDistance(60, settings), settings.colors.FAR);
  assert.equal(colors.colorForDistance(null, settings), settings.colors.UNKNOWN);
  assert.equal(colors.textColorForBackground('#ffffff'), '#111827');
  assert.equal(colors.textColorForBackground('#000000'), '#ffffff');
  assert.equal(colors.maskColor('#abcdef'), '#abcdef44');
});
