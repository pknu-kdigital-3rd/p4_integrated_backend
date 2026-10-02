// Distance grouping and display colors for the renderer-independent Live View overlay.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiveViewDistanceColors = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: false,
    nearMaxM: 15,
    midMaxM: 40,
    colors: Object.freeze({
      NEAR: '#ef4444',
      MID: '#3b82f6',
      FAR: '#22c55e',
      UNKNOWN: '#64748b',
    }),
  });
  const ZONES = Object.freeze(['NEAR', 'MID', 'FAR', 'UNKNOWN']);
  const MIN_THRESHOLD_M = 0.1;
  const MAX_THRESHOLD_M = 200;
  const HEX_COLOR = /^#[0-9a-f]{6}$/i;

  function isValidThresholds(nearMaxM, midMaxM) {
    const near = Number(nearMaxM), mid = Number(midMaxM);
    const nearStepValid = Math.abs(near * 10 - Math.round(near * 10)) < 1e-6;
    const midStepValid = Math.abs(mid * 10 - Math.round(mid * 10)) < 1e-6;
    return Number.isFinite(near) && Number.isFinite(mid)
      && nearStepValid && midStepValid
      && near >= MIN_THRESHOLD_M && near <= MAX_THRESHOLD_M
      && mid >= MIN_THRESHOLD_M && mid <= MAX_THRESHOLD_M
      && near < mid;
  }

  function normalizeSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    const validThresholds = isValidThresholds(source.nearMaxM, source.midMaxM);
    const sourceColors = source.colors && typeof source.colors === 'object' ? source.colors : {};
    const colors = {};
    for (const zone of ZONES) {
      const candidate = sourceColors[zone];
      colors[zone] = typeof candidate === 'string' && HEX_COLOR.test(candidate)
        ? candidate.toLowerCase() : DEFAULTS.colors[zone];
    }
    return {
      enabled: source.enabled === true,
      nearMaxM: validThresholds ? Number(source.nearMaxM) : DEFAULTS.nearMaxM,
      midMaxM: validThresholds ? Number(source.midMaxM) : DEFAULTS.midMaxM,
      colors,
    };
  }

  function zoneForDistance(distanceM, nearMaxM, midMaxM) {
    if (distanceM === null || distanceM === undefined || distanceM === '') return 'UNKNOWN';
    const distance = Number(distanceM);
    if (!Number.isFinite(distance) || distance <= 0) return 'UNKNOWN';
    if (distance <= nearMaxM) return 'NEAR';
    if (distance <= midMaxM) return 'MID';
    return 'FAR';
  }

  function colorForDistance(distanceM, settings) {
    const zone = zoneForDistance(distanceM, settings.nearMaxM, settings.midMaxM);
    const color = settings.colors?.[zone];
    return typeof color === 'string' && HEX_COLOR.test(color) ? color.toLowerCase() : DEFAULTS.colors[zone];
  }

  function textColorForBackground(hexColor) {
    if (typeof hexColor !== 'string' || !HEX_COLOR.test(hexColor)) return '#ffffff';
    const channels = [1, 3, 5].map(index => parseInt(hexColor.slice(index, index + 2), 16) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    return luminance > 0.179 ? '#111827' : '#ffffff';
  }

  function maskColor(hexColor, alpha = '44') {
    return `${HEX_COLOR.test(hexColor) ? hexColor : DEFAULTS.colors.UNKNOWN}${alpha}`;
  }

  return Object.freeze({
    DEFAULTS, ZONES, MIN_THRESHOLD_M, MAX_THRESHOLD_M,
    isValidThresholds, normalizeSettings, zoneForDistance,
    colorForDistance, textColorForBackground, maskColor,
  });
});
