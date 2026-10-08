// Raw saved-result renderer shared by portable review and cached Live View.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiveViewOverlay = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function normalizedBox(item, width, height) {
    if (!Array.isArray(item.bbox) || item.bbox.length !== 4) return null;
    let [x, y, right, bottom] = item.bbox.map(Number);
    if (![x, y, right, bottom].every(Number.isFinite)) return null;
    const format = item.bbox_format || 'xyxy_normalized';
    if (!['xyxy_normalized', 'xyxy_pixels', 'xywh_normalized', 'xywh_pixels'].includes(format)) return null;
    if (format.endsWith('pixels')) { x /= width; right /= width; y /= height; bottom /= height; }
    if (format.startsWith('xywh')) { x -= right / 2; y -= bottom / 2; right += x; bottom += y; }
    x = Math.max(0, x); y = Math.max(0, y); right = Math.min(1, right); bottom = Math.min(1, bottom);
    return right > x && bottom > y ? [x, y, right, bottom] : null;
  }
  function classColor(name) {
    const palette = ['#35e18c', '#4dabf7', '#ff922b', '#f06595', '#ffd43b', '#c77dff'];
    let hash = 0;
    for (const char of String(name)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return palette[hash % palette.length];
  }
  function draw(ctx, items, width, height, options = {}) {
    const canvas = ctx.canvas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    for (const item of items || []) {
      if (Number(item.confidence) < (options.minConfidence ?? 0)) continue;
      const box = normalizedBox(item, width, height);
      if (!box) continue;
      const style = options.classStyle ? options.classStyle(String(item.class).toLowerCase()) : { box: true, mask: true };
      if (!style.box && !style.mask) continue;
      const rawDistance = item.distance_m;
      const distance = rawDistance != null && Number(rawDistance) > 0
        ? Number(rawDistance) * (options.distanceMultiplier ?? 1) : null;
      const color = options.distanceSettings?.enabled
        ? options.distanceColors.colorForDistance(distance, options.distanceSettings) : classColor(item.class);
      const [x1, y1, x2, y2] = box;
      const x = x1 * canvas.width, y = y1 * canvas.height;
      const w = (x2 - x1) * canvas.width, h = (y2 - y1) * canvas.height;
      if (options.masks !== false && style.mask && item.mask_format === 'polygon_normalized' && item.mask?.length >= 3) {
        ctx.beginPath();
        item.mask.forEach(([px, py], index) => {
          if (index === 0) ctx.moveTo(px * canvas.width, py * canvas.height);
          else ctx.lineTo(px * canvas.width, py * canvas.height);
        });
        ctx.closePath(); ctx.fillStyle = color + '44'; ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
      }
      if (options.boxes !== false && style.box) {
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
      }
      const name = options.classLabel ? options.classLabel(item.class) : String(item.class || 'object');
      const label = `${name} ${Math.round(Number(item.confidence) * 100)}%`
        + (options.distances !== false ? (distance === null ? ' · distance unavailable' : ` · ${distance.toFixed(1)} m`) : '');
      ctx.font = '600 14px sans-serif'; ctx.textBaseline = 'top';
      const labelWidth = Math.min(canvas.width, ctx.measureText(label).width + 10);
      const labelX = Math.max(0, Math.min(x, canvas.width - labelWidth));
      const labelY = Math.max(0, y - 22);
      ctx.fillStyle = '#0b1220dd'; ctx.fillRect(labelX, labelY, labelWidth, 22);
      ctx.fillStyle = color; ctx.fillText(label, labelX + 5, labelY + 3);
    }
    ctx.restore();
  }
  return { normalizedBox, classColor, draw };
});
